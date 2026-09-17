import type { Metadata } from 'next';
export const dynamic = 'force-static';
export const metadata: Metadata = {
    title: 'API 文档 · Region',
    description: '行政区划查询 API 的授权、参数、响应和分页说明。',
};

function Params({ rows }: { rows: string[][] }) {
    return (
        <div className="table-scroll">
            <table>
                <thead>
                    <tr>
                        <th>参数</th>
                        <th>类型</th>
                        <th>说明</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(([name, type, description]) => (
                        <tr key={name}>
                            <td>
                                <code>{name}</code>
                            </td>
                            <td>{type}</td>
                            <td>{description}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
const listExample = `curl 'http://localhost:3099/region?size=20' \\
  -H 'X-API-Key: rg_YOUR_API_KEY'`;
const childExample = `curl 'http://localhost:3099/region?parent_id=123&size=100&columns=lat&columns=lng' \\
  -H 'X-API-Key: rg_YOUR_API_KEY'`;
const searchExample = `curl --get 'http://localhost:3099/region/search' \\
  -H 'X-API-Key: rg_YOUR_API_KEY' \\
  --data-urlencode 'parent_id=123' \\
  --data-urlencode 'keyword=朝阳' \\
  --data-urlencode 'size=20'`;

export default function Docs() {
    return (
        <div className="docs-shell">
            <header className="docs-header">
                <a className="brand" href="/docs">
                    Region<span className="brand-dot">.</span>
                </a>
                <span className="eyebrow">DEVELOPER REFERENCE</span>
                <a className="docs-console" href="/">
                    进入控制台 ↗
                </a>
            </header>
            <div className="docs-layout">
                <aside className="docs-nav">
                    <span className="eyebrow">API REFERENCE</span>
                    <nav aria-label="文档目录">
                        <a href="#quickstart">01 / 快速开始</a>
                        <a href="#authentication">02 / 授权方式</a>
                        <a href="#regions">03 / 区划列表</a>
                        <a href="#search">04 / 范围搜索</a>
                        <a href="#pagination">05 / 游标分页</a>
                        <a href="#errors">06 / 错误处理</a>
                    </nav>
                </aside>
                <main className="docs-content">
                    <div className="docs-hero">
                        <span className="eyebrow">
                            REGION API / HTTP + JSON
                        </span>
                        <h1>
                            连接世界的
                            <br />
                            每一级区划<span className="heading-dot">.</span>
                        </h1>
                        <p>
                            从大洲、国家到省市、乡镇，用统一的数据结构连接你的应用。
                        </p>
                        <div className="docs-pills">
                            <span>GET 只读接口</span>
                            <span>API Key 授权</span>
                            <span>游标分页</span>
                        </div>
                    </div>
                    <section id="quickstart">
                        <span className="eyebrow">01 / GET STARTED</span>
                        <h2>快速开始</h2>
                        <p>
                            管理员在控制台「授权 Key」中创建一个
                            Key。将它放入每次请求的 <code>X-API-Key</code>{' '}
                            请求头，即可查询数据。
                        </p>
                        <pre>{listExample}</pre>
                        <p className="muted">
                            示例使用本地服务地址。部署后请换成你的服务地址，并使用
                            HTTPS。此页面不会执行示例或调用业务接口。
                        </p>
                    </section>
                    <section id="authentication">
                        <span className="eyebrow">02 / AUTHENTICATION</span>
                        <h2>每一次调用，都需要授权</h2>
                        <pre>{'X-API-Key: rg_YOUR_API_KEY'}</pre>
                        <p>
                            授权 Key
                            由后台生成，完整内容仅在创建或轮换后显示一次。管理员可以修改名称和有效期、停用、启用、轮换或撤销。
                        </p>
                        <ul>
                            <li>
                                未提供、无效、停用、撤销或过期的 Key 均返回{' '}
                                <code>401</code>。
                            </li>
                            <li>
                                轮换后旧 Key 立即失效，原 Key
                                的用量历史保留；轮换不会自动启用已停用的
                                Key，也不会延长有效期。
                            </li>
                            <li>
                                管理令牌只用于后台管理，不能替代对外查询所需的
                                API Key。
                            </li>
                            <li>
                                请通过请求头传递 Key，不要放在 URL
                                中。建议由你的服务端调用，避免将 Key
                                暴露到公开网页代码中。
                            </li>
                        </ul>
                    </section>
                    <section id="regions">
                        <span className="eyebrow">03 / REGION LIST</span>
                        <div className="endpoint-title">
                            <span className="method">GET</span>
                            <h2>/region</h2>
                        </div>
                        <p>
                            查询指定父节点的直接子节点。不传{' '}
                            <code>parent_id</code>{' '}
                            时返回根节点。响应中保留字符串行政代码和独立的内部数字
                            ID。
                        </p>
                        <Params
                            rows={[
                                [
                                    'parent_id',
                                    'integer · 可选',
                                    '父节点的内部 ID，正整数；不是行政区划代码。省略时查根节点。',
                                ],
                                [
                                    'size',
                                    'integer · 可选',
                                    '每页条数，1–1000，默认 200。',
                                ],
                                [
                                    'after_id',
                                    'integer · 可选',
                                    '上一页的 next_after_id，默认 0；首屏可以省略。',
                                ],
                                [
                                    'columns',
                                    'string · 可重复',
                                    '追加返回字段，例如 columns=lat&columns=lng。默认字段始终返回。',
                                ],
                            ]}
                        />
                        <pre>{childExample}</pre>
                        <h3>响应示例</h3>
                        <pre>
                            {JSON.stringify(
                                {
                                    code: 200,
                                    data: {
                                        records: [
                                            {
                                                id: 124,
                                                code: '110101',
                                                level_type: 610,
                                                has_children: 1,
                                                name_cn: '示例区',
                                                name_en: null,
                                                lat: 39.9,
                                                lng: 116.4,
                                            },
                                        ],
                                        has_more: true,
                                        next_after_id: 124,
                                    },
                                },
                                null,
                                2,
                            )}
                        </pre>
                        <p className="muted">
                            示例 ID
                            和内容仅用于展示格式，不代表当前数据库。请先从根节点逐级查询，取得真实的内部
                            ID。
                        </p>
                        <h3>返回字段</h3>
                        <Params
                            rows={[
                                [
                                    'id',
                                    'integer',
                                    '内部 ID，后续作为 parent_id 使用。',
                                ],
                                [
                                    'code',
                                    'string',
                                    '原始行政代码，按字符串处理。',
                                ],
                                [
                                    'level_type',
                                    'integer',
                                    '区划类型，例如 110 大洲、210 国家、310 省、410 直辖市、510 地级市、610 市辖区/县级市、710 镇、760 街道、810 村。',
                                ],
                                ['has_children', '0 | 1', '是否存在下级节点。'],
                                [
                                    'name_cn / name_en',
                                    'string | null',
                                    '中文和英文名称，来源缺失时可能为 null。',
                                ],
                                [
                                    'parent_id / depth',
                                    'integer | null',
                                    '可追加：父节点内部 ID 和层级深度。',
                                ],
                                [
                                    'name_local / name_pinyin / name_jianpin',
                                    'string | null',
                                    '可追加：本地名称、拼音和简拼。',
                                ],
                                [
                                    'lat / lng',
                                    'number | null',
                                    '可追加：纬度和经度。',
                                ],
                                [
                                    'region_code / phone_code / utc / osm_id',
                                    'string | null',
                                    '可追加：地区代码、电话区号、UTC 偏移、OSM 编号。',
                                ],
                                [
                                    'zone / capital / geo_names_id',
                                    'number | null',
                                    '可追加：时区编号、首府标记、GeoNames 编号。',
                                ],
                            ]}
                        />
                    </section>
                    <section id="search">
                        <span className="eyebrow">04 / SCOPED SEARCH</span>
                        <div className="endpoint-title">
                            <span className="method">GET</span>
                            <h2>/region/search</h2>
                        </div>
                        <p>
                            在一个父节点的直接子节点范围内搜索名称或代码。不会递归搜索整棵子树，也不提供全局搜索。
                        </p>
                        <Params
                            rows={[
                                [
                                    'parent_id',
                                    'integer · 必填',
                                    '搜索范围对应的父节点内部 ID。',
                                ],
                                [
                                    'keyword',
                                    'string · 必填',
                                    '1–128 个字符，去除首尾空白后不能为空；匹配已存储的名称、拼音和代码。',
                                ],
                                [
                                    'size',
                                    'integer · 可选',
                                    '每页条数，1–1000，默认 200。',
                                ],
                                [
                                    'after_id',
                                    'integer · 可选',
                                    '上一页的 next_after_id，默认 0。',
                                ],
                            ]}
                        />
                        <pre>{searchExample}</pre>
                        <pre>
                            {JSON.stringify(
                                {
                                    code: 200,
                                    data: {
                                        records: [{ region_id: 124 }],
                                        has_more: false,
                                        next_after_id: null,
                                    },
                                },
                                null,
                                2,
                            )}
                        </pre>
                        <p>
                            搜索只返回 <code>region_id</code>
                            ，不返回节点详情。可与同一父节点下的列表数据按内部
                            ID 匹配。
                        </p>
                    </section>
                    <section id="pagination">
                        <span className="eyebrow">05 / PAGINATION</span>
                        <h2>按游标逐页读取</h2>
                        <ol>
                            <li>
                                首次请求省略 <code>after_id</code>。
                            </li>
                            <li>
                                如果 <code>has_more</code> 为 true，把{' '}
                                <code>next_after_id</code> 作为下一次请求的{' '}
                                <code>after_id</code>，其他参数保持不变。
                            </li>
                            <li>
                                当 <code>has_more</code> 为 false
                                时结束，不再发送下一页请求。
                            </li>
                        </ol>
                        <p>
                            接口按内部 ID
                            升序返回，不提供页码或总记录数。数据在分页过程中可能发生更新，不保证跨多次请求的快照一致性。
                        </p>
                    </section>
                    <section id="errors">
                        <span className="eyebrow">06 / ERROR HANDLING</span>
                        <h2>一致的响应结构</h2>
                        <p>
                            响应为 JSON：成功时 <code>data</code>{' '}
                            包含查询结果，失败时 <code>data.message</code>{' '}
                            包含说明。<code>code</code> 与 HTTP 状态码一致。
                        </p>
                        <Params
                            rows={[
                                [
                                    '200',
                                    '成功',
                                    '请求成功；没有匹配结果时 records 为空数组。',
                                ],
                                [
                                    '400',
                                    '参数错误',
                                    'ID、页大小、关键词或追加字段不合法。',
                                ],
                                [
                                    '401',
                                    '未授权',
                                    '请检查 X-API-Key、Key 状态及有效期。',
                                ],
                                ['404', '路径错误', '接口路径不存在。'],
                                ['405', '方法错误', '查询接口只支持 GET。'],
                                [
                                    '503',
                                    '暂时不可用',
                                    '数据库未配置或暂时不可用，请稍后重试。',
                                ],
                            ]}
                        />
                        <pre>
                            {JSON.stringify(
                                {
                                    code: 401,
                                    data: {
                                        message:
                                            '授权 Key 无效、已停用或已过期，请通过 X-API-Key 请求头提供有效 Key',
                                    },
                                },
                                null,
                                2,
                            )}
                        </pre>
                    </section>
                    <footer className="workspace-footer">
                        REGION API <span>清晰的数据，稳定的连接。</span>
                        <a href="/">管理控制台 ↗</a>
                    </footer>
                </main>
            </div>
        </div>
    );
}
