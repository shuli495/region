// Node.js 18+: node scripts/test-mca-api.js [--code 11] [--year 2025] [--maxLevel 2]
// 默认不传查询参数，与 Postman 示例一致；仅请求数据，不连接数据库。
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
    const url = new URL('https://dmfw.mca.gov.cn/9095/xzqh/getList');
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i].replace(/^--/, '');
        const value = args[i + 1];
        if (!['code', 'year', 'maxLevel'].includes(key) || !/^\d+$/.test(value || '')) {
            throw new Error('用法: node scripts/test-mca-api.js [--code 11] [--year 2025] [--maxLevel 2]');
        }
        if (key === 'maxLevel' && Number(value) > 2) {
            throw new Error('maxLevel 只能是 0、1、2');
        }
        url.searchParams.set(key, value);
    }

    console.log(`GET ${url}`);
    const started = Date.now();
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
    });
    const body = await response.text();
    const output = path.resolve('tmp/mca-api-response.txt');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, body);
    console.log(JSON.stringify({
        http_status: response.status,
        content_type: response.headers.get('content-type'),
        elapsed_ms: Date.now() - started,
        bytes: Buffer.byteLength(body),
        response_file: output,
    }, null, 2));

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        throw new Error(`响应不是 JSON: ${body.slice(0, 300)}`);
    }
    if (!payload || typeof payload !== 'object' || !payload.data) {
        throw new Error(`未返回 data: ${body.slice(0, 500)}`);
    }

    const levels = {};
    const stack = Array.isArray(payload.data) ? [...payload.data] : [payload.data];
    let total = 0;
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object' || typeof node.code !== 'string') {
            throw new Error('节点格式异常，缺少字符串 code');
        }
        const { code, name, level, type, children } = node;
        const group = levels[level] ||= { count: 0, code_lengths: {}, samples: [] };
        group.count++;
        group.code_lengths[code.length] = (group.code_lengths[code.length] || 0) + 1;
        if (group.samples.length < 3) group.samples.push({ code, name, level, type });
        total++;
        if (children != null) {
            if (!Array.isArray(children)) throw new Error(`children 不是数组: ${code}`);
            for (const child of children) stack.push(child);
        }
    }
    console.log(JSON.stringify({
        status: payload.status,
        message: payload.message,
        reported_total: payload.total,
        data_type: Array.isArray(payload.data) ? 'array' : 'object',
        total_nodes_including_virtual_root: total,
        levels,
    }, null, 2));
}

main().catch((error) => {
    console.error(`请求或解析失败: ${error.message}`);
    if (error.cause) console.error(`原因: ${error.cause.code || ''} ${error.cause.message}`);
    process.exitCode = 1;
});
