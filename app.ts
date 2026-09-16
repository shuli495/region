import { CronJob } from 'cron';
import KoaBody from 'koa-body';
import KoaStatic from 'koa-static';
import KoaHelmet from 'koa-helmet';
import {
    PighandFramework,
    corsDomain,
    apiInfo,
    errorHandler,
} from '@pighand/pighand-framework-koa';

import config from './config/config';
import Mysql from './config/db/Mysql';

import VersionService from './app/service/VersionService';

const { app } = PighandFramework({
    router_config: {
        appMiddleware: [
            KoaStatic(__dirname + '/public'),
            KoaBody({ multipart: true }),
            KoaHelmet(),
            corsDomain,
            apiInfo(['dev']),
            errorHandler,
        ],
        controllers: [__dirname + '/app/controller/**/*'],
    },
});

app.listen(config.port, async () => {
    await Promise.all([Promise.all([Mysql.connect()])]);

    if (Mysql.client) {
        await VersionService.setup();
        if (config.version_check_enabled) {
            const run = () => {
                void VersionService.checkNewVersion().catch(console.error);
            };
            // 每年1月10日02:00发布；小时检查负责失败重试及停机补跑。
            new CronJob('0 0 2 10 1 *', run, null, true, 'Asia/Shanghai');
            new CronJob('0 0 * * * *', run, null, true, 'Asia/Shanghai');
            run();
        }
    }
});
