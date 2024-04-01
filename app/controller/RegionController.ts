import { Context } from 'koa';
import {
    BaseController,
    Controller,
    Get,
} from '@pighand/pighand-framework-koa';

import RegionService from '../service/RegionService';

/**
 * 行政区划查询
 *
 * @author shuli495
 * @createDate 2024-03-12 15:24:49
 */
@Controller('region')
class RegionController extends BaseController(RegionService) {
    /**
     * 列表查询
     */
    @Get()
    async create(ctx: Context) {
        const params = ctx.query;

        const result = await RegionService.query(params as any);

        return super.result(ctx, result);
    }
}

export default RegionController;
