import config_local from './config_local';
import config_dev from './config_dev';
import config_test from './config_test';
import config_default from './config_default';
import config_production from './config_production';
import { ConfigInterface } from './ConfigInterface';

let nodeEnvDev = 'dev';
let nodeEnvTest = 'test';
let nodeEnvPro = 'pro';

/**
 * 配置文件处理
 */
// 根据环境变量获取相应配置
let envConfig: ConfigInterface = config_local;
if (process.env.NODE_ENV === 'dev' || process.env.NODE_ENV === 'develop') {
    envConfig = config_dev;
    nodeEnvDev = process.env.NODE_ENV;
} else if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'uat') {
    envConfig = config_test;
    nodeEnvTest = process.env.NODE_ENV;
} else if (
    process.env.NODE_ENV === 'pro' ||
    process.env.NODE_ENV === 'prod' ||
    process.env.NODE_ENV === 'production'
) {
    envConfig = config_production;
    nodeEnvPro = process.env.NODE_ENV;
}

// 配置文件生效级别
// 1级 - 环境变量
// 2级 - NODE_ENV指定的配置文件
// 3级 - 默认配置文件
let config: ConfigInterface = {
    env: process.env.NODE_ENV,
    ...config_default,
    ...envConfig,
    local: {
        ...config_default,
        ...config_local,
    },
    dev: {
        ...config_default,
        ...config_dev,
        envName: nodeEnvDev,
    },
    test: {
        ...config_default,
        ...config_test,
        envName: nodeEnvTest,
    },
    pro: {
        ...config_default,
        ...config_production,
        envName: nodeEnvPro,
    },
};

export default config;
