const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { planRemoteCodes } = require('../dist/app/service/RemoteCodePlan');
const { McaSyncService } = require('../dist/app/service/McaSyncService');
const {
    DataHistoryService,
} = require('../dist/app/service/DataHistoryService');
const remote = [
    {
        code: '110000',
        parent: null,
        name: '省',
        level: 1,
        level_type: 310,
        preserve_children: false,
    },
    {
        code: '110101',
        parent: '110000',
        name: '县',
        level: 3,
        level_type: 620,
        preserve_children: false,
    },
    ...['甲镇', '乙镇', '新增镇'].map((name, i) => ({
        code: ['110101102', '110101100', '110101101'][i],
        parent: '110101',
        name,
        level: 4,
        level_type: 710,
        preserve_children: true,
    })),
];
test('code plan handles occupied codes without merging unrelated local entities', () => {
    const local = [
        { id: 2, code: '110000', parent_id: 1, name_cn: '省', level_type: 310 },
        { id: 3, code: '110101', parent_id: 2, name_cn: '县', level_type: 620 },
        ...['甲镇', '乙镇', '本地农场'].map((name_cn, i) => ({
            id: 4 + i,
            code: `11010110${i}`,
            parent_id: 3,
            name_cn,
            level_type: 710,
        })),
    ];
    const p = planRemoteCodes(local, remote, 1);
    assert.equal(p.codeMaps.find((r) => r.id === 4).target, '110101102');
    assert.equal(p.codeMaps.find((r) => r.id === 5).target, '110101100');
    assert.equal(p.localAliases[0].id, 6);
    assert.equal(p.added, 1);
    assert.ok(p.keepIds.has(6));
});
test(
    'MySQL official-code policy publishes mappings, retains children and supports rollback/replay',
    { skip: !process.env.MCA_TEST_SOCKET },
    async () => {
        const mysql = require('mysql2/promise');
        const opts = { socketPath: process.env.MCA_TEST_SOCKET, user: 'root' };
        const admin = await mysql.createConnection(opts);
        const database = `code_policy_test_${process.pid}_${Date.now()}`;
        await admin.query(`CREATE DATABASE ${database}`);
        const pool = mysql.createPool({
            ...opts,
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
                "INSERT INTO region(id,code,name_cn,parent_id,level_type,depth,has_children) VALUES(1,'296','中国',NULL,210,1,1),(2,'110000','省',1,310,2,1),(3,'110101','县',2,620,3,1),(4,'110101100','甲镇',3,710,4,1),(5,'110101100001','甲村',4,810,5,0),(6,'110101101','乙镇',3,710,4,1),(7,'110101101001','乙村',6,810,5,0),(8,'110101102','本地农场',3,710,4,1),(9,'110101102001','农场村',8,810,5,0)",
            );
            await pool.query(
                'INSERT INTO data_version(scope,version) VALUES(2,2026091602)',
            );
            const service = new McaSyncService(pool);
            await service.setup();
            const history = new DataHistoryService(pool);
            await pool.query(
                "INSERT INTO region_sync_job(version,source_year,status,total,completed) VALUES(2026091700,2026,'conflicts',1,1)",
            );
            const snap = async () => {
                const x = {};
                for (const t of ['region', 'region_detail', 'region_search'])
                    [x[t]] = await pool.query(`SELECT * FROM ${t} ORDER BY 1`);
                return x;
            };
            const before = await snap();
            for (const [code, id] of [
                ['110101100', 4],
                ['110101102', 8],
            ]) {
                await pool.execute(
                    "INSERT INTO region_sync_conflict(version,code,kind,detail,fingerprint) VALUES(2026091700,?,'missing_remote',?,?)",
                    [
                        code,
                        JSON.stringify({
                            local: { id },
                            remote_candidates: [
                                { code: '110101102', parent: '110101' },
                            ],
                        }),
                        '0'.repeat(64),
                    ],
                );
            }
            await assert.rejects(
                service.resolve(2026091700, [
                    {
                        code: '110101100',
                        action: 'replace_code',
                        target_code: '110101102',
                        fingerprint: '0'.repeat(64),
                    },
                ]),
                /占用/,
            );
            await pool.query(
                "INSERT INTO region_sync_code_map(version,code,target_code) VALUES(2026091700,'110101100','110101999')",
            );

            await service.preferRemote(2026091700);
            const db = await pool.getConnection();
            try {
                await service.apply(db, remote, 2026091700);
            } finally {
                db.release();
            }
            const after = await snap();
            assert.equal(
                after.region.find((r) => r.id === 4).code,
                '110101102',
            );
            assert.equal(
                after.region.find((r) => r.id === 6).code,
                '110101100',
            );
            assert.equal(
                after.region.find((r) => r.id === 8).name_cn,
                '本地农场',
            );
            assert.match(after.region.find((r) => r.id === 8).code, /^local:/);
            assert.equal(after.region.find((r) => r.id === 9).parent_id, 8);
            assert.equal(after.region.find((r) => r.id === 5).parent_id, 4);
            assert.equal(after.region.length, 10);
            const state = await service.status();
            assert.equal(state.jobs[0].status, 'completed');
            const summary =
                typeof state.jobs[0].summary === 'string'
                    ? JSON.parse(state.jobs[0].summary)
                    : state.jobs[0].summary;
            assert.equal(summary.conflicts, 2);
            const conflicts = await service.conflicts(2026091700);
            assert.equal(
                conflicts.find((r) => r.code === '110101100').target_code,
                '110101102',
            );
            assert.match(
                conflicts.find((r) => r.code === '110101102').target_code,
                /^local:/,
            );

            assert.equal(state.versions[0].version, 2026091700);
            await history.replay(2026091700, 'rollback');
            assert.deepEqual(await snap(), before);
            assert.equal(
                (await service.conflicts(2026091700)).find(
                    (r) => r.code === '110101100',
                ).target_code,
                '110101102',
            );

            await history.replay(2026091700, 'apply');
            assert.deepEqual(await snap(), after);
            // 下一次相同快照不重复换码，local扩展节点也不会重新成为缺失冲突。
            const repeat = planRemoteCodes(
                after.region.filter(
                    (r) => r.level_type >= 300 && r.level_type < 800,
                ),
                remote,
                1,
            );
            assert.equal(repeat.codeMaps.length, 0);
            assert.equal(repeat.added, 0);
            assert.equal(repeat.localAliases.length, 0);
            await pool.query(
                "INSERT INTO region_sync_job(version,source_year,status,total,completed) VALUES(2026091701,2026,'fetching',1,1)",
            );
            const nextDb = await pool.getConnection();
            try {
                await service.apply(nextDb, remote, 2026091701);
            } finally {
                nextDb.release();
            }
            assert.equal((await service.status()).jobs[0].status, 'completed');
            assert.deepEqual(await snap(), after);
        } finally {
            await pool.end();
            await admin.query(`DROP DATABASE ${database}`);
            await admin.end();
        }
    },
);

test('two-way code swap keeps identities and does not allocate local aliases', () => {
    const rows = [
        { id: 2, code: '110000', parent_id: 1, name_cn: '省', level_type: 310 },
        { id: 3, code: '110101', parent_id: 2, name_cn: '县', level_type: 620 },
        {
            id: 4,
            code: '110101100',
            parent_id: 3,
            name_cn: '甲镇',
            level_type: 710,
        },
        {
            id: 6,
            code: '110101101',
            parent_id: 3,
            name_cn: '乙镇',
            level_type: 710,
        },
    ];
    const source = [
        ...remote.slice(0, 2),
        { ...remote[2], code: '110101101' },
        { ...remote[3], code: '110101100' },
    ];
    const plan = planRemoteCodes(rows, source, 1);
    assert.deepEqual(
        plan.codeMaps.map((r) => [r.id, r.target]),
        [
            [4, '110101101'],
            [6, '110101100'],
        ],
    );
    assert.equal(plan.added, 0);
    assert.equal(plan.localAliases.length, 0);
});
