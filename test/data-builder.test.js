const assert = require('node:assert/strict');
const test = require('node:test');

const {
    decodeValue,
    encodeTsv,
    parseInsert,
    parseValues,
} = require('../scripts/build-region-data');

test('data builder parses SQL values without splitting quoted commas', () => {
    assert.deepEqual(parseValues("1, 'A,B', '[1, 2]', NULL"), [
        '1',
        "'A,B'",
        "'[1, 2]'",
        'NULL',
    ]);
    assert.equal(decodeValue("'L\\'Aquila'"), "L'Aquila");
});

test('data builder parses inserts and escapes TSV', () => {
    const row = parseInsert(
        "INSERT INTO `region` (`id`, `name_cn`) VALUES (1, '朝阳\\n区');",
    );
    assert.deepEqual(row, { id: '1', name_cn: '朝阳\n区' });
    assert.equal(encodeTsv(row.name_cn), '朝阳\\n区');
    assert.equal(encodeTsv(null), '\\N');
});
