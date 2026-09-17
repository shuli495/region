// Next.js loads .env.local/.env before importing server modules.
const mysqlPort = Number(process.env.MINE_MYSQL_PORT || 3306);
if (!Number.isInteger(mysqlPort) || mysqlPort < 1 || mysqlPort > 65535) {
    throw new Error('MINE_MYSQL_PORT 必须是 1-65535 之间的整数');
}

export default {
    mysql_database: process.env.MINE_MYSQL_DATABASE || 'region',
    mysql_username: process.env.MINE_MYSQL_USER,
    mysql_password: process.env.MINE_MYSQL_PASSWORD,
    mysql_host: process.env.MINE_MYSQL_HOST,
    mysql_port: mysqlPort,
};
