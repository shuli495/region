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

    if (config.version_check_enabled) {
        new CronJob(
            config.version_check_corn,
            function () {
                VersionService.checkNewVersion().catch(console.error);
            },
            null,
            true,
        );

        VersionService.checkNewVersion().catch(console.error);
    }
});
