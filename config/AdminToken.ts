import { randomBytes } from 'node:crypto';

/** Share the token across server bundles and development hot reloads. */
export function adminToken(): string {
    if (!process.env.REGION_ADMIN_TOKEN) {
        process.env.REGION_ADMIN_TOKEN = randomBytes(24).toString('hex');
        console.info(
            `[Region] 自动生成管理令牌：${process.env.REGION_ADMIN_TOKEN}`,
        );
    }
    return process.env.REGION_ADMIN_TOKEN;
}
