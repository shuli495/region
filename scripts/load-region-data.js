const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mysql = require('mysql2/promise');
const {
    PatchService,
    PATCH_SCHEMA,
} = require('../dist/app/service/PatchService');
const { HISTORY_SCHEMA } = require('../dist/app/service/DataHistoryService');

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

async function load(connection, input, patchDirectory) {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(input, 'manifest.json'), 'utf8'),
    );
    if (manifest.format !== 'region-base-v1')
        throw new Error('请重新运行 npm run data:build 生成未打补丁的基础数据');
    let locked = false;
    try {
        const schema = fs.readFileSync('data/schema/region.sql', 'utf8');
        for (const statement of schema.split(';').map((sql) => sql.trim())) {
            if (statement) await connection.query(statement);
        }

        for (const sql of [...HISTORY_SCHEMA, PATCH_SCHEMA])
            await connection.query(sql);
        const [[lock]] = await connection.query(
            "SELECT GET_LOCK('region-data-patch',0) AS acquired",
        );
        if (Number(lock.acquired) !== 1)
            throw new Error('其他更新正在运行，请稍后重试');
        locked = true;
        await connection.beginTransaction();
        for (const table of [
            'data_version',
            'region_patch',
            'region_data_release',
            'region_change_log',
        ]) {
            const [[row]] = await connection.query(
                `SELECT COUNT(*) AS n FROM ${table}`,
            );
            if (Number(row.n))
                throw new Error('数据库已有版本历史，不能初始化');
        }
        const datasets = [
            ['region', manifest.region],
            ['region_detail', manifest.region_detail],
            ['region_search', manifest.region_search],
        ];
        for (const [table, dataset] of datasets) {
            const [[count]] = await connection.query(
                `SELECT COUNT(*) AS total FROM \`${table}\``,
            );
            if (Number(count.total) !== 0) {
                throw new Error(`${table} 不是空表，已停止导入`);
            }
        }

        for (const [table, dataset] of datasets) {
            for (const file of dataset.files) {
                const filePath = path.join(input, file);
                await loadFile(connection, table, dataset.columns, filePath);
            }
            const [[loaded]] = await connection.query(
                `SELECT COUNT(*) AS total FROM ${table}`,
            );
            if (Number(loaded.total) !== dataset.rows)
                throw new Error(`${table} 导入行数不匹配`);
        }
        const [[integrity]] = await connection.query(
            'SELECT COUNT(*) AS n FROM region r LEFT JOIN region p ON p.id=r.parent_id WHERE r.parent_id IS NOT NULL AND p.id IS NULL',
        );
        if (Number(integrity.n)) throw new Error('导入数据存在缺失父节点');
        const patches = await new PatchService(null, patchDirectory).applyIn(
            connection,
            true,
        );
        const [[count]] = await connection.query(
            'SELECT COUNT(*) AS n FROM region',
        );
        await connection.commit();
        return { region: Number(count.n), patches, missing_parents: 0 };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        if (locked)
            await connection.query("SELECT RELEASE_LOCK('region-data-patch')");
    }
}

async function main() {
    const input = path.resolve(argument('--input', 'tmp/region-data'));
    const database = process.env.MINE_MYSQL_DATABASE || 'region';
    const connection = await mysql.createConnection({
        host: process.env.MINE_MYSQL_HOST,
        port: Number(process.env.MINE_MYSQL_PORT || 3306),
        user: process.env.MINE_MYSQL_USER,
        password: process.env.MINE_MYSQL_PASSWORD,
        database,
        connectTimeout: 10000,
    });

    try {
        console.log(JSON.stringify(await load(connection, input), null, 2));
    } finally {
        await connection.end();
    }
}

function decodeTsv(value) {
    if (value === '\\N') return null;
    const escapes = { t: '\t', r: '\r', n: '\n', '\\': '\\' };
    return value.replace(
        /\\(.)/g,
        (_, character) => escapes[character] ?? character,
    );
}

async function loadFile(connection, table, columns, filePath) {
    const columnSql = columns.map((column) => `\`${column}\``).join(', ');
    const lines = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity,
    });
    let batch = [];

    for await (const line of lines) {
        batch.push(line.split('\t').map(decodeTsv));
        if (batch.length === 2000) {
            await connection.query(
                `INSERT INTO \`${table}\` (${columnSql}) VALUES ?`,
                [batch],
            );
            batch = [];
        }
    }
    if (batch.length) {
        await connection.query(
            `INSERT INTO \`${table}\` (${columnSql}) VALUES ?`,
            [batch],
        );
    }
}

if (require.main === module)
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });

module.exports = { load };
