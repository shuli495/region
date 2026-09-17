import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolConnection } from 'mysql2/promise';

export const HISTORY_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS region_data_release (
        version INT UNSIGNED PRIMARY KEY, scope TINYINT NOT NULL DEFAULT 2,
        title VARCHAR(255) NOT NULL, source VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL, parent_version INT UNSIGNED NULL,
        parent_checksum CHAR(64) NULL, checksum CHAR(64) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        applied_at TIMESTAMP NULL, rolled_back_at TIMESTAMP NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS region_change_log (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        operation_id CHAR(36) NOT NULL, release_version INT UNSIGNED NULL,
        source VARCHAR(16) NOT NULL, reason VARCHAR(255) NOT NULL,
        table_name VARCHAR(32) NOT NULL, row_id INT UNSIGNED NOT NULL,
        before_data JSON NULL, after_data JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY version_idx (release_version,id), KEY operation_idx (operation_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];
const TABLES = {
    region: [
        'id',
        'parent_id',
        'code',
        'level_type',
        'depth',
        'has_children',
        'name_cn',
        'name_en',
        'name_local',
        'name_pinyin',
        'name_jianpin',
    ],
    region_detail: [
        'region_id',
        'region_code',
        'phone_code',
        'zone',
        'utc',
        'lng',
        'lat',
        'capital',
        'osm_id',
        'geo_names_id',
    ],
    region_search: ['region_id', 'parent_id', 'search_text'],
};
const parse = (value: any) =>
    typeof value === 'string' ? JSON.parse(value) : value;
function json(alias: string, columns: string[]) {
    return `JSON_OBJECT(${columns.map((c) => `'${c}',${alias}.\`${c}\``).join(',')})`;
}
const hash = (value: any) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function positive(value: any) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error('ID或版本号必须为正整数');
    return value;
}

/** 只能在调用者的业务事务中使用；临时表DDL不会隐式提交事务。 */
export async function capture(db: PoolConnection, ids?: number[]) {
    await db.query('DROP TEMPORARY TABLE IF EXISTS audit_scope');
    await db.query(
        'CREATE TEMPORARY TABLE audit_scope (id INT UNSIGNED PRIMARY KEY)',
    );
    if (ids)
        for (let i = 0; i < ids.length; i += 1000)
            await db.query('INSERT IGNORE INTO audit_scope VALUES ?', [
                ids.slice(i, i + 1000).map((id) => [id]),
            ]);
    for (const [table, columns] of Object.entries(TABLES)) {
        await db.query(`DROP TEMPORARY TABLE IF EXISTS audit_${table}`);
        // CTAS只复制列，不继承业务表的自定义TABLESPACE。
        await db.query(
            `CREATE TEMPORARY TABLE audit_${table} (${columns[0]} INT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB AS SELECT * FROM ${table} WHERE 0`,
        );
        await db.query(
            `INSERT INTO audit_${table} SELECT t.* FROM ${table} t ${ids ? `JOIN audit_scope s ON s.id=t.${columns[0]}` : ''}`,
        );
    }
}
export async function record(
    db: PoolConnection,
    source: string,
    reason: string,
    version: number | null,
    scoped = false,
) {
    const operation = randomUUID();
    for (const [table, columns] of Object.entries(TABLES)) {
        const key = columns[0];
        const different = columns
            .slice(1)
            .map((c) => `NOT(b.\`${c}\` <=> a.\`${c}\`)`)
            .join(' OR ');
        await db.execute(
            `INSERT INTO region_change_log(operation_id,release_version,source,reason,table_name,row_id,before_data,after_data)
            SELECT ?,?,?,?,?,b.${key},${json('b', columns)},IF(a.${key} IS NULL,NULL,${json('a', columns)})
            FROM audit_${table} b LEFT JOIN ${table} a ON a.${key}=b.${key}
            WHERE a.${key} IS NULL OR ${different}`,
            [operation, version, source, reason, table],
        );
        await db.execute(
            `INSERT INTO region_change_log(operation_id,release_version,source,reason,table_name,row_id,before_data,after_data)
            SELECT ?,?,?,?,?,a.${key},NULL,${json('a', columns)} FROM ${table} a
            ${scoped ? `JOIN audit_scope s ON s.id=a.${key}` : ''}
            LEFT JOIN audit_${table} b ON b.${key}=a.${key} WHERE b.${key} IS NULL`,
            [operation, version, source, reason, table],
        );
    }
    const [[count]]: any = await db.execute(
        'SELECT COUNT(*) AS n FROM region_change_log WHERE operation_id=?',
        [operation],
    );
    return { operation_id: operation, changes: Number(count.n) };
}
export async function assertClean(db: PoolConnection) {
    const [[pending]]: any = await db.query(
        "SELECT (SELECT COUNT(*) FROM region_change_log WHERE release_version IS NULL)+(SELECT COUNT(*) FROM region_data_release WHERE status='draft') AS n",
    );
    if (Number(pending.n))
        throw new Error('存在未归档修改或草稿版本，请先归档发布');
}
export async function nextVersion(db: PoolConnection, preferred = 0) {
    const [[max]]: any = await db.query(
        'SELECT GREATEST(COALESCE((SELECT MAX(version) FROM region_data_release),0),COALESCE((SELECT version FROM data_version WHERE scope=2),0)) AS n',
    );
    const today =
        Number(
            new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            })
                .format(new Date())
                .replaceAll('-', ''),
        ) * 100;
    const next =
        preferred > Number(max.n)
            ? preferred
            : Math.max(today, Number(max.n) + 1);
    if (next > 4294967295) throw new Error('版本号超出INT范围');
    return next;
}
export async function registerAuto(
    db: PoolConnection,
    preferred: number,
    title: string,
    checksum: string,
    source = 'mca',
) {
    await assertClean(db);
    const [[parent]]: any = await db.query(
        'SELECT version,checksum FROM data_version WHERE scope=2',
    );
    // 同步任务版本已被预留；只需超过当前发布版本和已有历史版本。
    const [[used]]: any = await db.execute(
        'SELECT version FROM region_data_release WHERE version=?',
        [preferred],
    );
    const version =
        !used && preferred > Number(parent?.version || 0)
            ? preferred
            : await nextVersion(db);
    await db.execute(
        "INSERT INTO region_data_release(version,title,source,status,parent_version,parent_checksum,checksum,applied_at) VALUES(?,?,?,'applied',?,?,?,CURRENT_TIMESTAMP)",
        [
            version,
            title,
            source,
            parent?.version ?? null,
            parent?.checksum ?? null,
            checksum,
        ],
    );
    return version;
}

