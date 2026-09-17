const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    PatchService,
    readPatches,
} = require('../dist/app/service/PatchService');
const {
    DataHistoryService,
} = require('../dist/app/service/DataHistoryService');
const { load } = require('../scripts/load-region-data');

const patch1 = {
    version: 100,
    description: '交换前缀不级联',
    prefix_changes: [
        { from: '110101001', to: '110101002' },
        { from: '110101002', to: '110101003' },
    ],
};
const patch2 = {
    version: 101,
    description: '第二个补丁读取第一个补丁的结果',
    updates: { 110101003: { name_cn: '新街道' } },
};
const save = (dir, file, patch) =>
    fs.writeFile(path.join(dir, file), JSON.stringify(patch));
const expected = (status) =>
    status.packages
        .filter((p) => p.state === 'pending')
        .map(({ version, checksum }) => ({ version, checksum }));

test('patch catalog sorts by version, rejects duplicates and invalid fields, and reads newly pulled files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'region-patches-'));
    try {
        await save(dir, 'a.json', patch2);
        await save(dir, 'z.json', patch1);
        assert.deepEqual(
            (await readPatches(dir)).map((e) => e.patch.version),
            [100, 101],
        );
        await save(dir, 'duplicate.json', patch1);
        await assert.rejects(readPatches(dir), /版本重复/);
        await fs.unlink(path.join(dir, 'duplicate.json'));
        await save(dir, 'bad.json', {
            ...patch1,
            version: 102,
            updates: { 110101001: { 'name_cn=1': 'bad' } },
        });
        await assert.rejects(readPatches(dir), /不支持/);
        await fs.unlink(path.join(dir, 'bad.json'));
        await save(dir, 'new.json', { version: 102, description: '新包' });
        assert.equal((await readPatches(dir)).length, 3);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

async function fixture(run) {
    const mysql = require('mysql2/promise');
    const admin = await mysql.createConnection({
        socketPath: process.env.MCA_TEST_SOCKET,
        user: 'root',
    });
    const database = `patch_test_${process.pid}_${Date.now()}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'region-patch-db-'));
    await admin.query(`CREATE DATABASE ${database}`);
    const pool = mysql.createPool({
        socketPath: process.env.MCA_TEST_SOCKET,
        user: 'root',
        database,
        connectionLimit: 3,
    });
    try {
        for (const sql of (await fs.readFile('data/schema/region.sql', 'utf8'))
            .split(';')
            .filter((s) => s.trim()))
            await pool.query(sql);
        const history = new DataHistoryService(pool);
        await history.setup();
        const service = new PatchService(pool, dir);
        await service.setup();
        await save(dir, 'last-in-filenames.json', patch1);
        await save(dir, 'first-in-filenames.json', patch2);
        await run({ pool, dir, service, history });
    } finally {
        await pool.end();
        await admin.query(`DROP DATABASE ${database}`);
        await admin.end();
        await fs.rm(dir, { recursive: true, force: true });
    }
}
const seed = async (pool) => {
    await pool.query(`INSERT INTO region(id,code,name_cn,parent_id,level_type,depth,has_children) VALUES
        (1,'CN','中国',NULL,210,0,1),(2,'110000','省',1,310,1,1),(3,'110101','县',2,620,2,1),
        (4,'110101001','甲街道',3,760,3,1),(5,'110101002','乙街道',3,760,3,0),(6,'110101001001','村',4,810,4,0)`);
    await pool.query(
        'INSERT INTO region_search SELECT id,parent_id,name_cn FROM region',
    );
    await pool.query('INSERT INTO region_detail(region_id,lat) VALUES(4,30)');
};
const snapshot = async (pool) => {
    const result = {};
    for (const table of ['region', 'region_search', 'region_detail'])
        [result[table]] = await pool.query(`SELECT * FROM ${table} ORDER BY 1`);
    return result;
};

test(
    'MySQL packages: sequential updates, locking, stale preview, receipts, rollback/replay and legacy history',
    { skip: !process.env.MCA_TEST_SOCKET },
    async () =>
        fixture(async ({ pool, dir, service, history }) => {
            await seed(pool);
            // Local data is older than both package versions.
            await pool.query(
                'INSERT INTO data_version(scope,version) VALUES(2,99)',
            );
            const before = await snapshot(pool);
            const status = await service.status();
            assert.equal(status.pending, 2);
            const blocker = await pool.getConnection();
            await blocker.query("SELECT GET_LOCK('region-data-patch',0)");
            try {
                await assert.rejects(
                    service.apply(expected(status)),
                    /其他更新/,
                );
            } finally {
                await blocker.query("SELECT RELEASE_LOCK('region-data-patch')");
                blocker.release();
            }
            await assert.rejects(
                service.apply(expected(status).slice(0, 1)),
                /已变化/,
            );
            await history.create('未发布草稿');
            await assert.rejects(service.apply(expected(status)), /草稿/);
            await pool.query(
                "DELETE FROM region_data_release WHERE status='draft'",
            );
            const result = await service.apply(expected(status));
            assert.deepEqual(result.applied, [100, 101]);
            const after = await snapshot(pool);
            assert.equal(
                after.region.find((r) => r.id === 4).code,
                '110101002',
            );
            assert.equal(
                after.region.find((r) => r.id === 5).code,
                '110101003',
            );
            assert.equal(
                after.region.find((r) => r.id === 5).name_cn,
                '新街道',
            );
            assert.equal(
                after.region.find((r) => r.id === 6).code,
                '110101002001',
            );
            assert.equal((await service.status()).pending, 0);
            await assert.rejects(service.apply(expected(status)), /已变化/);
            await history.replay(result.version, 'rollback');
            assert.deepEqual(await snapshot(pool), before);
            assert.equal((await service.status()).blocked, true);
            await history.replay(result.version, 'apply');
            assert.deepEqual(await snapshot(pool), after);
            assert.equal((await service.status()).blocked, false);
            await save(dir, 'last-in-filenames.json', {
                ...patch1,
                description: '改写旧补丁',
            });
            assert.equal((await service.status()).packages[0].state, 'skipped');
            assert.equal((await service.status()).blocked, false);
            await save(dir, 'last-in-filenames.json', patch1);
            await save(dir, 'new.json', {
                version: 102,
                description: '增加一个区划',
                additions: [
                    {
                        id: '110101004',
                        parent_id: '110101',
                        name_cn: '新增街道',
                        level_type: 760,
                    },
                ],
            });
            const fresh = await service.status();
            assert.equal(fresh.pending, 1);
            await save(dir, 'new.json', {
                version: 102,
                description: '改写预览后的包',
                updates: { 110101003: { name_cn: '另一名称' } },
            });
            await assert.rejects(service.apply(expected(fresh)), /已变化/);
            await fs.unlink(path.join(dir, 'new.json'));
            // Old CLI receipts were stored in release history by checksum.
            await pool.query('DELETE FROM region_patch');
            await pool.query('DELETE FROM region_data_release');
            const entries = await readPatches(dir);
            for (const entry of entries)
                await pool.execute(
                    "INSERT INTO region_data_release(version,title,source,status,checksum) VALUES(?,?,'patch','applied',?)",
                    [
                        entry.patch.version,
                        entry.patch.description,
                        entry.checksum,
                    ],
                );
            assert.equal((await service.status()).pending, 0);
        }),
);

test(
    'MySQL packages: failure rolls back every patch, receipt and version in the batch',
    { skip: !process.env.MCA_TEST_SOCKET },
    async () =>
        fixture(async ({ pool, dir, service }) => {
            await seed(pool);
            const before = await snapshot(pool);
            await save(dir, 'bad.json', {
                version: 102,
                description: '制造循环',
                parent_changes: { 110101: '110101003' },
            });
            await assert.rejects(
                service.apply(expected(await service.status())),
                /循环/,
            );
            assert.deepEqual(await snapshot(pool), before);
            for (const table of [
                'region_patch',
                'region_data_release',
                'region_change_log',
                'data_version',
            ]) {
                const [[row]] = await pool.query(
                    `SELECT COUNT(*) AS n FROM ${table}`,
                );
                assert.equal(Number(row.n), 0);
            }
            await fs.unlink(path.join(dir, 'bad.json'));
            assert.deepEqual(
                (await service.apply(expected(await service.status()))).applied,
                [100, 101],
            );
        }),
);

test(
    'MySQL initialization applies all patches and rolls back imported rows if a patch fails',
    { skip: !process.env.MCA_TEST_SOCKET },
    async () =>
        fixture(async ({ pool, dir, service }) => {
            const input = path.join(dir, 'base');
            await fs.mkdir(input);
            await seed(pool);
            const manifest = { format: 'region-base-v1' };
            for (const table of ['region', 'region_search', 'region_detail']) {
                const [rows] = await pool.query(
                    `SELECT * FROM ${table} ORDER BY 1`,
                );
                const columns = Object.keys(rows[0]);
                const file = `${table}.tsv`;
                await fs.writeFile(
                    path.join(input, file),
                    rows
                        .map((row) =>
                            columns
                                .map((c) => (row[c] === null ? '\\N' : row[c]))
                                .join('\t'),
                        )
                        .join('\n') + '\n',
                );
                manifest[table] = { columns, files: [file], rows: rows.length };
                await pool.query(`DELETE FROM ${table}`);
            }
            await fs.writeFile(
                path.join(input, 'manifest.json'),
                JSON.stringify(manifest),
            );
            await save(dir, 'bad.json', {
                version: 102,
                description: '不存在的父级',
                parent_changes: { 110101003: '999999' },
            });
            const db = await pool.getConnection();
            try {
                await assert.rejects(load(db, input, dir), /父节点/);
                const [[empty]] = await db.query(
                    'SELECT COUNT(*) AS n FROM region',
                );
                assert.equal(Number(empty.n), 0);
                await fs.unlink(path.join(dir, 'bad.json'));
                const result = await load(db, input, dir);
                assert.deepEqual(result.patches.applied, [100, 101]);
                assert.equal((await service.status()).pending, 0);
                const [[row]] = await db.query(
                    "SELECT name_cn FROM region WHERE code='110101003'",
                );
                assert.equal(row.name_cn, '新街道');
                await assert.rejects(load(db, input, dir), /已有版本历史/);
            } finally {
                db.release();
            }
        }),
);

test(
    'MySQL packages: skip equal/older versions and recheck local version before applying',
    { skip: !process.env.MCA_TEST_SOCKET },
    async () =>
        fixture(async ({ pool, dir, service }) => {
            await seed(pool);
            const preview = await service.status();
            assert.equal(preview.pending, 2);
            await pool.query(
                'INSERT INTO data_version(scope,version) VALUES(2,100)',
            );
            let status = await service.status();
            assert.deepEqual(
                status.packages.map((p) => p.state),
                ['skipped', 'pending'],
            );
            await pool.query(
                'UPDATE data_version SET version=101 WHERE scope=2',
            );
            status = await service.status();
            assert.equal(status.pending, 0);
            assert.equal(status.blocked, false);
            const before = await snapshot(pool);
            await assert.rejects(service.apply(expected(preview)), /已变化/);
            await pool.query(
                'UPDATE data_version SET version=102 WHERE scope=2',
            );
            assert.equal((await service.status()).pending, 0);
            await save(dir, 'new.json', {
                version: 103,
                description: '高于本地版本的新包',
                updates: { 110101001: { name_cn: '最新名称' } },
            });
            status = await service.status();
            assert.deepEqual(
                expected(status).map((p) => p.version),
                [103],
            );
            assert.deepEqual(
                (await service.apply(expected(status))).applied,
                [103],
            );
            const [receipts] = await pool.query(
                'SELECT version FROM region_patch ORDER BY version',
            );
            assert.deepEqual(
                receipts.map((r) => r.version),
                [103],
            );
            const after = await snapshot(pool);
            assert.equal(
                after.region.find((r) => r.id === 4).code,
                before.region.find((r) => r.id === 4).code,
            );
            assert.equal(
                after.region.find((r) => r.id === 4).name_cn,
                '最新名称',
            );
            assert.equal((await service.status()).pending, 0);
        }),
);
