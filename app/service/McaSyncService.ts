import { planRemoteCodes } from './RemoteCodePlan';
import {
    HISTORY_SCHEMA,
    capture,
    record,
    registerAuto,
    assertClean,
} from './DataHistoryService';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, PoolConnection } from 'mysql2/promise';

export const SYNC_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS region_sync_job (
        version INT UNSIGNED PRIMARY KEY, source_year INT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'fetching',
        total INT NOT NULL DEFAULT 1, completed INT NOT NULL DEFAULT 0,
        current_code VARCHAR(12), attempts INT NOT NULL DEFAULT 0,
        last_error TEXT, summary JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS region_sync_branch (
        version INT UNSIGNED NOT NULL, code VARCHAR(12) NOT NULL,
        payload JSON NOT NULL, PRIMARY KEY(version,code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS region_sync_conflict (
        version INT UNSIGNED NOT NULL, code VARCHAR(32) NOT NULL,
        kind VARCHAR(32) NOT NULL, detail JSON NOT NULL, fingerprint CHAR(64) NOT NULL,
        active TINYINT NOT NULL DEFAULT 1, resolution VARCHAR(20), resolved_at TIMESTAMP NULL,
        PRIMARY KEY(version,code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS region_sync_code_map (
        version INT UNSIGNED NOT NULL, code VARCHAR(9) NOT NULL, target_code VARCHAR(9) NOT NULL,
        PRIMARY KEY(version,code), UNIQUE KEY target_idx(version,target_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS region_sync_policy (
        version INT UNSIGNED PRIMARY KEY, mode VARCHAR(24) NOT NULL,
        accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

interface Node {
    code: string;
    name: string;
    level: number;
    type: string;
    children: Node[];
}
interface Row {
    code: string;
    parent: string | null;
    name: string;
    level_type: number;
    level: number;
    preserve_children: boolean;
}
const MAINLAND =
    '11 12 13 14 15 21 22 23 31 32 33 34 35 36 37 41 42 43 44 45 46 50 51 52 53 54 61 62 63 64 65'.split(
        ' ',
    );
const TYPES: Record<number, Record<string, number>> = {
    1: { 省: 310, 自治区: 320, 直辖市: 410 },
    2: { 地级市: 510, 地区: 520, 自治州: 530, 盟: 540 },
    3: {
        县级市: 610,
        市辖区: 610,
        县: 620,
        自治县: 630,
        旗: 640,
        自治旗: 650,
        特区: 660,
        林区: 670,
    },
    4: {
        镇: 710,
        乡: 720,
        民族乡: 730,
        苏木: 740,
        民族苏木: 750,
        街道: 760,
        区公所: 770,
        兵团: 780,
    },
};

export function dueVersion(now = new Date()): number | null {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);
    const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (`${p.month}${p.day}${p.hour}` < '011002') return null;
    return Number(`${p.year}0110`);
}

export function validateTree(payload: any, code: string): Node {
    const root: Node = payload?.data;
    if (
        payload?.status !== 200 ||
        !root ||
        Array.isArray(root) ||
        root.code !== code
    ) {
        throw new Error(`接口响应异常或根代码不匹配: ${code}`);
    }
    const seen = new Set<string>();
    function visit(n: Node, parentLevel: number) {
        // 港澳台不在本次省地县乡同步范围。
        if (
            n?.level === 1 &&
            (n.code === '资料暂缺' || /^(71|81|82)/.test(n.code))
        )
            return;
        if (
            !n ||
            seen.has(n.code) ||
            !Array.isArray(n.children) ||
            !Number.isInteger(n.level) ||
            n.level <= parentLevel ||
            n.level > 4
        )
            throw new Error(`区划树结构异常: ${code}`);
        seen.add(n.code);
        if (
            n.level !== 0 &&
            (!/^\d{12}$/.test(n.code) || !n.name || !TYPES[n.level]?.[n.type])
        )
            throw new Error(`未知代码或类型: ${n.code} ${n.type}`);
        for (const child of n.children) visit(child, n.level);
    }
    visit(root, -1);
    if (code === '00') {
        const provinces = root.children.filter((n) =>
            MAINLAND.includes(n.code.slice(0, 2)),
        );
        if (
            provinces.length !== 31 ||
            new Set(provinces.map((n) => n.code.slice(0, 2))).size !== 31 ||
            provinces.some((n) => n.level !== 1)
        )
            throw new Error('全国响应不完整，必须包含大陆31省级分支');
    }
    return root;
}

export function branchCodes(root: Node): string[] {
    return root.children
        .filter((n) => MAINLAND.includes(n.code.slice(0, 2)))
        .flatMap((n) => n.children.map((c) => c.code));
}

export function snapshotRows(root: Node, branches: Map<string, Node>): Row[] {
    const rows = new Map<string, Row>();
    function visit(node: Node, parent: string | null) {
        const n = branches.get(node.code) || node;
        if (
            n.level !== node.level ||
            n.name !== node.name ||
            n.type !== node.type
        )
            throw new Error(`抓取期间区划发生变化: ${node.code}`);
        const length = n.level === 4 ? 9 : 6;
        if (!/^0*$/.test(n.code.slice(length)))
            throw new Error(`代码后缀异常: ${n.code}`);
        const code = n.code.slice(0, length);
        if (rows.has(code)) throw new Error(`重复区划代码: ${code}`);
        rows.set(code, {
            code,
            parent,
            name: n.name,
            level: n.level,
            level_type: TYPES[n.level][n.type],
            preserve_children: n.children.length === 0,
        });
        for (const child of n.children) visit(child, code);
    }
    for (const code of branchCodes(root))
        if (!branches.has(code)) throw new Error(`缺少分支: ${code}`);
    for (const province of root.children)
        if (MAINLAND.includes(province.code.slice(0, 2))) visit(province, null);
    return [...rows.values()];
}

export async function requestTree(code: string, year: number): Promise<Node> {
    const url = new URL('https://dmfw.mca.gov.cn/9095/xzqh/getList');
    url.searchParams.set('year', String(year));
    url.searchParams.set('maxLevel', '2');
    // 全国默认请求返回省级及地级/直属县级节点。
    if (code !== '00') url.searchParams.set('code', code);
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
        throw new Error(`民政部 HTTP ${response.status}: ${code}`);
    return validateTree(await response.json(), code);
}

export class McaSyncService {
    private running = false;
    constructor(
        private pool: Pool,
        private fetchTree = requestTree,
        private intervalMs = 2000,
    ) {}

    async setup() {
        for (const sql of [...SYNC_SCHEMA, ...HISTORY_SCHEMA])
            await this.pool.query(sql);
    }
    async status() {
        const [versions] = await this.pool.query(
            'SELECT * FROM data_version ORDER BY scope',
        );
        const [jobs] = await this.pool.query(
            'SELECT * FROM region_sync_job ORDER BY version DESC LIMIT 10',
        );
        return { versions, jobs };
    }

    async run(now = new Date(), immediate = false) {
        if (this.running) return;
        this.running = true;
        let db: PoolConnection;
        let version: number;
        let locked = false;
        try {
            db = await this.pool.getConnection();
            const [[lock]]: any = await db.query(
                "SELECT GET_LOCK('region-data-patch',0) AS acquired",
            );
            if (Number(lock.acquired) !== 1) return;
            locked = true;
            const [[pending]]: any = await db.query(
                "SELECT * FROM region_sync_job WHERE status <> 'completed' ORDER BY version LIMIT 1",
            );
            if (pending?.status === 'conflicts') return;
            const [[current]]: any = await db.query(
                'SELECT version FROM data_version WHERE scope=2',
            );
            const currentNumber = Number(current?.version || 0);
            const currentDate =
                currentNumber > 99999999
                    ? Math.floor(currentNumber / 100)
                    : currentNumber;
            const today = Number(
                new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'Asia/Shanghai',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                })
                    .format(now)
                    .replaceAll('-', ''),
            );
            const scheduled = dueVersion(now);
            version =
                pending?.version ||
                (immediate
                    ? Math.max(
                          today * 100,
                          currentNumber > 99999999
                              ? currentNumber + 1
                              : currentNumber * 100 + 1,
                      )
                    : scheduled);
            if (!pending && immediate) {
                const [[latestJob]]: any = await db.query(
                    'SELECT MAX(version) AS version FROM region_sync_job',
                );
                version = Math.max(version, Number(latestJob.version || 0) + 1);
            }
            if (!version) return;
            if (!pending && !immediate && currentDate >= scheduled) return;
            // 保持与已有YYYYMMDDNN版本一致，年度任务序号从00开始。
            if (!pending && !immediate) version *= 100;
            const [[knownJob]]: any = await db.execute(
                'SELECT status FROM region_sync_job WHERE version=?',
                [version],
            );
            if (knownJob?.status === 'completed') return;
            const year =
                pending?.source_year ||
                Math.floor(today / 10000) - (immediate ? 0 : 1);
            await db.execute(
                'INSERT IGNORE INTO region_sync_job(version,source_year) VALUES(?,?)',
                [version, year],
            );
            await db.execute(
                "UPDATE region_sync_job SET status='fetching',attempts=attempts+1,last_error=NULL WHERE version=?",
                [version],
            );
            const [saved]: any = await db.execute(
                'SELECT code,payload FROM region_sync_branch WHERE version=?',
                [version],
            );
            const trees = new Map<string, Node>(
                saved.map((r: any) => [
                    r.code,
                    typeof r.payload === 'string'
                        ? JSON.parse(r.payload)
                        : r.payload,
                ]),
            );
            let lastRequest = 0;
            const fetchBranch = async (code: string) => {
                if (trees.has(code)) return trees.get(code);
                await db.execute(
                    'UPDATE region_sync_job SET current_code=? WHERE version=?',
                    [code, version],
                );
                await delay(
                    Math.max(0, this.intervalMs - (Date.now() - lastRequest)),
                );
                lastRequest = Date.now();
                const tree = await this.fetchTree(code, year);
                await db.beginTransaction();
                try {
                    await db.execute(
                        'INSERT INTO region_sync_branch(version,code,payload) VALUES(?,?,?)',
                        [version, code, JSON.stringify(tree)],
                    );
                    await db.execute(
                        'UPDATE region_sync_job SET completed=completed+1 WHERE version=?',
                        [version],
                    );
                    await db.commit();
                } catch (error) {
                    await db.rollback();
                    throw error;
                }
                trees.set(code, tree);
                return tree;
            };
            const root = await fetchBranch('00');
            const codes = branchCodes(root);
            await db.execute(
                'UPDATE region_sync_job SET total=? WHERE version=?',
                [codes.length + 1, version],
            );
            for (const code of codes) await fetchBranch(code);
            const rows = snapshotRows(root, trees);
            await db.execute(
                "UPDATE region_sync_job SET status='applying',current_code=NULL WHERE version=?",
                [version],
            );
            await this.apply(db, rows, version);
        } catch (error) {
            if (db && version && locked) {
                await db.rollback();
                await db.execute(
                    "UPDATE region_sync_job SET status='failed',last_error=? WHERE version=?",
                    [String(error.message).slice(0, 10000), version],
                );
            }
            throw error;
        } finally {
            if (db) {
                try {
                    if (locked)
                        await db.query(
                            "SELECT RELEASE_LOCK('region-data-patch')",
                        );
                } finally {
                    db.release();
                }
            }
            this.running = false;
        }
    }

    async preferRemote(version: number) {
        this.validVersion(version);
        const db = await this.pool.getConnection();
        let locked = false;
        try {
            const [[lock]]: any = await db.query(
                "SELECT GET_LOCK('region-data-patch',0) AS acquired",
            );
            if (Number(lock.acquired) !== 1) throw new Error('同步任务正在运行');
            locked = true;
            await db.beginTransaction();
            const [[job]]: any = await db.execute(
                'SELECT status,total,completed FROM region_sync_job WHERE version=? FOR UPDATE',
                [version],
            );
            if (
                !job ||
                job.status === 'completed' ||
                job.completed !== job.total
            )
                throw new Error('仅支持已抓取完成、尚未发布的任务');
            await assertClean(db);
            await db.execute(
                "INSERT INTO region_sync_policy(version,mode) VALUES(?,'prefer_remote') ON DUPLICATE KEY UPDATE mode=VALUES(mode),accepted_at=CURRENT_TIMESTAMP",
                [version],
            );
            await db.execute(
                "UPDATE region_sync_job SET status='fetching',last_error=NULL WHERE version=?",
                [version],
            );
            await db.commit();
            return { version, ready: true };
        } catch (error) {
            await db.rollback();
            throw error;
        } finally {
            try {
                if (locked)
                    await db.query("SELECT RELEASE_LOCK('region-data-patch')");
            } finally {
                db.release();
            }
        }
    }

    async conflicts(version: number) {
        this.validVersion(version);
        const [rows]: any = await this.pool.execute(
            'SELECT c.code,c.kind,c.detail,c.fingerprint,c.resolution,c.resolved_at,m.target_code FROM region_sync_conflict c LEFT JOIN region_sync_code_map m ON m.version=c.version AND m.code=c.code WHERE c.version=? AND c.active=1 ORDER BY c.code',
            [version],
        );
        const result = rows.map((r: any) => ({
            ...r,
            detail:
                typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
        }));
        // 整版策略覆盖逐条决定后，使用发布日志中的最终编号，不能显示旧映射。
        if (result.some((r: any) => r.resolution === 'prefer_remote')) {
            const [[job]]: any = await this.pool.execute(
                'SELECT summary FROM region_sync_job WHERE version=?',
                [version],
            );
            const summary =
                typeof job?.summary === 'string'
                    ? JSON.parse(job.summary)
                    : job?.summary;
            const [changes]: any = await this.pool.execute(
                "SELECT row_id,JSON_UNQUOTE(JSON_EXTRACT(after_data,'$.code')) AS code FROM region_change_log WHERE release_version=? AND table_name='region' ORDER BY id",
                [summary?.published_version || version],
            );
            const finalCodes = new Map(
                changes.map((r: any) => [Number(r.row_id), r.code]),
            );
            for (const r of result)
                if (r.resolution === 'prefer_remote')
                    r.target_code =
                        finalCodes.get(Number(r.detail.local.id)) ?? r.code;
        }
        return result;
    }

    private validVersion(version: number) {
        if (!Number.isInteger(version) || version < 1 || version > 4294967295)
            throw new Error('版本号错误');
    }

    async resolve(
        version: number,
        resolutions: {
            code: string;
            action: string;
            fingerprint: string;
            target_code?: string;
        }[],
    ) {
        this.validVersion(version);
        if (
            !Array.isArray(resolutions) ||
            !resolutions.length ||
            resolutions.length > 1000 ||
            new Set(resolutions.map((r) => r?.code)).size !==
                resolutions.length ||
            resolutions.some(
                (r) =>
                    !r ||
                    !/^\d{6}(\d{3})?$/.test(r.code) ||
                    !['keep_local', 'delete_local', 'replace_code'].includes(
                        r.action,
                    ) ||
                    !/^[a-f0-9]{64}$/.test(r.fingerprint) ||
                    (r.action === 'replace_code' &&
                        (!/^\d{6}(\d{3})?$/.test(r.target_code || '') ||
                            r.target_code === r.code)),
            )
        ) {
            throw new Error('冲突处理参数错误：每批1-1000条，不允许重复code');
        }
        const db = await this.pool.getConnection();
        let locked = false;
        try {
            const [[lock]]: any = await db.query(
                "SELECT GET_LOCK('region-data-patch',0) AS acquired",
            );
            if (Number(lock.acquired) !== 1)
                throw new Error('同步任务正在运行，请稍后重试');
            locked = true;
            await db.beginTransaction();
            const [[job]]: any = await db.execute(
                'SELECT status FROM region_sync_job WHERE version=? FOR UPDATE',
                [version],
            );
            if (!job || !['conflicts', 'completed'].includes(job.status))
                throw new Error('任务不处于待解决冲突状态');
            for (const item of resolutions) {
                const [[conflict]]: any = await db.execute(
                    'SELECT * FROM region_sync_conflict WHERE version=? AND code=? AND active=1',
                    [version, item.code],
                );
                if (!conflict || conflict.fingerprint !== item.fingerprint)
                    throw new Error(
                        `冲突已变化或不存在，请重新获取: ${item.code}`,
                    );
                if (conflict.resolution) {
                    if (conflict.resolution !== item.action)
                        throw new Error(`冲突已选择其他方案: ${item.code}`);
                    if (item.action === 'replace_code') {
                        const [[mapping]]: any = await db.execute(
                            'SELECT target_code FROM region_sync_code_map WHERE version=? AND code=?',
                            [version, item.code],
                        );
                        if (mapping?.target_code !== item.target_code)
                            throw new Error('冲突已选择其他换码目标');
                    }
                    continue;
                }
                if (item.action === 'replace_code') {
                    const detail =
                        typeof conflict.detail === 'string'
                            ? JSON.parse(conflict.detail)
                            : conflict.detail;
                    const [[parent]]: any = await db.execute(
                        'SELECT p.code FROM region r JOIN region p ON p.id=r.parent_id WHERE r.code=?',
                        [item.code],
                    );
                    if (
                        !detail.remote_candidates.some(
                            (r: any) =>
                                r.code === item.target_code &&
                                r.parent === parent?.code,
                        )
                    )
                        throw new Error('换码目标必须是同父级的同名接口候选');
                    const [[occupied]]: any = await db.execute(
                        'SELECT id FROM region WHERE code=?',
                        [item.target_code],
                    );
                    if (occupied && job.status !== 'completed')
                        throw new Error(
                            `目标代码已被占用，不能覆盖: ${item.target_code}`,
                        );
                    const [[savedMap]]: any = await db.execute(
                        'SELECT target_code FROM region_sync_code_map WHERE version=? AND code=?',
                        [version, item.code],
                    );
                    if (savedMap && savedMap.target_code !== item.target_code)
                        throw new Error('冲突已选择其他换码目标');
                    await db.execute(
                        'INSERT IGNORE INTO region_sync_code_map(version,code,target_code) VALUES(?,?,?)',
                        [version, item.code, item.target_code],
                    );
                    const [[stored]]: any = await db.execute(
                        'SELECT target_code FROM region_sync_code_map WHERE version=? AND code=?',
                        [version, item.code],
                    );
                    if (!stored || stored.target_code !== item.target_code)
                        throw new Error('多个本地节点选择同一目标代码');
                }
                if (job.status === 'completed')
                    throw new Error('已发布版本不能修改');
                await db.execute(
                    'UPDATE region_sync_conflict SET resolution=?,resolved_at=CURRENT_TIMESTAMP WHERE version=? AND code=?',
                    [item.action, version, item.code],
                );
            }
            const [[count]]: any = await db.execute(
                'SELECT COUNT(*) AS n FROM region_sync_conflict WHERE version=? AND active=1 AND resolution IS NULL',
                [version],
            );
            const ready = Number(count.n) === 0 && job.status !== 'completed';
            if (job.status !== 'completed')
                await db.execute(
                    "UPDATE region_sync_job SET summary=JSON_SET(COALESCE(summary,JSON_OBJECT()),'$.pending',?) WHERE version=?",
                    [Number(count.n), version],
                );
            if (ready)
                await db.execute(
                    "UPDATE region_sync_job SET status='fetching',last_error=NULL WHERE version=?",
                    [version],
                );
            await db.commit();
            return { version, pending: Number(count.n), ready };
        } catch (error) {
            await db.rollback();
            throw error;
        } finally {
            try {
                if (locked)
                    await db.query("SELECT RELEASE_LOCK('region-data-patch')");
            } finally {
                db.release();
            }
        }
    }

    private async descendants(
        db: PoolConnection,
        roots: number[],
    ): Promise<any[]> {
        if (!roots.length) return [];
        const [rows]: any = await db.query(
            `WITH RECURSIVE tree AS (
            SELECT id AS owner,id,code,parent_id,name_cn,level_type,depth FROM region WHERE id IN (?)
            UNION ALL SELECT tree.owner,r.id,r.code,r.parent_id,r.name_cn,r.level_type,r.depth
            FROM region r JOIN tree ON r.parent_id=tree.id
        ) SELECT * FROM tree`,
            [roots],
        );
        return rows;
    }

    private async collectConflicts(
        db: PoolConnection,
        existing: any[],
        rows: Row[],
        protectedIds: Set<number>,
        version: number,
    ) {
        const remote = new Set(rows.map((row) => row.code));
        const missing = existing.filter(
            (r) => !remote.has(r.code) && !protectedIds.has(r.id),
        );
        const missingIds = new Set(missing.map((r) => r.id));
        const byId = new Map(existing.map((r) => [r.id, r]));
        const roots = missing.filter((r) => {
            const seen = new Set<number>();
            let parent = r.parent_id;
            while (byId.has(parent)) {
                if (missingIds.has(parent)) return false;
                if (seen.has(parent)) throw new Error('本地父子关系存在循环');
                seen.add(parent);
                parent = byId.get(parent).parent_id;
            }
            return true;
        });
        const descendants = await this.descendants(
            db,
            roots.map((r) => r.id),
        );
        const groups = new Map<number, any[]>();
        for (const r of descendants) {
            if (!groups.has(r.owner)) groups.set(r.owner, []);
            groups.get(r.owner).push(r);
        }
        await db.execute(
            'UPDATE region_sync_conflict SET active=0 WHERE version=?',
            [version],
        );
        const keepIds = new Set<number>();
        const deleteRoots: number[] = [];
        const codeMaps: { id: number; code: string; target: string }[] = [];
        let pending = 0;
        for (const root of roots) {
            const subtree = groups.get(root.id).sort((a, b) => a.id - b.id);
            const candidates = rows
                .filter((r) => r.name === root.name_cn)
                .map((r) => ({ code: r.code, name: r.name, parent: r.parent }));
            const detail = {
                description: `本地“${root.name_cn}”(${root.code})未出现在接口快照中，可能是代码变更、撤销或来源覆盖差异。`,
                local: root,
                subtree_nodes: subtree.length,
                descendant_nodes: subtree.length - 1,
                remote_candidates: candidates,
                options: [
                    {
                        action: 'keep_local',
                        description:
                            '保留本节点及本地后代，远端同名新代码仍作为独立节点；不自动认定为同一区划。',
                    },
                    {
                        action: 'replace_code',
                        description:
                            '采用同父级同名候选的接口代码，保留内部ID和后代代码；目标被占用时禁止覆盖。',
                    },
                    {
                        action: 'delete_local',
                        description:
                            '删除本节点及仍隶属于它的全部后代（含村/社区）、搜索及详情；远端仍存在并已迁出的节点保留。',
                    },
                ],
            };
            const fingerprint = createHash('sha256')
                .update(JSON.stringify({ subtree, candidates }))
                .digest('hex');
            await db.execute(
                `INSERT INTO region_sync_conflict(version,code,kind,detail,fingerprint,active) VALUES(?,?,'missing_remote',?,?,1)
                ON DUPLICATE KEY UPDATE active=1,detail=VALUES(detail),
                resolution=IF(fingerprint=VALUES(fingerprint),resolution,NULL),
                resolved_at=IF(fingerprint=VALUES(fingerprint),resolved_at,NULL),fingerprint=VALUES(fingerprint)`,
                [version, root.code, JSON.stringify(detail), fingerprint],
            );
            const [[decision]]: any = await db.execute(
                'SELECT c.resolution,m.target_code FROM region_sync_conflict c LEFT JOIN region_sync_code_map m ON m.version=c.version AND m.code=c.code WHERE c.version=? AND c.code=?',
                [version, root.code],
            );
            if (decision.resolution === 'keep_local')
                for (const r of subtree) keepIds.add(r.id);
            else if (
                decision.resolution === 'replace_code' &&
                decision.target_code
            ) {
                codeMaps.push({
                    id: root.id,
                    code: root.code,
                    target: decision.target_code,
                });
                for (const r of subtree)
                    if (r.id !== root.id) keepIds.add(r.id);
            } else if (decision.resolution === 'delete_local')
                deleteRoots.push(root.id);
            else {
                if (decision.target_code)
                    await db.execute(
                        'DELETE FROM region_sync_code_map WHERE version=? AND code=?',
                        [version, root.code],
                    );
                pending++;
            }
        }
        if (pending)
            await db.execute(
                "UPDATE region_sync_job SET status='conflicts',last_error=NULL,summary=? WHERE version=?",
                [
                    JSON.stringify({
                        conflicts: roots.length,
                        pending,
                        message: '等待人工选择保留本地或删除本地子树',
                    }),
                    version,
                ],
            );
        return { pending, keepIds, deleteRoots, codeMaps, count: roots.length };
    }

    async apply(db: PoolConnection, rows: Row[], version: number) {
        await db.beginTransaction();
        try {
            const [[country]]: any = await db.query(
                "SELECT id,depth FROM region WHERE name_cn='中国' AND level_type < 300",
            );
            if (!country) throw new Error('找不到中国根节点');
            const [existing]: any = await db.query(
                `WITH RECURSIVE cn AS (
                    SELECT id,code,parent_id,depth,level_type,name_cn FROM region
                    WHERE parent_id=? AND code IN (?)
                    UNION ALL
                    SELECT r.id,r.code,r.parent_id,r.depth,r.level_type,r.name_cn
                    FROM region r JOIN cn ON r.parent_id=cn.id
                    WHERE r.level_type BETWEEN 300 AND 799
                ) SELECT * FROM cn`,
                [country.id, MAINLAND.map((prefix) => `${prefix}0000`)],
            );
            const local = new Map<string, any>(
                existing.map((r: any) => [r.code, r]),
            );
            const desired = new Set(rows.map((r) => r.code));
            // 空数组表示来源未提供下级，按本地父子关系保护整棵后代树。
            const emptyCodes = new Set(
                rows
                    .filter((row) => row.preserve_children)
                    .map((row) => row.code),
            );
            const protectedIds = new Set<number>(
                existing
                    .filter(
                        (r: any) =>
                            emptyCodes.has(r.code) ||
                            r.code.startsWith('local:'),
                    )
                    .map((r: any) => r.id),
            );
            for (let i = 0; i < 4; i++)
                for (const r of existing)
                    if (protectedIds.has(r.parent_id)) protectedIds.add(r.id);

            const [[policy]]: any = await db.execute(
                'SELECT mode FROM region_sync_policy WHERE version=?',
                [version],
            );
            const preferred = policy?.mode === 'prefer_remote';
            const [[conflictCount]]: any = preferred
                ? await db.execute(
                      'SELECT COUNT(*) AS total FROM region_sync_conflict WHERE version=? AND active=1',
                      [version],
                  )
                : [[{ total: 0 }]];

            const plan = preferred
                ? planRemoteCodes(existing, rows, country.id)
                : null;
            const decisions = preferred
                ? {
                      pending: 0,
                      keepIds: plan.keepIds,
                      deleteRoots: [] as number[],
                      codeMaps: plan.codeMaps,
                      count: Number(conflictCount.total),
                  }
                : await this.collectConflicts(
                      db,
                      existing,
                      rows,
                      protectedIds,
                      version,
                  );
            if (decisions.pending) {
                await db.commit();
                return;
            }
            await assertClean(db);
            await capture(db);
            const movingIds = new Set(decisions.codeMaps.map((m) => m.id));
            const originals = new Map(
                decisions.codeMaps.map((m) => [m.id, local.get(m.code)]),
            );
            for (const mapping of decisions.codeMaps) {
                const occupant = local.get(mapping.target);
                if (occupant && !movingIds.has(occupant.id))
                    throw new Error(`换码目标未迁出: ${mapping.target}`);
                const original = originals.get(mapping.id);
                const target = rows.find((r) => r.code === mapping.target);
                if (
                    !original ||
                    (!preferred &&
                        (!target || original.name_cn !== target.name))
                )
                    throw new Error('换码对应关系已变化');
                const [result]: any = await db.execute(
                    'UPDATE region SET code=? WHERE id=? AND code=?',
                    [
                        `~sync:${version}:${mapping.id}`,
                        mapping.id,
                        mapping.code,
                    ],
                );
                if (result.affectedRows !== 1)
                    throw new Error('换码节点已变化');
                local.delete(mapping.code);
            }
            for (const mapping of decisions.codeMaps) {
                await db.execute('UPDATE region SET code=? WHERE id=?', [
                    mapping.target,
                    mapping.id,
                ]);
                local.set(mapping.target, {
                    ...originals.get(mapping.id),
                    code: mapping.target,
                });
            }
            let added = 0,
                changed = 0,
                removed = 0;
            for (const row of rows) {
                const parent = row.parent ? local.get(row.parent) : country;
                if (!parent) throw new Error(`父节点缺失: ${row.code}`);
                const previous = local.get(row.code);
                const depth = Number(parent.depth) + 1;
                if (previous) {
                    if (decisions.keepIds.has(previous.id)) continue;
                    if (
                        previous.name_cn !== row.name ||
                        previous.parent_id !== parent.id ||
                        previous.level_type !== row.level_type ||
                        previous.depth !== depth
                    ) {
                        await db.execute(
                            'UPDATE region SET name_cn=?,parent_id=?,level_type=?,depth=? WHERE id=?',
                            [
                                row.name,
                                parent.id,
                                row.level_type,
                                depth,
                                previous.id,
                            ],
                        );
                        changed++;
                    }
                    local.set(row.code, {
                        ...previous,
                        parent_id: parent.id,
                        depth,
                    });
                } else {
                    const [result]: any = await db.execute(
                        'INSERT INTO region(code,name_cn,parent_id,level_type,depth,has_children) VALUES(?,?,?,?,?,0)',
                        [row.code, row.name, parent.id, row.level_type, depth],
                    );
                    local.set(row.code, { id: result.insertId, depth });
                    added++;
                }
            }
            // 远端仍存在的节点已先迁移到新父级；仅删除用户选择的剩余本地子树。
            if (decisions.deleteRoots.length) {
                const deleting = await this.descendants(
                    db,
                    decisions.deleteRoots,
                );
                const remoteIds = new Set(
                    rows.map((row) => local.get(row.code).id),
                );
                if (
                    deleting.some(
                        (r: any) =>
                            remoteIds.has(r.id) || decisions.keepIds.has(r.id),
                    )
                ) {
                    throw new Error(
                        '删除范围与保留/远端节点重叠，需重新检查冲突',
                    );
                }
                for (let offset = 0; offset < deleting.length; offset += 1000) {
                    const ids = deleting
                        .slice(offset, offset + 1000)
                        .map((r: any) => r.id);
                    await db.query(
                        'DELETE FROM region_search WHERE region_id IN (?)',
                        [ids],
                    );
                    await db.query(
                        'DELETE FROM region_detail WHERE region_id IN (?)',
                        [ids],
                    );
                    await db.query('DELETE FROM region WHERE id IN (?)', [ids]);
                }
                removed = deleting.length;
            }
            // MySQL 不允许 UPDATE 中直接自查询同一表，用临时表保存父节点集合。
            await db.query('DROP TEMPORARY TABLE IF EXISTS sync_node_ids');
            await db.query(
                'CREATE TEMPORARY TABLE sync_node_ids (id INT UNSIGNED PRIMARY KEY)',
            );
            const ids = [
                country.id,
                ...rows.map((row) => local.get(row.code).id),
                ...decisions.keepIds,
            ];
            for (let offset = 0; offset < ids.length; offset += 1000) {
                await db.query(
                    'INSERT IGNORE INTO sync_node_ids(id) VALUES ?',
                    [ids.slice(offset, offset + 1000).map((id) => [id])],
                );
            }
            await db.query(
                "INSERT INTO region_search(region_id,parent_id,search_text) SELECT r.id,r.parent_id,CONCAT_WS(' ',r.name_cn,r.name_en,r.name_local,r.name_pinyin,r.name_jianpin,r.code) FROM region r JOIN sync_node_ids scope ON scope.id=r.id ON DUPLICATE KEY UPDATE parent_id=VALUES(parent_id),search_text=VALUES(search_text)",
            );
            await db.query('DROP TEMPORARY TABLE IF EXISTS sync_parent_ids');
            await db.query(
                'CREATE TEMPORARY TABLE sync_parent_ids (id INT UNSIGNED PRIMARY KEY)',
            );
            await db.query(
                'INSERT IGNORE INTO sync_parent_ids SELECT parent_id FROM region WHERE parent_id IS NOT NULL',
            );
            await db.query(
                'UPDATE region r JOIN sync_node_ids scope ON scope.id=r.id LEFT JOIN sync_parent_ids p ON p.id=r.id SET r.has_children=(p.id IS NOT NULL)',
            );
            // 上级深度变化时同步村级等后代深度，内部ID和村级代码保持不变。
            for (let i = 0; i < 10; i++) {
                const [result]: any = await db.query(
                    'UPDATE region child JOIN region parent ON parent.id=child.parent_id JOIN sync_node_ids scope ON scope.id=parent.id SET child.depth=parent.depth+1 WHERE child.depth<>parent.depth+1',
                );
                if (!result.affectedRows) break;
                if (i === 9) throw new Error('层级深度未收敛');
            }
            if (preferred) {
                await db.execute(
                    "UPDATE region_sync_conflict SET resolution='prefer_remote',resolved_at=CURRENT_TIMESTAMP,detail=JSON_SET(detail,'$.applied_policy','接口编号优先；未匹配本地节点保留') WHERE version=? AND active=1",
                    [version],
                );
            }
            const checksum = createHash('sha256')
                .update(
                    JSON.stringify(
                        [...rows].sort((a, b) => a.code.localeCompare(b.code)),
                    ),
                )
                .digest('hex');
            const publishedVersion = await registerAuto(
                db,
                version,
                `民政部同步任务 ${version}`,
                checksum,
            );
            await record(
                db,
                'mca',
                `民政部同步任务 ${version}`,
                publishedVersion,
            );
            await db.execute(
                'INSERT INTO data_version(scope,version,checksum) VALUES(2,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),checksum=VALUES(checksum)',
                [publishedVersion, checksum],
            );
            await db.execute(
                "UPDATE region_sync_job SET status='completed',last_error=NULL,current_code=NULL,summary=? WHERE version=?",
                [
                    JSON.stringify({
                        published_version: publishedVersion,
                        remapped_codes: decisions.codeMaps.length,
                        code_policy: preferred ? 'prefer_remote' : 'individual',
                        local_extension_codes: plan?.localAliases.length || 0,
                        pending: 0,
                        added,
                        changed,
                        removed,
                        nodes: rows.length,
                        conflicts: decisions.count,
                        kept_local_nodes: decisions.keepIds.size,
                    }),
                    version,
                ],
            );
            await db.commit();
        } catch (error) {
            await db.rollback();
            throw error;
        }
    }
}
