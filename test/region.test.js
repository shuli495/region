const assert = require('node:assert/strict');
const test = require('node:test');

const Mysql = require('../dist/config/db/Mysql').default;
const RegionService = require('../dist/app/service/RegionService').default;

test('region query rejects invalid columns', async () => {
    await assert.rejects(
        RegionService.query({ columns: ['id; SELECT 1'] }),
        /返回字段错误/,
    );
});

test('region query uses parent cursor index shape', async () => {
    const calls = [];
    Mysql.client = {
        execute: async (sql, values) => {
            calls.push({ sql, values });
            return [[{ id: 11 }, { id: 12 }, { id: 13 }]];
        },
    };

    const result = await RegionService.query({
        parent_id: 10,
        after_id: 5,
        size: 2,
        columns: ['lat'],
    });

    assert.match(calls[0].sql, /LEFT JOIN region_detail/);
    assert.match(calls[0].sql, /r\.parent_id = \?.*r\.id > \?.*LIMIT 3$/);
    assert.deepEqual(calls[0].values, [10, 5]);
    assert.deepEqual(result, {
        records: [{ id: 11 }, { id: 12 }],
        has_more: true,
        next_after_id: 12,
    });
});

test('scoped search only reads region_search', async () => {
    const calls = [];
    Mysql.client = {
        execute: async (sql, values) => {
            calls.push({ sql, values });
            return [[{ region_id: 8 }]];
        },
    };

    await RegionService.search({ parent_id: 1, keyword: '朝阳', size: 20 });

    assert.match(calls[0].sql, /^SELECT region_id FROM region_search/);
    assert.match(calls[0].sql, /parent_id = \?.*INSTR\(search_text, \?\)/);
    assert.doesNotMatch(calls[0].sql, /JOIN region/);
    assert.match(calls[0].sql, /LIMIT 21$/);
    assert.deepEqual(calls[0].values, [1, '朝阳', 0]);
});

test('search requires a parent id', async () => {
    await assert.rejects(
        RegionService.search({ keyword: 'Beijing' }),
        /搜索必须指定父节点/,
    );
});
