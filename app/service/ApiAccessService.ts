import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'mysql2/promise';

export const ACCESS_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS region_api_key (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        key_prefix VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'enabled',
        expires_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY key_hash_idx (key_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS region_api_usage_daily (
        usage_date DATE NOT NULL,
        key_id INT UNSIGNED NOT NULL DEFAULT 0,
        endpoint VARCHAR(32) NOT NULL,
        status_code SMALLINT UNSIGNED NOT NULL,
        requests BIGINT UNSIGNED NOT NULL DEFAULT 0,
        total_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
        last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (usage_date,key_id,endpoint,status_code),
        KEY key_date_idx (key_id,usage_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];
const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const newKey = () => `rg_${randomBytes(32).toString('hex')}`;
function id(value: unknown) {
    if (!Number.isSafeInteger(value) || Number(value) < 1)
        throw new Error('Key ID 错误');
    return Number(value);
}
function name(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
        throw new Error('名称需要 1–100 个字符');
    return value.trim();
}
function expiry(value: unknown) {
    if (value === null || value === '') return null;
    if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
        !Number.isFinite(Date.parse(value))
    )
        throw new Error('到期时间需要 UTC ISO 日期或 null');
    return new Date(value);
}
export class ApiAccessService {
    constructor(private pool: Pool) {}
    async setup() {
        for (const sql of ACCESS_SCHEMA) await this.pool.query(sql);
    }
    async keys() {
        const [rows]: any = await this.pool
            .query(`SELECT id,name,key_prefix,status,DATE_FORMAT(expires_at,'%Y-%m-%dT%H:%i:%sZ') AS expires_at,created_at,updated_at,
            (expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP()) AS expired
            FROM region_api_key ORDER BY id DESC`);
        return rows.map((row: any) => ({
            ...row,
            expired: Number(row.expired),
        }));
    }
    async create(input: any) {
        const label = name(input.name);
        const expires = expiry(input.expires_at ?? null);
        const key = newKey();
        const [row]: any = await this.pool.execute(
            'INSERT INTO region_api_key(name,key_hash,key_prefix,expires_at) VALUES(?,?,?,?)',
            [
                label,
                hash(key),
                key.slice(0, 12),
                expires
                    ? expires.toISOString().slice(0, 19).replace('T', ' ')
                    : null,
            ],
        );
        return { id: row.insertId, key };
    }
    async update(input: any) {
        const keyId = id(input.id);
        const label = name(input.name);
        if (!['enabled', 'disabled'].includes(input.status))
            throw new Error('Key 状态错误');
        const expires = expiry(input.expires_at ?? null);
        const [row]: any = await this.pool.execute(
            "UPDATE region_api_key SET name=?,status=?,expires_at=? WHERE id=? AND status<>'revoked'",
            [
                label,
                input.status,
                expires
                    ? expires.toISOString().slice(0, 19).replace('T', ' ')
                    : null,
                keyId,
            ],
        );
        if (!row.affectedRows) throw new Error('Key 不存在或已撤销');
        return { id: keyId };
    }
    async revoke(value: unknown) {
        const keyId = id(value);
        const [row]: any = await this.pool.execute(
            "UPDATE region_api_key SET status='revoked' WHERE id=?",
            [keyId],
        );
        if (!row.affectedRows) throw new Error('Key 不存在');
        return { id: keyId };
    }
    async rotate(value: unknown) {
        const keyId = id(value),
            key = newKey();
        const [row]: any = await this.pool.execute(
            "UPDATE region_api_key SET key_hash=?,key_prefix=? WHERE id=? AND status<>'revoked'",
            [hash(key), key.slice(0, 12), keyId],
        );
        if (!row.affectedRows) throw new Error('Key 不存在或已撤销');
        return { id: keyId, key };
    }
    async authorize(key: string | null) {
        if (!key || !/^rg_[a-f0-9]{64}$/.test(key))
            return { id: 0, allowed: false };
        const [[row]]: any = await this.pool.execute(
            `SELECT id, (status='enabled' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())) AS allowed
             FROM region_api_key WHERE key_hash=?`,
            [hash(key)],
        );
        return { id: row?.id || 0, allowed: Number(row?.allowed) === 1 };
    }
    async record(
        keyId: number,
        endpoint: string,
        status: number,
        elapsed: number,
    ) {
        await this.pool.execute(
            `INSERT INTO region_api_usage_daily(usage_date,key_id,endpoint,status_code,requests,total_ms,last_used_at)
             VALUES(DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR),?,?,?,?,?,CURRENT_TIMESTAMP)
             ON DUPLICATE KEY UPDATE requests=requests+1,total_ms=total_ms+VALUES(total_ms),last_used_at=CURRENT_TIMESTAMP`,
            [keyId, endpoint, status, 1, Math.max(0, Math.round(elapsed))],
        );
    }
    async usage(query: Record<string, string>) {
        const days = Number(query.days ?? 30);
        if (![7, 30, 90].includes(days))
            throw new Error('统计范围必须为 7、30 或 90 天');
        const keyId =
            query.key_id === undefined ? undefined : Number(query.key_id);
        if (keyId !== undefined && (!Number.isSafeInteger(keyId) || keyId < 0))
            throw new Error('Key ID 错误');
        const where = `u.usage_date >= DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR) - INTERVAL ${days - 1} DAY${keyId === undefined ? '' : ' AND u.key_id=?'}`;
        const params = keyId === undefined ? [] : [keyId];
        const [rows]: any = await this.pool.execute(
            `SELECT DATE_FORMAT(u.usage_date,'%Y-%m-%d') AS date,u.key_id,k.name,k.key_prefix,u.endpoint,u.status_code,u.requests,u.total_ms,u.last_used_at
             FROM region_api_usage_daily u LEFT JOIN region_api_key k ON k.id=u.key_id WHERE ${where} ORDER BY u.usage_date,u.key_id,u.endpoint,u.status_code`,
            params,
        );
        const summary = { requests: 0, errors: 0, total_ms: 0 };
        const daily = new Map<string, typeof summary>();
        const keys = new Map<number, any>();
        const endpoints = new Map<string, any>();
        const now = new Date(Date.now() + 8 * 3600_000);
        for (let offset = days - 1; offset >= 0; offset--)
            daily.set(
                new Date(now.getTime() - offset * 86400_000)
                    .toISOString()
                    .slice(0, 10),
                { requests: 0, errors: 0, total_ms: 0 },
            );
        for (const row of rows) {
            if (!keys.has(row.key_id))
                keys.set(row.key_id, {
                    key_id: row.key_id,
                    name: row.name || '未识别 / 未提供 Key',
                    key_prefix: row.key_prefix,
                    requests: 0,
                    errors: 0,
                    total_ms: 0,
                    last_used_at: row.last_used_at,
                });
            if (!endpoints.has(row.endpoint))
                endpoints.set(row.endpoint, {
                    endpoint: row.endpoint,
                    requests: 0,
                    errors: 0,
                    total_ms: 0,
                });
            const key = keys.get(row.key_id);
            if (new Date(row.last_used_at) > new Date(key.last_used_at))
                key.last_used_at = row.last_used_at;
            for (const target of [
                summary,
                daily.get(row.date),
                key,
                endpoints.get(row.endpoint),
            ]) {
                if (!target) continue;
                target.requests += Number(row.requests);
                target.errors +=
                    row.status_code >= 400 ? Number(row.requests) : 0;
                target.total_ms += Number(row.total_ms);
            }
        }
        const metrics = (row: typeof summary) => ({
            ...row,
            success: row.requests - row.errors,
            avg_ms: row.requests ? Math.round(row.total_ms / row.requests) : 0,
        });
        return {
            days,
            timezone: 'Asia/Shanghai',
            summary: metrics(summary),
            daily: [...daily].map(([date, row]) => ({ date, ...metrics(row) })),
            keys: [...keys.values()]
                .map(metrics)
                .sort((a, b) => b.requests - a.requests),
            endpoints: [...endpoints.values()].map(metrics),
        };
    }
}
