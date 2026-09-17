export async function register() {
    if (
        process.env.NEXT_RUNTIME !== 'nodejs' ||
        process.env.NEXT_PHASE === 'phase-production-build'
    )
        return;
    const { adminToken } = await import('./config/AdminToken');
    adminToken();
    if (
        process.env.REGION_VERSION_CHECK_ENABLED === 'false' ||
        !process.env.MINE_MYSQL_HOST
    )
        return;
    const { CronJob } = await import('cron');
    const { initialize } = await import('./app/service/Runtime');
    const { default: version } = await import('./app/service/VersionService');
    const state = globalThis as typeof globalThis & {
        regionSchedule?: boolean;
    };
    if (state.regionSchedule) return;
    state.regionSchedule = true;
    const run = () => {
        void initialize()
            .then(() => version.checkNewVersion())
            .catch(console.error);
    };
    new CronJob('0 0 * * * *', run, null, true, 'Asia/Shanghai');
    run();
}
