import Mysql from '../../config/db/Mysql';
import VersionService from './VersionService';
import { ApiAccessService } from './ApiAccessService';

let ready: Promise<void> | undefined;
export function initialize() {
    if (!ready)
        ready = (async () => {
            if (!Mysql.client) await Mysql.connect();
            if (!Mysql.client)
                throw new Error('数据库未配置，请设置 MINE_MYSQL 环境变量');
            await VersionService.setup();
            await new ApiAccessService(Mysql.client).setup();
        })().catch((error) => {
            ready = undefined;
            throw error;
        });
    return ready;
}
