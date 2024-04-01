import { Context } from 'koa';
import {
    BaseController,
    Controller,
    Post,
} from '@pighand/pighand-framework-koa';

import RegionService from '../service/RegionService';
import VersionService from '../service/VersionService';

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
        const { type, version } = ctx.request.body;

        if (!type || !version) {
            this.throw('参数错误');
        }

        if (type != 'base' && type != 'cn' && type != 'other') {
            this.throw('type错误');
        }

        const result = await VersionService.cutVersion(type, version);

        return super.result(ctx, result);
    }
}

export default RegionController;
