import { ConfigInterface } from './ConfigInterface';

/**
 * 默认环境配置文件
 */
const config_default: ConfigInterface = {
    port: 3099,

    mysql_database: 'region',
    mysql_username: process.env.MINE_MYSQL_USER,
    mysql_password: process.env.MINE_MYSQL_PASSWORD,
    mysql_host: process.env.MINE_MYSQL_HOST,
    mysql_port: Number(process.env.MINE_MYSQL_PORT),
    mysql_log: console.log,

    version_check_corn: '0 0 0 * * *',
    version_auto_update: true,
};

export default config_default;
