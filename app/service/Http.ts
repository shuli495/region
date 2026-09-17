import { timingSafeEqual } from 'node:crypto';
import { adminToken } from '../../config/AdminToken';
import { initialize } from './Runtime';
import VersionService from './VersionService';
import RegionService from './RegionService';
import Mysql from '../../config/db/Mysql';
import { ApiAccessService } from './ApiAccessService';
import { publicApi } from './PublicApi';

function result(data: unknown, code = 200) {
    return Response.json(
        { code, data },
        { status: code, headers: { 'Cache-Control': 'no-store' } },
    );
}
export async function handle(request: Request, resource: 'version' | 'region') {
    if (resource === 'region') return publicApi(request);
    try {
        const url = new URL(request.url);
        const path = url.pathname
            .replace(/^\/(version|region)\/?/, '')
            .replace(/\/$/, '');
        const method = request.method;
        if (resource === 'version') {
            const actual = Buffer.from(
                request.headers.get('authorization') || '',
            );
            const token = adminToken();
            const expected = Buffer.from(
                `Bearer ${request.headers.get('x-region-token-encoding') === 'uri' ? encodeURIComponent(token) : token}`,
            );
            if (
                actual.length !== expected.length ||
                !timingSafeEqual(actual, expected)
            )
                return result({ message: '无权限，请检查管理令牌' }, 401);
            const origin = request.headers.get('origin');
            // Next.js 的内部 URL 可能使用 localhost；浏览器同源地址以 Host 为准。
            const requestOrigin = new URL(url.origin);
            requestOrigin.host = request.headers.get('host') || url.host;
            if (method !== 'GET' && origin && origin !== requestOrigin.origin)
                return result({ message: '不允许跨站修改' }, 403);
        }
        const query: any = Object.fromEntries(url.searchParams);
        if (url.searchParams.has('columns'))
            query.columns = url.searchParams.getAll('columns');
        const routes = [
            '',
            'conflicts',
            'conflicts/resolve',
            'prefer-remote',
            'patches/apply',
            'releases',
            'releases/attach',
            'releases/publish',
            'releases/rollback',
            'releases/apply',
            'changes',
            'regions',
            'regions/search',
            'api-keys',
            'api-keys/update',
            'api-keys/revoke',
            'api-keys/rotate',
            'usage',
        ];
        if (!routes.includes(path))
            return result({ message: '接口不存在' }, 404);
        const allowed = ['', 'releases', 'changes', 'api-keys'].includes(path)
            ? ['GET', 'POST']
            : ['conflicts', 'regions', 'regions/search', 'usage'].includes(path)
              ? ['GET']
              : ['POST'];
        if (!allowed.includes(method))
            return result({ message: '请求方法不支持' }, 405);
        let body: any = {};
        if (method === 'POST') {
            const raw = await request.text();
            if (raw.length > 1024 * 1024)
                return result({ message: '请求过大' }, 413);
            try {
                body = raw ? JSON.parse(raw) : {};
            } catch {
                return result({ message: 'JSON格式错误' }, 400);
            }
            if (!body || typeof body !== 'object' || Array.isArray(body))
                return result({ message: '请求体必须为对象' }, 400);
        }
        await initialize();
        const access = new ApiAccessService(Mysql.client);
        if (method === 'GET' && path === 'api-keys')
            return result(await access.keys());
        if (method === 'GET' && path === 'usage')
            return result(await access.usage(query));
        if (method === 'GET' && path === 'regions')
            return result(await RegionService.query(query));
        if (method === 'GET' && path === 'regions/search')
            return result(await RegionService.search(query));
        if (method === 'POST' && path === 'api-keys')
            return result(await access.create(body));
        if (method === 'POST' && path === 'api-keys/update')
            return result(await access.update(body));
        if (method === 'POST' && path === 'api-keys/revoke')
            return result(await access.revoke(body.id));
        if (method === 'POST' && path === 'api-keys/rotate')
            return result(await access.rotate(body.id));
        const history = VersionService.history;
        if (method === 'GET') {
            if (path === '') return result(await VersionService.status());
            if (path === 'conflicts')
                return result(
                    await VersionService.conflicts(Number(query.version)),
                );
            if (path === 'releases') return result(await history.releases());
            return result(await history.changes(query));
        }
        if (path === '') {
            if (
                body.immediate !== undefined &&
                typeof body.immediate !== 'boolean'
            )
                return result({ message: 'immediate必须为布尔值' }, 400);
            void VersionService.checkNewVersion(body.immediate === true).catch(
                console.error,
            );
            return result({ accepted: true }, 202);
        }
        if (path === 'patches/apply')
            return result(await VersionService.patches.apply(body.packages));
        if (path === 'changes') return result(await history.edit(body));
        if (path === 'releases')
            return result(await history.create(body.title, body.operation_ids));
        if (path === 'releases/attach')
            return result(
                await history.attach(body.version, body.operation_ids),
            );
        if (path === 'releases/publish')
            return result(await history.publish(body.version));
        if (path === 'releases/rollback' || path === 'releases/apply')
            return result(
                await history.replay(
                    body.version,
                    path.endsWith('rollback') ? 'rollback' : 'apply',
                ),
            );
        if (path === 'prefer-remote')
            return result(
                await VersionService.preferRemote(Number(body.version)),
                202,
            );
        const resolved = await VersionService.resolve(
            Number(body.version),
            body.resolutions,
        );
        return result(resolved, resolved.ready ? 202 : 200);
    } catch (error: any) {
        console.error(error);
        if (error.code || /数据库未配置/.test(error.message))
            return result(
                { message: '数据库暂不可用，请检查连接配置及建表状态' },
                503,
            );
        return result({ message: error.message || '请求失败' }, 400);
    }
}
