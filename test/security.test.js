const assert = require('node:assert/strict');
const test = require('node:test');

const Mysql = require('../dist/config/db/Mysql').default;
const RegionService = require('../dist/app/service/RegionService').default;

test('region query rejects dynamic SQL identifiers', async () => {
    await assert.rejects(
        RegionService.query({ level_type: 'cn_300; DROP TABLE country' }),
    );
    await assert.rejects(
        RegionService.query({ level_type: '100', columns: ['id; SELECT 1'] }),
    );
});

test('region pagination uses bound values', async () => {
    const calls = [];
    Mysql.client = {
        execute: async (sql, values) => {
            calls.push({ sql, values });
            return [[{ total: 0 }]];
        },
    };

    await RegionService.query({
        level_type: 'cn_300',
        columns: ['lat'],
        size: 10,
        current: 2,
    });

    assert.match(calls[1].sql, /LIMIT \? OFFSET \?$/);
    assert.deepEqual(calls[1].values, [10, 10]);
});
