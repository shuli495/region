'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ApiAccessPanel from './ApiAccessPanel';

type Row = Record<string, any>;
type Page = { records: Row[]; has_more: boolean; next_after_id: number | null };
const empty: Page = { records: [], has_more: false, next_after_id: null };
const labels: Record<string, string> = {
    completed: '已完成',
    fetching: '抓取中',
    applying: '发布中',
    conflicts: '待处理冲突',
    failed: '失败待重试',
    draft: '草稿',
    applied: '已发布',
    rolled_back: '已回退',
    manual: '手动修订',
    auto: '自动同步',
    patch: '数据补丁',
    keep_local: '保留本地',
    delete_local: '删除本地',
    replace_code: '采用新代码',
    prefer_remote: '接口优先',
};
const levels: Record<number, string> = {
    110: '大洲',
    210: '国家',
    310: '省',
    320: '自治区',
    410: '直辖市',
    510: '地级市',
    520: '地区',
    530: '自治州',
    540: '盟',
    610: '市辖区 / 县级市',
    620: '县',
    630: '自治县',
    640: '旗',
    650: '自治旗',
    660: '特区',
    670: '林区',
    710: '镇',
    720: '乡',
    730: '民族乡',
    740: '苏木',
    750: '民族苏木',
    760: '街道',
    770: '区公所',
    780: '兵团',
    810: '村',
    820: '社区',
};
const date = (value: string) =>
    value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function Badge({ value }: { value: string }) {
    return <span className={`badge ${value}`}>{labels[value] || value}</span>;
}

