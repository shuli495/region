import { Context } from 'koa';
import { timingSafeEqual } from 'crypto';
import {
    BaseController,
    Controller,
    Post,
    Get,
} from '@pighand/pighand-framework-koa';

import RegionService from '../service/RegionService';
import VersionService from '../service/VersionService';
import config from '../../config/config';

/**
 * 版本号
 *
 * @author shuli495
 * @createDate 2024-03-12 15:24:49
 */
@Controller('version')
class RegionController extends BaseController(RegionService) {
    private authorize(ctx: Context) {
        if (!config.version_admin_token) this.throw('版本管理接口未启用', 404);
        const actual = Buffer.from(ctx.get('authorization'));
        const expected = Buffer.from(`Bearer ${config.version_admin_token}`);
        if (
            actual.length !== expected.length ||
            !timingSafeEqual(actual, expected)
        ) {
            this.throw('无权限', 401);
        }
    }

    @Get()
    async status(ctx: Context) {
        this.authorize(ctx);
        return super.result(ctx, await VersionService.status());
    }

    @Post('/prefer-remote')
    async preferRemote(ctx: Context) {
        this.authorize(ctx);
        const result = await VersionService.preferRemote(
            Number(ctx.request.body?.version),
        );
        const response = super.result(ctx, result, 202);
        ctx.status = 202;
        return response;
    }

    @Get('/conflicts')
    async conflicts(ctx: Context) {
        this.authorize(ctx);
        return super.result(
            ctx,
            await VersionService.conflicts(Number(ctx.query.version)),
        );
    }

    @Post('/conflicts/resolve')
    async resolveConflicts(ctx: Context) {
        this.authorize(ctx);
        const { version, resolutions } = ctx.request.body || {};
        const result = await VersionService.resolve(
            Number(version),
            resolutions,
        );
        const response = super.result(ctx, result, result.ready ? 202 : 200);
        ctx.status = result.ready ? 202 : 200;
        return response;
    }

    @Get('/releases')
    async releases(ctx: Context) {
        this.authorize(ctx);
        return super.result(ctx, await VersionService.history.releases());
    }
    @Get('/changes')
    async changes(ctx: Context) {
        this.authorize(ctx);
        return super.result(
            ctx,
            await VersionService.history.changes(ctx.query),
        );
    }
    @Post('/releases')
    async createRelease(ctx: Context) {
        this.authorize(ctx);
        const { title, operation_ids } = ctx.request.body || {};
        return super.result(
            ctx,
            await VersionService.history.create(title, operation_ids),
        );
    }
    @Post('/releases/attach')
    async attachRelease(ctx: Context) {
        this.authorize(ctx);
        const { version, operation_ids } = ctx.request.body || {};
        return super.result(
            ctx,
            await VersionService.history.attach(version, operation_ids),
        );
    }
    @Post('/releases/publish')
    async publishRelease(ctx: Context) {
        this.authorize(ctx);
        return super.result(
            ctx,
            await VersionService.history.publish(ctx.request.body?.version),
        );
    }
    @Post('/releases/rollback')
    async rollbackRelease(ctx: Context) {
        this.authorize(ctx);
        return super.result(
            ctx,
            await VersionService.history.replay(
                ctx.request.body?.version,
                'rollback',
            ),
        );
    }
    @Post('/releases/apply')
    async applyRelease(ctx: Context) {
        this.authorize(ctx);
        return super.result(
            ctx,
            await VersionService.history.replay(
                ctx.request.body?.version,
                'apply',
            ),
        );
    }
    @Post('/changes')
    async editData(ctx: Context) {
        this.authorize(ctx);
        return super.result(
            ctx,
            await VersionService.history.edit(ctx.request.body),
        );
    }

    /** 启动到期任务或恢复失败任务；版本由年度计划确定。 */
    @Post()
    async resume(ctx: Context) {
        this.authorize(ctx);
        void VersionService.checkNewVersion().catch(console.error);
        const result = super.result(ctx, { accepted: true }, 202);
        ctx.status = 202;
        return result;
    }
}

export default RegionController;
