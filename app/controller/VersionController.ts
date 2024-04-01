import { Context } from 'koa';
import { timingSafeEqual } from 'crypto';
import {
    BaseController,
    Controller,
    Post,
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
    /**
     * 切换版本号
     * @param ctx
     * @returns
     */
    @Post()
    async test(ctx: Context) {
        if (!config.version_admin_token) {
            this.throw('版本管理接口未启用', 404);
        }

        const authorization = ctx.get('authorization');
        const expectedAuthorization = `Bearer ${config.version_admin_token}`;
        const actualBuffer = Buffer.from(authorization);
        const expectedBuffer = Buffer.from(expectedAuthorization);
        if (
            actualBuffer.length !== expectedBuffer.length ||
            !timingSafeEqual(actualBuffer, expectedBuffer)
        ) {
            this.throw('无权限', 401);
        }

        const { type, version } = ctx.request.body || {};

        if (
            !type ||
            !Number.isInteger(Number(version)) ||
            Number(version) < 1
        ) {
            this.throw('参数错误');
        }

        if (type != 'base' && type != 'cn' && type != 'other') {
            this.throw('type错误');
        }

        const result = await VersionService.cutVersion(type, Number(version));

        return super.result(ctx, result);
    }
}

export default RegionController;
