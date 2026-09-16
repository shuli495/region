// 先运行 yarn build；默认执行到期任务/续跑，--status 查看持久化进度。
const mysql = require('mysql2/promise');
const { McaSyncService } = require('../dist/app/service/McaSyncService');
async function main() {
    const pool = mysql.createPool({
        host: process.env.MINE_MYSQL_HOST,
        port: Number(process.env.MINE_MYSQL_PORT || 3306),
        user: process.env.MINE_MYSQL_USER,
        password: process.env.MINE_MYSQL_PASSWORD,
        database: process.env.MINE_MYSQL_DATABASE || 'region',
        connectionLimit: 2,
    });
    try {
        const service = new McaSyncService(pool);
        await service.setup();
        if (process.argv.includes('--prefer-remote')) {
            const index = process.argv.indexOf('--version');
            if (index < 0) throw new Error('--prefer-remote需要--version');
            await service.preferRemote(Number(process.argv[index + 1]));
        }
        if (!process.argv.includes('--status'))
            await service.run(new Date(), process.argv.includes('--now'));
        console.log(JSON.stringify(await service.status(), null, 2));
    } finally {
        await pool.end();
    }
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
