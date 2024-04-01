import { ConfigInterface } from './ConfigInterface';

/**
 * 生产环境配置文件
 */
const config: ConfigInterface = {
    restart_command: 'yarn pm2:pro',
};

export default config;
