import Mysql from '../../config/db/Mysql';
import { initialize } from './Runtime';
import { ApiAccessService } from './ApiAccessService';
import RegionService from './RegionService';

/** Every public region request uses an API key, including requests from admins. */
export async function publicApi(request: Request) {
    const started = performance.now();
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/region\/?/, '').replace(/\/$/, '');
    const endpoint =
        path === ''
            ? '/region'
            : path === 'search'
              ? '/region/search'
              : '/region/*';
    let keyId = 0,
        ready = false;
    let status = 500;
    let data: unknown;
    try {
        await initialize();
        ready = true;
        const auth = await new ApiAccessService(Mysql.client).authorize(
            request.headers.get('x-api-key'),
        );
        keyId = auth.id;
        if (!auth.allowed) {
            status = 401;
            data = {
                message:
                    '授权 Key 无效、已停用或已过期，请通过 X-API-Key 请求头提供有效 Key',
            };
        } else if (!['', 'search'].includes(path)) {
            status = 404;
            data = { message: '接口不存在' };
        } else if (request.method !== 'GET') {
            status = 405;
            data = { message: '仅支持 GET 请求' };
        } else {
            const query: any = Object.fromEntries(url.searchParams);
            if (url.searchParams.has('columns'))
                query.columns = url.searchParams.getAll('columns');
            data = await (path === 'search'
                ? RegionService.search(query)
                : RegionService.query(query));
            status = 200;
        }
    } catch (error: any) {
        if (error.code || /数据库未配置/.test(error.message)) {
            status = 503;
            data = { message: '数据库暂不可用，请稍后重试' };
        } else {
            status = 400;
            data = { message: error.message || '请求参数错误' };
        }
        console.error(error);
    }
    if (ready) {
        // Do not turn a successful read into an error when metrics storage fails.
        try {
            await new ApiAccessService(Mysql.client).record(
                keyId,
                endpoint,
                status,
                performance.now() - started,
            );
        } catch (error) {
            console.error('[Region] 用量统计写入失败', error);
        }
    }
    return Response.json(
        { code: status, data },
        {
            status,
            headers: {
                'Cache-Control': 'no-store',
                ...(status === 405 ? { Allow: 'GET' } : {}),
            },
        },
    );
}
