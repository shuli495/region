const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mysql = require('mysql2/promise');

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
    const input = path.resolve(argument('--input', 'tmp/region-data'));
    const manifest = JSON.parse(
        fs.readFileSync(path.join(input, 'manifest.json'), 'utf8'),
    );
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
        const schema = fs.readFileSync('data/schema/region.sql', 'utf8');
        for (const statement of schema.split(';').map((sql) => sql.trim())) {
            if (statement) await connection.query(statement);
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
                console.log(`loading ${table}: ${file}`);
                await loadFile(connection, table, dataset.columns, filePath);
            }

            const [[loaded]] = await connection.query(
                `SELECT COUNT(*) AS total FROM \`${table}\``,
            );
            if (Number(loaded.total) !== dataset.rows) {
                throw new Error(
                    `${table} 行数错误: ${loaded.total}, 期望 ${dataset.rows}`,
                );
            }
        }

        const [[integrity]] = await connection.query(
            'SELECT COUNT(*) AS total FROM region child LEFT JOIN region parent ON parent.id = child.parent_id WHERE child.parent_id IS NOT NULL AND parent.id IS NULL',
        );
        if (Number(integrity.total) !== 0) {
            throw new Error(`存在 ${integrity.total} 条缺失父节点的数据`);
        }

        console.log(
            JSON.stringify(
                {
                    database,
                    region: manifest.region.rows,
                    region_detail: manifest.region_detail.rows,
                    region_search: manifest.region_search.rows,
                    missing_parents: 0,
                },
                null,
                2,
            ),
        );
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

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
