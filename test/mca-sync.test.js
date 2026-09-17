const assert = require('node:assert/strict');
const test = require('node:test');
const {
    dueVersion,
    validateTree,
    snapshotRows,
    branchCodes,
    McaSyncService,
} = require('../dist/app/service/McaSyncService');
const codes =
    '11 12 13 14 15 21 22 23 31 32 33 34 35 36 37 41 42 43 44 45 46 50 51 52 53 54 61 62 63 64 65'.split(
        ' ',
    );
const node = (code, name, level, type, children = []) => ({
    code,
    name,
    level,
    type,
    children,
});
const provinces = codes.map((p) =>
    node(`${p}0000000000`, `省${p}`, 1, '省', [
        node(`${p}0100000000`, `市${p}`, 2, '地级市'),
    ]),
);
const root = node('00', null, 0, '', provinces);
const trees = new Map([
    ['00', root],
    ...provinces.map((p) => {
        const city = p.children[0];
        return [
            city.code,
            {
                ...city,
                children: [
                    node(city.code.slice(0, 4) + '01000000', '县', 3, '县', [
                        node(city.code.slice(0, 4) + '01100000', '镇', 4, '镇'),
                    ]),
                ],
            },
        ];
    }),
]);

test('annual deadline uses Shanghai Jan 10 02:00', () => {
    assert.equal(dueVersion(new Date('2027-01-09T17:59:59Z')), null);
    assert.equal(dueVersion(new Date('2027-01-09T18:00:00Z')), 20270110);
    assert.equal(dueVersion(new Date('2027-11-01T00:00:00Z')), 20270110);
});
test('snapshot validates coverage, normalized codes and missing branches', () => {
    validateTree({ status: 200, data: root }, '00');
    assert.equal(branchCodes(root).length, 31);
    const rows = snapshotRows(root, trees);
    assert.equal(rows.length, 124);
    assert.deepEqual(rows[3], {
        code: '110101100',
        parent: '110101',
        name: '镇',
        level: 4,
        level_type: 710,
        preserve_children: true,
    });
    assert.throws(
        () =>
            validateTree(
                {
                    status: 200,
                    data: { ...root, children: provinces.slice(1) },
                },
                '00',
            ),
        /31/,
    );
    assert.throws(() => snapshotRows(root, new Map()), /缺少分支/);
    const wrong = structuredClone(trees.get('110100000000'));
    wrong.name = '变化了';
    assert.throws(
        () => snapshotRows(root, new Map([...trees, ['110100000000', wrong]])),
        /抓取期间/,
    );
    assert.throws(
        () =>
            validateTree(
                { status: 200, data: { ...wrong, code: 'bad' } },
                'bad',
            ),
        /未知代码/,
    );
});

