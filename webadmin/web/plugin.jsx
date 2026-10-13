/*
 * OIE Community Store - web administrator frontend.
 *
 * Talks exclusively to the engine extension's REST surface at
 * /api/extensions/communitystore (session-authenticated, gated by the
 * manage-extensions permission). No GitHub calls happen in the browser.
 */

import { platform } from '@oie/web-shell';
import { renderDocsHtml } from './markdown.js';
import { STORE_CSS } from './store-style.js';

/* RBAC: the store's manage tasks (declared in CommunityStoreServicePlugin's
   ExtensionPermissions) resolve as bare task names through the RBAC plugin's
   extension task-permission merge → "Manage Community Store". Without an RBAC
   plugin the default controller allows everything, so these are always true. */
const canInstall = () => platform.checkTask('', 'doInstallStoreItem');
const canRemove = () => platform.checkTask('', 'doRemoveStoreContent');
const canEditSettings = () => platform.checkTask('', 'doEditStoreSettings');

const React = platform.React;
const BASE = '/extensions/communitystore';

/* ------------------------------------------------------------------ */
/* Publisher docs are rendered through the sanitizing pipeline in       */
/* markdown.js (raw HTML escaped, link/image protocols allowlisted).    */
/* ------------------------------------------------------------------ */

const DOCS_CSS = `
.cs-docs { line-height: 1.55; overflow-wrap: break-word; }
.cs-docs img { max-width: 100%; }
.cs-docs pre { overflow-x: auto; padding: 8px 10px; border: 1px solid var(--line, #8884); border-radius: 4px; }
.cs-docs code { font-family: monospace; font-size: 0.9em; }
.cs-docs table { border-collapse: collapse; }
.cs-docs th, .cs-docs td { border: 1px solid var(--line, #8884); padding: 4px 8px; }
.cs-docs blockquote { border-left: 3px solid var(--line, #8884); margin-left: 0; padding-left: 12px; }
.cs-docs h1, .cs-docs h2 { border-bottom: 1px solid var(--line, #8884); padding-bottom: 4px; }
`;

/* ------------------------------------------------------------------ */
/* API helpers                                                         */
/* ------------------------------------------------------------------ */

function parseMaybeJson(value) {
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (e) { return value; }
    }
    return value;
}

async function apiGet(path) {
    return parseMaybeJson(await platform.api.get(path));
}

async function apiPost(path, body) {
    return parseMaybeJson(await platform.api.post(path, body));
}

async function apiPut(path, body) {
    return parseMaybeJson(await platform.api.put(path, body));
}

function toast(message, kind) {
    try { platform.ui.toast(message, kind); } catch (e) { /* toast is best-effort */ }
}

function errText(e) {
    let text = (e && (e.message || e.statusText)) ? (e.message || e.statusText) : String(e);
    // Engine-side failures arrive as a serialized ClientException XML blob — stack trace
    // and all. Surface only the human message (the outermost <detailMessage>).
    const m = /<detailMessage>([\s\S]*?)<\/detailMessage>/.exec(text);
    if (m) {
        text = m[1]
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            .trim();
    }
    return text;
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

const TYPE_LABELS = {
    connector: '连接器',
    plugin: '插件',
    datatype: '数据类型',
    channel: '通道',
    'code-template-library': '代码模板库',
    'code-template': '代码模板',
};

// Stable ordering for the type filter and the group-by-type sections.
const TYPE_ORDER = ['connector', 'plugin', 'datatype', 'channel', 'code-template-library', 'code-template'];
const typeRank = (t) => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; };

// Content types are imported (channels/code templates) rather than installed as extensions:
// they take effect immediately, with no engine restart.
const CONTENT_TYPES = ['channel', 'code-template-library', 'code-template'];
const isContentType = (t) => CONTENT_TYPES.includes(t);

// Web store client: an entry is hidden IFF its offered version declares a UI surface
// that does not include "web" (i.e. swing-only). Content (ui absent) and server-only /
// ui-less extensions (ui []) are always shown. Engine min/max compatibility is a
// separate filter and is unchanged.
const showsInWebUi = (entry) => !(Array.isArray(entry.ui) && entry.ui.length && !entry.ui.includes('web'));

// Normalize the engine's /codeTemplateLibraries response (XStream single-root + one-element-list
// quirk) into a plain [{id, name}] list for the install-dialog library picker.
function normalizeLibraries(resp) {
    let node = resp && resp.list !== undefined ? resp.list : resp;
    let arr = node && node.codeTemplateLibrary;
    if (!arr) return [];
    if (!Array.isArray(arr)) arr = [arr];
    return arr.map((l) => ({ id: l && l.id, name: (l && l.name) || l.id })).filter((l) => l.id);
}

// Small persisted UI prefs (view mode, grouping), scoped to the store.
function getPref(key, fallback) {
    try { const v = localStorage.getItem('communitystore.' + key); return v === null ? fallback : v; }
    catch (e) { return fallback; }
}
function setPref(key, value) {
    try { localStorage.setItem('communitystore.' + key, value); } catch (e) { /* private mode */ }
}

/** Self-contained confirmation overlay (no dependency on host modal internals).
 *  An optional secondary action renders between Cancel and the primary button
 *  (used for the three-way modified-template choice). */
function ConfirmOverlay({ title, children, confirmLabel, onConfirm, secondaryLabel, onSecondary, onCancel, busy, loading, error, documentation = false, inactive = false, closeLabel = "关闭文档" }) {
    const dialog = React.useRef(null);
    const titleId = React.useId();
    React.useEffect(() => {
        const previous = document.activeElement;
        dialog.current?.focus();
        return () => { if (previous?.isConnected) previous.focus(); };
    }, []);
    const onKeyDown = (event) => {
        if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel(); }
        if (event.key !== 'Tab') return;
        const nodes = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')];
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    return <div className="cs-overlay" style={inactive ? {display: 'none'} : undefined}>
        <div className={`panel cs-dialog ${documentation ? 'cs-documentation-dialog' : ''}`}  role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog} tabIndex={-1} onKeyDown={onKeyDown}>
            <div className="panel-header" id={titleId}>{title}{documentation ? <button className="btn btn-sm" onClick={onCancel} aria-label={closeLabel}>关闭</button> : null}</div>
            <div className="panel-body">
                {children}
                {loading ? <p role="status">正在加载库…</p> : null}
                {error ? <p role="alert" className="cs-notice error">{error}</p> : null}
                {!documentation ? <div className="cs-dialog-actions">
                    <button className="btn" onClick={() => onCancel()} disabled={busy}>取消</button>
                    {secondaryLabel ? <button className="btn btn-danger" onClick={() => onSecondary()} disabled={busy || loading}>{secondaryLabel}</button> : null}
                    <button className="btn btn-primary" onClick={() => onConfirm()} disabled={busy || loading}>
                        {busy ? '处理中…' : confirmLabel}
                    </button>
                </div> : null}
            </div>
        </div>
    </div>;
}

