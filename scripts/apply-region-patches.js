const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { createHash } = require('node:crypto');
const {
    HISTORY_SCHEMA,
    capture,
    record,
    registerAuto,
    assertClean,
} = require('../dist/app/service/DataHistoryService');

const patchIndex = process.argv.indexOf('--patch');
const patchFile = path.resolve(
    patchIndex < 0
        ? 'data/patches/20260916.json'
        : process.argv[patchIndex + 1],
);
const dryRun = process.argv.includes('--dry-run');

function searchText(row) {
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

function nextPrefix(prefix) {
    const last = prefix.charCodeAt(prefix.length - 1);
    return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

async function main() {
    const patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
    const connection = await mysql.createConnection({
        host: process.env.MINE_MYSQL_HOST,
        port: Number(process.env.MINE_MYSQL_PORT || 3306),
        user: process.env.MINE_MYSQL_USER,
        password: process.env.MINE_MYSQL_PASSWORD,
        database: process.env.MINE_MYSQL_DATABASE || 'region',
        connectTimeout: 10000,
    });

    try {
        const [[lock]] = await connection.query(
            "SELECT GET_LOCK('region-data-patch', 30) AS acquired",
        );
        if (lock.acquired !== 1) throw new Error('无法获取数据更新锁');

        for (const sql of HISTORY_SCHEMA) await connection.query(sql);
        await connection.beginTransaction();
        const [[currentVersion]] = await connection.query(
            'SELECT version FROM data_version WHERE scope=2',
        );
        if (Number(currentVersion?.version || 0) >= Number(patch.version)) {
            await connection.rollback();
            console.log(
                JSON.stringify(
                    {
                        version: patch.version,
                        already_applied: true,
                        current_version: Number(currentVersion.version),
                    },
                    null,
                    2,
                ),
            );
            return;
        }
        const [[historical]] = await connection.execute(
            'SELECT version FROM region_data_release WHERE version=?',
            [patch.version],
        );
        if (historical)
            throw new Error('该补丁已有版本历史，请通过版本重新应用接口重放');
        await assertClean(connection);
        await capture(connection);
        await connection.query(
            'CREATE TEMPORARY TABLE patch_region_ids (id INT UNSIGNED PRIMARY KEY)',
        );
        await connection.query(
            'CREATE TEMPORARY TABLE patch_parent_ids (id INT UNSIGNED PRIMARY KEY)',
        );

        const staged = [];
        for (const [index, change] of (patch.prefix_changes || []).entries()) {
            const temporaryPrefix = `ZP${String(index).padStart(4, '0')}`;
            const fromUpper = nextPrefix(change.from);
            const [[count]] = await connection.execute(
                'SELECT COUNT(*) AS total FROM region WHERE code >= CONVERT(? USING ascii) COLLATE ascii_bin AND code < CONVERT(? USING ascii) COLLATE ascii_bin',
                [change.from, fromUpper],
            );
            if (Number(count.total) === 0) continue;

            await connection.execute(
                'INSERT IGNORE INTO patch_region_ids SELECT id FROM region WHERE code >= CONVERT(? USING ascii) COLLATE ascii_bin AND code < CONVERT(? USING ascii) COLLATE ascii_bin',
                [change.from, fromUpper],
            );
            const [[root]] = await connection.execute(
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
                [
                    temporaryPrefix,
                    change.from.length + 1,
                    change.from,
                    fromUpper,
                ],
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
            const [[row]] = await connection.execute(
                'SELECT id, parent_id FROM region WHERE code = ?',
                [code],
            );
            const [[parent]] = await connection.execute(
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
            const [[existing]] = await connection.execute(
                'SELECT id FROM region WHERE code = ?',
                [addition.id],
            );
            if (existing) continue;

            const [[parent]] = await connection.execute(
                'SELECT id, depth FROM region WHERE code = ?',
                [addition.parent_id],
            );
            if (!parent) throw new Error(`新增节点父级不存在: ${addition.id}`);

            const [result] = await connection.execute(
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
            const [[root]] = await connection.execute(
                'SELECT id, parent_id FROM region WHERE code = ?',
                [change.to],
            );
            const [[parent]] = await connection.execute(
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
            const [[row]] = await connection.execute(
                'SELECT id, parent_id FROM region WHERE code = ?',
                [code],
            );
            if (!row) continue;
            const [[children]] = await connection.execute(
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
            await connection.execute('DELETE FROM region WHERE id = ?', [
                row.id,
            ]);
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
        const [affectedParents] = await connection.query(
            'SELECT id FROM patch_parent_ids',
        );
        for (const parent of affectedParents) {
            await connection.execute(
                'UPDATE region SET has_children=EXISTS(SELECT 1 FROM (SELECT parent_id FROM region WHERE parent_id=? LIMIT 1) children) WHERE id=?',
                [parent.id, parent.id],
            );
        }
        const checksum = createHash('sha256')
            .update(JSON.stringify(patch))
            .digest('hex');
        const publishedVersion = await registerAuto(
            connection,
            Number(patch.version),
            `区划补丁 ${patch.version}`,
            checksum,
            'patch',
        );
        await record(
            connection,
            'patch',
            `区划补丁 ${patch.version}`,
            publishedVersion,
        );
        await connection.execute(
            'INSERT INTO data_version(scope,version,checksum) VALUES(2,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),checksum=VALUES(checksum)',
            [publishedVersion, checksum],
        );

        const [[missing]] = await connection.query(
            'SELECT COUNT(*) AS total FROM region child LEFT JOIN region parent ON parent.id=child.parent_id WHERE child.parent_id IS NOT NULL AND parent.id IS NULL',
        );
        if (Number(missing.total) !== 0) {
            throw new Error(`更新后存在 ${missing.total} 条缺失父节点数据`);
        }

        if (dryRun) await connection.rollback();
        else await connection.commit();
        console.log(
            JSON.stringify(
                {
                    version: patch.version,
                    published_version: publishedVersion,
                    dry_run: dryRun,
                    prefix_changes: staged.length,
                    parent_changes: Object.keys(patch.parent_changes || {})
                        .length,
                    additions: (patch.additions || []).length,
                    removals: (patch.removals || []).length,
                    missing_parents: 0,
                },
                null,
                2,
            ),
        );
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        await connection.query("SELECT RELEASE_LOCK('region-data-patch')");
        await connection.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