test(
    'MySQL: resumes saved branches, rolls back conflicts, preserves IDs and commits version atomically',
    { skip: !process.env.MCA_TEST_SOCKET },
    async () => {
        const mysql = require('mysql2/promise');
        const fs = require('node:fs');
        const database = `mca_sync_test_${process.pid}_${Date.now()}`;
        const admin = await mysql.createConnection({
            socketPath: process.env.MCA_TEST_SOCKET,
            user: 'root',
        });
        await admin.query(`CREATE DATABASE ${database}`);
        const pool = mysql.createPool({
            supportBigNumbers: true,
            bigNumberStrings: true,
            socketPath: process.env.MCA_TEST_SOCKET,
            user: 'root',
            database,
            connectionLimit: 3,
        });
        try {
            for (const sql of fs
                .readFileSync('data/schema/region.sql', 'utf8')
                .split(';')
                .filter((s) => s.trim()))
                await pool.query(sql);
            await pool.query(
                "INSERT INTO region(id,code,name_cn,level_type,depth,parent_id) VALUES(1,'296','中国',210,1,NULL),(2,'110000','旧省名',410,2,1),(5,'139999','境外样本',510,2,NULL)",
            );
            await pool.query(
                "INSERT INTO region(id,code,name_cn,parent_id,level_type,depth) VALUES(3,'110101999','旧镇',2,710,3),(4,'110101999001','原村',3,810,4),(6,'110101998','删除镇',2,710,3),(7,'110101998001','删除村',6,810,4)",
            );
            await pool.query(
                'INSERT INTO data_version(scope,version) VALUES(2,20260916)',
            );
            let fail = true;
            const calls = [];
            const fetcher = async (code, year) => {
                calls.push(code);
                assert.equal(year, 2026);
                if (fail && code === '130100000000')
                    throw new Error('模拟网络故障');
                return trees.get(code);
            };
            let service = new McaSyncService(pool, fetcher, 0);
            await service.setup();
            const date = new Date('2027-01-10T00:00:00Z');
            await assert.rejects(service.run(date), /网络故障/);
            let { jobs, versions } = await service.status();
            assert.equal(jobs[0].completed, 3);
            assert.equal(jobs[0].status, 'failed');
            assert.equal(versions[0].version, 20260916);
            const oldCalls = calls.slice();
            fail = false;
            // 新实例模拟进程重启，已完成的00、11、12不再请求。
            service = new McaSyncService(pool, fetcher, 0);
            await service.run(date);
            assert.deepEqual(
                calls.slice(oldCalls.length, oldCalls.length + 1),
                ['130100000000'],
            );
            ({ jobs, versions } = await service.status());
            assert.equal(jobs[0].completed, 32);
            assert.equal(jobs[0].status, 'conflicts');
            assert.equal(versions[0].version, 20260916);
            const [[unchanged]] = await pool.query(
                'SELECT name_cn FROM region WHERE id=2',
            );
            assert.equal(unchanged.name_cn, '旧省名');
            let conflicts = await service.conflicts(2027011000);
            assert.equal(conflicts.length, 2);
            const decision = (code, action) => ({
                code,
                action,
                fingerprint: conflicts.find((c) => c.code === code).fingerprint,
            });
            assert.equal(
                conflicts.find((c) => c.code === '110101999').detail
                    .descendant_nodes,
                1,
            );
            await assert.rejects(
                service.resolve(2027011000, [
                    decision('110101999', 'keep_local'),
                    {
                        ...decision('110101998', 'delete_local'),
                        fingerprint: '0'.repeat(64),
                    },
                ]),
                /已变化/,
            );
            assert.ok(
                (await service.conflicts(2027011000)).every(
                    (c) => c.resolution === null,
                ),
            );
            const partial = await service.resolve(2027011000, [
                decision('110101999', 'keep_local'),
            ]);
            assert.equal(partial.pending, 1);
            const before = calls.length;
            await service.run(date);
            assert.equal((await service.status()).jobs[0].status, 'conflicts');
            assert.equal(calls.length, before);
            const ready = await service.resolve(2027011000, [
                decision('110101998', 'delete_local'),
            ]);
            assert.equal(ready.ready, true);
            // 人工决定后本地数据变化，重新分析必须清除失效决定并再次等待。
            await pool.query(
                "UPDATE region SET name_cn='已变化的村' WHERE id=4",
            );
            await service.run(date);
            assert.equal((await service.status()).jobs[0].status, 'conflicts');
            await assert.rejects(
                service.resolve(2027011000, [
                    decision('110101999', 'keep_local'),
                ]),
                /已变化/,
            );
            conflicts = await service.conflicts(2027011000);
            assert.equal(
                conflicts.find((c) => c.code === '110101998').resolution,
                'delete_local',
            );
            await service.resolve(2027011000, [
                decision('110101999', 'keep_local'),
            ]);
            await service.run(date);
            assert.equal(calls.length, before);
            ({ jobs, versions } = await service.status());
            assert.equal(jobs[0].status, 'completed');
            assert.equal(versions[0].version, 2027011000);
            const {
                DataHistoryService,
            } = require('../dist/app/service/DataHistoryService');
            const history = new DataHistoryService(pool);
            assert.ok(
                (await history.changes({ version: 2027011000 })).records
                    .length > 0,
            );
            await history.replay(2027011000, 'rollback');
            assert.equal(
                (await service.status()).versions[0].version,
                20260916,
            );
            await service.run(date); // 已回退任务不会被年度补跑自动重新发布。
            assert.equal(
                (await service.status()).versions[0].version,
                20260916,
            );
            await history.replay(2027011000, 'apply');

            assert.match(versions[0].checksum, /^[a-f0-9]{64}$/);
            const [[province]] = await pool.query(
                'SELECT * FROM region WHERE code="110000"',
            );
            assert.equal(province.id, 2);
            assert.equal(province.name_cn, '省11');
            const [[village]] = await pool.query(
                'SELECT * FROM region WHERE id=4',
            );
            assert.equal(village.code, '110101999001');
            assert.equal(village.depth, 4);
            const [[removed]] = await pool.query(
                'SELECT COUNT(*) AS n FROM region WHERE id IN (6,7)',
            );
            assert.equal(Number(removed.n), 0);
            const [[search]] = await pool.query(
                'SELECT * FROM region_search WHERE region_id=2',
            );
            assert.match(search.search_text, /省11/);
            const [[foreign]] = await pool.query(
                'SELECT * FROM region WHERE id=5',
            );
            assert.equal(foreign.name_cn, '境外样本');
            assert.equal(foreign.depth, 2);
            const [[orphans]] = await pool.query(
                'SELECT COUNT(*) AS n FROM region r LEFT JOIN region p ON p.id=r.parent_id WHERE r.parent_id IS NOT NULL AND p.id IS NULL',
            );
            assert.equal(Number(orphans.n), 0);
            await service.run(date);
            assert.equal(calls.length, before);
            // 与已有补丁执行器共用锁，避免并发写入。
            const c = await pool.getConnection();
            await c.query("SELECT GET_LOCK('region-data-patch',0)");
            await service.run(new Date('2028-01-10T00:00:00Z'));
            assert.equal(calls.length, before);
            await c.query("SELECT RELEASE_LOCK('region-data-patch')");
            c.release();
            const duplicate = await service.resolve(2027011000, [
                decision('110101999', 'keep_local'),
            ]);
            assert.equal(duplicate.ready, false);
            // 换码保留内部ID及村级编码，并能从修改日志回退/重新应用。
            const [[county]] = await pool.query(
                "SELECT id FROM region WHERE code='110101'",
            );
            const [[target]] = await pool.query(
                "SELECT id FROM region WHERE code='110101100'",
            );
            await pool.execute('DELETE FROM region_search WHERE region_id=?', [
                target.id,
            ]);
            await pool.execute('DELETE FROM region WHERE id=?', [target.id]);
            await pool.execute(
                "UPDATE region SET name_cn='镇',parent_id=?,depth=4 WHERE id=3",
                [county.id],
            );
            await pool.query(
                "INSERT INTO region_sync_job(version,source_year,status) VALUES(2029011000,2028,'failed')",
            );
            const apply = async () => {
                const db = await pool.getConnection();
                try {
                    await service.apply(
                        db,
                        snapshotRows(root, trees),
                        2029011000,
                    );
                } finally {
                    db.release();
                }
            };
            await apply();
            const [conflict] = await service.conflicts(2029011000);
            await assert.rejects(
                service.resolve(2029011000, [
                    {
                        code: conflict.code,
                        action: 'replace_code',
                        target_code: '999999999',
                        fingerprint: conflict.fingerprint,
                    },
                ]),
                /候选/,
            );
            await service.resolve(2029011000, [
                {
                    code: conflict.code,
                    action: 'replace_code',
                    target_code: '110101100',
                    fingerprint: conflict.fingerprint,
                },
            ]);
            await apply();
            const [[mapped]] = await pool.query(
                'SELECT code FROM region WHERE id=3',
            );
            assert.equal(mapped.code, '110101100');
            const [[child]] = await pool.query(
                'SELECT parent_id,code FROM region WHERE id=4',
            );
            assert.equal(child.parent_id, 3);
            assert.equal(child.code, '110101999001');
            await history.replay(2029011000, 'rollback');
            const [[original]] = await pool.query(
                'SELECT code FROM region WHERE id=3',
            );
            assert.equal(original.code, '110101999');
            await history.replay(2029011000, 'apply');
        } finally {
            await pool.end();
            await admin.query(`DROP DATABASE ${database}`);
            await admin.end();
        }
    },
);

test('Longgang direct village administration is a valid county leaf', () => {
    const data = node('330383000000', '龙港市', 3, '县级市');
    assert.equal(validateTree({ status: 200, data }, data.code), data);
});

test('empty Shihezi branch is accepted and protects local descendants', () => {
    const data = node('659001000000', '石河子市', 3, '县级市');
    assert.equal(validateTree({ status: 200, data }, data.code), data);
});
