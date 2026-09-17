const assert = require('node:assert/strict');
const test = require('node:test');
const { handle } = require('../dist/app/service/Http');
const runtime = require('../dist/app/service/Runtime');
const service = require('../dist/app/service/VersionService').default;

test('Next HTTP handlers authorize every management route before connecting to the database', async () => {
    const previous = process.env.REGION_ADMIN_TOKEN;
    try {
        process.env.REGION_ADMIN_TOKEN = 'a'.repeat(32);
        for (const path of [
            '',
            '/changes',
            '/releases',
            '/releases/attach',
            '/releases/publish',
            '/releases/rollback',
            '/releases/apply',
            '/conflicts',
            '/conflicts/resolve',
            '/prefer-remote',
            '/patches/apply',
            '/regions',
            '/regions/search',
            '/api-keys',
            '/api-keys/update',
            '/api-keys/revoke',
            '/api-keys/rotate',
            '/usage',
        ]) {
            for (const method of ['GET', 'POST']) {
                const response = await handle(
                    new Request(`http://localhost/version${path}`, { method }),
                    'version',
                );
                assert.equal(response.status, 401, `${method} ${path}`);
            }
        }
        delete process.env.REGION_ADMIN_TOKEN;
        assert.equal(
            (await handle(new Request('http://localhost/version'), 'version'))
                .status,
            401,
        );
    } finally {
        if (previous === undefined) delete process.env.REGION_ADMIN_TOKEN;
        else process.env.REGION_ADMIN_TOKEN = previous;
    }
});

test('Next HTTP handlers preserve async resume status, validate JSON and reject cross-site writes', async () => {
    const previous = process.env.REGION_ADMIN_TOKEN,
        oldInit = runtime.initialize,
        oldRun = service.checkNewVersion;
    let immediate;
    try {
        process.env.REGION_ADMIN_TOKEN = 'x';
        runtime.initialize = async () => {};
        service.checkNewVersion = async (value) => {
            immediate = value;
        };
        const headers = {
            Authorization: `Bearer ${process.env.REGION_ADMIN_TOKEN}`,
        };
        const request = (body, extra = {}) =>
            new Request('http://localhost/version', {
                method: 'POST',
                headers: { ...headers, ...extra },
                body,
            });
        const response = await handle(request('{"immediate":true}'), 'version');
        assert.equal(response.status, 202);
        assert.equal((await response.json()).data.accepted, true);
        assert.equal(immediate, true);
        process.env.REGION_ADMIN_TOKEN = '中文 空格 % !';
        assert.equal(
            (
                await handle(
                    new Request('http://localhost/version', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${encodeURIComponent(process.env.REGION_ADMIN_TOKEN)}`,
                            'X-Region-Token-Encoding': 'uri',
                        },
                        body: '{}',
                    }),
                    'version',
                )
            ).status,
            202,
        );
        process.env.REGION_ADMIN_TOKEN = 'x';
        const forwarded = (origin) =>
            new Request('http://localhost:3199/version', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer x',
                    Host: '127.0.0.1:3199',
                    Origin: origin,
                },
                body: '{}',
            });
        assert.equal(
            (await handle(forwarded('http://127.0.0.1:3199'), 'version'))
                .status,
            202,
        );
        assert.equal(
            (await handle(forwarded('http://evil.example'), 'version')).status,
            403,
        );

        assert.equal((await handle(request('{'), 'version')).status, 400);
        assert.equal((await handle(request('null'), 'version')).status, 400);
        assert.equal(
            (await handle(request('{"immediate":"yes"}'), 'version')).status,
            400,
        );
        assert.equal(
            (
                await handle(
                    request('{}', { Origin: 'https://evil.example' }),
                    'version',
                )
            ).status,
            403,
        );
        assert.equal(
            (
                await handle(
                    new Request('http://localhost/version/releases/publish', {
                        headers,
                    }),
                    'version',
                )
            ).status,
            405,
        );
        assert.equal(
            (
                await handle(
                    new Request('http://localhost/version/missing', {
                        headers,
                    }),
                    'version',
                )
            ).status,
            404,
        );
    } finally {
        if (previous === undefined) delete process.env.REGION_ADMIN_TOKEN;
        else process.env.REGION_ADMIN_TOKEN = previous;
        runtime.initialize = oldInit;
        service.checkNewVersion = oldRun;
    }
});

test('admin token accepts custom values and generates only once when empty', () => {
    const { adminToken } = require('../dist/config/AdminToken');
    const previous = process.env.REGION_ADMIN_TOKEN;
    const info = console.info;
    const logs = [];
    console.info = (message) => logs.push(message);
    try {
        for (const value of ['x', '中文令牌', 'with spaces !@#$']) {
            process.env.REGION_ADMIN_TOKEN = value;
            assert.equal(adminToken(), value);
        }
        assert.equal(logs.length, 0);
        process.env.REGION_ADMIN_TOKEN = '';
        const generated = adminToken();
        assert.match(generated, /^[a-f0-9]{48}$/);
        assert.equal(adminToken(), generated);
        assert.equal(logs.length, 1);
        assert.ok(logs[0].includes(generated));
        delete process.env.REGION_ADMIN_TOKEN;
        assert.notEqual(adminToken(), generated);
    } finally {
        console.info = info;
        if (previous === undefined) delete process.env.REGION_ADMIN_TOKEN;
        else process.env.REGION_ADMIN_TOKEN = previous;
    }
});
