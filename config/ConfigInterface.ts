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

    // 是否启用版本检查任务
    version_check_enabled?: boolean;
    // 版本管理接口令牌
    version_admin_token?: string;
}
