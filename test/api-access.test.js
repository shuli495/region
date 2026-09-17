const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { ApiAccessService } = require('../dist/app/service/ApiAccessService');

test('API key management validates names, IDs, status and expiry before SQL', async () => {
    const service = new ApiAccessService({
        execute() {
            throw new Error('Unexpected SQL');
        },
    });
    await assert.rejects(service.create({ name: ' ' }), /名称/);
    await assert.rejects(
        service.create({ name: 'client', expires_at: 'tomorrow' }),
        /到期时间/,
    );
    await assert.rejects(service.update({ id: -1 }), /ID/);
    await assert.rejects(
        service.update({ id: 1, name: 'client', status: 'other' }),
        /状态/,
    );
    await assert.rejects(service.usage({ days: '1;DELETE' }), /统计范围/);
    await assert.rejects(service.usage({ key_id: '-1' }), /ID/);
    assert.deepEqual(await service.authorize(''), { id: 0, allowed: false });
});

test(
    'MySQL: key lifecycle, public API authorization and exact concurrent usage aggregation',
    { skip: !process.env.MCA_TEST_SOCKET },
    async () => {
        const mysql = require('mysql2/promise');
        const Mysql = require('../dist/config/db/Mysql').default;
        const runtime = require('../dist/app/service/Runtime');
        const { handle } = require('../dist/app/service/Http');
        const options = {
            socketPath: process.env.MCA_TEST_SOCKET,
            user: 'root',
            supportBigNumbers: true,
            bigNumberStrings: true,
        };
        const admin = await mysql.createConnection(options);
        const database = `api_access_test_${process.pid}_${Date.now()}`;
        await admin.query(`CREATE DATABASE ${database}`);
        const pool = mysql.createPool({
            ...options,
            database,
            connectionLimit: 5,
        });
        const oldPool = Mysql.client,
            oldInit = runtime.initialize;
        try {
            for (const sql of fs
                .readFileSync('data/schema/region.sql', 'utf8')
                .split(';')
                .filter((value) => value.trim()))
                await pool.query(sql);
            const service = new ApiAccessService(pool);
            await service.setup();
            await pool.query(
                "INSERT INTO region(id,code,name_cn,level_type,depth,parent_id,has_children) VALUES(1,'CN','中国',210,1,NULL,1),(2,'110000','北京市',410,2,1,0)",
            );
            await pool.query(
                "INSERT INTO region_search VALUES(2,1,'北京市 Beijing 110000')",
            );
            Mysql.client = pool;
            runtime.initialize = async () => {};
            const issued = await service.create({ name: 'web' });
            assert.match(issued.key, /^rg_[a-f0-9]{64}$/);
            const [[stored]] = await pool.execute(
                'SELECT * FROM region_api_key WHERE id=?',
                [issued.id],
            );
            assert.equal(stored.key_hash.length, 64);
            assert.ok(!JSON.stringify(stored).includes(issued.key));
            const keys = await service.keys();
            assert.ok(!('key_hash' in keys[0]));
            assert.equal(keys[0].name, 'web');
            assert.equal(keys[0].expired, 0);
            let requests = 0,
                errors = 0;
            async function call(path, key, status, options = {}) {
                const response = await handle(
                    new Request(`http://localhost${path}`, {
                        headers: key ? { 'X-API-Key': key } : {},
                        ...options,
                    }),
                    'region',
                );
                assert.equal(
                    response.status,
                    status,
                    `${path}: ${await response.clone().text()}`,
                );
                requests++;
                errors += status >= 400 ? 1 : 0;
                return response.json();
            }
            await call('/region', null, 401);
            await call(`/region?api_key=${issued.key}`, null, 401);
            await call('/region', 'invalid', 401);
            await call('/region', null, 401, {
                headers: { Authorization: 'Bearer administrator' },
            });
            assert.equal(
                (await call('/region?after_id=0', issued.key, 200)).data
                    .records[0].name_cn,
                '中国',
            );
            assert.equal(
                (
                    await call(
                        '/region/search?parent_id=1&keyword=北京',
                        issued.key,
                        200,
                    )
                ).data.records[0].region_id,
                2,
            );
            await call('/region?size=-1', issued.key, 400);
            await call('/region?after_id=-1', issued.key, 400);
            await call('/region', issued.key, 405, {
                method: 'POST',
                headers: { 'X-API-Key': issued.key },
            });
            await call('/region/unknown', issued.key, 404);
            await service.update({
                id: issued.id,
                name: 'web-renamed',
                status: 'disabled',
                expires_at: null,
            });
            await call('/region', issued.key, 401);
            const rotated = await service.rotate(issued.id);
            assert.equal((await service.authorize(rotated.key)).allowed, false);
            await service.update({
                id: issued.id,
                name: 'web-renamed',
                status: 'enabled',
                expires_at: '2000-01-01T00:00:00.000Z',
            });
            await call('/region', rotated.key, 401);
            assert.equal(
                (await service.keys())[0].expires_at,
                '2000-01-01T00:00:00Z',
            );
            assert.equal((await service.keys())[0].expired, 1);
            await service.update({
                id: issued.id,
                name: 'web-renamed',
                status: 'enabled',
                expires_at: '2099-01-01T00:00:00.000Z',
            });
            assert.equal((await service.authorize(rotated.key)).allowed, true);
            await call('/region', issued.key, 401);
            await call('/region', rotated.key, 200);
            await Promise.all(
                Array.from({ length: 24 }, () =>
                    call('/region?parent_id=1', rotated.key, 200),
                ),
            );
            const usage = await service.usage({ days: '7' });
            assert.equal(usage.daily.length, 7);
            assert.equal(usage.summary.requests, requests);
            assert.equal(usage.summary.errors, errors);
            assert.equal(usage.summary.success, requests - errors);
            assert.equal(
                usage.daily.reduce((total, row) => total + row.requests, 0),
                requests,
            );
            assert.equal(
                usage.keys.reduce((total, row) => total + row.requests, 0),
                requests,
            );
            assert.equal(
                usage.endpoints.reduce((total, row) => total + row.requests, 0),
                requests,
            );
            const scoped = await service.usage({
                days: '7',
                key_id: String(issued.id),
            });
            assert.equal(scoped.keys.length, 1);
            assert.equal(scoped.keys[0].name, 'web-renamed');
            assert.equal(scoped.keys[0].key_id, issued.id);
            await service.revoke(issued.id);
            await call('/region', rotated.key, 401);
            await assert.rejects(service.rotate(issued.id), /撤销/);
            await assert.rejects(
                service.update({
                    id: issued.id,
                    name: 'oops',
                    status: 'enabled',
                    expires_at: null,
                }),
                /撤销/,
            );
            assert.equal(
                (await service.usage({ days: '30' })).summary.requests,
                requests,
            );
            const second = await service.create({ name: 'another' });
            assert.notEqual(second.key, rotated.key);
            assert.equal(
                (await service.usage({ key_id: String(second.id) })).summary
                    .requests,
                0,
            );
        } finally {
            Mysql.client = oldPool;
            runtime.initialize = oldInit;
            await pool.end();
            await admin.query(`DROP DATABASE ${database}`);
            await admin.end();
        }
    },
);
