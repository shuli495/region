import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolConnection, Connection } from 'mysql2/promise';
import {
    assertClean,
    capture,
    record,
    registerAuto,
} from './DataHistoryService';

type Database = PoolConnection | Connection;
type Patch = {
    version: number;
    description: string;
    prefix_changes?: { from: string; to: string; parent_code?: string }[];
    parent_changes?: Record<string, string>;
    additions?: Record<string, any>[];
    updates?: Record<string, Record<string, any>>;
    removals?: string[];
};
type Entry = { file: string; patch: Patch; checksum: string };
export const PATCH_SCHEMA = `CREATE TABLE IF NOT EXISTS region_patch (
    version INT UNSIGNED PRIMARY KEY, checksum CHAR(64) NOT NULL,
    release_version INT UNSIGNED NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
const hash = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = (value: unknown) =>
    typeof value === 'string' && /^\d{6}(\d{3}){0,2}$/.test(value);
const fields = [
    'level_type',
    'name_cn',
    'name_en',
    'name_other',
    'name_pinyin',
    'name_jianpin',
];
function validate(patch: any): asserts patch is Patch {
    const object = (value: any) =>
        value && typeof value === 'object' && !Array.isArray(value);
    if (
        !object(patch) ||
        !Number.isInteger(patch.version) ||
        patch.version < 1 ||
        patch.version > 4294967295 ||
        typeof patch.description !== 'string' ||
        !patch.description.trim() ||
        patch.description.length > 200
    )
        throw new Error('补丁版本或说明无效');
    for (const key of ['prefix_changes', 'additions', 'removals'])
        if (patch[key] !== undefined && !Array.isArray(patch[key]))
            throw new Error(`补丁 ${key} 必须为数组`);
    for (const key of ['parent_changes', 'updates'])
        if (patch[key] !== undefined && !object(patch[key]))
            throw new Error(`补丁 ${key} 必须为对象`);
    const validateFields = (values: any) => {
        if (!object(values)) throw new Error('补丁字段无效');
        for (const [key, value] of Object.entries(values)) {
            if (!fields.includes(key))
                throw new Error(`不支持的补丁字段: ${key}`);
            if (key === 'level_type') {
                if (
                    !Number.isInteger(Number(value)) ||
                    Number(value) < 300 ||
                    Number(value) > 899
                )
                    throw new Error('补丁层级无效');
            } else if (
                value !== null &&
                (typeof value !== 'string' ||
                    value.length >
                        (['name_cn', 'name_jianpin'].includes(key) ? 64 : 128))
            )
                throw new Error(`补丁字段无效: ${key}`);
        }
    };
    const from = new Set();
    for (const change of patch.prefix_changes || []) {
        if (
            !object(change) ||
            !code(change.from) ||
            !code(change.to) ||
            change.from.length !== change.to.length ||
            (change.parent_code !== undefined && !code(change.parent_code)) ||
            from.has(change.from)
        )
            throw new Error('补丁编码映射无效或重复');
        from.add(change.from);
    }
    for (const [id, parent] of Object.entries(patch.parent_changes || {}))
        if (!code(id) || !code(parent) || id === parent)
            throw new Error('补丁父级无效');
    for (const [id, values] of Object.entries(patch.updates || {})) {
        if (!code(id)) throw new Error('补丁更新编码无效');
        validateFields(values);
    }
    const added = new Set();
    for (const row of patch.additions || []) {
        if (
            !object(row) ||
            !code(row.id) ||
            !code(row.parent_id) ||
            row.id === row.parent_id ||
            added.has(row.id) ||
            !row.name_cn ||
            row.level_type === undefined
        )
            throw new Error('补丁新增节点无效或重复');
        added.add(row.id);
        validateFields(
            Object.fromEntries(
                Object.entries(row).filter(
                    ([key]) =>
                        !['id', 'parent_id', 'parent_path'].includes(key),
                ),
            ),
        );
    }
    if ((patch.removals || []).some((id: unknown) => !code(id)))
        throw new Error('补丁删除编码无效');
}
export async function readPatches(
    directory = path.join(process.cwd(), 'data/patches'),
): Promise<Entry[]> {
    // 每次读取磁盘，让 git pull 后新增的包无需重新编译即可被发现。
    const files = (await readdir(directory))
        .filter((file) => file.endsWith('.json'))
        .sort();
    const entries = await Promise.all(
        files.map(async (file) => {
            const patch = JSON.parse(
                await readFile(path.join(directory, file), 'utf8'),
            );
            validate(patch);
            return { file, patch, checksum: hash(patch) };
        }),
    );
    entries.sort((a, b) => a.patch.version - b.patch.version);
    if (
        new Set(entries.map(({ patch }) => patch.version)).size !==
        entries.length
    )
        throw new Error('补丁版本重复');
    return entries;
}

export class PatchService {
    constructor(
        private pool: Pool,
        private directory = path.join(process.cwd(), 'data/patches'),
    ) {}
    async setup() {
        await this.pool.query(PATCH_SCHEMA);
    }
    private async inspect(
        db: Pool | Database,
        entries: Entry[],
        initializing = false,
    ) {
        const [[current]]: any = await db.query(
            'SELECT version FROM data_version WHERE scope=2',
        );
        const currentVersion = initializing ? 0 : Number(current?.version || 0);
        const [receipts]: any =
            await db.query(`SELECT p.version,p.checksum,p.release_version,r.status
            FROM region_patch p LEFT JOIN region_data_release r ON r.version=p.release_version`);
        // 兼容旧命令行生成的补丁历史；跳过旧包不等于记录为已执行。
        const [legacy]: any = await db.query(
            "SELECT version,checksum,status FROM region_data_release WHERE source='patch'",
        );
        return entries.map((entry) => {
            const receipt = receipts.find(
                (r: any) => Number(r.version) === entry.patch.version,
            );
            const previous =
                legacy.find((r: any) => r.checksum === entry.checksum) ||
                legacy.find(
                    (r: any) => Number(r.version) === entry.patch.version,
                );
            const applied =
                receipt ||
                (previous && {
                    ...previous,
                    release_version: previous.version,
                });
            const state =
                entry.patch.version <= currentVersion
                    ? applied &&
                      applied.checksum === entry.checksum &&
                      (!applied.release_version || applied.status === 'applied')
                        ? 'applied'
                        : 'skipped'
                    : applied && applied.checksum !== entry.checksum
                      ? 'changed'
                      : applied &&
                          (!applied.release_version ||
                              applied.status === 'applied')
                        ? 'applied'
                        : applied
                          ? 'rolled_back'
                          : 'pending';
            return {
                ...entry,
                state,
                release_version: applied?.release_version ?? null,
            };
        });
    }
    async status() {
        try {
            const items = await this.inspect(
                this.pool,
                await readPatches(this.directory),
            );
            const blocked = items.some(
                (item) =>
                    item.state === 'changed' || item.state === 'rolled_back',
            );
            return {
                pending: items.filter((item) => item.state === 'pending')
                    .length,
                blocked,
                error: blocked
                    ? '已执行补丁被修改或已回退，请恢复原文件或在版本时间线重新应用后再更新。'
                    : null,
                packages: items.map(
                    ({ file, patch, checksum, state, release_version }) => ({
                        file,
                        version: patch.version,
                        description: patch.description,
                        checksum,
                        state,
                        release_version,
                    }),
                ),
            };
        } catch (error: any) {
            return {
                pending: 0,
                blocked: true,
                error: `无法检查数据包：${error.message}`,
                packages: [],
            };
        }
    }
    async apply(expected: { version: number; checksum: string }[]) {
        if (
            !Array.isArray(expected) ||
            !expected.length ||
            expected.some(
                (item) =>
                    !item ||
                    !Number.isInteger(item.version) ||
                    typeof item.checksum !== 'string',
            )
        )
            throw new Error('请先检查待更新的数据包');
        const db = await this.pool.getConnection();
        let locked = false;
        try {
            const [[lock]]: any = await db.query(
                "SELECT GET_LOCK('region-data-patch',0) AS acquired",
            );
            if (Number(lock.acquired) !== 1)
                throw new Error('其他更新正在运行，请稍后重试');
            locked = true;
            await db.beginTransaction();
            const result = await this.applyIn(db, false, expected);
            await db.commit();
            return result;
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
    // 初始化由导入器持有锁和事务；与后台严格复用相同补丁逻辑。
    async applyIn(
        db: Database,
        initializing: boolean,
        expected?: { version: number; checksum: string }[],
    ) {
        const all = await this.inspect(
            db,
            await readPatches(this.directory),
            initializing,
        );
        if (
            all.some(
                (item) =>
                    item.state === 'changed' || item.state === 'rolled_back',
            )
        )
            throw new Error('补丁已修改或已回退，不能继续更新');
        const pending = all.filter((item) => item.state === 'pending');
        if (
            expected &&
            hash(expected) !==
                hash(
                    pending.map(({ patch, checksum }) => ({
                        version: patch.version,
                        checksum,
                    })),
                )
        )
            throw new Error('待更新的数据包已变化，请刷新后重试');
        await assertClean(db as PoolConnection);
        if (!pending.length) return { applied: [], version: null };
        if (!initializing) await capture(db as PoolConnection);
        for (const { patch } of pending) await applyPatch(db, patch);
        const checksum = hash(pending.map(({ checksum }) => checksum));
        const preferred = pending.at(-1)!.patch.version;
        const version = initializing
            ? preferred
            : await registerAuto(
                  db as PoolConnection,
                  preferred,
                  `数据包更新（${pending.length} 个补丁）`,
                  checksum,
                  'patch',
              );
        if (!initializing)
            await record(
                db as PoolConnection,
                'patch',
                '管理后台数据包更新',
                version,
            );
        for (const { patch, checksum } of pending)
            await db.execute(
                'INSERT INTO region_patch(version,checksum,release_version) VALUES(?,?,?)',
                [patch.version, checksum, initializing ? null : version],
            );
        await db.execute(
            'INSERT INTO data_version(scope,version,checksum) VALUES(2,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),checksum=VALUES(checksum)',
            [version, checksum],
        );
        return { applied: pending.map(({ patch }) => patch.version), version };
    }
}

function searchText(row: Record<string, any>) {
    return [
        row.name_cn,
        row.name_en,
        row.name_other,
        row.name_pinyin,
        row.name_jianpin,
        row.id,
    ]
        .filter(Boolean)
        .join(' ');
}
function nextPrefix(prefix: string) {
    return (
        prefix.slice(0, -1) +
        String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
    );
}
async function applyPatch(connection: Database, patch: Patch) {
    await connection.query(
        'DROP TEMPORARY TABLE IF EXISTS patch_region_ids, patch_parent_ids',
    );
    await connection.query(
        'CREATE TEMPORARY TABLE patch_region_ids (id INT UNSIGNED PRIMARY KEY)',
    );
    await connection.query(
        'CREATE TEMPORARY TABLE patch_parent_ids (id INT UNSIGNED PRIMARY KEY)',
    );
    const staged: any[] = [];
    for (const [index, change] of [...(patch.prefix_changes || [])]
        .sort((a, b) => b.from.length - a.from.length)
        .entries()) {
        const temporaryPrefix = `ZP${String(index).padStart(4, '0')}`;
        const fromUpper = nextPrefix(change.from);
        const [[count]]: any = await connection.execute(
            'SELECT COUNT(*) AS total FROM region WHERE code >= CONVERT(? USING ascii) COLLATE ascii_bin AND code < CONVERT(? USING ascii) COLLATE ascii_bin',
            [change.from, fromUpper],
        );
        if (Number(count.total) === 0) continue;

        await connection.execute(
            'INSERT IGNORE INTO patch_region_ids SELECT id FROM region WHERE code >= CONVERT(? USING ascii) COLLATE ascii_bin AND code < CONVERT(? USING ascii) COLLATE ascii_bin',
            [change.from, fromUpper],
        );
        const [[root]]: any = await connection.execute(
            'SELECT id, parent_id FROM region WHERE code = ?',
            [change.from],
        );
        if (root?.parent_id) {
            await connection.execute(
                'INSERT IGNORE INTO patch_parent_ids(id) VALUES(?)',
                [root.parent_id],
            );
        }
        await connection.execute(
            'UPDATE region SET code = CONCAT(CONVERT(? USING ascii), SUBSTRING(code, ?)) WHERE code >= CONVERT(? USING ascii) COLLATE ascii_bin AND code < CONVERT(? USING ascii) COLLATE ascii_bin',
            [temporaryPrefix, change.from.length + 1, change.from, fromUpper],
        );
        staged.push({ ...change, temporaryPrefix });
    }

    for (const change of staged) {
        const temporaryUpper = nextPrefix(change.temporaryPrefix);
        await connection.execute(
            'UPDATE region SET code = CONCAT(CONVERT(? USING ascii), SUBSTRING(code, ?)) WHERE code >= CONVERT(? USING ascii) COLLATE ascii_bin AND code < CONVERT(? USING ascii) COLLATE ascii_bin',
            [
                change.to,
                change.temporaryPrefix.length + 1,
                change.temporaryPrefix,
                temporaryUpper,
            ],
        );
    }

    for (const [code, parentCode] of Object.entries(
        patch.parent_changes || {},
    )) {
        const [[row]]: any = await connection.execute(
            'SELECT id, parent_id FROM region WHERE code = ?',
            [code],
        );
        const [[parent]]: any = await connection.execute(
            'SELECT id FROM region WHERE code = ?',
            [parentCode],
        );
        if (!row || !parent) {
            throw new Error(`无法调整父节点: ${code} -> ${parentCode}`);
        }
        await connection.execute(
            'UPDATE region SET parent_id = ? WHERE id = ?',
            [parent.id, row.id],
        );
        await connection.execute(
            'INSERT IGNORE INTO patch_region_ids(id) VALUES(?)',
            [row.id],
        );
        await connection.execute(
            'INSERT IGNORE INTO patch_parent_ids(id) VALUES(?),(?)',
            [row.parent_id, parent.id],
        );
    }

    for (const addition of patch.additions || []) {
        const [[existing]]: any = await connection.execute(
            'SELECT id FROM region WHERE code = ?',
            [addition.id],
        );
        if (existing) continue;

        const [[parent]]: any = await connection.execute(
            'SELECT id, depth FROM region WHERE code = ?',
            [addition.parent_id],
        );
        if (!parent) throw new Error(`新增节点父级不存在: ${addition.id}`);

        const [result]: any = await connection.execute(
            'INSERT INTO region(parent_id,code,level_type,depth,has_children,name_cn,name_en,name_local,name_pinyin,name_jianpin) VALUES(?,?,?,?,0,?,?,?,?,?)',
            [
                parent.id,
                addition.id,
                Number(addition.level_type),
                Number(parent.depth) + 1,
                addition.name_cn || null,
                addition.name_en || null,
                addition.name_other || null,
                addition.name_pinyin || null,
                addition.name_jianpin || null,
            ],
        );
        await connection.execute(
            'INSERT INTO region_search(region_id,parent_id,search_text) VALUES(?,?,?)',
            [result.insertId, parent.id, searchText(addition)],
        );
        await connection.execute(
            'INSERT IGNORE INTO patch_region_ids(id) VALUES(?)',
            [result.insertId],
        );
        await connection.execute(
            'INSERT IGNORE INTO patch_parent_ids(id) VALUES(?),(?)',
            [parent.id, result.insertId],
        );
    }

    for (const change of staged) {
        if (!change.parent_code) continue;
        const [[root]]: any = await connection.execute(
            'SELECT id, parent_id FROM region WHERE code = ?',
            [change.to],
        );
        const [[parent]]: any = await connection.execute(
            'SELECT id FROM region WHERE code = ?',
            [change.parent_code],
        );
        if (!root || !parent) {
            throw new Error(`无法重挂接节点: ${change.to}`);
        }
        await connection.execute(
            'UPDATE region SET parent_id = ? WHERE id = ?',
            [parent.id, root.id],
        );
        await connection.execute(
            'INSERT IGNORE INTO patch_parent_ids(id) VALUES(?),(?)',
            [root.parent_id, parent.id],
        );
    }

    for (const [code, fields] of Object.entries(patch.updates || {})) {
        const [[target]]: any = await connection.execute(
            'SELECT id FROM region WHERE code=?',
            [code],
        );
        if (!target) throw new Error(`待更新节点不存在: ${code}`);
        const allowed = [
            'level_type',
            'name_cn',
            'name_en',
            'name_other',
            'name_pinyin',
            'name_jianpin',
        ];
        const entries = Object.entries(fields).filter(([key]) =>
            allowed.includes(key),
        );
        const assignments = entries
            .map(([key]) =>
                key === 'name_other' ? 'name_local = ?' : `\`${key}\` = ?`,
            )
            .join(', ');
        if (!assignments) continue;
        await connection.execute(
            `UPDATE region SET ${assignments} WHERE code = ?`,
            [...entries.map(([, value]) => value), code],
        );
        await connection.execute(
            'INSERT IGNORE INTO patch_region_ids SELECT id FROM region WHERE code = ?',
            [code],
        );
    }

    for (const code of patch.removals || []) {
        const [[row]]: any = await connection.execute(
            'SELECT id, parent_id FROM region WHERE code = ?',
            [code],
        );
        if (!row) continue;
        const [[children]]: any = await connection.execute(
            'SELECT COUNT(*) AS total FROM region WHERE parent_id = ?',
            [row.id],
        );
        if (Number(children.total) !== 0) {
            throw new Error(`待删除节点仍有子节点: ${code}`);
        }
        await connection.execute(
            'DELETE FROM region_search WHERE region_id = ?',
            [row.id],
        );
        await connection.execute(
            'DELETE FROM region_detail WHERE region_id = ?',
            [row.id],
        );
        await connection.execute('DELETE FROM region WHERE id = ?', [row.id]);
        if (row.parent_id) {
            await connection.execute(
                'INSERT IGNORE INTO patch_parent_ids(id) VALUES(?)',
                [row.parent_id],
            );
        }
    }

    await connection.query(
        "UPDATE region_search s JOIN region r ON r.id=s.region_id JOIN patch_region_ids p ON p.id=r.id SET s.parent_id=r.parent_id, s.search_text=CONCAT_WS(' ',r.name_cn,r.name_en,r.name_local,r.name_pinyin,r.name_jianpin,r.code)",
    );
    const [affectedParents]: any = await connection.query(
        'SELECT id FROM patch_parent_ids',
    );
    for (const parent of affectedParents) {
        await connection.execute(
            'UPDATE region SET has_children=EXISTS(SELECT 1 FROM (SELECT parent_id FROM region WHERE parent_id=? LIMIT 1) children) WHERE id=?',
            [parent.id, parent.id],
        );
    }

    const [[missing]]: any = await connection.query(
        'SELECT COUNT(*) AS n FROM region r LEFT JOIN region p ON p.id=r.parent_id WHERE r.parent_id IS NOT NULL AND p.id IS NULL',
    );
    if (Number(missing.n)) throw new Error('补丁产生缺失父节点');
    // 重算深度并验证全部节点可从根到达，避免重挂接产生循环。
    await connection.query('DROP TEMPORARY TABLE IF EXISTS patch_depths');
    await connection.query(`CREATE TEMPORARY TABLE patch_depths (id INT UNSIGNED PRIMARY KEY, depth INT NOT NULL)
        WITH RECURSIVE tree AS (
            SELECT id,0 AS depth FROM region WHERE parent_id IS NULL
            UNION ALL SELECT r.id,t.depth+1 FROM region r JOIN tree t ON r.parent_id=t.id
        ) SELECT id,depth FROM tree`);
    const [[invalid]]: any = await connection.query(
        'SELECT COUNT(*) AS n FROM region r LEFT JOIN patch_depths d ON d.id=r.id WHERE d.id IS NULL',
    );
    if (Number(invalid.n)) throw new Error('补丁产生父子循环');
    await connection.query(
        'UPDATE region r JOIN patch_depths d ON d.id=r.id SET r.depth=d.depth WHERE r.depth<>d.depth',
    );
}
