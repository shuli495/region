/**
 * 配置接口
 */

export interface ConfigInterface {
    host?: string;
    env?: string;

    local?: any;
    dev?: any;
    test?: any;
    pro?: any;

    port?: number;

    // mysql相关配置
    mysql_database?: string;
    mysql_username?: string;
    mysql_password?: string;
    mysql_host?: string;
    mysql_port?: number;
    mysql_log?: any;

    // 版本检查定时器
    version_check_corn?: string;
    // 是否自动更新行政区划数据
    version_auto_update?: boolean;
    // 重启命令
    restart_command?: string;
}