export default function Dashboard() {
    const [tab, setTab] = useState('regions');
    const [accessRevision, setAccessRevision] = useState(0);
    const [token, setToken] = useState('');
    const [credential, setCredential] = useState('');
    const [authenticated, setAuthenticated] = useState(false);
    const [status, setStatus] = useState<Row>({ versions: [], jobs: [] });
    const [releases, setReleases] = useState<Row[]>([]);
    const [changes, setChanges] = useState<Page>(empty);
    const [unassigned, setUnassigned] = useState(true);
    const [releaseFilter, setReleaseFilter] = useState('');
    const [selected, setSelected] = useState<string[]>([]);
    const [title, setTitle] = useState('');
    const [regions, setRegions] = useState<Page>(empty);
    const [trail, setTrail] = useState<Row[]>([]);
    const [filter, setFilter] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(false);
    const [editor, setEditor] = useState<Row | null>(null);
    const [conflictVersion, setConflictVersion] = useState<number | null>(null);
    const [conflicts, setConflicts] = useState<Row[]>([]);
    const requestId = useRef(0);
    const changesRequestId = useRef(0);
    const canEdit = trail.some(
        (row) => row.name_cn === '中国' && row.level_type < 300,
    );
    const parent = trail.at(-1);
    const api = useCallback(
        async (path: string, body?: unknown, auth = token) => {
            const response = await fetch(path, {
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                    Authorization: `Bearer ${encodeURIComponent(auth)}`,
                    'X-Region-Token-Encoding': 'uri',
                    ...(body === undefined
                        ? {}
                        : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                cache: 'no-store',
            });
            const payload = await response.json();
            if (!response.ok)
                throw new Error(
                    payload.data?.message || `请求失败 (${response.status})`,
                );
            return payload.data;
        },
        [token],
    );
    const refresh = useCallback(async () => {
        const [nextStatus, nextReleases] = await Promise.all([
            api('/version'),
            api('/version/releases'),
        ]);
        setStatus(nextStatus);
        setReleases(nextReleases);
    }, [api]);
    const loadRegions = useCallback(
        async (after = 0) => {
            const id = ++requestId.current;
            setLoading(true);
            try {
                const query = new URLSearchParams({
                    size: '100',
                    columns: 'parent_id',
                });
                for (const column of [
                    'name_local',
                    'name_pinyin',
                    'name_jianpin',
                    'lat',
                    'lng',
                ])
                    query.append('columns', column);
                if (parent) query.set('parent_id', String(parent.id));
                if (after) query.set('after_id', String(after));
                const data = await api(`/version/regions?${query}`);
                if (id === requestId.current)
                    setRegions((previous) => ({
                        ...data,
                        records: after
                            ? [...previous.records, ...data.records]
                            : data.records,
                    }));
            } finally {
                if (id === requestId.current) setLoading(false);
            }
        },
        [api, parent],
    );
    const loadChanges = useCallback(
        async (after = 0) => {
            const id = ++changesRequestId.current;
            const query = new URLSearchParams({ limit: '100' });
            if (unassigned) query.set('unassigned', 'true');
            if (releaseFilter) query.set('version', releaseFilter);
            if (after) query.set('after_id', String(after));
            const data = await api(`/version/changes?${query}`);
            if (id !== changesRequestId.current) return;
            setChanges((previous) => ({
                ...data,
                records: after
                    ? [...previous.records, ...data.records]
                    : data.records,
            }));
        },
        [api, unassigned, releaseFilter],
    );
    useEffect(() => {
        if (authenticated && tab === 'regions') {
            setRegions(empty);
            void loadRegions().catch((e) => setError(e.message));
        }
    }, [authenticated, tab, loadRegions]);
    useEffect(() => {
        if (authenticated && tab === 'changes') {
            setSelected([]);
            void loadChanges().catch((e) => setError(e.message));
        }
    }, [authenticated, tab, loadChanges]);
    useEffect(() => {
        if (!authenticated) return;
        const timer = setInterval(() => {
            if (document.hidden) return;
            void refresh().catch((e) => setError(e.message));
            if (conflictVersion)
                void api(`/version/conflicts?version=${conflictVersion}`)
                    .then(setConflicts)
                    .catch((e) => setError(e.message));
        }, 10000);
        return () => clearInterval(timer);
    }, [authenticated, refresh, api, conflictVersion]);
    async function action(work: () => Promise<void>, message: string) {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await work();
            setNotice(message);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }
    async function login(event: React.FormEvent) {
        event.preventDefault();
        await action(async () => {
            const [nextStatus, nextReleases] = await Promise.all([
                api('/version', undefined, credential),
                api('/version/releases', undefined, credential),
            ]);
            setToken(credential);
            setCredential('');
            setStatus(nextStatus);
            setReleases(nextReleases);
            setAuthenticated(true);
        }, '已连接管理服务');
    }
    async function mutate(path: string, body: unknown, message: string) {
        await action(async () => {
            await api(path, body);
            await refresh();
            if (tab === 'changes') await loadChanges();
        }, message);
    }
    async function showConflicts(version: number) {
        await action(async () => {
            const data = await api(`/version/conflicts?version=${version}`);
            setConflicts(data);
            setConflictVersion(version);
        }, '');
    }
    async function resolve(conflict: Row, resolution: string, target?: string) {
        if (
            resolution === 'delete_local' &&
            !confirm(
                `删除 ${conflict.detail.local.name_cn} 及其子树（共 ${conflict.detail.subtree_nodes} 个节点）？决定完成后会自动发布。`,
            )
        )
            return;
        await action(async () => {
            await api('/version/conflicts/resolve', {
                version: conflictVersion,
                resolutions: [
                    {
                        code: conflict.code,
                        fingerprint: conflict.fingerprint,
                        action: resolution,
                        ...(target ? { target_code: target } : {}),
                    },
                ],
            });
            setConflicts(
                await api(`/version/conflicts?version=${conflictVersion}`),
            );
            await refresh();
        }, '决定已保存；全部解决后自动继续发布');
    }
    const current = status.versions.find((v: Row) => Number(v.scope) === 2);
    const latest = status.jobs[0];
    const draft = releases.find((r) => r.status === 'draft');
    const tabs = [
        { id: 'regions', icon: '◎', title: '区划数据', sub: 'DATA EXPLORER' },
        { id: 'sync', icon: '↻', title: '版本升级', sub: 'SYNC & UPGRADE' },
        { id: 'releases', icon: '▤', title: '发布历史', sub: 'RELEASES' },
        { id: 'changes', icon: '≡', title: '修改日志', sub: 'CHANGE LOG' },
        { id: 'keys', icon: '⌘', title: '授权 Key', sub: 'API KEYS' },
        { id: 'usage', icon: '▥', title: '用量统计', sub: 'API ANALYTICS' },
    ];
    const active = tabs.find((item) => item.id === tab)!;
    if (!authenticated)
        return (
            <main className="login">
                <section className="login-art">
                    <span className="eyebrow">
                        REGION / DATA INFRASTRUCTURE
                    </span>
                    <div className="globe" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                        <b>R.</b>
                    </div>
                    <h1>
                        让每一处变化，
                        <br />
                        都有迹可循。
                    </h1>
                    <p>全球行政区划 · 数据管理 · 版本演进</p>
                    <span className="edition">REGION CONTROL / 01</span>
                </section>
                <section className="login-form">
                    <div className="login-inner">
                        <span className="brand">
                            Region<span> / 控制台</span>
                        </span>
                        <h2>连接你的数据</h2>
                        <p className="muted">
                            输入管理员令牌，进入行政区划工作台。
                        </p>
                        <form onSubmit={login}>
                            <label>
                                管理令牌
                                <input
                                    autoFocus
                                    type="password"
                                    required
                                    autoComplete="off"
                                    value={credential}
                                    onChange={(e) =>
                                        setCredential(e.target.value)
                                    }
                                    placeholder="REGION_ADMIN_TOKEN"
                                />
                            </label>
                            <button className="primary" disabled={busy}>
                                {busy ? '连接中…' : '进入控制台 →'}
                            </button>
                        </form>
                        {error && (
                            <p role="alert" className="error">
                                {error}
                            </p>
                        )}
                        <p>
                            <a className="text" href="/docs">
                                无需登录，查看 API 文档 →
                            </a>
                        </p>
                        <p className="footnote">
                            令牌仅保存在当前页面内存中，刷新后需重新连接。
                            <br />
                            未配置令牌时，请从服务启动控制台复制自动生成的令牌。
                        </p>
                    </div>
                </section>
            </main>
        );
    return (
        <div className="shell">
            <aside className="sidebar">
                <a className="brand" href="/">
                    Region<span className="brand-dot">.</span>
                </a>
                <span className="eyebrow">行政区划控制台</span>
                <nav aria-label="主导航">
                    {tabs.map((item) => (
                        <button
                            key={item.id}
                            className={tab === item.id ? 'active' : ''}
                            onClick={() => {
                                setTab(item.id);
                                window.scrollTo(0, 0);
                                setError('');
                                setNotice('');
                            }}
                        >
                            <span className="nav-icon">{item.icon}</span>
                            <span>
                                {item.title}
                                <small>{item.sub}</small>
                            </span>
                            {tab === item.id && <b>↗</b>}
                        </button>
                    ))}
                </nav>
                <a
                    className="sidebar-docs text"
                    href="/docs"
                    target="_blank"
                    rel="noreferrer"
                >
                    API 文档 ↗
                </a>
                <div className="sidebar-bottom">
                    <span className="live-dot" /> 管理服务已连接
                    <p>年度同步 · Asia/Shanghai</p>
                    <button
                        className="text"
                        onClick={() => {
                            setToken('');
                            setAuthenticated(false);
                            setError('');
                            setNotice('');
                            setEditor(null);
                            setConflictVersion(null);
                        }}
                    >
                        退出连接 ↗
                    </button>
                </div>
            </aside>
            <main className="workspace">
                <header className="topbar">
                    <span>
                        工作空间 <span className="muted">/ {active.title}</span>
                    </span>
                    <span className="admin">● ADMIN</span>
                </header>
                <section className="page-heading">
                    <div>
                        <span className="eyebrow">{active.sub}</span>
                        <h1>
                            {active.title}
                            <span className="heading-dot">.</span>
                        </h1>
                        <p className="muted">
                            {tab === 'keys'
                                ? '为应用分配独立凭证，随时调整访问权限。'
                                : tab === 'usage'
                                  ? '查看调用趋势、错误分布和接口处理耗时。'
                                  : tab === 'regions'
                                    ? '沿着行政层级浏览世界，让数据保持准确。'
                                    : tab === 'sync'
                                      ? '获取官方年版，核对变化，安全发布。'
                                      : tab === 'releases'
                                        ? '每一次发布可追溯，每一次回退有依据。'
                                        : '查看数据修改前后，选择操作归档为版本。'}
                        </p>
                    </div>
                    <button
                        disabled={busy}
                        onClick={() =>
                            action(async () => {
                                await refresh();
                                setAccessRevision((value) => value + 1);
                                if (tab === 'regions') await loadRegions();
                                if (tab === 'changes') await loadChanges();
                            }, '已刷新')
                        }
                    >
                        ↻ 刷新数据
                    </button>
                </section>
                {status.patches &&
                    (status.patches.pending > 0 || status.patches.blocked) && (
                        <section
                            className="panel patch-update"
                            aria-label="数据包更新"
                            role="status"
                        >
                            <div className="panel-title">
                                <h2>
                                    {status.patches.blocked
                                        ? '数据包需要处理'
                                        : `发现 ${status.patches.pending} 个数据包更新`}
                                </h2>
                                <button
                                    className="primary"
                                    disabled={busy || status.patches.blocked}
                                    onClick={() => {
                                        const packages = status.patches.packages
                                            .filter(
                                                (item: Row) =>
                                                    item.state === 'pending',
                                            )
                                            .map((item: Row) => ({
                                                version: item.version,
                                                checksum: item.checksum,
                                            }));
                                        if (
                                            confirm(
                                                `应用 ${packages.length} 个数据包更新？将按版本顺序更新并生成可回退版本。`,
                                            )
                                        )
                                            void action(async () => {
                                                await api(
                                                    '/version/patches/apply',
                                                    { packages },
                                                );
                                                await refresh();
                                                if (tab === 'regions')
                                                    await loadRegions();
                                            }, '数据包已更新，可在版本时间线查看或回退');
                                    }}
                                >
                                    {busy ? '处理中…' : '更新全部数据包'}
                                </button>
                            </div>
                            <p className="muted">
                                已发现项目内的新数据包，无需重新抓取官方数据。更新前请先发布未归档修改和草稿。
                            </p>
                            {status.patches.error && (
                                <p className="error">{status.patches.error}</p>
                            )}
                            <ul>
                                {status.patches.packages
                                    .filter((item: Row) =>
                                        [
                                            'pending',
                                            'changed',
                                            'rolled_back',
                                        ].includes(item.state),
                                    )
                                    .map((item: Row) => (
                                        <li key={item.version}>
                                            {item.version} · {item.description}
                                            {item.state === 'changed'
                                                ? '（文件已被修改）'
                                                : item.state === 'rolled_back'
                                                  ? '（版本已回退）'
                                                  : ''}
                                        </li>
                                    ))}
                            </ul>
                            {status.patches.blocked && (
                                <button onClick={() => setTab('releases')}>
                                    查看版本时间线
                                </button>
                            )}
                        </section>
                    )}
                {!['keys', 'usage'].includes(tab) && (
                    <div className="stats">
                        <div>
                            <span>当前国内版本</span>
                            <strong>{current?.version || '—'}</strong>
                            <small>
                                {current
                                    ? date(current.updated_at)
                                    : '暂无发布记录'}
                            </small>
                        </div>
                        <div>
                            <span>最近同步任务</span>
                            <strong>
                                {latest ? (
                                    <Badge value={latest.status} />
                                ) : (
                                    '尚未开始'
                                )}
                            </strong>
                            <small>
                                {latest
                                    ? `任务 ${latest.version}`
                                    : '等待首次同步'}
                            </small>
                        </div>
                        <div>
                            <span>发布管理</span>
                            <strong>{draft ? '1 个草稿' : '已就绪'}</strong>
                            <small>
                                {draft
                                    ? draft.title
                                    : '修改日志 → 创建草稿 → 发布'}
                            </small>
                        </div>
                    </div>
                )}
                {error && (
                    <div role="alert" className="error banner">
                        {error}
                        <button className="text" onClick={() => setError('')}>
                            关闭
                        </button>
                    </div>
                )}
                {notice && (
                    <div role="status" className="notice banner">
                        {notice}
                    </div>
                )}
                {(tab === 'keys' || tab === 'usage') && (
                    <ApiAccessPanel
                        key={tab}
                        mode={tab}
                        api={api}
                        revision={accessRevision}
                    />
                )}
                {tab === 'regions' && (
                    <section className="panel">
                        <div className="panel-toolbar">
                            <div className="breadcrumbs">
                                <button
                                    className="text"
                                    onClick={() => {
                                        setTrail([]);
                                        setFilter('');
                                    }}
                                >
                                    世界
                                </button>
                                {trail.map((r, i) => (
                                    <span key={r.id}>
                                        {' '}
                                        /{' '}
                                        <button
                                            className="text"
                                            onClick={() => {
                                                setTrail(trail.slice(0, i + 1));
                                                setFilter('');
                                            }}
                                        >
                                            {r.name_cn || r.name_en}
                                        </button>
                                    </span>
                                ))}
                            </div>
                            <div className="tools">
                                <input
                                    aria-label="筛选已加载节点"
                                    placeholder="筛选已加载的名称或代码…"
                                    value={filter}
                                    onChange={(e) => setFilter(e.target.value)}
                                />
                                <button
                                    className="primary"
                                    disabled={!canEdit || busy}
                                    onClick={() =>
                                        setEditor({
                                            parent_id: parent.id,
                                            level_type:
                                                parent.level_type < 300
                                                    ? 310
                                                    : parent.level_type < 500
                                                      ? 510
                                                      : parent.level_type < 600
                                                        ? 610
                                                        : parent.level_type <
                                                            700
                                                          ? 710
                                                          : 810,
                                            code: '',
                                            name_cn: '',
                                        })
                                    }
                                >
                                    ＋ 新增区划
                                </button>
                            </div>
                        </div>
                        <div className="table-scroll">
                            <table>
                                <thead>
                                    <tr>
                                        <th>区划名称</th>
                                        <th>行政代码</th>
                                        <th>层级</th>
                                        <th>内部 ID</th>
                                        <th>操作</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {regions.records
                                        .filter((r) =>
                                            [r.name_cn, r.name_en, r.code].some(
                                                (v) =>
                                                    String(v || '')
                                                        .toLowerCase()
                                                        .includes(
                                                            filter.toLowerCase(),
                                                        ),
                                            ),
                                        )
                                        .map((r) => (
                                            <tr key={r.id}>
                                                <td>
                                                    <button
                                                        className="node-link"
                                                        onClick={() => {
                                                            setTrail([
                                                                ...trail,
                                                                r,
                                                            ]);
                                                            setFilter('');
                                                        }}
                                                    >
                                                        <span className="node-icon">
                                                            {r.has_children
                                                                ? '▦'
                                                                : '○'}
                                                        </span>
                                                        <span>
                                                            {r.name_cn ||
                                                                r.name_en ||
                                                                '未命名'}
                                                            <small>
                                                                {r.name_en ||
                                                                    (r.has_children
                                                                        ? '查看下级区划'
                                                                        : '暂无下级区划')}
                                                            </small>
                                                        </span>
                                                        <span className="arrow">
                                                            →
                                                        </span>
                                                    </button>
                                                </td>
                                                <td className="mono">
                                                    {r.code}
                                                </td>
                                                <td>
                                                    <span className="level">
                                                        {levels[r.level_type] ||
                                                            r.level_type}
                                                    </span>
                                                </td>
                                                <td className="muted mono">
                                                    {r.id}
                                                </td>
                                                <td>
                                                    <button
                                                        className="text"
                                                        disabled={
                                                            busy ||
                                                            r.level_type < 300
                                                        }
                                                        onClick={() =>
                                                            setEditor({ ...r })
                                                        }
                                                    >
                                                        编辑 ↗
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                        {!regions.records.length && (
                            <div className="empty">
                                {loading
                                    ? '正在读取区划数据…'
                                    : '当前层级暂无区划数据'}
                            </div>
                        )}
                        <footer className="panel-footer">
                            <span>
                                已加载 {regions.records.length} 个节点 ·
                                仅中国区划支持编辑
                            </span>
                            {regions.has_more && (
                                <button
                                    disabled={loading || busy}
                                    onClick={() =>
                                        action(
                                            () =>
                                                loadRegions(
                                                    regions.next_after_id!,
                                                ),
                                            '',
                                        )
                                    }
                                >
                                    {loading ? '加载中…' : '加载更多 ↓'}
                                </button>
                            )}
                        </footer>
                    </section>
                )}
                {tab === 'sync' && (
                    <>
                        <section className="sync-intro">
                            <div>
                                <span className="eyebrow">
                                    OFFICIAL DATA / MCA
                                </span>
                                <h2>让区划数据，与变化同步。</h2>
                                <p>
                                    同步中国大陆省、地、县、乡四级数据。
                                    <br />
                                    支持断点续传，存在差异时由你决定如何处理。
                                </p>
                                <span className="schedule">
                                    ◷ 每年 1 月 10 日 02:00 · 失败任务按小时重试
                                </span>
                            </div>
                            <div className="sync-actions">
                                <button
                                    className="primary"
                                    disabled={busy}
                                    onClick={() =>
                                        mutate(
                                            '/version',
                                            {},
                                            '已提交检查 / 恢复请求，进度每10秒刷新',
                                        )
                                    }
                                >
                                    检查 / 恢复升级 ↗
                                </button>
                                <button
                                    disabled={busy}
                                    onClick={() => {
                                        if (
                                            confirm(
                                                '立即获取当年官方年版并启动同步？现有未完成任务将优先恢复。',
                                            )
                                        )
                                            void mutate(
                                                '/version',
                                                { immediate: true },
                                                '已提交立即同步请求',
                                            );
                                    }}
                                >
                                    立即同步年版
                                </button>
                            </div>
                        </section>
                        <section className="panel">
                            <div className="panel-title">
                                <h2>同步任务</h2>
                                <span className="muted">
                                    最近 10 轮 · 自动刷新
                                </span>
                            </div>
                            {status.jobs.length ? (
                                status.jobs.map((job: Row) => (
                                    <div className="job" key={job.version}>
                                        <div className="job-title">
                                            <strong className="mono">
                                                {job.version}
                                            </strong>
                                            <Badge value={job.status} />
                                            <span className="muted">
                                                来源年版 {job.source_year}
                                            </span>
                                        </div>
                                        <progress
                                            max={Math.max(job.total || 0, 1)}
                                            value={job.completed || 0}
                                            aria-label={`任务 ${job.version} 抓取进度`}
                                        />
                                        <div className="job-meta">
                                            <span>
                                                已抓取 {job.completed || 0} /{' '}
                                                {job.total || 0} 个分支 · 尝试{' '}
                                                {job.attempts || 0} 轮
                                            </span>
                                            <button
                                                className="text"
                                                disabled={busy}
                                                onClick={() =>
                                                    showConflicts(job.version)
                                                }
                                            >
                                                查看冲突 / 决定 →
                                            </button>
                                        </div>
                                        {job.last_error && (
                                            <p className="error">
                                                {job.last_error}
                                            </p>
                                        )}
                                        {job.summary && (
                                            <details>
                                                <summary>查看任务统计</summary>
                                                <pre>
                                                    {typeof job.summary ===
                                                    'string'
                                                        ? job.summary
                                                        : JSON.stringify(
                                                              job.summary,
                                                              null,
                                                              2,
                                                          )}
                                                </pre>
                                            </details>
                                        )}
                                    </div>
                                ))
                            ) : (
                                <div className="empty">
                                    尚无同步任务，点击上方按钮开始检查。
                                </div>
                            )}
                        </section>
                    </>
                )}
                {tab === 'releases' && (
                    <section className="panel">
                        <div className="panel-title">
                            <h2>版本时间线</h2>
                            <span className="muted">最近 100 个版本</span>
                        </div>
                        {releases.length ? (
                            releases.map((release) => (
                                <article
                                    className="release"
                                    key={release.version}
                                >
                                    <div className="release-mark">◈</div>
                                    <div className="release-body">
                                        <div className="job-title">
                                            <strong className="mono">
                                                {release.version}
                                            </strong>
                                            <Badge value={release.status} />
                                            <span className="muted">
                                                {labels[release.source] ||
                                                    release.source}
                                            </span>
                                        </div>
                                        <h3>{release.title}</h3>
                                        <p className="muted">
                                            {date(release.created_at)} · 父版本{' '}
                                            {release.parent_version || '—'}
                                        </p>
                                        <div className="tools">
                                            <button
                                                onClick={() => {
                                                    setUnassigned(false);
                                                    setReleaseFilter(
                                                        String(release.version),
                                                    );
                                                    setTab('changes');
                                                }}
                                            >
                                                查看修改
                                            </button>
                                            {release.status === 'draft' && (
                                                <button
                                                    className="primary"
                                                    disabled={busy}
                                                    onClick={() => {
                                                        if (
                                                            confirm(
                                                                `发布草稿 ${release.version}？请确认所有未归档修改均已关联。`,
                                                            )
                                                        )
                                                            void mutate(
                                                                '/version/releases/publish',
                                                                {
                                                                    version:
                                                                        release.version,
                                                                },
                                                                '版本已发布',
                                                            );
                                                    }}
                                                >
                                                    发布版本 ↗
                                                </button>
                                            )}
                                            {release.status === 'applied' &&
                                                Number(current?.version) ===
                                                    Number(release.version) && (
                                                    <button
                                                        className="danger"
                                                        disabled={busy}
                                                        onClick={() => {
                                                            if (
                                                                confirm(
                                                                    `回退当前版本 ${release.version}，恢复其修改前数据？`,
                                                                )
                                                            )
                                                                void mutate(
                                                                    '/version/releases/rollback',
                                                                    {
                                                                        version:
                                                                            release.version,
                                                                    },
                                                                    '版本已回退',
                                                                );
                                                        }}
                                                    >
                                                        回退版本
                                                    </button>
                                                )}
                                            {release.status === 'rolled_back' &&
                                                Number(current?.version) ===
                                                    Number(
                                                        release.parent_version,
                                                    ) && (
                                                    <button
                                                        disabled={busy}
                                                        onClick={() => {
                                                            if (
                                                                confirm(
                                                                    `重新应用版本 ${release.version}？`,
                                                                )
                                                            )
                                                                void mutate(
                                                                    '/version/releases/apply',
                                                                    {
                                                                        version:
                                                                            release.version,
                                                                    },
                                                                    '版本已重新应用',
                                                                );
                                                        }}
                                                    >
                                                        重新应用
                                                    </button>
                                                )}
                                        </div>
                                    </div>
                                </article>
                            ))
                        ) : (
                            <div className="empty">
                                暂无版本记录。编辑区划后，可在修改日志中创建版本。
                            </div>
                        )}
                    </section>
                )}
                {tab === 'changes' && (
                    <section className="panel">
                        <div className="panel-toolbar">
                            <div className="tools">
                                <label className="inline">
                                    <input
                                        type="checkbox"
                                        checked={unassigned}
                                        onChange={(e) => {
                                            setUnassigned(e.target.checked);
                                            setReleaseFilter('');
                                        }}
                                    />
                                    仅未归档修改
                                </label>
                                <input
                                    aria-label="按版本号筛选"
                                    type="number"
                                    placeholder="按版本号筛选"
                                    value={releaseFilter}
                                    onChange={(e) => {
                                        setReleaseFilter(e.target.value);
                                        setUnassigned(false);
                                    }}
                                />
                            </div>
                        </div>
                        <div className="release-compose">
                            <div>
                                <strong>
                                    {draft
                                        ? `关联到草稿 ${draft.version}`
                                        : '将修改整理为一个版本'}
                                </strong>
                                <p className="muted">
                                    按操作选择，自动关联该操作的全部日志。手动修改已经生效，发布仅归档版本。
                                </p>
                            </div>
                            <div className="tools">
                                {!draft && (
                                    <input
                                        aria-label="版本标题"
                                        placeholder="版本标题，如：九月区划修订"
                                        value={title}
                                        maxLength={255}
                                        onChange={(e) =>
                                            setTitle(e.target.value)
                                        }
                                    />
                                )}
                                <button
                                    className="primary"
                                    disabled={
                                        busy ||
                                        !selected.length ||
                                        (!draft && !title.trim())
                                    }
                                    onClick={() =>
                                        action(async () => {
                                            await api(
                                                draft
                                                    ? '/version/releases/attach'
                                                    : '/version/releases',
                                                draft
                                                    ? {
                                                          version:
                                                              draft.version,
                                                          operation_ids:
                                                              selected,
                                                      }
                                                    : {
                                                          title,
                                                          operation_ids:
                                                              selected,
                                                      },
                                            );
                                            setSelected([]);
                                            setTitle('');
                                            await Promise.all([
                                                refresh(),
                                                loadChanges(),
                                            ]);
                                        }, '已关联修改，请到发布历史核对并发布')
                                    }
                                >
                                    {draft ? '关联' : '创建草稿'} (
                                    {selected.length})
                                </button>
                            </div>
                        </div>
                        {changes.records.length ? (
                            changes.records.map((change) => (
                                <details className="change" key={change.id}>
                                    <summary>
                                        <input
                                            aria-label={`选择操作 ${change.operation_id}`}
                                            type="checkbox"
                                            disabled={
                                                !!change.release_version || busy
                                            }
                                            checked={selected.includes(
                                                change.operation_id,
                                            )}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) =>
                                                setSelected((previous) =>
                                                    e.target.checked
                                                        ? [
                                                              ...new Set([
                                                                  ...previous,
                                                                  change.operation_id,
                                                              ]),
                                                          ]
                                                        : previous.filter(
                                                              (id) =>
                                                                  id !==
                                                                  change.operation_id,
                                                          ),
                                                )
                                            }
                                        />
                                        <span>
                                            <strong>{change.reason}</strong>
                                            <small>
                                                {change.table_name} /{' '}
                                                {change.row_id} ·{' '}
                                                {date(change.created_at)}
                                            </small>
                                        </span>
                                        <span className="muted mono">
                                            {change.release_version || '未归档'}
                                        </span>
                                    </summary>
                                    <div className="diff">
                                        <div>
                                            <h4>修改前</h4>
                                            <pre>
                                                {JSON.stringify(
                                                    change.before_data,
                                                    null,
                                                    2,
                                                )}
                                            </pre>
                                        </div>
                                        <div>
                                            <h4>修改后</h4>
                                            <pre>
                                                {JSON.stringify(
                                                    change.after_data,
                                                    null,
                                                    2,
                                                )}
                                            </pre>
                                        </div>
                                    </div>
                                    <p className="footnote">
                                        操作 ID：{change.operation_id}
                                    </p>
                                </details>
                            ))
                        ) : (
                            <div className="empty">
                                当前条件下暂无修改记录。
                            </div>
                        )}
                        <footer className="panel-footer">
                            <span>已加载 {changes.records.length} 条日志</span>
                            {changes.has_more && (
                                <button
                                    disabled={busy}
                                    onClick={() =>
                                        action(
                                            () =>
                                                loadChanges(
                                                    changes.next_after_id!,
                                                ),
                                            '',
                                        )
                                    }
                                >
                                    加载更多 ↓
                                </button>
                            )}
                        </footer>
                    </section>
                )}
                <footer className="workspace-footer">
                    REGION <span>每一处坐标，每一次演进。</span>
                    <span>全球行政区划管理平台</span>
                </footer>
            </main>
            {editor && (
                <Editor
                    row={editor}
                    busy={busy}
                    error={error}
                    close={() => setEditor(null)}
                    save={async (body) => {
                        await action(async () => {
                            await api('/version/changes', body);
                            setEditor(null);
                            await Promise.all([loadRegions(), refresh()]);
                        }, '数据修改已生效并记录日志；请到修改日志归档版本');
                    }}
                />
            )}
            {conflictVersion && (
                <Modal
                    wide
                    busy={busy}
                    close={() => setConflictVersion(null)}
                    label="conflict-heading"
                >
                    <div className="panel-title">
                        <h2 id="conflict-heading">
                            冲突处理 · {conflictVersion}
                        </h2>
                        <button
                            autoFocus
                            disabled={busy}
                            onClick={() => setConflictVersion(null)}
                        >
                            关闭
                        </button>
                    </div>
                    <p className="muted">
                        核对影响范围后选择方案。全部解决后自动恢复发布；数据变化时需重新确认。
                    </p>
                    {conflicts.length ? (
                        conflicts.map((c) => (
                            <article className="conflict" key={c.code}>
                                <div className="job-title">
                                    <strong>{c.detail.local.name_cn}</strong>
                                    <span className="mono">{c.code}</span>
                                    {c.resolution && (
                                        <Badge value={c.resolution} />
                                    )}
                                </div>
                                <p>{c.detail.description}</p>
                                <p className="muted">
                                    影响 {c.detail.subtree_nodes} 个节点（含后代{' '}
                                    {c.detail.descendant_nodes} 个）
                                </p>
                                {!c.resolution && (
                                    <div className="tools">
                                        <button
                                            disabled={busy}
                                            onClick={() =>
                                                resolve(c, 'keep_local')
                                            }
                                        >
                                            保留本地子树
                                        </button>
                                        <button
                                            className="danger"
                                            disabled={busy}
                                            onClick={() =>
                                                resolve(c, 'delete_local')
                                            }
                                        >
                                            删除本地子树
                                        </button>
                                        {c.detail.remote_candidates?.map(
                                            (candidate: Row) => (
                                                <button
                                                    key={candidate.code}
                                                    disabled={busy}
                                                    onClick={() => {
                                                        if (
                                                            confirm(
                                                                `将 ${c.code} 替换为 ${candidate.code}，保留内部ID及后代？`,
                                                            )
                                                        )
                                                            void resolve(
                                                                c,
                                                                'replace_code',
                                                                candidate.code,
                                                            );
                                                    }}
                                                >
                                                    换码为 {candidate.code} ·{' '}
                                                    {candidate.name}
                                                </button>
                                            ),
                                        )}
                                    </div>
                                )}
                            </article>
                        ))
                    ) : (
                        <div className="empty">此任务没有待处理冲突。</div>
                    )}
                    {error && (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    )}
                </Modal>
            )}
        </div>
    );
}

function Editor({
    row,
    busy,
    error,
    close,
    save,
}: {
    row: Row;
    busy: boolean;
    error: string;
    close: () => void;
    save: (body: unknown) => Promise<void>;
}) {
    const [reason, setReason] = useState('');
    const [cascade, setCascade] = useState(false);
    const [fields, setFields] = useState<Row>({ ...row });
    const [localError, setLocalError] = useState('');
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        const keys = [
            'parent_id',
            'code',
            'name_cn',
            'name_en',
            'name_local',
            'name_pinyin',
            'name_jianpin',
            'level_type',
        ];
        const values: Row = {};
        for (const key of keys)
            if (
                fields[key] !== undefined &&
                (!row.id || fields[key] !== row[key])
            )
                values[key] = ['parent_id', 'level_type'].includes(key)
                    ? Number(fields[key])
                    : fields[key];
        const detail: Row = {};
        for (const key of ['lat', 'lng'])
            if (fields[key] !== row[key])
                detail[key] = fields[key] === '' ? null : Number(fields[key]);
        await save({
            action: row.id ? 'update' : 'create',
            ...(row.id ? { id: row.id } : {}),
            fields: values,
            ...(Object.keys(detail).length ? { detail } : {}),
            reason,
        });
    }
    return (
        <Modal busy={busy} close={close} label="editor-heading">
            <div className="panel-title">
                <h2 id="editor-heading">{row.id ? '编辑区划' : '新增区划'}</h2>
                <button disabled={busy} onClick={close}>
                    关闭
                </button>
            </div>
            <p className="muted">保存后立即生效，修改前后数据会记入日志。</p>
            <form onSubmit={submit}>
                <div className="form-grid">
                    {[
                        ['name_cn', '中文名称'],
                        ['code', '行政代码'],
                        ['parent_id', '父节点内部 ID'],
                        ['level_type', '行政层级'],
                        ['name_en', '英文名称'],
                        ['name_local', '本地名称'],
                        ['name_pinyin', '拼音'],
                        ['name_jianpin', '简拼'],
                        ['lat', '纬度'],
                        ['lng', '经度'],
                    ].map(([key, label], i) => (
                        <label key={key}>
                            {label}
                            {key === 'level_type' ? (
                                <select
                                    value={fields[key]}
                                    onChange={(e) =>
                                        setFields({
                                            ...fields,
                                            [key]: Number(e.target.value),
                                        })
                                    }
                                >
                                    {Object.entries(levels)
                                        .filter(([id]) => Number(id) >= 300)
                                        .map(([id, text]) => (
                                            <option key={id} value={id}>
                                                {text}
                                            </option>
                                        ))}
                                </select>
                            ) : (
                                <input
                                    autoFocus={i === 0}
                                    required={[
                                        'name_cn',
                                        'code',
                                        'parent_id',
                                    ].includes(key)}
                                    type={
                                        ['parent_id', 'lat', 'lng'].includes(
                                            key,
                                        )
                                            ? 'number'
                                            : 'text'
                                    }
                                    step={key === 'parent_id' ? '1' : 'any'}
                                    min={
                                        key === 'parent_id'
                                            ? 1
                                            : key === 'lat'
                                              ? -90
                                              : key === 'lng'
                                                ? -180
                                                : undefined
                                    }
                                    max={
                                        key === 'lat'
                                            ? 90
                                            : key === 'lng'
                                              ? 180
                                              : undefined
                                    }
                                    value={fields[key] ?? ''}
                                    onChange={(e) =>
                                        setFields({
                                            ...fields,
                                            [key]: e.target.value,
                                        })
                                    }
                                />
                            )}
                        </label>
                    ))}
                </div>
                <label>
                    修改原因
                    <textarea
                        required
                        maxLength={255}
                        placeholder="填写依据或官方公告来源"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                    />
                </label>
                {(localError || error) && (
                    <p role="alert" className="error">
                        {localError || error}
                    </p>
                )}
                <div className="modal-actions">
                    <button className="primary" disabled={busy}>
                        {busy ? '处理中…' : '保存并记录修改'}
                    </button>
                    {row.id && (
                        <>
                            <label className="inline">
                                <input
                                    type="checkbox"
                                    checked={cascade}
                                    onChange={(e) =>
                                        setCascade(e.target.checked)
                                    }
                                />
                                包括全部后代
                            </label>
                            <button
                                type="button"
                                className="danger"
                                disabled={busy || !reason.trim()}
                                onClick={() => {
                                    if (row.has_children && !cascade) {
                                        setLocalError(
                                            '该节点有下级，请明确勾选包括全部后代后再删除。',
                                        );
                                        return;
                                    }
                                    if (
                                        confirm(
                                            `删除 ${row.name_cn}${cascade ? ' 及全部后代' : ''}？数据将立即删除并记入日志。`,
                                        )
                                    )
                                        void save({
                                            action: 'delete',
                                            id: row.id,
                                            cascade,
                                            reason,
                                        });
                                }}
                            >
                                删除区划
                            </button>
                        </>
                    )}
                </div>
            </form>
        </Modal>
    );
}

function Modal({
    children,
    close,
    busy,
    wide = false,
    label,
}: {
    children: React.ReactNode;
    close: () => void;
    busy: boolean;
    wide?: boolean;
    label: string;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const dialog = ref.current;
        dialog?.showModal();
        return () => dialog?.close();
    }, []);
    return (
        <dialog
            ref={ref}
            className={`modal ${wide ? 'wide' : ''}`}
            aria-labelledby={label}
            onCancel={(event) => {
                event.preventDefault();
                if (!busy) close();
            }}
        >
            {children}
        </dialog>
    );
}