/* ------------------------------------------------------------------ */
/* Install / uninstall flows                                           */
/* ------------------------------------------------------------------ */

function useStoreActions(refresh, onComplete) {
    const [confirm, setConfirm] = React.useState(null); // { entry, mode: 'install' | 'upgrade' | 'copy' | 'modified-choice' | 'remove' }
    const [busy, setBusy] = React.useState(false);
    const inFlight = React.useRef(false);
    const pickerRequest = React.useRef(0);
    const [loadingLibraries, setLoadingLibraries] = React.useState(false);
    const [actionError, setActionError] = React.useState(null);
    const choose = (value) => { pickerRequest.current++; setLoadingLibraries(false); setActionError(null); setConfirm(value); };
    // Code Template install: choose a target library (a standalone template must live in one).
    const [libraries, setLibraries] = React.useState([]);
    const [libMode, setLibMode] = React.useState('new'); // 'new' | 'existing'
    const [newLib, setNewLib] = React.useState('');
    const [existingLib, setExistingLib] = React.useState('');

    // Preload the library picker for flows that create a NEW standalone template
    // (fresh install, install-as-copy). Upgrades keep their existing membership.
    const loadLibraryPicker = async (entry) => {
        const request = ++pickerRequest.current;
        setLoadingLibraries(true);
        setLibMode('new');
        setNewLib(entry.name || '社区商店');
        setExistingLib('');
        setLibraries([]);
        try {
            const result = normalizeLibraries(await apiGet('/codeTemplateLibraries'));
            if (request === pickerRequest.current) setLibraries(result);
        } catch (e) {
            if (request === pickerRequest.current) setActionError('无法加载现有库。您可以创建新库，或取消后重试。' + errText(e));
        } finally { if (request === pickerRequest.current) setLoadingLibraries(false); }
    };

    const requestInstall = async (entry) => {
        choose({ entry, mode: 'install' });
        // The library picker applies only to a FRESH standalone-template install; an
        // update / re-import keeps its existing library membership (backend enforces).
        if (entry.type === 'code-template' && !entry.installedVersion) await loadLibraryPicker(entry);
    };
    // Import under a fresh id, leaving anything installed untouched — the only
    // path for a present channel (snapshot gallery), and the keep-my-changes
    // path for templates.
    const requestCopy = async (entry) => {
        choose({ entry, mode: 'copy' });
        if (entry.type === 'code-template') await loadLibraryPicker(entry);
    };
    // Update / re-import on installed content. Channels never get here (the server always
    // reports updateAvailable false for them — snapshots only — and the details pane offers
    // them no re-import). Code templates and libraries are drift-aware: pristine goes
    // straight to an in-place upgrade; modified asks overwrite/copy/cancel — including
    // pre-tracking installs (driftTracked=false), which the server reports as modified
    // because it cannot tell. Everything else keeps today's flow.
    const requestUpdate = (entry) => {
        if (entry.type === 'code-template' || entry.type === 'code-template-library') {
            choose({ entry, mode: entry.modified ? 'modified-choice' : 'upgrade' });
        } else requestInstall(entry);
    };
    const requestRemove = (entry) => choose({ entry, mode: 'remove' });

    const execute = async (modeOverride, overwrite = false) => {
        if (!confirm || inFlight.current || loadingLibraries) return;
        const entry = confirm.entry;
        const mode = typeof modeOverride === 'string' ? modeOverride : confirm.mode;
        if (!['install', 'upgrade', 'copy', 'remove'].includes(mode)) return;
        const content = isContentType(entry.type);
        inFlight.current = true;
        setActionError(null);
        setBusy(true);
        try {
            if (mode === 'remove') {
                await apiPost(`${BASE}/_removeContent`, { id: entry.id });
                toast(`已从引擎中移除 ${entry.name}。`, 'success');
                onComplete?.({ entry, mode, restartRequired: false });
                setConfirm(null);
                await refresh(false);
                return;
            }
            {
                const body = { id: entry.id, tag: entry.tag };
                if (mode === 'upgrade' || mode === 'copy') body.mode = mode;
                if (mode === 'upgrade') { body.expectedContentHash = entry.expectedContentHash || ''; body.overwrite = overwrite; }
                if (entry.type === 'code-template' && (mode === 'copy' || (mode === 'install' && !entry.installedVersion))) {
                    if (libMode === 'existing') {
                        if (!existingLib) { toast('请选择一个库以添加此代码模板。', 'warn'); setBusy(false); return; }
                        body.targetLibraryId = existingLib;
                    } else {
                        body.newLibrary = (newLib || '').trim() || '社区商店';
                    }
                }
                const result = await apiPost(`${BASE}/_install`, body);
                onComplete?.({ entry, mode, restartRequired: !!result.restartRequired });
                toast(mode === 'upgrade' ? (entry.updateAvailable ? `已将 ${entry.name} 升级至 v${entry.version}。` : `已重新导入 ${entry.name}。`)
                    : mode === 'copy' ? `已将 ${entry.name} 作为副本导入。`
                        : content
                            ? `已导入 ${entry.name}，现已可用。`
                            : `已安装 ${entry.name} ${entry.version}。重启引擎以激活。`, 'success');
                // Extensions need a restart (shell's staged → Reload UI banner); imported
                // content takes effect immediately, so no restart prompt.
                if (!content) {
                    try { window.dispatchEvent(new Event('webadmin:restart-pending')); } catch (e) { /* non-browser */ }
                }
            }
            setConfirm(null);
            await refresh(false);
        } catch (e) {
            setActionError(errText(e));
            toast(errText(e), 'error');
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    let overlay = null;
    if (confirm && confirm.mode === 'remove') {
        const entry = confirm.entry;
        overlay = (
            <ConfirmOverlay
                title={`移除 ${entry.name}？`}
                confirmLabel="移除"
                busy={busy} loading={loadingLibraries} error={actionError}
                onCancel={() => choose(null)}
                onConfirm={() => execute('remove')}>
                <div>
                    {entry.type === 'code-template-library' ? (
                        <p>
                            将删除库 <strong>{entry.name}</strong> 及其中的<strong>所有代码模板</strong>
                            — 包括安装后您添加的模板。
                        </p>
                    ) : (
                        <p>
                            将从引擎中删除代码模板 <strong>{entry.name}</strong>，
                            包括其库成员关系。库本身将被保留
                            {entry.revoked ? '。' : '，并且如果以后需要重新导入，该包仍可在浏览中使用。'}
                        </p>
                    )}
                </div>
            </ConfirmOverlay>
        );
    } else if (confirm && confirm.mode === 'modified-choice') {
        // Drift-aware template/library update or re-import: an in-place upgrade would
        // discard whatever the user changed — or MIGHT have changed, for a pre-tracking
        // install (driftTracked=false) where the store cannot tell. Three-way:
        // overwrite / copy / cancel.
        const entry = confirm.entry;
        const noun = entry.type === 'code-template-library' ? '库' : '模板';
        const untracked = entry.driftTracked === false;
        overlay = (
            <ConfirmOverlay
                title={`${entry.updateAvailable ? '更新' : '重新导入'} ${entry.name}？`}
                confirmLabel="作为新副本安装"
                secondaryLabel="覆盖"
                busy={busy} loading={loadingLibraries} error={actionError}
                onCancel={() => choose(null)}
                onSecondary={() => execute('upgrade', true)}
                onConfirm={() => requestCopy(entry)}>
                <div>
                    <p>
                        {untracked
                            ? `此${noun}是使用旧版变更追踪格式安装的 — 商店无法判断您是否已对其进行了修改。`
                            : `自安装以来，您已修改了此${noun}。`}
                    </p>
                    <p>
                        <strong>覆盖</strong>将{untracked ? '当前内容' : '您的修改'}替换为
                        版本 {entry.version}。<strong>作为新副本安装</strong>将保留{untracked ? '已安装的内容' : '您的版本'}，
                        并将版本 {entry.version} 作为单独的{noun}导入
                        {entry.type === 'code-template' ? '（您需要为其选择一个库）' : ''}。
                    </p>
                </div>
            </ConfirmOverlay>
        );
    } else if (confirm && confirm.mode === 'upgrade') {
        const entry = confirm.entry;
        const reimport = !entry.updateAvailable; // same version offered — re-import, not update
        overlay = (
            <ConfirmOverlay
                title={reimport ? `重新导入 ${entry.name}？` : `将 ${entry.name} 更新至 v${entry.version}？`}
                confirmLabel={reimport ? '重新导入' : `更新至 v${entry.version}`}
                busy={busy} loading={loadingLibraries} error={actionError}
                onCancel={() => choose(null)}
                onConfirm={() => execute()}>
                <div>
                    <p>
                        将已安装的 {TYPE_LABELS[entry.type] || entry.type} <strong>{entry.name}</strong> 就地替换为
                        来自 <span className="mono">{entry.repo}</span> ({entry.tag}) 的版本 {entry.version}。
                        {entry.type === 'code-template' ? '其库成员关系将被保留，' : '它'}将
                        立即生效 — 无需重启引擎。
                    </p>
                </div>
            </ConfirmOverlay>
        );
    } else if (confirm) {
        const entry = confirm.entry;
        const copy = confirm.mode === 'copy';
        const content = isContentType(entry.type);
        const wantsLibrary = entry.type === 'code-template' && (copy || !entry.installedVersion);
        overlay = (
            <ConfirmOverlay
                title={copy ? `将 ${entry.name} 作为副本安装？`
                    : `${content ? (entry.updateAvailable ? '更新' : '导入') : '安装'} ${entry.name}？`}
                confirmLabel={copy ? '作为副本安装'
                    : content ? (entry.updateAvailable ? `更新至 ${entry.version}` : '导入') : `安装 ${entry.version}`}
                busy={busy} loading={loadingLibraries} error={actionError}
                onCancel={() => choose(null)}
                onConfirm={() => execute()}>
                {(
                    <div>
                        {copy ? (
                            <p>
                                将导入 {TYPE_LABELS[entry.type] || entry.type} <strong>{entry.name}</strong> 版本 {entry.version}，来自{' '}
                                <span className="mono">{entry.repo}</span> ({entry.tag})，作为具有新 id 的副本
                                {entry.installedVersion ? ' — 已安装的内容保持不变' : ''}。
                                该副本属于您：商店不会追踪或更新它。
                            </p>
                        ) : content ? (
                            <p>
                                将导入 {TYPE_LABELS[entry.type] || entry.type} <strong>{entry.name}</strong>，来自{' '}
                                <span className="mono">{entry.repo}</span> ({entry.tag})。导入后立即生效 — 无需重启引擎。
                            </p>
                        ) : (
                            <p>
                                将在 sha256 验证后，将 <span className="mono">{entry.repo}</span> 发行版{' '}
                                <span className="mono">{entry.tag}</span> 安装到引擎的扩展目录中。
                            </p>
                        )}
                        {wantsLibrary ? (
                            <div className="mt-3">
                                <div className="text-text-dim mb-1">添加到库：</div>
                                <label className="flex items-center gap-2 mb-1" style={{ cursor: 'pointer' }}>
                                    <input type="radio" name="cs-lib" checked={libMode === 'new'} onChange={() => setLibMode('new')} />
                                    创建新库：
                                    <input className="field" style={{ maxWidth: 220 }} value={newLib} placeholder="库名称"
                                        onFocus={() => setLibMode('new')} onChange={(e) => setNewLib(e.target.value)} />
                                </label>
                                <label className="flex items-center gap-2" style={{ cursor: libraries.length ? 'pointer' : 'default' }}>
                                    <input type="radio" name="cs-lib" checked={libMode === 'existing'} disabled={!libraries.length} onChange={() => setLibMode('existing')} />
                                    现有库：
                                    <select className="field" style={{ maxWidth: 220 }} value={existingLib} disabled={!libraries.length}
                                        onChange={(e) => { setExistingLib(e.target.value); setLibMode('existing'); }}>
                                        <option value="">{libraries.length ? '选择库…' : '暂无库'}</option>
                                        {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                                    </select>
                                </label>
                            </div>
                        ) : null}
                        <p className="hint mt-2">
                            社区内容由第三方发布，未经开放集成引擎项目审核。安装将在引擎中执行其代码。
                            请仅从您信任的发布者处安装。
                        </p>
                    </div>
                )}
            </ConfirmOverlay>
        );
    }

    return { requestInstall, requestUpdate, requestCopy, requestRemove, overlay, busy };
}

/* ------------------------------------------------------------------ */
/* Publisher documentation panel                                       */
/* ------------------------------------------------------------------ */

function DocsPanel({ entry }) {
    const [docs, setDocs] = React.useState(null);
    const [error, setError] = React.useState(null);

    React.useEffect(() => {
        let cancelled = false;
        setDocs(null);
        setError(null);
        apiGet(`${BASE}/catalog/${encodeURIComponent(entry.id)}/docs`)
            .then((result) => { if (!cancelled) setDocs(result); })
            .catch((e) => { if (!cancelled) setError(errText(e)); });
        return () => { cancelled = true; };
    }, [entry.id, entry.tag]);

    const html = React.useMemo(() => {
        if (!docs || !docs.found) return null;
        try {
            return renderDocsHtml(docs.markdown, docs.repo, docs.tag, docs.images,
                { linkBase: docs.linkBase, imageBase: docs.imageBase });
        } catch (e) {
            return null;
        }
    }, [docs]);

    return (
        <div className="panel mt-3">
            <div className="panel-header flex items-center gap-2">
                文档
                {docs && docs.found ? <span className="mono text-text-dim" style={{ fontSize: '0.85em' }}>{docs.path} @ {docs.tag}</span> : null}
            </div>
            <div className="panel-body">
                <style>{DOCS_CSS}</style>
                {error ? <span className="text-text-dim">无法加载文档：{error}</span> : null}
                {!error && !docs ? <span className="text-text-dim">正在加载文档…</span> : null}
                {docs && !docs.found ? (
                    <span className="text-text-dim">
                        此发布者未提供商店文档。发布者可以在其仓库中添加
                        store.md（或 README.md）文件，它将在此处渲染，并关联到对应的发行版标签。
                    </span>
                ) : null}
                {html ? <div className="cs-docs" dangerouslySetInnerHTML={{ __html: html }} /> : null}
                {docs && docs.truncated ? (
                    <div className="hint mt-2">文档已被截断。完整文件可在仓库中查看。</div>
                ) : null}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Detail view                                                         */
/* ------------------------------------------------------------------ */

// Match the host navigation glyphs and stroke weight (core/icons.ts).
const TYPE_ICONS = {
    'connector': 'M8 2v6M16 2v6M5 8h14v4a7 7 0 0 1-14 0V8zM12 19v3',
    'plugin': 'M8 2v6M16 2v6M5 8h14v4a7 7 0 0 1-14 0V8zM12 19v3',
    'datatype': 'M8 2v6M16 2v6M5 8h14v4a7 7 0 0 1-14 0V8zM12 19v3',
    'channel': 'M2 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M16 5a3 3 0 1 0 6 0a3 3 0 1 0-6 0M16 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0M7.7 10.7l8.6-4.4M7.7 13.3l8.6 4.4',
    'code-template': 'M8 7l-5 5 5 5M16 7l5 5-5 5M13 4l-2 16',
    'code-template-library': 'M8 7l-5 5 5 5M16 7l5 5-5 5M13 4l-2 16',
};
function PackageIcon({ type }) {
    return <span className="cs-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={TYPE_ICONS[type] || TYPE_ICONS.plugin} /></svg></span>;
}
function PackageStatus({ entry }) {
    if (entry.revoked) return <span className="cs-pill error">{entry.revokedReason === 'blocked' ? '已被源阻止' : '已从源中移除'}</span>;
    if (entry.stagedVersion) return <span className="cs-pill warn">等待重启</span>;
    if (entry.modified) return <span className="cs-pill warn">{entry.driftTracked === false ? '变更未知' : '已有本地修改'}</span>;
    if (entry.updateAvailable) return <span className="cs-pill update">有可用更新</span>;
    if (!entry.compatible) return <span className="cs-pill warn">不兼容</span>;
    if (entry.deprecated) return <span className="cs-pill warn">已弃用</span>;
    if (entry.installedVersion) return <span className="cs-pill ok">已安装</span>;
    return <span className="cs-pill">{isContentType(entry.type) ? '可导入' : '可安装'}</span>;
}
function safeExternalUrl(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
    catch { return null; }
}
function ExternalLink({ href, children }) {
    const safe = safeExternalUrl(href);
    return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : null;
}
const DOWNLOAD_NOTE = '统计范围包括已保留的 GitHub 发行版（含预发布版）中匹配的安装包 ZIP 下载次数。重复和自动下载均计入统计；此数据并非安装量或用户数。已重命名的资源系列和已删除的发行版不在统计范围内。';
const DOWNLOAD_ERRORS = {
    unsupported_asset: '此安装包 URL 或文件名未发布下载统计数据。',
    package_not_found: '此包已不在目录中。',
    revoked: '此包已从其源中移除。',
    no_matching_assets: '在 GitHub 发行版中未找到匹配的安装包资源。',
    rate_limit_or_access_denied: '已达到 GitHub 速率限制或仓库访问被拒绝。请检查商店设置中的 GitHub 令牌；系统将在五分钟后重试。',
    repository_not_found: 'GitHub 无法找到或无法访问该仓库。',
    lookup_limit: '在查询限制内无法完整统计发行版历史。',
    github_unreachable: '引擎无法连接 GitHub。请检查其网络和 TLS 配置。',
    invalid_response: 'GitHub 返回了意外的统计响应。',
    interrupted: '下载查询被中断。',
};
function metricFreshness(stats) { return stats?.checkedAt ? `${stats.stale ? '刷新失败；上次成功统计' : '更新于'}：${new Date(stats.checkedAt).toLocaleString()}` : '此目录尚未发布统计数据。'; }
function downloadError(entry) { return DOWNLOAD_ERRORS[entry.downloads?.reason] || '此目录中没有该包的下载计数。'; }
function DownloadCount({ entry }) {
    const stats = entry.downloads;
    return <span title={stats?.status === 'available' ? `${DOWNLOAD_NOTE} ${metricFreshness(stats)}` : downloadError(entry)}>{stats?.status === 'available' && Number.isSafeInteger(stats.count) && stats.count >= 0 ? `${stats.count.toLocaleString()}${stats.stale ? '（过时）' : ''}` : '—'}</span>;
}
function StarCount({ entry }) {
    const stats=entry.stars;
    return <span title={`GitHub 仓库星标数；共享同一仓库的包共享此计数。${metricFreshness(stats)}`}>{stats?.status === 'available' && Number.isSafeInteger(stats.count) && stats.count >= 0 ? `${stats.count.toLocaleString()}${stats.stale ? '（过时）' : ''}` : '—'}</span>;
}
function DetailView({ entry, actions }) {
    const [docsOpen, setDocsOpen] = React.useState(true);
    React.useEffect(() => setDocsOpen(true), [entry?.id]);
    if (!entry) return <aside className="cs-detail"><h2>包详情</h2><p className="cs-detail-description">选择一个包以查看其兼容性、来源和安装选项。</p></aside>;
    const content = isContentType(entry.type);
    const channelCopy = entry.type === 'channel' && entry.installedVersion;
    const update = entry.updateAvailable || (content && entry.installedVersion && !channelCopy);
    const actionable = canInstall() && entry.installable && entry.compatible && !entry.revoked && !entry.stagedVersion
        && (content || !entry.installedVersion || entry.updateAvailable);
    const label = channelCopy ? '作为副本导入' : update ? entry.updateAvailable ? `查看更新至 ${entry.version}` : '查看重新导入'
        : content ? '查看导入' : '查看安装';
    return <aside className="cs-detail" aria-label="已选包">
        <PackageIcon type={entry.type} />
        <h2>{entry.name}</h2>
        <div className="cs-meta">{TYPE_LABELS[entry.type] || entry.type}{entry.authors?.length ? ` · 作者：${entry.authors.join(', ')}` : ''}</div>
        <p className="cs-detail-description">{entry.description || '未提供描述。'}</p>
        <PackageStatus entry={entry} />
        <p className="cs-footnote">{DOWNLOAD_NOTE} {entry.downloads?.status !== 'available' ? downloadError(entry) : ''}</p>
        <dl className="cs-facts">
            <div className="cs-fact"><dt>提供版本</dt><dd>{entry.revoked ? '不可用' : entry.version}</dd></div>
            <div className="cs-fact"><dt>已安装版本</dt><dd>{entry.installedVersion || '未安装'}</dd></div>
            {entry.stagedVersion ? <div className="cs-fact"><dt>暂存版本</dt><dd>{entry.stagedVersion}</dd></div> : null}
            <div className="cs-fact"><dt>下载量 · 所有版本</dt><dd><DownloadCount entry={entry} /><div className="cs-footnote">{metricFreshness(entry.downloads)}</div></dd></div>
            <div className="cs-fact"><dt>GitHub 星标</dt><dd><StarCount entry={entry} /><div className="cs-footnote">{metricFreshness(entry.stars)}</div></dd></div>
            <div className="cs-fact"><dt>引擎兼容性</dt><dd>{entry.minEngineVersion || '未指定'}{entry.maxEngineVersion ? ` – ${entry.maxEngineVersion}` : entry.minEngineVersion ? '+' : ''}</dd></div>
        </dl>
        {entry.revoked ? <p className="cs-notice error">此包已不再由其源提供。请评估您是否仍信任它。</p>
            : entry.stagedVersion ? <p className="cs-notice warn">版本 {entry.stagedVersion} 已暂存。重启引擎以激活。</p>
            : !entry.compatible ? <p className="cs-notice warn">此引擎没有可用的兼容版本。</p>
            : <p className="cs-notice">{content ? '导入的内容立即可用，无需重启。' : '安装后需要重启引擎。'}</p>}
        {entry.modified ? <p className="cs-notice warn">{entry.driftTracked === false ? '使用旧版追踪格式，本地变更未知。' : '检测到本地修改。'}替换此内容前请先确认。您可以通过导入副本来保留您的修改。</p> : null}
        {entry.deprecated ? <p className="cs-notice warn">发布者已弃用此包{entry.deprecationMessage ? `：${entry.deprecationMessage}` : '。'}</p> : null}
        {entry.newerSnapshot ? <p className="cs-notice">有更新的快照可用：{entry.newerSnapshot}。作为副本导入以保留已安装的通道。</p> : null}
        {actionable ? <button className="btn btn-primary cs-primary-action" disabled={actions.busy}
            onClick={() => channelCopy ? actions.requestCopy(entry) : update ? actions.requestUpdate(entry) : actions.requestInstall(entry)}>{label}</button> : null}
        <p className="cs-footnote">社区发布。校验和验证制品完整性，而非发布者身份。</p>
        <details className="cs-package-info"><summary>包信息</summary><dl className="cs-facts">
            <div className="cs-fact"><dt>许可证</dt><dd>{entry.license || '未指定'}</dd></div>
            <div className="cs-fact"><dt>仓库</dt><dd><ExternalLink href={entry.repoUrl || `https://github.com/${entry.repo}`}>{entry.repo || '仓库'}</ExternalLink></dd></div>
            <div className="cs-fact"><dt>来源</dt><dd>{entry.source}</dd></div>
            <div className="cs-fact"><dt>制品完整性</dt><dd>{entry.sha256 || entry.checksumUrl ? '安装时进行 SHA-256 校验' : '未发布校验和'}</dd></div>
            {entry.publishedAt ? <div className="cs-fact"><dt>发布时间</dt><dd>{new Date(entry.publishedAt).toLocaleDateString()}</dd></div> : null}
            {!entry.offeredIsLatest && entry.latestTag ? <div className="cs-fact"><dt>最新发行版</dt><dd>{entry.latestTag}（提供兼容版本）</dd></div> : null}
        </dl></details>
        <div className="cs-detail-links">
            <ExternalLink href={entry.documentation}>文档 ↗</ExternalLink>
            <ExternalLink href={entry.releaseUrl}>发行说明 ↗</ExternalLink>
        </div>
        {!entry.revoked ? <>
            <button className="btn cs-docs-toggle" aria-expanded={docsOpen} onClick={() => setDocsOpen(!docsOpen)}>{docsOpen ? '隐藏发布者文档' : '查看发布者文档'}</button>
            {docsOpen ? <DocsPanel entry={entry} /> : null}
        </> : null}
        {entry.installedVersion ? <div className="cs-facts">
            {content && entry.type !== 'channel' && canRemove() ? <button className="btn btn-danger" disabled={actions.busy} onClick={() => actions.requestRemove(entry)}>从引擎中移除…</button>
                : <p className="cs-footnote">{entry.type === 'channel' ? '请在通道中管理或删除此通道。' : '请在扩展中管理或卸载此包。'}</p>}
        </div> : null}
    </aside>;
}
function statusGroup(e) {
    if (e.stagedVersion) return '等待重启';
    if (e.revoked) return '需要关注';
    if (e.updateAvailable) return '有可用更新';
    return e.installedVersion ? '已安装' : '可用';
}
const STATUS_ORDER = ['等待重启', '需要关注', '有可用更新', '已安装', '可用'];
const SORT_COLUMNS = [['name','包名'],['type','类型'],['installedVersion','已安装'],['version','可用'],['downloads','下载量'],['stars','星标'],['status','状态']];
function comparePackages(a, b, key, direction) {
    const value = entry => {
        if (key === 'downloads' || key === 'stars') {
            const metric = entry[key];
            return metric?.status === 'available' && Number.isSafeInteger(metric.count) && metric.count >= 0 ? metric.count : null;
        }
        if (key === 'type') return typeRank(entry.type);
        if (key === 'status') return STATUS_ORDER.indexOf(statusGroup(entry));
        if (key === 'version' && entry.revoked) return null;
        return entry[key] || null;
    };
    const x=value(a), y=value(b);
    // Missing values remain last in either direction; zero is a real count.
    if (x == null && y != null) return 1;
    if (y == null && x != null) return -1;
    const compared = x == null ? 0 : typeof x === 'number' ? x-y : x.localeCompare(y, undefined, {numeric:true, sensitivity:'base'});
    return compared * (direction === 'desc' ? -1 : 1) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
function CatalogView({ catalog, tab, selectedId, onSelect, actions }) {
    const [search, setSearch] = React.useState('');
    const [typeFilter, setTypeFilter] = React.useState('');
    const [groupBy, setGroupBy] = React.useState(() => getPref('groupBy', 'type'));
    const [sortBy, setSortBy] = React.useState(() => getPref('sortBy', 'name'));
    const [sortDirection, setSortDirection] = React.useState(() => getPref('sortDirection', 'asc'));
    const changeSort = (key, toggle = false) => {
        const direction = toggle && key === sortBy ? (sortDirection === 'asc' ? 'desc' : 'asc') : ['downloads','stars','installedVersion','version'].includes(key) ? 'desc' : 'asc';
        setSortBy(key); setSortDirection(direction); setPref('sortBy',key); setPref('sortDirection',direction);
    };
    const [collapsed, setCollapsed] = React.useState({});
    const visible = (catalog.entries || []).filter(e => e.installedVersion || e.stagedVersion || showsInWebUi(e));
    const entries = visible.filter(e => (tab === 'installed' ? e.installedVersion || e.stagedVersion
        : tab === 'updates' ? e.updateAvailable && !e.stagedVersion && !e.revoked : !e.revoked)
        && (!typeFilter || e.type === typeFilter)
        && `${e.name} ${e.description} ${e.repo} ${(e.keywords || []).join(' ')}`.toLowerCase().includes(search.toLowerCase()))
        .sort((a,b) => comparePackages(a,b,sortBy,sortDirection));
    const types = [...new Set(visible.map(e => e.type))].sort((a,b) => typeRank(a) - typeRank(b));
    const groups = new Map();
    for (const entry of entries) {
        const key = groupBy === 'type' ? entry.type : groupBy === 'status' ? statusGroup(entry) : '所有包';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
    }
    const orderedGroups = [...groups].sort(([a],[b]) => groupBy === 'type' ? typeRank(a)-typeRank(b) : groupBy === 'status' ? STATUS_ORDER.indexOf(a)-STATUS_ORDER.indexOf(b) : 0);
    const selected = visible.find(e => e.id === selectedId);
    return <div className="cs-catalog">
        <div className="cs-toolbar">
            <label className="cs-search"><input className="field" aria-label="搜索包" placeholder="搜索社区包…" value={search} onChange={e => setSearch(e.target.value)} /></label>
            <select className="field" aria-label="包类型" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}><option value="">所有包类型</option>{types.map(type => <option key={type} value={type}>{TYPE_LABELS[type] || type}</option>)}</select>
            <select className="field" aria-label="分组方式" value={groupBy} onChange={e => {setGroupBy(e.target.value);setPref('groupBy',e.target.value);}}><option value="status">按状态分组</option><option value="type">按类型分组</option><option value="none">不分组</option></select>
            <select className="field" aria-label="排序方式" value={sortBy} onChange={e => changeSort(e.target.value)}>{SORT_COLUMNS.map(([key,label]) => <option key={key} value={key}>按{label}排序</option>)}</select>
            <button className="btn btn-sm" aria-label="切换排序方向" onClick={() => changeSort(sortBy,true)}>{sortDirection === 'asc' ? '升序 ↑' : '降序 ↓'}</button>
            <span className="cs-result-count" role="status">{entries.length} 个包</span>
        </div>
        <div className="cs-workspace" tabIndex={0} aria-label="包列表">
            <table className="cs-table"><thead><tr>{SORT_COLUMNS.map(([key,label]) => <th key={key} scope="col" aria-sort={sortBy === key ? sortDirection === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="cs-sort-heading" onClick={() => changeSort(key,true)} title={key === 'downloads' ? DOWNLOAD_NOTE : `按${label}排序`}>{label}<span aria-hidden="true">{sortBy === key ? sortDirection === 'asc' ? ' ↑' : ' ↓' : ' ↕'}</span></button></th>)}</tr></thead>
                {orderedGroups.map(([key, items]) => <tbody key={key}>
                    {groupBy !== 'none' ? <tr className="cs-group"><th colSpan={7} scope="rowgroup"><button aria-expanded={!collapsed[groupBy+key]} onClick={() => setCollapsed(old => ({...old,[groupBy+key]:!old[groupBy+key]}))}><span aria-hidden="true">{collapsed[groupBy+key] ? '▸' : '▾'}</span> {groupBy === 'type' ? TYPE_LABELS[key] || key : key} <span className="cs-count">{items.length}</span></button></th></tr> : null}
                    {(groupBy === 'none' || !collapsed[groupBy+key]) && items.map(entry => <tr key={entry.id} className="cs-package-row" onClick={() => onSelect(entry.id)}>
                        <td><button className="cs-package" aria-haspopup="dialog" onClick={e => {e.stopPropagation();onSelect(entry.id);}}><PackageIcon type={entry.type} /><span><span className="cs-name">{entry.name}</span><span className="cs-description">{entry.description}</span></span></button></td>
                        <td>{TYPE_LABELS[entry.type] || entry.type}</td><td>{entry.installedVersion || '—'}</td><td>{entry.revoked ? '—' : entry.version}</td><td><DownloadCount entry={entry} /></td><td><StarCount entry={entry} /></td><td><PackageStatus entry={entry} /></td>
                    </tr>)}
                </tbody>)}
            </table>
            {!entries.length ? <div className="cs-empty">{search || typeFilter ? '没有匹配结果。请尝试其他搜索条件或包类型。' : tab === 'updates' ? '当前目录中没有可用更新。' : tab === 'installed' ? '此引擎上未安装任何商店包。' : '没有可用包。请在设置中检查您的来源和同步状态。'}</div> : null}
        </div>
        {selected ? <ConfirmOverlay documentation closeLabel="关闭包详情" inactive={!!actions.overlay} title={selected.name} onCancel={() => onSelect(null)}><DetailView key={selected.id} entry={selected} actions={actions} /></ConfirmOverlay> : null}
    </div>;
}

/* ------------------------------------------------------------------ */
/* Settings view                                                       */
/* ------------------------------------------------------------------ */

function SettingsView({ catalog, onSaved }) {
    const [settings, setSettings] = React.useState(null);
    const [token, setToken] = React.useState(null); // null = unchanged
    const [newKind, setNewKind] = React.useState('repo');
    const [newValue, setNewValue] = React.useState('');
    const [newTopic, setNewTopic] = React.useState('oie-plugin');
    const [newBlock, setNewBlock] = React.useState('');
    const [saving, setSaving] = React.useState(false);

    const load = async () => {
        try { setSettings(await apiGet(`${BASE}/settings`)); }
        catch (e) { toast(errText(e), 'error'); }
    };
    React.useEffect(() => { load(); }, []);

    if (!settings) return <div className="text-text-dim">正在加载设置…</div>;

    const save = async () => {
        setSaving(true);
        try {
            const body = {
                customSources: settings.customSources,
                localBlocklist: settings.localBlocklist,
                betaChannel: settings.betaChannel,
            };
            if (token !== null) body.token = token;
            const updated = await apiPut(`${BASE}/settings`, body);
            setSettings(updated);
            setToken(null);
            toast('设置已保存。', 'success');
            onSaved();
        } catch (e) {
            toast(errText(e), 'error');
        } finally {
            setSaving(false);
        }
    };

    const addSource = () => {
        const value = newValue.trim();
        if (!value) return;
        const source = newKind === 'catalog'
            ? { kind: 'catalog', url: value }
            : newKind === 'org'
                ? { kind: 'org', org: value, topic: newTopic.trim() || 'oie-plugin' }
                : { kind: 'repo', repo: value };
        setSettings({ ...settings, customSources: [...settings.customSources, source] });
        setNewValue('');
    };

    const describeSource = (s) => s.kind === 'catalog' ? `目录：${s.url}`
        : s.kind === 'org' ? `组织：${s.org}（主题：${s.topic}）` : `仓库：${s.repo}`;

    return (
        <div className="flex flex-col gap-3" style={{ maxWidth: 760 }}>
            <div className="panel">
                <div className="panel-header">来源</div>
                <div className="panel-body">
                    <div className="hint mb-2">
                        内置来源随商店一起提供，并随商店发行版更新。自定义来源
                        为附加来源，存储在此引擎上。
                    </div>
                    <table className="dt">
                        <thead><tr><th>来源</th><th>类型</th><th></th></tr></thead>
                        <tbody>
                            {settings.bundledSources.map((s, i) => (
                                <tr key={`b${i}`}>
                                    <td className="mono">{describeSource(s)}</td>
                                    <td className="text-text-dim">内置</td><td></td>
                                </tr>
                            ))}
                            {settings.customSources.map((s, i) => (
                                <tr key={`c${i}`}>
                                    <td className="mono">{describeSource(s)}</td>
                                    <td className="text-text-dim">自定义</td>
                                    <td><button className="btn" onClick={() =>
                                        setSettings({ ...settings, customSources: settings.customSources.filter((_, j) => j !== i) })
                                    }>移除</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="flex gap-2 items-center mt-3">
                        <select className="field" style={{ maxWidth: 110 }} value={newKind} onChange={(e) => setNewKind(e.target.value)}>
                            <option value="repo">仓库</option>
                            <option value="org">组织</option>
                            <option value="catalog">目录</option>
                        </select>
                        <input className="field" style={{ maxWidth: newKind === 'catalog' ? 380 : 260 }} value={newValue} onChange={(e) => setNewValue(e.target.value)}
                            placeholder={newKind === 'catalog' ? 'https://…/index.json' : newKind === 'org' ? '组织或用户登录名' : '所有者/仓库'} />
                        {newKind === 'org' ? (
                            <input className="field" style={{ maxWidth: 160 }} value={newTopic} onChange={(e) => setNewTopic(e.target.value)}
                                placeholder="主题过滤" />
                        ) : null}
                        <button className="btn" onClick={addSource}>添加来源</button>
                    </div>
                </div>
            </div>

            <div className="panel">
                <div className="panel-header">屏蔽列表</div>
                <div className="panel-body">
                    <div className="hint mb-2">被屏蔽的仓库不会出现在目录中。内置屏蔽列表无法在此处移除。</div>
                    {settings.bundledBlocklist.map((b, i) => (
                        <div key={`bb${i}`} className="flex gap-2 items-center"><span className="mono">{b}</span><span className="text-text-dim">（内置）</span></div>
                    ))}
                    {settings.localBlocklist.map((b, i) => (
                        <div key={`lb${i}`} className="flex gap-2 items-center">
                            <span className="mono">{b}</span>
                            <button className="btn" onClick={() =>
                                setSettings({ ...settings, localBlocklist: settings.localBlocklist.filter((_, j) => j !== i) })
                            }>移除</button>
                        </div>
                    ))}
                    <div className="flex gap-2 items-center mt-2">
                        <input className="field" style={{ maxWidth: 260 }} value={newBlock} onChange={(e) => setNewBlock(e.target.value)} placeholder="所有者/仓库" />
                        <button className="btn" onClick={() => {
                            const value = newBlock.trim().toLowerCase();
                            if (value) setSettings({ ...settings, localBlocklist: [...settings.localBlocklist, value] });
                            setNewBlock('');
                        }}>屏蔽</button>
                    </div>
                </div>
            </div>

            <div className="panel">
                <div className="panel-header">GitHub 访问</div>
                <div className="panel-body flex flex-col gap-2">
                    <label className="flex gap-2 items-center">
                        <input type="checkbox" checked={settings.betaChannel}
                            onChange={(e) => setSettings({ ...settings, betaChannel: e.target.checked })} />
                        包含预发布版（测试通道）
                    </label>
                    <div className="flex gap-2 items-center">
                        <input className="field" type="password" style={{ maxWidth: 340 }}
                            placeholder={settings.tokenSet ? '令牌已配置（留空保持不变，保存空值则清除）' : '个人访问令牌（可选）'}
                            value={token === null ? '' : token}
                            onChange={(e) => setToken(e.target.value)} />
                        {settings.tokenSet && token === null ? <span className="tag">已设置</span> : null}
                    </div>
                    <div className="hint">
                        令牌可提高 GitHub API 速率限制并启用私有来源访问。令牌在引擎上
                        加密存储，不会返回到浏览器。
                        {catalog && catalog.rateLimitRemaining ? ` 剩余速率限制：${catalog.rateLimitRemaining}。` : ''}
                    </div>
                </div>
            </div>

            <div className="flex gap-2">
                <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存设置'}</button>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Root view                                                           */
/* ------------------------------------------------------------------ */

function CommunityStoreView() {
    const [tab, setTab] = React.useState('browse');
    const [catalog, setCatalog] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const [selectedId, setSelectedId] = React.useState(null);
    const [completion, setCompletion] = React.useState(null);
    const [staged, setStaged] = React.useState({});
    const request = React.useRef(0);
    const refresh = async (force) => {
        const current = ++request.current;
        setLoading(true); setError(null);
        try {
            const data = await apiGet(`${BASE}/catalog?refresh=${force ? 'true' : 'false'}`);
            if (request.current !== current) return;
            setCatalog(data);
            setStaged(previous => Object.fromEntries(Object.entries(previous).filter(([id, version]) =>
                !(data.entries || []).some(e => e.id === id && e.installedVersion === version))));
        } catch (e) { if (request.current === current) setError(errText(e)); }
        finally { if (request.current === current) setLoading(false); }
    };
    React.useEffect(() => { refresh(false); return () => { request.current++; }; }, []);
    const actions = useStoreActions(refresh, result => {
        setCompletion(result);
        if (result.restartRequired) setStaged(previous => ({ ...previous, [result.entry.id]: result.entry.version }));
    });
    const data = catalog ? { ...catalog, entries: (catalog.entries || []).map(entry => ({...entry, stagedVersion: staged[entry.id], downloads: entry.statistics?.downloads, stars: entry.statistics?.stars})) } : null;
    const visible = (data?.entries || []).filter(e => e.installedVersion || e.stagedVersion || showsInWebUi(e));
    const counts = {
        browse: visible.filter(e => !e.revoked).length,
        installed: visible.filter(e => e.installedVersion || e.stagedVersion).length,
        updates: visible.filter(e => e.updateAvailable && !e.stagedVersion && !e.revoked).length,
    };
    return <div className="view cs-store flex flex-col flex-1 min-h-0">
        <style>{STORE_CSS}</style>
        {actions.overlay}
        <div className="cs-header">
            <header className="cs-heading">
                <div><h1>社区商店</h1><p>扩展您的引擎，打造专属体验。</p></div>
                <div className="cs-sync"><button className="btn" onClick={() => refresh(true)} disabled={loading || actions.busy}>{loading ? '同步中…' : '↻ 同步来源'}</button><div>{catalog ? `引擎 ${catalog.engineVersion} · 同步于 ${new Date(catalog.generatedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}` : '正在连接引擎'}</div></div>
            </header>
            <nav className="cs-tabs" aria-label="社区商店视图">
                {[['browse','发现'],['installed','已安装'],['updates','更新'], ...(canEditSettings() ? [['settings','设置']] : [])].map(([id,label]) =>
                    <button key={id} className={`cs-tab ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}{id !== 'settings' && data ? <span className="cs-count">{counts[id]}</span> : null}</button>)}
            </nav>
        </div>
        <div className="view-body cs-body">
            {error ? <div className="cs-notice error" role="alert">无法加载目录：{error} <button className="btn btn-sm" onClick={() => refresh(true)} disabled={loading}>重试</button></div> : null}
            {data?.errors?.length ? <div className="cs-notice warn" role="status"><strong>部分来源无法同步。</strong>结果可能不完整。{data.errors.map((e,i) => <div key={i}>{e.source}: {e.message}</div>)}</div> : null}
            {completion ? <div className="cs-notice" role="status">{completion.restartRequired ? `${completion.entry.name} ${completion.entry.version} 已暂存。重启引擎以激活。` : completion.mode === 'remove' ? `${completion.entry.name} 已移除。` : `${completion.entry.name} 已导入${completion.mode === 'copy' ? '为副本' : ''}，现已可用。`} <button className="btn btn-sm" onClick={() => setCompletion(null)} aria-label="关闭结果">关闭</button></div> : null}
            {tab === 'settings' && canEditSettings() ? <div className="cs-settings-scroll"><SettingsView catalog={catalog} onSaved={() => refresh(true)} /></div>
                : data ? <CatalogView catalog={data} tab={tab} selectedId={selectedId} onSelect={setSelectedId} actions={actions} />
                    : loading ? <div className="cs-empty" role="status">正在加载社区包…</div> : null}
        </div>
    </div>;
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function register() {
    platform.registerNavItem({
        id: 'community-store',
        label: '社区商店',
        icon: 'store',
        path: '/community-store',
        section: '引擎',
        order: 80,
        // The store's own task, declared in CommunityStoreServicePlugin's
        // ExtensionPermissions → "View Community Store". RBAC merges it via
        // /task-permissions; without RBAC the nav is always visible.
        task: 'doShowCommunityStore',
    });
    platform.registerView('/community-store', platform.reactView(CommunityStoreView), { title: '社区商店' });
}
