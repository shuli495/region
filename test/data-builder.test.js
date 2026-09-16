const assert = require('node:assert/strict');
const test = require('node:test');

const {
    decodeValue,
    encodeTsv,
    loadPatches,
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

test('data patches replace one prefix without cascading', () => {
    const patches = loadPatches('data/patches');
    assert.deepEqual(patches.files, [
        '20260916.json',
        '20260916-2.json',
        '20260916-3.json',
    ]);
    assert.equal(
        patches.transform({ id: '530624102', parent_id: '530624' }).id,
        '530624101',
    );
    assert.equal(
        patches.transform({ id: '533423205', parent_id: '533423' }).parent_id,
        '533422',
    );
    assert.equal(patches.transform({ id: '500105' }), null);
    assert.equal(
        patches.transform({
            id: '441204111215',
            parent_id: '441204111',
        }).parent_id,
        '440608108',
    );
    assert.equal(
        patches.transform({
            id: '441204111204',
            parent_id: '441204111',
        }).parent_id,
        '441204111',
    );
    assert.equal(
        patches.transform({
            id: '441204111220',
            parent_id: '441204111',
        }).parent_id,
        '440608108',
    );
    assert.ok(patches.additions.some((row) => row.id === '659013'));
});

test('data builder parses inserts and escapes TSV', () => {
    const row = parseInsert(
        "INSERT INTO `region` (`id`, `name_cn`) VALUES (1, '朝阳\\n区');",
    );
    assert.deepEqual(row, { id: '1', name_cn: '朝阳\n区' });
    assert.equal(encodeTsv(row.name_cn), '朝阳\\n区');
    assert.equal(encodeTsv(null), '\\N');
});