export class DataHistoryService {
    constructor(private pool: Pool) {}
    async setup() {
        for (const sql of HISTORY_SCHEMA) await this.pool.query(sql);
    }
    async releases() {
        const [rows] = await this.pool.query(
            'SELECT * FROM region_data_release ORDER BY version DESC LIMIT 100',
        );
        return rows;
    }
    async changes(query: any = {}) {
        const where: string[] = [];
        const params: any[] = [];
        if (query.version !== undefined) {
            where.push('release_version=?');
            params.push(positive(Number(query.version)));
        }
        if (query.unassigned === 'true') where.push('release_version IS NULL');
        if (query.operation_id) {
            where.push('operation_id=?');
            params.push(String(query.operation_id));
        }
        const after = Number(query.after_id || 0),
            limit = Number(query.limit || 100);
        if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 1000
        )
            throw new Error('分页参数错误');
        where.push('id>?');
        params.push(after);
        const [rows]: any = await this.pool.execute(
            `SELECT * FROM region_change_log WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${limit + 1}`,
            params,
        );
        return {
            records: rows.slice(0, limit),
            has_more: rows.length > limit,
            next_after_id: rows.length > limit ? rows[limit - 1].id : null,
        };
    }
    private async locked<T>(action: (db: PoolConnection) => Promise<T>) {
        const db = await this.pool.getConnection();
        let lock = false;
        try {
            const [[r]]: any = await db.query(
                "SELECT GET_LOCK('region-data-patch',0) AS acquired",
            );
            if (Number(r.acquired) !== 1)
                throw new Error('其他更新正在运行，请稍后重试');
            lock = true;
            await db.beginTransaction();
            const result = await action(db);
            await db.commit();
            return result;
        } catch (e) {
            await db.rollback();
            throw e;
        } finally {
            try {
                if (lock)
                    await db.query("SELECT RELEASE_LOCK('region-data-patch')");
            } finally {
                db.release();
            }
        }
    }
    async create(title: string, operations: string[] = []) {
        if (!Array.isArray(operations))
            throw new Error('operation_ids必须是数组');
        if (typeof title !== 'string' || !title.trim() || title.length > 255)
            throw new Error('版本标题错误');
        return this.locked(async (db) => {
            const [[draft]]: any = await db.query(
                "SELECT version FROM region_data_release WHERE status='draft' LIMIT 1",
            );
            if (draft)
                throw new Error(
                    `已有草稿版本 ${draft.version}，请向该版本关联修改`,
                );
            const version = await nextVersion(db);
            const [[parent]]: any = await db.query(
                'SELECT version,checksum FROM data_version WHERE scope=2',
            );
            await db.execute(
                "INSERT INTO region_data_release(version,title,source,status,parent_version,parent_checksum) VALUES(?,?,'manual','draft',?,?)",
                [
                    version,
                    title.trim(),
                    parent?.version ?? null,
                    parent?.checksum ?? null,
                ],
            );
            if (operations.length) await this.attachIn(db, version, operations);
            return { version, status: 'draft' };
        });
    }
    private async attachIn(
        db: PoolConnection,
        version: number,
        operations: string[],
    ) {
        positive(version);
        if (
            !Array.isArray(operations) ||
            !operations.length ||
            operations.length > 100 ||
            new Set(operations).size !== operations.length ||
            operations.some(
                (id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id),
            )
        )
            throw new Error('operation_ids参数错误');
        const [[release]]: any = await db.execute(
            'SELECT status FROM region_data_release WHERE version=?',
            [version],
        );
        if (release?.status !== 'draft') throw new Error('只能关联到草稿版本');
        for (const operation of operations) {
            const [records]: any = await db.execute(
                'SELECT release_version FROM region_change_log WHERE operation_id=?',
                [operation],
            );
            if (
                !records.length ||
                records.some(
                    (r: any) =>
                        r.release_version !== null &&
                        Number(r.release_version) !== version,
                )
            )
                throw new Error(`修改操作不存在或已关联其他版本: ${operation}`);
            await db.execute(
                'UPDATE region_change_log SET release_version=? WHERE operation_id=?',
                [version, operation],
            );
        }
    }
    async attach(version: number, operations: string[]) {
        return this.locked(async (db) => {
            await this.attachIn(db, version, operations);
            return { version };
        });
    }
    async publish(version: number) {
        positive(version);
        return this.locked(async (db) => {
            const [[release]]: any = await db.execute(
                'SELECT * FROM region_data_release WHERE version=?',
                [version],
            );
            const [[current]]: any = await db.query(
                'SELECT version FROM data_version WHERE scope=2',
            );
            if (release?.status === 'applied' && current?.version === version)
                return { version, status: 'applied' };
            if (release?.status !== 'draft')
                throw new Error('只能发布草稿版本');
            if ((current?.version ?? null) !== release.parent_version)
                throw new Error('当前版本已变化，不能发布该草稿');
            const [[pending]]: any = await db.query(
                'SELECT COUNT(*) AS n FROM region_change_log WHERE release_version IS NULL',
            );
            if (Number(pending.n))
                throw new Error(
                    '仍有未关联修改，请先全部关联到草稿，避免形成不完整版本',
                );
            const records = await this.readChanges(db, version);
            if (!records.length) throw new Error('版本没有修改记录');
            await this.checkImages(db, records, 'after');
            const checksum = hash(records);
            await db.execute(
                "UPDATE region_data_release SET status='applied',checksum=?,applied_at=CURRENT_TIMESTAMP WHERE version=?",
                [checksum, version],
            );
            await this.setCurrent(db, version, checksum);
            return { version, status: 'applied' };
        });
    }
    private async readChanges(db: PoolConnection, version: number) {
        const [rows]: any = await db.execute(
            'SELECT * FROM region_change_log WHERE release_version=? ORDER BY id',
            [version],
        );
        const merged = new Map<string, any>();
        for (const row of rows) {
            const key = `${row.table_name}:${row.row_id}`;
            const prev = merged.get(key);
            merged.set(key, {
                table: row.table_name,
                id: row.row_id,
                before: prev ? prev.before : parse(row.before_data),
                after: parse(row.after_data),
            });
        }
        return [...merged.values()];
    }
    private async checkImages(
        db: PoolConnection,
        images: any[],
        side: 'before' | 'after',
    ) {
        for (const item of images) {
            const columns = TABLES[item.table as keyof typeof TABLES];
            if (!columns) throw new Error('修改记录表名错误');
            const [rows]: any = await db.execute(
                `SELECT ${json('t', columns)} AS image FROM ${item.table} t WHERE ${columns[0]}=?`,
                [item.id],
            );
            const current = rows.length ? parse(rows[0].image) : null;
            const canonical = (o: any): string =>
                o === null
                    ? 'null'
                    : JSON.stringify(
                          Object.fromEntries(
                              Object.keys(o)
                                  .sort()
                                  .map((k) => [k, o[k]]),
                          ),
                      );
            if (canonical(current) !== canonical(item[side]))
                throw new Error(
                    `数据已变化，不能覆盖: ${item.table}/${item.id}`,
                );
        }
    }
    private async setCurrent(
        db: PoolConnection,
        version: number | null,
        checksum: string | null,
    ) {
        if (version === null)
            await db.execute('DELETE FROM data_version WHERE scope=2');
        else
            await db.execute(
                'INSERT INTO data_version(scope,version,checksum) VALUES(2,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),checksum=VALUES(checksum)',
                [version, checksum],
            );
    }
    async replay(version: number, direction: 'rollback' | 'apply') {
        positive(version);
        return this.locked(async (db) => {
            await assertClean(db);
            const [[release]]: any = await db.execute(
                'SELECT * FROM region_data_release WHERE version=?',
                [version],
            );
            if (!release) throw new Error('该版本没有修改历史，无法回退或重放');
            const [[current]]: any = await db.query(
                'SELECT version FROM data_version WHERE scope=2',
            );
            const rollback = direction === 'rollback';
            if (
                rollback
                    ? release.status !== 'applied' ||
                      current?.version !== version
                    : release.status !== 'rolled_back' ||
                      (current?.version ?? null) !== release.parent_version
            )
                throw new Error('只能回退当前版本，或从对应父版本重新应用');
            const images = await this.readChanges(db, version);
            await this.checkImages(db, images, rollback ? 'after' : 'before');
            // 先移除所有受影响行，支持同一次版本中的代码交换，随后按原ID恢复。
            for (const table of ['region_search', 'region_detail', 'region']) {
                const ids = images
                    .filter((i) => i.table === table)
                    .map((i) => i.id);
                for (let i = 0; i < ids.length; i += 1000)
                    await db.query(
                        `DELETE FROM ${table} WHERE ${TABLES[table as keyof typeof TABLES][0]} IN (?)`,
                        [ids.slice(i, i + 1000)],
                    );
            }
            for (const table of Object.keys(TABLES))
                for (const item of images.filter((i) => i.table === table)) {
                    const image = item[rollback ? 'before' : 'after'];
                    if (image === null) continue;
                    const columns = TABLES[table as keyof typeof TABLES];
                    await db.execute(
                        `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
                        columns.map((c) => image[c]),
                    );
                }
            const [[orphans]]: any = await db.query(
                'SELECT COUNT(*) AS n FROM region r LEFT JOIN region p ON p.id=r.parent_id WHERE r.parent_id IS NOT NULL AND p.id IS NULL',
            );
            if (Number(orphans.n)) throw new Error('回放将产生缺失父节点');
            await this.setCurrent(
                db,
                rollback ? release.parent_version : version,
                rollback ? release.parent_checksum : release.checksum,
            );
            await db.execute(
                `UPDATE region_data_release SET status=?,${rollback ? 'rolled_back_at' : 'applied_at'}=CURRENT_TIMESTAMP WHERE version=?`,
                [rollback ? 'rolled_back' : 'applied', version],
            );
            return { version, status: rollback ? 'rolled_back' : 'applied' };
        });
    }
    async edit(input: any) {
        if (
            !input ||
            !['create', 'update', 'delete'].includes(input.action) ||
            typeof input.reason !== 'string' ||
            !input.reason.trim() ||
            input.reason.length > 255
        )
            throw new Error('action或reason参数错误');
        const fields = input.fields || {};
        if (typeof fields !== 'object' || Array.isArray(fields))
            throw new Error('fields参数错误');
        const names: Record<string, number> = {
            name_cn: 64,
            name_en: 128,
            name_local: 128,
            name_pinyin: 128,
            name_jianpin: 64,
        };
        for (const [key, value] of Object.entries(fields)) {
            if (Object.hasOwn(names, key)) {
                if (
                    value !== null &&
                    (typeof value !== 'string' || value.length > names[key])
                )
                    throw new Error(`字段错误: ${key}`);
                if (key === 'name_cn' && (!value || typeof value !== 'string'))
                    throw new Error('名称不能为空');
            } else if (key === 'code') {
                if (
                    typeof value !== 'string' ||
                    !/^\d{6}(\d{3}){0,2}$/.test(value)
                )
                    throw new Error('代码必须为6、9或12位数字');
            } else if (key === 'parent_id') positive(value);
            else if (key === 'level_type') {
                if (
                    !Number.isInteger(value) ||
                    Number(value) < 300 ||
                    Number(value) > 899
                )
                    throw new Error('level_type错误');
            } else throw new Error(`不允许修改字段: ${key}`);
        }
        const detail = input.detail;
        if (detail !== undefined && detail !== null) {
            if (typeof detail !== 'object' || Array.isArray(detail))
                throw new Error('detail参数错误');
            for (const [key, value] of Object.entries(detail)) {
                if (!TABLES.region_detail.slice(1).includes(key))
                    throw new Error(`详情字段错误: ${key}`);
                if (value === null) {
                    if (key === 'capital') throw new Error('capital不能为null');
                    continue;
                }
                if (['lng', 'lat'].includes(key)) {
                    if (
                        typeof value !== 'number' ||
                        !Number.isFinite(value) ||
                        Math.abs(value) > (key === 'lng' ? 180 : 90)
                    )
                        throw new Error(`坐标错误: ${key}`);
                } else if (['capital', 'zone', 'geo_names_id'].includes(key)) {
                    if (
                        !Number.isInteger(value) ||
                        Number(value) < 0 ||
                        Number(value) >
                            (key === 'capital'
                                ? 1
                                : key === 'zone'
                                  ? 255
                                  : 4294967295)
                    )
                        throw new Error(`详情数值错误: ${key}`);
                } else if (
                    typeof value !== 'string' ||
                    value.length >
                        (key === 'utc' ? 6 : key === 'osm_id' ? 64 : 32)
                )
                    throw new Error(`详情文本错误: ${key}`);
            }
        }
        return this.locked(async (db) => {
            let id: number = input.action === 'create' ? 0 : positive(input.id);
            let old: any = null;
            if (id) {
                const [[r]]: any = await db.execute(
                    'SELECT * FROM region WHERE id=?',
                    [id],
                );
                old = r;
                if (!old || old.level_type < 300)
                    throw new Error('节点不存在或不允许修改国家节点');
            }
            const parentId = fields.parent_id ?? old?.parent_id;
            positive(parentId);
            let ancestor = parentId,
                domestic = false;
            for (let i = 0; i < 20 && ancestor; i++) {
                if (ancestor === id) throw new Error('父级调整会形成循环');
                const [[p]]: any = await db.execute(
                    'SELECT id,parent_id,name_cn,level_type FROM region WHERE id=?',
                    [ancestor],
                );
                if (!p) throw new Error('父节点不存在');
                if (p.name_cn === '中国' && p.level_type < 300) {
                    domestic = true;
                    break;
                }
                ancestor = p.parent_id;
            }
            if (!domestic)
                throw new Error('当前修改入口仅支持中国区划(scope=2)');
            // 调整父级时还须确认原节点也属于中国，防止把海外数据混入国内日志。
            if (old) {
                let a = old.parent_id,
                    found = false;
                for (let i = 0; i < 20 && a; i++) {
                    const [[p]]: any = await db.execute(
                        'SELECT parent_id,name_cn,level_type FROM region WHERE id=?',
                        [a],
                    );
                    if (!p) break;
                    if (p.name_cn === '中国' && p.level_type < 300) {
                        found = true;
                        break;
                    }
                    a = p.parent_id;
                }
                if (!found) throw new Error('原节点不属于中国区划');
            }
            let descendants: any[] = [];
            if (id) {
                const [rows]: any = await db.execute(
                    'WITH RECURSIVE tree AS (SELECT id,parent_id FROM region WHERE id=? UNION ALL SELECT r.id,r.parent_id FROM region r JOIN tree ON r.parent_id=tree.id) SELECT * FROM tree',
                    [id],
                );
                descendants = rows;
            }
            if (
                input.action === 'delete' &&
                descendants.length > 1 &&
                input.cascade !== true
            )
                throw new Error('存在子节点，删除整个子树需显式 cascade=true');
            const ids = [
                ...new Set<number>([
                    parentId,
                    ...(old?.parent_id ? [old.parent_id] : []),
                    ...descendants.map((r) => r.id),
                ]),
            ];
            await capture(db, ids);
            if (input.action === 'create') {
                if (!fields.code || !fields.name_cn || !fields.level_type)
                    throw new Error(
                        '新增必须提供code、name_cn、level_type和parent_id',
                    );
                const [[parent]]: any = await db.execute(
                    'SELECT depth FROM region WHERE id=?',
                    [parentId],
                );
                const keys = Object.keys(fields);
                const [r]: any = await db.execute(
                    `INSERT INTO region(${keys.map((k) => `\`${k}\``).join(',')},depth,has_children) VALUES(${keys.map(() => '?').join(',')},?,0)`,
                    [...keys.map((k) => fields[k]), Number(parent.depth) + 1],
                );
                id = r.insertId;
                await db.execute('INSERT IGNORE INTO audit_scope VALUES(?)', [
                    id,
                ]);
            } else if (input.action === 'update') {
                const keys = Object.keys(fields);
                if (keys.length)
                    await db.execute(
                        `UPDATE region SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`,
                        [...keys.map((k) => fields[k]), id],
                    );
            } else {
                const deleted = descendants.map((r) => r.id);
                for (let i = 0; i < deleted.length; i += 1000)
                    for (const table of [
                        'region_search',
                        'region_detail',
                        'region',
                    ])
                        await db.query(
                            `DELETE FROM ${table} WHERE ${TABLES[table as keyof typeof TABLES][0]} IN (?)`,
                            [deleted.slice(i, i + 1000)],
                        );
            }
            if (input.action !== 'delete' && detail !== undefined) {
                if (detail === null)
                    await db.execute(
                        'DELETE FROM region_detail WHERE region_id=?',
                        [id],
                    );
                else if (Object.keys(detail).length) {
                    const keys = Object.keys(detail);
                    await db.execute(
                        `INSERT INTO region_detail(region_id,${keys.map((k) => `\`${k}\``).join(',')}) VALUES(?,${keys.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE ${keys.map((k) => `\`${k}\`=VALUES(\`${k}\`)`).join(',')}`,
                        [id, ...keys.map((k) => detail[k])],
                    );
                }
            }
            for (let i = 0; i < 20; i++) {
                const [r]: any = await db.query(
                    'UPDATE region c JOIN audit_scope s ON s.id=c.id JOIN region p ON p.id=c.parent_id SET c.depth=p.depth+1 WHERE c.depth<>p.depth+1',
                );
                if (!r.affectedRows) break;
                if (i === 19) throw new Error('层级深度未收敛');
            }
            await db.query('DROP TEMPORARY TABLE IF EXISTS audit_parents');
            await db.query(
                'CREATE TEMPORARY TABLE audit_parents (id INT UNSIGNED PRIMARY KEY)',
            );
            await db.query(
                'INSERT IGNORE INTO audit_parents SELECT r.parent_id FROM region r JOIN audit_scope s ON s.id=r.parent_id',
            );
            await db.query(
                'UPDATE region r JOIN audit_scope s ON s.id=r.id LEFT JOIN audit_parents p ON p.id=r.id SET r.has_children=(p.id IS NOT NULL)',
            );
            await db.query(
                "INSERT INTO region_search(region_id,parent_id,search_text) SELECT r.id,r.parent_id,CONCAT_WS(' ',r.name_cn,r.name_en,r.name_local,r.name_pinyin,r.name_jianpin,r.code) FROM region r JOIN audit_scope s ON s.id=r.id ON DUPLICATE KEY UPDATE parent_id=VALUES(parent_id),search_text=VALUES(search_text)",
            );
            return {
                id,
                ...(await record(
                    db,
                    'manual',
                    input.reason.trim(),
                    null,
                    true,
                )),
            };
        });
    }
}
