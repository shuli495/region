const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
    DataHistoryService,
} = require('../dist/app/service/DataHistoryService');

test(
    'MySQL history: manual edits, association, publish, rollback and replay restore all three tables',
    { skip: !process.env.MCA_TEST_SOCKET },
    async () => {
        const mysql = require('mysql2/promise');
        const options = {
            socketPath: process.env.MCA_TEST_SOCKET,
            user: 'root',
        };
        const admin = await mysql.createConnection(options);
        const database = `history_test_${process.pid}_${Date.now()}`;
        await admin.query(`CREATE DATABASE ${database}`);
        const pool = mysql.createPool({
            ...options,
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
                "INSERT INTO region(id,code,name_cn,parent_id,level_type,depth,has_children) VALUES(1,'296','中国',NULL,210,1,1),(2,'110000','省',1,310,2,1),(3,'110101','县',2,620,3,1),(4,'110101001','旧街道',3,760,4,1),(5,'110101001001','村',4,810,5,0)",
            );
            await pool.query(
                'INSERT INTO region_detail(region_id,lat,lng) VALUES(4,20,100)',
            );
            await pool.query(
                "INSERT INTO region_search(region_id,parent_id,search_text) VALUES(4,3,'旧街道')",
            );
            await pool.query(
                'INSERT INTO data_version(scope,version) VALUES(2,2026091602)',
            );
            const service = new DataHistoryService(pool);
            await service.setup();
            const snapshot = async () => {
                const data = {};
                for (const table of [
                    'region',
                    'region_detail',
                    'region_search',
                ]) {
                    [data[table]] = await pool.query(
                        `SELECT * FROM ${table} ORDER BY 1`,
                    );
                }
                return data;
            };
            const baseline = await snapshot();
            await assert.rejects(
                service.edit({
                    action: 'update',
                    id: 4,
                    fields: { parent_id: 5 },
                    reason: '循环',
                }),
                /循环/,
            );
            const first = await service.edit({
                action: 'update',
                id: 4,
                fields: { name_cn: '新街道', parent_id: 2, code: '110101002' },
                detail: { lng: 121 },
                reason: '核实更名并调整隶属',
            });
            assert.ok(first.changes > 0);
            const second = await service.edit({
                action: 'create',
                fields: {
                    code: '110101003',
                    name_cn: '新增街道',
                    level_type: 760,
                    parent_id: 3,
                },
                reason: '新增',
            });
            const [[village]] = await pool.query(
                'SELECT depth FROM region WHERE id=5',
            );
            assert.equal(village.depth, 4);
            const [[details]] = await pool.query(
                'SELECT lat,lng FROM region_detail WHERE region_id=4',
            );
            assert.deepEqual(details, { lat: 20, lng: 121 });
            const after = await snapshot();
            const draft = await service.create('人工修订', [
                first.operation_id,
            ]);
            await assert.rejects(service.publish(draft.version), /未关联/);
            await assert.rejects(
                service.attach(draft.version, [
                    second.operation_id,
                    '00000000-0000-0000-0000-000000000000',
                ]),
                /不存在/,
            );
            assert.ok(
                (await service.changes({ unassigned: 'true' })).records.some(
                    (r) => r.operation_id === second.operation_id,
                ),
            );
            await service.attach(draft.version, [second.operation_id]);
            await service.publish(draft.version);
            const count = (
                await service.changes({ version: draft.version, limit: 1000 })
            ).records.length;
            await service.replay(draft.version, 'rollback');
            assert.deepEqual(await snapshot(), baseline);
            const [[version]] = await pool.query(
                'SELECT version FROM data_version WHERE scope=2',
            );
            assert.equal(version.version, 2026091602);
            await service.replay(draft.version, 'apply');
            assert.deepEqual(await snapshot(), after);
            assert.equal(
                (await service.changes({ version: draft.version, limit: 1000 }))
                    .records.length,
                count,
            );
            await pool.query("UPDATE region SET name_cn='外部修改' WHERE id=4");
            await assert.rejects(
                service.replay(draft.version, 'rollback'),
                /数据已变化/,
            );
            await pool.query("UPDATE region SET name_cn='新街道' WHERE id=4");
            await assert.rejects(
                service.edit({ action: 'delete', id: 4, reason: '删除' }),
                /cascade/,
            );
            const removed = await service.edit({
                action: 'delete',
                id: 4,
                cascade: true,
                reason: '已确认删除子树',
            });
            const deletion = await service.create('删除版本', [
                removed.operation_id,
            ]);
            await service.publish(deletion.version);
            await assert.rejects(
                service.replay(draft.version, 'rollback'),
                /当前版本/,
            );
            await service.replay(deletion.version, 'rollback');
            assert.deepEqual(await snapshot(), after);
            await service.replay(deletion.version, 'apply');
            const [[gone]] = await pool.query(
                'SELECT COUNT(*) AS n FROM region WHERE id IN (4,5)',
            );
            assert.equal(gone.n, 0);
            await service.replay(deletion.version, 'rollback');
            await service.edit({
                action: 'update',
                id: 4,
                fields: { name_cn: '未归档' },
                reason: '临时修改',
            });
            await assert.rejects(
                service.replay(draft.version, 'rollback'),
                /未归档/,
            );
        } finally {
            await pool.end();
            await admin.query(`DROP DATABASE ${database}`);
            await admin.end();
        }
    },
);
