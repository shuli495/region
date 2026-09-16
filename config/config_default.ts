import { ConfigInterface } from './ConfigInterface';

const mysqlPort = Number(process.env.MINE_MYSQL_PORT || 3306);
if (!Number.isInteger(mysqlPort) || mysqlPort < 1 || mysqlPort > 65535) {
    throw new Error('MINE_MYSQL_PORT 必须是 1-65535 之间的整数');
}

const versionAdminToken = process.env.REGION_ADMIN_TOKEN;
if (versionAdminToken && versionAdminToken.length < 32) {
    throw new Error('REGION_ADMIN_TOKEN 长度不能少于 32 个字符');
}

/**
 * 默认环境配置文件
 */
const config_default: ConfigInterface = {
    port: 3099,

    mysql_database: process.env.MINE_MYSQL_DATABASE || 'region',
    mysql_username: process.env.MINE_MYSQL_USER,
    mysql_password: process.env.MINE_MYSQL_PASSWORD,
    mysql_host: process.env.MINE_MYSQL_HOST,
    mysql_port: mysqlPort,
    mysql_log: false,

    version_check_enabled: process.env.REGION_VERSION_CHECK_ENABLED !== 'false',
    version_admin_token: versionAdminToken,
};

export default config_default;
