'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type Key = {
    id: number;
    name: string;
    key_prefix: string;
    status: string;
    expires_at: string | null;
    expired: number;
    created_at: string;
};
type Counts = {
    requests: number;
    errors: number;
    success: number;
    avg_ms: number;
};
type Usage = {
    summary: Counts;
    daily: (Counts & { date: string })[];
    keys: (Counts & {
        key_id: number;
        name: string;
        key_prefix: string;
        last_used_at: string;
    })[];
    endpoints: (Counts & { endpoint: string })[];
};
type Api = (path: string, body?: unknown) => Promise<any>;
const format = (value: number) => value.toLocaleString('zh-CN');
const date = (value: string | null) =>
    value
        ? new Date(value).toLocaleString('zh-CN', { hour12: false })
        : '永不过期';
const statusNames: Record<string, string> = {
    enabled: '启用',
    disabled: '已停用',
    revoked: '已撤销',
};
function inputDate(value: string | null) {
    if (!value) return '';
    const timestamp = new Date(value);
    return new Date(timestamp.getTime() - timestamp.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
}
export default function ApiAccessPanel({
    mode,
    api,
    revision,
}: {
    mode: 'keys' | 'usage';
    api: Api;
    revision: number;
}) {
    const [keys, setKeys] = useState<Key[]>([]);
    const [usage, setUsage] = useState<Usage | null>(null);
    const [days, setDays] = useState('30');
    const [keyFilter, setKeyFilter] = useState('');
    const [filter, setFilter] = useState('');
    const [editing, setEditing] = useState<Key | 'new' | null>(null);
    const [secret, setSecret] = useState<{ id: number; key: string } | null>(
        null,
    );
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState('');
    const sequence = useRef(0);
    const refresh = useCallback(async () => {
        const requestId = ++sequence.current;
        setLoading(true);
        try {
            const [keyRows, stats] = await Promise.all([
                api('/version/api-keys'),
                mode === 'usage'
                    ? api(
                          `/version/usage?days=${days}${keyFilter ? `&key_id=${keyFilter}` : ''}`,
                      )
                    : Promise.resolve(null),
            ]);
            if (requestId !== sequence.current) return;
            setKeys(keyRows);
            setUsage(stats);
        } finally {
            if (requestId === sequence.current) setLoading(false);
        }
    }, [api, mode, days, keyFilter]);
    useEffect(() => {
        setError('');
        setUsage(null);
        void refresh().catch((e) => setError(e.message));
        return () => {
            sequence.current++;
        };
    }, [refresh, revision]);
    async function act(work: () => Promise<void>, message: string) {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await work();
            await refresh();
            setNotice(message);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }
    async function copy() {
        try {
            await navigator.clipboard.writeText(secret!.key);
            setNotice('Key 已复制');
        } catch {
            setNotice('无法自动复制，请手动选择并复制下方 Key');
        }
    }
    const visibleKeys = keys.filter((key) =>
        `${key.name} ${key.key_prefix}`
            .toLowerCase()
            .includes(filter.toLowerCase()),
    );
    return (
        <div className="access-panel">
            {error && (
                <p role="alert" className="error">
                    {error}
                </p>
            )}
            {notice && (
                <p role="status" className="notice banner">
                    {notice}
                </p>
            )}
            {secret && (
                <section className="secret-panel" aria-label="新生成的授权 Key">
                    <div>
                        <span className="eyebrow">SAVE YOUR KEY</span>
                        <h2>请保存这个 Key</h2>
                        <p>
                            完整内容只在本次创建或轮换后显示。关闭后无法再次查看，请妥善保存。
                        </p>
                    </div>
                    <label>
                        完整授权 Key
                        <input
                            readOnly
                            value={secret.key}
                            onFocus={(event) => event.target.select()}
                        />
                    </label>
                    <div className="tools">
                        <button className="primary" onClick={copy}>
                            复制 Key
                        </button>
                        <button onClick={() => setSecret(null)}>
                            已保存，关闭显示
                        </button>
                    </div>
                </section>
            )}
            {mode === 'keys' ? (
                <>
                    <section className="access-intro">
                        <div>
                            <span className="eyebrow">ACCESS CONTROL</span>
                            <h2>为每一个应用，分配独立访问凭证。</h2>
                            <p>
                                停用可以恢复；撤销不可恢复。轮换后旧 Key
                                失效，用量历史继续保留。
                            </p>
                        </div>
                        <a
                            className="text"
                            href="/docs"
                            target="_blank"
                            rel="noreferrer"
                        >
                            查看接入文档 ↗
                        </a>
                    </section>
                    <section className="panel">
                        <div className="panel-toolbar">
                            <div>
                                <h2>授权 Key</h2>
                                <span className="muted">
                                    {
                                        keys.filter(
                                            (key) =>
                                                key.status === 'enabled' &&
                                                !key.expired,
                                        ).length
                                    }{' '}
                                    个有效 · {keys.length} 个总计
                                </span>
                            </div>
                            <div className="tools">
                                <input
                                    aria-label="筛选授权 Key"
                                    placeholder="按名称或 Key 前缀筛选"
                                    value={filter}
                                    onChange={(e) => setFilter(e.target.value)}
                                />
                                <button
                                    className="primary"
                                    disabled={busy || loading || !!secret}
                                    onClick={() => {
                                        setError('');
                                        setEditing('new');
                                    }}
                                >
                                    ＋ 创建 Key
                                </button>
                            </div>
                        </div>
                        <div className="table-scroll">
                            <table>
                                <thead>
                                    <tr>
                                        <th>名称 / Key 前缀</th>
                                        <th>状态</th>
                                        <th>有效期</th>
                                        <th>创建时间</th>
                                        <th>操作</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibleKeys.map((key) => (
                                        <tr key={key.id}>
                                            <td>
                                                <strong>{key.name}</strong>
                                                <small className="mono muted">
                                                    {key.key_prefix}…
                                                </small>
                                            </td>
                                            <td>
                                                <span
                                                    className={`badge ${key.status === 'enabled' && !key.expired ? 'applied' : key.status === 'revoked' ? 'failed' : 'draft'}`}
                                                >
                                                    {key.status === 'enabled' &&
                                                    key.expired
                                                        ? '已过期'
                                                        : statusNames[
                                                              key.status
                                                          ]}
                                                </span>
                                            </td>
                                            <td>{date(key.expires_at)}</td>
                                            <td className="muted">
                                                {date(key.created_at)}
                                            </td>
                                            <td>
                                                <div className="key-actions">
                                                    {key.status !==
                                                    'revoked' ? (
                                                        <>
                                                            <button
                                                                className="text"
                                                                disabled={busy}
                                                                onClick={() => {
                                                                    setError(
                                                                        '',
                                                                    );
                                                                    setEditing(
                                                                        key,
                                                                    );
                                                                }}
                                                            >
                                                                编辑
                                                            </button>
                                                            <button
                                                                className="text"
                                                                disabled={busy}
                                                                onClick={() =>
                                                                    act(
                                                                        async () => {
                                                                            await api(
                                                                                '/version/api-keys/update',
                                                                                {
                                                                                    id: key.id,
                                                                                    name: key.name,
                                                                                    expires_at:
                                                                                        key.expires_at,
                                                                                    status:
                                                                                        key.status ===
                                                                                        'enabled'
                                                                                            ? 'disabled'
                                                                                            : 'enabled',
                                                                                },
                                                                            );
                                                                        },
                                                                        key.status ===
                                                                            'enabled'
                                                                            ? 'Key 已停用'
                                                                            : 'Key 已启用；有效期保持不变',
                                                                    )
                                                                }
                                                            >
                                                                {key.status ===
                                                                'enabled'
                                                                    ? '停用'
                                                                    : '启用'}
                                                            </button>
                                                            <button
                                                                className="text"
                                                                disabled={
                                                                    busy ||
                                                                    !!secret
                                                                }
                                                                onClick={() => {
                                                                    if (
                                                                        confirm(
                                                                            `轮换「${key.name}」？旧 Key 将立即失效，需要更新调用方配置。`,
                                                                        )
                                                                    )
                                                                        void act(
                                                                            async () => {
                                                                                setSecret(
                                                                                    await api(
                                                                                        '/version/api-keys/rotate',
                                                                                        {
                                                                                            id: key.id,
                                                                                        },
                                                                                    ),
                                                                                );
                                                                            },
                                                                            '已轮换，请保存新的 Key',
                                                                        );
                                                                }}
                                                            >
                                                                轮换
                                                            </button>
                                                            <button
                                                                className="text danger"
                                                                disabled={busy}
                                                                onClick={() => {
                                                                    if (
                                                                        confirm(
                                                                            `撤销「${key.name}」？此操作不可恢复，历史用量仍会保留。`,
                                                                        )
                                                                    )
                                                                        void act(
                                                                            async () => {
                                                                                await api(
                                                                                    '/version/api-keys/revoke',
                                                                                    {
                                                                                        id: key.id,
                                                                                    },
                                                                                );
                                                                                if (
                                                                                    secret?.id ===
                                                                                    key.id
                                                                                )
                                                                                    setSecret(
                                                                                        null,
                                                                                    );
                                                                            },
                                                                            'Key 已撤销',
                                                                        );
                                                                }}
                                                            >
                                                                撤销
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <span className="muted">
                                                            历史用量已保留
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {!visibleKeys.length && (
                            <div className="empty">
                                {loading
                                    ? '正在加载授权 Key…'
                                    : keys.length
                                      ? '没有匹配的 Key'
                                      : '还没有授权 Key，创建后即可调用区划 API。'}
                            </div>
                        )}
                        <footer className="panel-footer">
                            调用方式：X-API-Key 请求头 ·
                            管理令牌不能用于公共查询
                        </footer>
                    </section>
                </>
            ) : (
                <>
                    <section className="panel usage-controls">
                        <div>
                            <span className="eyebrow">API ANALYTICS</span>
                            <p>北京时间逐日汇总 · 不包含后台操作和文档浏览</p>
                        </div>
                        <div className="tools">
                            <label>
                                时间范围
                                <select
                                    value={days}
                                    onChange={(e) => setDays(e.target.value)}
                                >
                                    <option value="7">最近 7 天</option>
                                    <option value="30">最近 30 天</option>
                                    <option value="90">最近 90 天</option>
                                </select>
                            </label>
                            <label>
                                授权 Key
                                <select
                                    value={keyFilter}
                                    onChange={(e) =>
                                        setKeyFilter(e.target.value)
                                    }
                                >
                                    <option value="">全部 Key</option>
                                    <option value="0">
                                        未识别 / 未提供 Key
                                    </option>
                                    {keys.map((key) => (
                                        <option key={key.id} value={key.id}>
                                            {key.name} · {key.key_prefix}…
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <button
                                disabled={loading || busy}
                                onClick={() => {
                                    setError('');
                                    void refresh().catch((e) =>
                                        setError(e.message),
                                    );
                                }}
                            >
                                刷新统计
                            </button>
                        </div>
                    </section>
                    {loading && !usage ? (
                        <div className="empty">正在汇总用量…</div>
                    ) : (
                        usage && (
                            <>
                                <div className="stats usage-stats">
                                    <div>
                                        <span>总调用量</span>
                                        <strong>
                                            {format(usage.summary.requests)}
                                        </strong>
                                        <small>最近 {days} 天</small>
                                    </div>
                                    <div>
                                        <span>成功率</span>
                                        <strong>
                                            {usage.summary.requests
                                                ? `${((usage.summary.success / usage.summary.requests) * 100).toFixed(1)}%`
                                                : '—'}
                                        </strong>
                                        <small>
                                            {format(usage.summary.success)}{' '}
                                            次成功
                                        </small>
                                    </div>
                                    <div>
                                        <span>错误请求</span>
                                        <strong>
                                            {format(usage.summary.errors)}
                                        </strong>
                                        <small>包含鉴权和参数错误</small>
                                    </div>
                                    <div>
                                        <span>平均处理耗时</span>
                                        <strong>
                                            {usage.summary.requests
                                                ? `${usage.summary.avg_ms} ms`
                                                : '—'}
                                        </strong>
                                        <small>不含网络和统计写入</small>
                                    </div>
                                </div>
                                <section className="panel usage-trend">
                                    <div className="panel-title">
                                        <h2>每日调用量</h2>
                                        <span className="muted">
                                            绿色：成功 · 橙色：错误
                                        </span>
                                    </div>
                                    {usage.summary.requests ? (
                                        <div
                                            className="usage-chart"
                                            role="img"
                                            aria-label={`最近${days}天的每日调用量，共${usage.summary.requests}次`}
                                        >
                                            <div className="usage-bars">
                                                {usage.daily.map((day) => {
                                                    const max = Math.max(
                                                        ...usage.daily.map(
                                                            (row) =>
                                                                row.requests,
                                                        ),
                                                        1,
                                                    );
                                                    return (
                                                        <div
                                                            className="usage-bar"
                                                            key={day.date}
                                                            title={`${day.date}：${day.requests}次，错误${day.errors}次`}
                                                        >
                                                            <span
                                                                style={{
                                                                    height: `${(day.errors / max) * 100}%`,
                                                                }}
                                                                className="bar-error"
                                                            />
                                                            <span
                                                                style={{
                                                                    height: `${(day.success / max) * 100}%`,
                                                                }}
                                                                className="bar-success"
                                                            />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="chart-axis">
                                                <span>
                                                    {usage.daily[0]?.date}
                                                </span>
                                                <span>
                                                    {usage.daily.at(-1)?.date}
                                                </span>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="empty">
                                            当前范围暂无调用记录。使用授权 Key
                                            调用接口后，在这里查看统计。
                                        </div>
                                    )}
                                    <details className="usage-details">
                                        <summary>查看每日明细</summary>
                                        <div className="table-scroll">
                                            <table>
                                                <thead>
                                                    <tr>
                                                        <th>日期</th>
                                                        <th>调用量</th>
                                                        <th>错误</th>
                                                        <th>平均耗时</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {usage.daily.map((day) => (
                                                        <tr key={day.date}>
                                                            <td>{day.date}</td>
                                                            <td>
                                                                {format(
                                                                    day.requests,
                                                                )}
                                                            </td>
                                                            <td>
                                                                {format(
                                                                    day.errors,
                                                                )}
                                                            </td>
                                                            <td>
                                                                {day.avg_ms} ms
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </details>
                                </section>
                                <section className="panel">
                                    <div className="panel-title">
                                        <h2>按 Key 汇总</h2>
                                    </div>
                                    <div className="table-scroll">
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>授权 Key</th>
                                                    <th>调用量</th>
                                                    <th>成功 / 错误</th>
                                                    <th>平均耗时</th>
                                                    <th>最近调用</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {usage.keys.map((key) => (
                                                    <tr key={key.key_id}>
                                                        <td>
                                                            {key.name}
                                                            <small className="muted mono">
                                                                {key.key_prefix
                                                                    ? `${key.key_prefix}…`
                                                                    : '鉴权失败'}
                                                            </small>
                                                        </td>
                                                        <td>
                                                            {format(
                                                                key.requests,
                                                            )}
                                                        </td>
                                                        <td>
                                                            {format(
                                                                key.success,
                                                            )}{' '}
                                                            /{' '}
                                                            {format(key.errors)}
                                                        </td>
                                                        <td>{key.avg_ms} ms</td>
                                                        <td>
                                                            {date(
                                                                key.last_used_at,
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    {!usage.keys.length && (
                                        <div className="empty">
                                            暂无 Key 用量
                                        </div>
                                    )}
                                </section>
                                <section className="panel">
                                    <div className="panel-title">
                                        <h2>按接口汇总</h2>
                                    </div>
                                    <div className="table-scroll">
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>接口</th>
                                                    <th>调用量</th>
                                                    <th>错误</th>
                                                    <th>平均耗时</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {usage.endpoints.map(
                                                    (endpoint) => (
                                                        <tr
                                                            key={
                                                                endpoint.endpoint
                                                            }
                                                        >
                                                            <td className="mono">
                                                                {
                                                                    endpoint.endpoint
                                                                }
                                                            </td>
                                                            <td>
                                                                {format(
                                                                    endpoint.requests,
                                                                )}
                                                            </td>
                                                            <td>
                                                                {format(
                                                                    endpoint.errors,
                                                                )}
                                                            </td>
                                                            <td>
                                                                {
                                                                    endpoint.avg_ms
                                                                }{' '}
                                                                ms
                                                            </td>
                                                        </tr>
                                                    ),
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                    {!usage.endpoints.length && (
                                        <div className="empty">
                                            暂无接口用量
                                        </div>
                                    )}
                                </section>
                                <p className="footnote">
                                    从功能启用后开始累计；统计写入失败或数据库不可用时，部分请求可能无法记账。
                                </p>
                            </>
                        )
                    )}
                </>
            )}
            {editing && (
                <KeyEditor
                    key={typeof editing === 'string' ? 'new' : editing.id}
                    item={editing === 'new' ? null : editing}
                    busy={busy}
                    error={error}
                    close={() => setEditing(null)}
                    save={async (values) =>
                        act(
                            async () => {
                                if (editing === 'new')
                                    setSecret(
                                        await api('/version/api-keys', values),
                                    );
                                else
                                    await api('/version/api-keys/update', {
                                        ...values,
                                        id: editing.id,
                                    });
                                setEditing(null);
                            },
                            editing === 'new'
                                ? 'Key 已创建，请保存完整内容'
                                : 'Key 设置已保存',
                        )
                    }
                />
            )}
        </div>
    );
}
function KeyEditor({
    item,
    busy,
    error,
    close,
    save,
}: {
    item: Key | null;
    busy: boolean;
    error: string;
    close: () => void;
    save: (values: {
        name: string;
        status: string;
        expires_at: string | null;
    }) => Promise<void>;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const [name, setName] = useState(item?.name || '');
    const [expires, setExpires] = useState(inputDate(item?.expires_at || null));
    const [status, setStatus] = useState(item?.status || 'enabled');
    useEffect(() => {
        const dialog = ref.current;
        dialog?.showModal();
        return () => dialog?.close();
    }, []);
    return (
        <dialog
            ref={ref}
            className="modal key-editor"
            aria-labelledby="key-editor-title"
            onCancel={(e) => {
                e.preventDefault();
                if (!busy) close();
            }}
        >
            <div className="panel-title">
                <h2 id="key-editor-title">
                    {item ? '编辑授权 Key' : '创建授权 Key'}
                </h2>
                <button disabled={busy} onClick={close}>
                    关闭
                </button>
            </div>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void save({
                        name,
                        status,
                        expires_at: expires
                            ? new Date(expires).toISOString()
                            : null,
                    });
                }}
            >
                <label>
                    名称
                    <input
                        autoFocus
                        required
                        maxLength={100}
                        placeholder="例如：官网地区选择器"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>
                <label>
                    到期时间（本地时区，留空表示永不过期）
                    <input
                        type="datetime-local"
                        value={expires}
                        onChange={(e) => setExpires(e.target.value)}
                    />
                </label>
                {item && (
                    <label>
                        状态
                        <select
                            value={status}
                            onChange={(e) => setStatus(e.target.value)}
                        >
                            <option value="enabled">启用</option>
                            <option value="disabled">停用</option>
                        </select>
                    </label>
                )}
                {error && (
                    <p role="alert" className="error">
                        {error}
                    </p>
                )}
                <div className="modal-actions">
                    <button className="primary" disabled={busy}>
                        {busy
                            ? '保存中…'
                            : item
                              ? '保存设置'
                              : '创建并显示 Key'}
                    </button>
                </div>
            </form>
        </dialog>
    );
}
