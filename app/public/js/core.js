/* =========================================================================
 * 核心：工具、格式化、状态、HTTP、账单解析与聚合
 * ========================================================================= */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
export const p2 = n => String(n).padStart(2, '0');
export const uniq = a => [...new Set(a)];
export const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
export const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };

/* ---------- 格式化 ---------- */
const CUR = { CNY: '¥', USD: '$', JPY: '¥', EUR: '€' };
export const curSym = () => CUR[state.currency] ?? '';
/** 数字格式器按小数位缓存：toLocaleString 带参数时每次调用都会新建格式器，大表格与治理检查中会被调用成千上万次 */
const moneyFmts = new Map();
const moneyFmt = d => { let f = moneyFmts.get(d); if (!f) moneyFmts.set(d, f = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })); return f; };
export function money(n, d = 2) {
  const v = Math.abs(n) < 0.5 * 10 ** -d ? 0 : n;
  return (v < 0 ? '-' : '') + curSym() + moneyFmt(d).format(Math.abs(v));
}
export const moneyFine = n => money(n, Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 6 : 4);
const compactFmt = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
export const compact = n => (n == null ? '-' : compactFmt.format(n));
export const moneyShort = n => (Math.abs(n) >= 1e5 ? (n < 0 ? '-' : '') + curSym() + compact(Math.abs(n)) : money(n));
export const signedMoney = n => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
const intFmter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
export const intFmt = n => (n == null ? '-' : intFmter.format(Math.round(n)));
export const numFmt = (n, d = 3) => (n == null ? '-' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: d }));
export const pct = (a, b, d = 1) => (b ? (a / b * 100).toFixed(d) + '%' : '-');
export function fmtTime(v, withTime = true) {
  if (v == null || v === '') return '-';
  const d = new Date(typeof v === 'string' && !/^\d+$/.test(v) ? v : Number(v));
  if (isNaN(d)) return String(v);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` + (withTime ? ` ${p2(d.getHours())}:${p2(d.getMinutes())}` : '');
}
export function ago(ts) {
  if (!ts) return '从未';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return fmtTime(ts);
}
export const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const addMonths = (c, n) => { const [y, m] = c.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
export const lastDayOf = c => addDays(addMonths(c, 1) + '-01', -1);
export const weekday = d => new Date(d + 'T00:00:00Z').getUTCDay();
export const isWeekend = d => { const w = weekday(d); return w === 0 || w === 6; };
export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/* ---------- 图标 ---------- */
export const I = {
  overview: '<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  model: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/>',
  ws: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  warn: '<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="M20 6L9 17l-5-5"/>', x: '<path d="M18 6L6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
  wallet: '<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15V7"/><circle cx="16" cy="14" r="1.2"/>',
  forecast: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  token: '<path d="M4 7h16M4 12h10M4 17h13"/>',
  unit: '<path d="M12 2v20M17 6.5C17 4.6 14.8 3 12 3S7 4.6 7 6.5 9.2 10 12 10s5 1.6 5 3.5S14.8 17 12 17s-5-1.6-5-3.5"/>',
  cache: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  up: '<path d="M7 17L17 7M8 7h9v9"/>', down: '<path d="M7 7l10 10M17 8v9H8"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  terminal: '<path d="M4 17l6-5-6-5M12 19h8"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  chevL: '<path d="M15 6l-6 6 6 6"/>', chevR: '<path d="M9 6l6 6-6 6"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.9-9.9A6 6 0 0 1 17.7 9 4.5 4.5 0 0 1 17.5 18z"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};
/** 复制按钮（行内小图标），点击由 main.js 统一处理 */
export const copyBtn = (text, label = '复制') => (text ? `<button type="button" class="copy" data-copy="${esc(text)}" title="${esc(label)}：${esc(text)}" aria-label="${esc(label)} ${esc(text)}">${icon('copy')}</button>` : '');
/** KPI 图标点缀色（界面色，不用于图表数据） */
export const TONE = { wallet: 'blue', forecast: 'violet', calendar: 'violet', key: 'teal', token: 'sky', unit: 'amber', cache: 'indigo', model: 'fuchsia', layers: 'fuchsia', activity: 'teal' };
export const toneOf = ic => TONE[ic] || '';
export const icon = (n, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[n] || ''}</svg>`;

/* =========================================================================
 * 状态
 * ========================================================================= */
export const state = {
  me: null, csrf: '', today: '', tz: 'Asia/Shanghai',
  status: null, data: null, loadedAt: 0, loading: false,
  workspaces: new Map(), apiKeys: new Map(),
  lines: [], daily: [], prev: [], prevFull: [], prevDaily: [], history: [],
  keyActivity: new Map(), budgets: { monthly: null, alertPct: 80, keys: {} }, changes: null,
  compareLabel: '', compareRange: '', currency: 'CNY',
  colors: { key: new Map(), model: new Map(), ws: new Map() },
  providers: [], usage: new Map(), usageRows: [],
};
export const ui = {
  tab: 'overview',
  period: { mode: 'month', cycle: '', preset: '30', from: '', to: '', ...LS.get('bc.period', {}) },
  f: { provider: '', ws: '', key: '', model: '', cc: '', owner: '', channel: '__all', dir: '', item: '', q: '', metric: LS.get('bc.metric', 'pretax') },
  moreFilters: false, onlySpent: false,
  trendMode: 'daily', trendBy: 'key', compBy: 'ws', varBy: 'key', hmMetric: 'cost', adminTab: 'aliyun',
  density: LS.get('bc.density', 'normal'),
};
/** 由 main.js 注入，供各视图调用，避免循环依赖 */
export const app = { render() {}, setFilter() {}, go() {}, openModel() {}, setPeriod() {}, reload: async () => {}, refreshStatus: async () => {} };
export const METRICS = { pretax: '应付金额', gross: '原价', after: '优惠后金额' };
export const metricVal = l => (ui.f.metric === 'gross' ? l.gross : ui.f.metric === 'after' ? l.after : l.pretax);
export const NONE_KEY = '__none__';
export const isAdmin = () => state.me?.role === 'admin';
export const PROVIDERS = { aliyun: '阿里云', tencent: '腾讯云' };
/** 当前数据中涉及多个云厂商时才显示云厂商维度，避免单云用户看到无意义的筛选 */
export const multiCloud = () => state.providers.length > 1;
export const provTag = (p, force = false) => (p && (force || multiCloud()) ? `<span class="prov ${esc(p)}" title="${esc(PROVIDERS[p] || p)}">${esc(PROVIDERS[p] || p)}</span>` : '');
export const brandName = () => state.status?.branding?.name || '大模型费用分析';
/** 是否有任一 Key 设置了成本中心 / 负责人 */
export const hasTags = () => [...state.apiKeys.values()].some(k => k.costCenter || k.owner);
export const NO_CC = '__nocc__';
export const NO_WS = '__nows';
export const NO_OWNER = '__noowner__';
/** 全局筛选维度（不含关键字与费用口径） */
export const FILTER_DIMS = ['provider', 'ws', 'cc', 'owner', 'key', 'model', 'dir', 'item', 'channel'];
export const emptyFilters = () => ({ provider: '', ws: '', key: '', model: '', cc: '', owner: '', channel: '__all', dir: '', item: '', q: '' });
export const isSet = (k, v) => (k === 'channel' ? v !== '__all' && v != null : !!v);

/* =========================================================================
 * 对话框：动态创建 <dialog>，支持表单提交（返回 Promise）
 * ========================================================================= */
export function modal({ title, body, submit = '确定', cancel = '取消', wide = false, onSubmit, onOpen, danger = false }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'modal' + (wide ? ' wide' : '');
    d.setAttribute('aria-label', title);
    d.innerHTML = `<div class="dlg-h"><h2>${esc(title)}</h2><span class="sp"></span><button type="button" class="btn ghost icon sm" data-x aria-label="关闭">${icon('x')}</button></div>
      <form class="dlg-b" novalidate>${body}<div class="bad-text dlg-err" role="alert"></div>
      <div class="row dlg-f"><span class="sp"></span>${cancel ? `<button type="button" class="btn" data-x>${esc(cancel)}</button>` : ''}${submit ? `<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(submit)}</button>` : ''}</div></form>`;
    document.body.appendChild(d);
    const form = d.querySelector('form'), err = d.querySelector('.dlg-err');
    const close = v => { d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', e => { e.preventDefault(); close(null); });
    let downOnBackdrop = false;
    d.addEventListener('mousedown', e => { downOnBackdrop = e.target === d; });
    d.addEventListener('click', e => { if (e.target.closest('[data-x]') || (e.target === d && downOnBackdrop)) close(null); downOnBackdrop = false; });
    form.onsubmit = async e => {
      e.preventDefault();
      err.textContent = '';
      const btn = form.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try { const v = onSubmit ? await onSubmit(form, d) : Object.fromEntries(new FormData(form)); if (v !== false) close(v ?? true); }
      catch (ex) { err.textContent = ex.message; }
      finally { if (btn) btn.disabled = false; }
    };
    d.showModal();
    onOpen?.(form, d);
    (form.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea') || form.querySelector('button'))?.focus();
  });
}

/* =========================================================================
 * HTTP / Toast
 * ========================================================================= */
export async function http(method, url, body, { background = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (background) headers['X-Background'] = '1'; // 后台轮询：不刷新会话空闲计时
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (res.status === 401) {
    // 把原因（会话过期 / 被强制退出）带到登录页显示
    const j = await res.json().catch(() => ({}));
    try { if (state.me) sessionStorage.setItem('bc.loginMsg', j.error || '会话已过期，请重新登录'); } catch { /* ignore */ }
    location.href = '/login' + location.hash;
    throw new Error(j.error || '未登录或会话已过期');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || res.statusText), { status: res.status, code: j.code });
  return j;
}
export function toast(msg, kind = '', ms = 2800) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.innerHTML = icon(kind === 'err' ? 'warn' : 'check') + `<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* =========================================================================
 * 计费项 / 渠道
 * ========================================================================= */
const CHANNEL_LABEL = {
  '': '默认（API 调用）', app: '应用调用', bmp: '控制台体验', 'assistant-api': 'Assistant API', responses: 'Responses API', evalModel: '模型评测',
  batch: '批量推理', agent1: '智能体', agent2: '智能体', 'managed agent': '托管智能体', RAG: '知识库 RAG', training: '模型训练',
};
export const channelLabel = c => (CHANNEL_LABEL[c] != null ? CHANNEL_LABEL[c] : /-code-proxy$/.test(c) ? '编程助手代理' : c);
const DIR_LABEL = { in: '输入', out: '输出', emb: '向量', other: '其他' };
const ioCache = new Map();
export function ioInfo(io) {
  const raw = io || '';
  if (ioCache.has(raw)) return ioCache.get(raw);
  let s = raw, ctx = '', thinking = false, time = '', cache = '', ttl = '';
  const m = s.match(/^context_([^_]+)_(.+)$/); if (m) { ctx = m[1]; s = m[2]; }
  if (/^thinking_/.test(s)) { thinking = true; s = s.slice(9); }
  if (/_offpeak$/.test(s)) { time = 'offpeak'; s = s.slice(0, -8); } else if (/_peak$/.test(s)) { time = 'peak'; s = s.slice(0, -5); }
  const cm = s.match(/cache_creation(?:_(\w+))?$/);
  if (cm) { cache = 'create'; ttl = cm[1] || ''; } else if (/cache/.test(s)) cache = 'hit';
  const dir = /^output/.test(s) ? 'out' : /^input/.test(s) ? 'in' : /^embedding/.test(s) ? 'emb' : 'other';
  const tags = [];
  if (cache === 'hit') tags.push('缓存命中');
  if (cache === 'create') tags.push('缓存创建' + (ttl ? `(${ttl})` : ''));
  if (thinking) tags.push('思考');
  if (time === 'peak') tags.push('峰时');
  if (time === 'offpeak') tags.push('闲时');
  if (ctx) tags.push('上下文 ' + ctx);
  const label = !raw ? '—' : dir === 'other' ? raw : DIR_LABEL[dir] + (tags.length ? ' · ' + tags.join(' · ') : '');
  const r = { dir, cache, time, thinking, ctx, label };
  ioCache.set(raw, r);
  return r;
}

/* =========================================================================
 * 数据映射与关联
 * ========================================================================= */
export function mapLines(block) {
  if (!block) return [];
  const idx = Object.fromEntries(block.cols.map((c, i) => [c, i]));
  const v = (r, c) => (idx[c] == null ? undefined : r[idx[c]]);
  return block.rows.map(r => {
    const io = v(r, 'io') || '';
    const pretax = num(v(r, 'pretax'));
    const ws = v(r, 'workspace_id');
    return {
      provider: v(r, 'provider') || 'aliyun', alloc: v(r, 'alloc') || 0,
      date: v(r, 'period') || '', apiKeyId: v(r, 'api_key_id') || '', workspaceId: ws === '-' ? '' : (ws || ''), model: v(r, 'model') || '(未知模型)',
      io, ioi: ioInfo(io), channel: v(r, 'channel') || '', stopFlag: v(r, 'stop_flag') || '', kind: v(r, 'kind') || '',
      usage: v(r, 'usage') ?? null, usageUnit: v(r, 'usage_unit') || '', tokens: v(r, 'tokens') ?? null,
      listPrice: v(r, 'list_price') ?? '', listPriceUnit: v(r, 'list_price_unit') || '',
      gross: num(v(r, 'gross')), pretax, after: v(r, 'after_discount') == null ? pretax : num(v(r, 'after_discount')),
      discount: num(v(r, 'invoice_discount')), coupons: num(v(r, 'coupons')), cashCoupons: num(v(r, 'cash_coupons')), prepaid: num(v(r, 'prepaid')),
      resourcePkg: v(r, 'resource_pkg') || '', currency: v(r, 'currency') || '', billingItem: v(r, 'billing_item') || '', commodityCode: v(r, 'commodity_code') || '',
      productDetail: v(r, 'product_detail') || '', instanceId: v(r, 'instance_id') || '', region: v(r, 'region') || '', item: v(r, 'item') || '',
    };
  });
}

export function applyData(d) {
  state.data = d;
  state.today = d.today;
  state.workspaces = new Map(d.workspaces.map(w => [w.workspaceId, { ...w, source: w.deletedAt ? 'deleted' : 'api' }]));
  state.apiKeys = new Map(d.apiKeys.map(k => [k.apiKeyId, { ...k, source: k.deletedAt ? 'deleted' : 'api' }]));
  state.extraTags = new Map((d.extraTags || []).map(t => [t.apiKeyId, t]));
  state.lines = mapLines(d.lines);
  state.daily = d.daily ? mapLines(d.daily) : state.lines;
  const usePrevMtd = d.period.mode === 'month' && d.period.isCurrent && d.prevMtd;
  state.prev = mapLines(usePrevMtd ? d.prevMtd : d.prev);
  state.prevFull = usePrevMtd ? mapLines(d.prev) : state.prev;
  state.prevDaily = mapLines(d.prevDaily);
  state.history = mapLines(d.history);
  state.keyActivity = new Map((d.keyActivity || []).map(a => [a.apiKeyId || NONE_KEY, a]));
  // 请求次数 / 失败次数：腾讯云来自 TokenHub 用量统计，阿里云来自百炼监控投递的云监控 Prometheus（可选）
  state.usageRows = mapUsage(d.usage);
  state.usage = new Map();
  for (const u of state.usageRows) {
    const k = state.usage.get(u.apiKeyId) || { requests: 0, fails: 0, tokens: 0, input: 0, output: 0, cache: 0, models: new Map(), days: new Map() };
    k.requests += u.requests; k.fails += u.fails; k.tokens += u.tokens; k.input += u.input; k.output += u.output; k.cache += u.cache;
    const m = k.models.get(u.model) || { requests: 0, fails: 0, tokens: 0 };
    m.requests += u.requests; m.fails += u.fails; m.tokens += u.tokens; k.models.set(u.model, m);
    const dd = k.days.get(u.day) || { requests: 0, fails: 0, tokens: 0 };
    dd.requests += u.requests; dd.fails += u.fails; dd.tokens += u.tokens; k.days.set(u.day, dd);
    state.usage.set(u.apiKeyId, k);
  }
  state.budgets = { monthly: null, alertPct: 80, keys: {}, ...(d.budgets || {}) };
  state.changes = null; // 变更记录缓存随数据刷新失效：同步检测到的新变更要在 Key / 业务空间详情中可见
  state.compareLabel = d.period.mode === 'month' ? (usePrevMtd ? '较上月同期' : '较上月') : '较上一周期';
  state.compareRange = usePrevMtd ? d.period.prevMtdLabel : d.period.prevLabel;
  state.loadedAt = Date.now();
  finalize();
}

function mapUsage(block) {
  if (!block) return [];
  const idx = Object.fromEntries(block.cols.map((c, i) => [c, i]));
  const g = (r, c) => (idx[c] == null ? 0 : num(r[idx[c]]));
  return block.rows.map(r => ({ provider: r[idx.provider], day: idx.day == null ? '' : r[idx.day], apiKeyId: r[idx.api_key_id] || '', model: r[idx.model], requests: g(r, 'requests'), fails: g(r, 'fails'), input: g(r, 'input_tokens'), output: g(r, 'output_tokens'), cache: g(r, 'cache_tokens'), tokens: g(r, 'total_tokens') }));
}
/** 模型名规范化：用量统计与账单中的模型名大小写 / 分隔符可能不同 */
export const normModel = s => String(s || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
/**
 * 按当前全局筛选过滤用量行（云厂商、Key、模型、成本中心、业务空间）。
 * Token 类型 / 计费项 / 渠道筛选无法作用于请求数，此时返回 null（页面显示“—”而不是错误的数字）。
 */
export function usageFiltered(rows = state.usageRows, f = ui.f) {
  if (f.dir || f.item || f.channel !== '__all') return null;
  const nm = f.model ? normModel(f.model) : '';
  return rows.filter(u => {
    if (f.provider && u.provider !== f.provider) return false;
    if (f.key && (u.apiKeyId || NONE_KEY) !== f.key) return false;
    if (nm && normModel(u.model) !== nm) return false;
    const k = state.apiKeys.get(u.apiKeyId);
    if (f.cc && (f.cc === NO_CC ? !!k?.costCenter : k?.costCenter !== f.cc)) return false;
    if (f.owner && (f.owner === NO_OWNER ? !!k?.owner : k?.owner !== f.owner)) return false;
    if (f.ws && (f.ws === NO_WS ? !!k?.wsKey : (k?.wsKey || '') !== f.ws)) return false;
    if (f.q) {
      const q = f.q.trim().toLowerCase();
      if (q && !`${u.apiKeyId} ${keyDesc(u.apiKeyId)} ${u.model} ${wsName(k?.wsKey || '')} ${k?.costCenter || ''} ${k?.owner || ''} ${PROVIDERS[u.provider] || ''}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}
/** 用量行按维度汇总：请求数、失败数、Token（含按日） */
export function usageAgg(rows, keyFn) {
  const m = new Map();
  for (const u of rows || []) {
    const id = keyFn(u);
    const a = m.get(id) || { requests: 0, fails: 0, tokens: 0, input: 0, output: 0, cache: 0, days: new Map(), keys: new Set(), providers: new Set() };
    a.requests += u.requests; a.fails += u.fails; a.tokens += u.tokens; a.input += u.input; a.output += u.output; a.cache += u.cache; a.keys.add(u.apiKeyId); a.providers.add(u.provider);
    const d = a.days.get(u.day) || { requests: 0, fails: 0, tokens: 0 };
    d.requests += u.requests; d.fails += u.fails; d.tokens += u.tokens; a.days.set(u.day, d);
    m.set(id, a);
  }
  return m;
}
/** 调用次数来源说明（列标题 / 帮助文字） */
export const REQ_SRC = '腾讯云来自 TokenHub 用量统计；阿里云来自百炼监控投递的云监控 Prometheus（在“系统管理 → 阿里云接入”中启用）';
/** 该云厂商是否有调用次数数据源 */
export const callsOn = p => p === 'tencent' || (p === 'aliyun' && !!state.status?.calls?.aliyun);
/** 失败次数是否可信：阿里云只有配置了失败次数指标才有 */
export const failsKnown = us => !us?.providers?.has('aliyun') || !!state.status?.calls?.aliyunFails;
/**
 * 单次平均费用的分子：只合计有调用次数数据的日期的费用。调用次数常常只覆盖周期的一部分（如阿里云从开启监控投递之日起才有数据、
 * 数据源中断），用整个周期的费用除以部分日期的请求数会把单次费用放大数倍。dailyLines 为该实体的按日账单行（已按筛选过滤）
 */
export function coveredCost(dailyLines, us) {
  if (!us?.days?.size) return 0;
  let c = 0;
  for (const l of dailyLines || []) if (us.days.has(l.date)) c += metricVal(l);
  return c;
}
/**
 * 单次平均指标（请求数实时、今天的账单延迟数小时入账）：不计今天，分子只用有调用数据的日期的费用。
 * Token 结构（输入 / 输出 / 缓存）按总 Token 比例扣除今天的部分
 */
export function perCallCovered(us, dailyLines) {
  const d = us?.days?.get(state.today);
  let u = us;
  if (d && us.requests - d.requests > 0) {
    const r = us.tokens ? (us.tokens - d.tokens) / us.tokens : 1;
    const days = new Map(us.days); days.delete(state.today);
    u = { ...us, requests: us.requests - d.requests, fails: us.fails - d.fails, tokens: us.tokens - d.tokens, input: us.input * r, output: us.output * r, cache: us.cache * r, days };
  }
  return perCall(u, coveredCost(dailyLines, u));
}
/** 失败率：失败次数可信时返回失败请求占比，否则 null（页面显示“—”，不能把“未采集”显示成 0%） */
export const failRateOf = us => (us && us.requests && failsKnown(us) ? us.fails / us.requests : null);
/** 用量统计口径：请求数可用时计算单次平均 Token / 费用（Token 取用量统计 / 同日同 Key 同模型的账单 Token，费用取账单） */
export function perCall(us, cost) {
  if (!us || !us.requests) return null;
  const ok = us.requests - us.fails;
  return { requests: us.requests, fails: us.fails, success: us.requests && failsKnown(us) ? ok / us.requests : null, tokPer: us.tokens / us.requests, inPer: us.input / us.requests, outPer: us.output / us.requests, costPer: cost / us.requests, costPerK: cost / us.requests * 1000 };
}

function finalize() {
  // 包含上一个完整周期（本月进行中时 prevFull 与 prev 不同）：否则按业务空间 / 成本中心 / 负责人筛选时“上月全月”数据无法关联
  const all = [...new Set([...state.lines, ...state.daily, ...state.prev, ...state.prevFull, ...state.prevDaily, ...state.history])];
  for (const l of all) {
    if (l.apiKeyId && !state.apiKeys.has(l.apiKeyId)) {
      const t = state.extraTags?.get(l.apiKeyId); // 只出现在账单中的 Key 也可以有本地标签
      state.apiKeys.set(l.apiKeyId, { apiKeyId: l.apiKeyId, provider: l.provider, apiKeyValue: '', description: '', workspaceId: l.workspaceId, workspaceName: '', disabled: null, source: 'bill', accessIps: [], accessibleModels: [], costCenter: t?.costCenter || '', owner: t?.owner || '', note: t?.note || '' });
    }
    const k = l.apiKeyId ? state.apiKeys.get(l.apiKeyId) : null;
    if (k && (!k.workspaceId || k.workspaceId === '-') && l.workspaceId) k.workspaceId = l.workspaceId;
    if (l.workspaceId && !state.workspaces.has(l.workspaceId)) {
      state.workspaces.set(l.workspaceId, { workspaceId: l.workspaceId, workspaceName: (k && k.workspaceName) || '', source: 'bill' });
    }
  }
  for (const k of state.apiKeys.values()) {
    if (k.workspaceId === '-') k.workspaceId = '';
    k.wsKey = k.workspaceId || '';
    const w = k.workspaceId && state.workspaces.get(k.workspaceId);
    if (w && !w.workspaceName && k.workspaceName) w.workspaceName = k.workspaceName;
    if (w && !k.workspaceName) k.workspaceName = w.workspaceName;
  }
  for (const l of all) l.wsKey = l.workspaceId || (l.apiKeyId && state.apiKeys.get(l.apiKeyId)?.wsKey) || '';
  const rank = f => {
    const t = new Map();
    for (const l of state.lines) { const k = f(l); t.set(k, (t.get(k) || 0) + l.pretax + l.gross * 1e-6); }
    return new Map([...t.entries()].filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 7).map((e, i) => [e[0], i]));
  };
  for (const l of all) { const k = l.apiKeyId && state.apiKeys.get(l.apiKeyId); l.cc = (k && k.costCenter) || ''; l.owner = (k && k.owner) || ''; }
  state.colors = { key: rank(l => l.apiKeyId || NONE_KEY), model: rank(l => l.model), ws: rank(l => l.wsKey) };
  state.currency = state.lines.find(l => l.currency)?.currency || 'CNY';
  const used = new Set([...(state.data?.providers || []), ...[...state.apiKeys.values()].map(k => k.provider || 'aliyun'), ...state.lines.map(l => l.provider)]);
  state.providers = Object.keys(PROVIDERS).filter(p => used.has(p));
}

/* ---------- 名称 ---------- */
export const keyObj = id => (id && id !== NONE_KEY ? state.apiKeys.get(id) : null);
export function keyDesc(id) {
  if (!id || id === NONE_KEY) return '无 API Key（控制台/订阅/其他）';
  const k = keyObj(id);
  if (k?.description) return k.description;
  return k?.source === 'bill' ? '（不在 Key 列表）' : '（无描述）';
}
/** 紧凑名称：有描述用描述，否则“ID（无描述）” */
export const keyShort = id => (!id || id === NONE_KEY ? '无 API Key' : keyObj(id)?.description || `${id}${keyDesc(id)}`);
export const keyLabel = id => (!id || id === NONE_KEY ? keyDesc(id) : `${keyShort(id)} · ${id}`);
export function wsName(wsKey) {
  if (!wsKey) return '（未归属业务空间）';
  const w = state.workspaces.get(wsKey);
  return w ? (w.workspaceName || w.workspaceId) : wsKey;
}
const colorFrom = (map, id) => { const i = map.get(id); return i == null ? 'var(--other)' : `var(--s${i + 1})`; };
export const keyColor = id => colorFrom(state.colors.key, id || NONE_KEY);
/**
 * 当前范围内的系列配色：已有全局颜色的实体保持原色（跨视图一致），空闲色位依次分给范围内费用较高的其余实体，最多 8 色。
 * 筛选 / 下钻到全局前 7 名以外的实体时，图表仍按实体区分，而不是全部并成一个灰色“其他”
 */
export function scopeColors(ranked, colorFn, max = 8) {
  const out = new Map();
  for (const id of ranked) { const c = colorFn(id); if (c !== "var(--other)") out.set(id, c); }
  const free = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--s${i})`).filter(c => ![...out.values()].includes(c));
  for (const id of ranked) { if (!free.length || out.size >= max) break; if (!out.has(id)) out.set(id, free.shift()); }
  return out;
}
const PROV_COLOR = { aliyun: 'var(--s2)', tencent: 'var(--s1)' };
export const ccName = cc => (cc && cc !== NO_CC ? cc : '（未分配成本中心）');
export const ownerName = o => (o && o !== NO_OWNER ? o : '（未指定负责人）');
const hashColor = id => (id ? `var(--s${(Math.abs([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 7) + 1})` : 'var(--other)');
export const DIMS = {
  key: { label: 'API Key', of: l => l.apiKeyId || NONE_KEY, short: keyShort, color: keyColor },
  model: { label: '模型', of: l => l.model, short: id => id, color: id => colorFrom(state.colors.model, id) },
  ws: { label: '业务空间', of: l => l.wsKey, short: id => wsName(id === NO_WS ? '' : id), color: id => colorFrom(state.colors.ws, id === NO_WS ? '' : id) },
  provider: { label: '云厂商', of: l => l.provider, short: id => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : id), color: id => PROV_COLOR[id] || 'var(--other)' },
  cc: { label: '成本中心', of: l => l.cc, short: ccName, color: id => hashColor(id === NO_CC ? '' : id) },
  owner: { label: '负责人', of: l => l.owner, short: ownerName, color: id => hashColor(id === NO_OWNER ? '' : id) },
};

/* =========================================================================
 * 维度联动：维度值（含“未归属”哨兵值）、全局筛选 ↔ 维度、实体范围（scope）
 *  - 维度值 dimVal：ws / cc / owner 的空值统一为 NO_WS / NO_CC / NO_OWNER，与全局筛选取值一致
 *  - scope：{ provider?, ws?, cc?, owner?, key?, model?, global? }；global=true 表示在全局筛选基础上再限定，
 *    否则只按 scope 自身限定（实体详情页：业务空间 / Key 详情不受全局筛选影响）
 * ========================================================================= */
export const SCOPE_DIMS = ['provider', 'ws', 'cc', 'owner', 'key', 'model'];
export const dimVal = {
  provider: l => l.provider, ws: l => l.wsKey || NO_WS, cc: l => l.cc || NO_CC, owner: l => l.owner || NO_OWNER,
  key: l => l.apiKeyId || NONE_KEY, model: l => l.model, dir: l => l.ioi.dir, item: l => l.io, channel: l => l.channel,
};
/** Key 元数据在某维度上的取值（无消费的 Key 也能关联到业务空间 / 成本中心 / 负责人） */
export const keyDimVal = {
  provider: k => k.provider || 'aliyun', ws: k => k.wsKey || NO_WS, cc: k => k.costCenter || NO_CC, owner: k => k.owner || NO_OWNER, key: k => k.apiKeyId,
};
export const dimName = (dim, v) => (dim === 'ws' ? (v === NO_WS ? '（未归属业务空间）' : wsName(v)) : dim === 'cc' ? ccName(v) : dim === 'owner' ? ownerName(v)
  : dim === 'provider' ? (Object.hasOwn(PROVIDERS, v) ? PROVIDERS[v] : v) : dim === 'key' ? keyShort(v) : v);
export const DIM_LABEL = { provider: '云厂商', ws: '业务空间', cc: '成本中心', owner: '负责人', key: 'API Key', model: '模型' };
const scopeObj = s => (typeof s === 'string' ? { key: s } : s || null);
const lineIn = (l, s) => SCOPE_DIMS.every(d => s[d] == null || dimVal[d](l) === s[d]);
/** 按范围取账单行；scope 为空时等同全局筛选 */
export function scopeLines(arr, scope) {
  const s = scopeObj(scope);
  if (!s) return filterLines(arr);
  return (s.global ? filterLines(arr) : arr).filter(l => lineIn(l, s));
}
/** 按范围取用量行（请求次数）；全局筛选中有 Token 类型 / 计费项 / 渠道时返回 null */
export function scopeUsage(scope) {
  const s = scopeObj(scope);
  if (!s) return usageFiltered();
  const base = s.global ? usageFiltered() : state.usageRows;
  if (!base) return null;
  const nm = s.model != null ? normModel(s.model) : null;
  return base.filter(u => {
    const k = state.apiKeys.get(u.apiKeyId) || {};
    if (s.provider != null && u.provider !== s.provider) return false;
    if (s.key != null && (u.apiKeyId || NONE_KEY) !== s.key) return false;
    if (s.ws != null && (k.wsKey || NO_WS) !== s.ws) return false;
    if (s.cc != null && (k.costCenter || NO_CC) !== s.cc) return false;
    if (s.owner != null && (k.owner || NO_OWNER) !== s.owner) return false;
    if (nm != null && normModel(u.model) !== nm) return false;
    return true;
  });
}
export const scopeLabel = scope => { const s = scopeObj(scope); return s ? SCOPE_DIMS.filter(d => s[d] != null).map(d => dimName(d, s[d])).join(' · ') : ''; };
/** 范围 → 全局筛选补丁（用于“按此筛选 / 账单明细”） */
export const scopeFilter = scope => { const s = scopeObj(scope) || {}; return Object.fromEntries(SCOPE_DIMS.filter(d => s[d] != null).map(d => [d, s[d]])); };
/** 业务空间 / 成本中心 / 负责人 / 云厂商 详情页地址 */
export const groupHash = (dim, id) => `#/group/${dim}/${encodeURIComponent(id)}`;
/** 维度值的“详情”跳转地址：Key → Key 详情；业务空间 / 成本中心 / 负责人 / 云厂商 → 分组详情；模型无页面（抽屉） */
export const entityHash = (dim, v) => (dim === 'key' ? (v && v !== NONE_KEY ? `#/key/${encodeURIComponent(v)}` : null) : ['ws', 'cc', 'owner', 'provider'].includes(dim) ? groupHash(dim, v) : null);
/** 维度值的行内链接按钮（表格单元格内使用；表格行点击会忽略按钮） */
export function dimLink(dim, v, text = dimName(dim, v), scope = null) {
  if (dim === 'model') return `<button type="button" class="lnk" data-model="${esc(v)}"${scope ? ` data-scope="${esc(JSON.stringify(scope))}"` : ''} title="查看模型详情：${esc(v)}">${esc(text)}</button>`;
  const h = entityHash(dim, v);
  return h ? `<button type="button" class="lnk" data-go="${esc(h)}" title="${esc(`查看${DIM_LABEL[dim] || ''}详情：${dimName(dim, v)}`)}">${esc(text)}</button>` : esc(text);
}

/**
 * 级联筛选：某维度在“其余筛选条件”下的可选值集合。
 * 来源 = 符合其余条件的账单行 + 符合其余条件的 Key 元数据（无消费的 Key / 业务空间也可被关联出来）。
 * 其余条件中含模型 / Token 类型 / 计费项 / 渠道 / 关键字时，只能由账单行决定。
 */
const facetMemo = new WeakMap();
export function facetValues(dim, f = ui.f) {
  const g = { ...f, [dim]: dim === 'channel' ? '__all' : '' };
  const sig = dim + '|' + JSON.stringify(g);
  let memo = facetMemo.get(state.lines);
  if (!memo) facetMemo.set(state.lines, memo = new Map());
  if (memo.has(sig)) return memo.get(sig);
  const set = new Set();
  for (const l of filterWith(state.lines, g)) set.add(dimVal[dim](l));
  const lineOnly = ['model', 'dir', 'item', 'channel', 'q'].some(k => isSet(k, g[k]));
  if (keyDimVal[dim] && !lineOnly) {
    for (const k of state.apiKeys.values()) if (keyMatch(k, g)) set.add(keyDimVal[dim](k));
    if (dim === 'ws' && !g.key && !g.cc && !g.owner) for (const w of state.workspaces.values()) if (!g.provider || (w.provider || 'aliyun') === g.provider) set.add(w.workspaceId);
  }
  if (memo.size > 200) memo.clear();
  memo.set(sig, set);
  return set;
}
/** Key 元数据是否满足筛选中的元数据条件（云厂商 / 业务空间 / 成本中心 / 负责人 / Key） */
export function keyMatch(k, f = ui.f) {
  if (f.provider && (k.provider || 'aliyun') !== f.provider) return false;
  if (f.ws && (k.wsKey || NO_WS) !== f.ws) return false;
  if (f.cc && (k.costCenter || NO_CC) !== f.cc) return false;
  if (f.owner && (k.owner || NO_OWNER) !== f.owner) return false;
  if (f.key && k.apiKeyId !== f.key) return false;
  return true;
}

/* =========================================================================
 * 过滤与聚合
 * ========================================================================= */
/* 同一数据数组 + 同一筛选条件的结果会被多个视图/组件重复请求，按数组弱引用缓存，数据刷新后自动失效 */
const filterMemo = new WeakMap();
export function filterLines(arr = state.lines) {
  if (!arr) return [];
  const sig = JSON.stringify(ui.f);
  const hit = filterMemo.get(arr);
  if (hit && hit.sig === sig) return hit.out;
  const out = filterWith(arr, ui.f);
  filterMemo.set(arr, { sig, out });
  return out;
}
/** 按任意筛选条件过滤（不缓存；级联筛选计算可选值时使用） */
export function filterWith(arr, f) {
  const q = (f.q || '').trim().toLowerCase();
  return arr.filter(l => {
    if (f.provider && l.provider !== f.provider) return false;
    if (f.cc && (f.cc === NO_CC ? !!l.cc : l.cc !== f.cc)) return false;
    if (f.owner && (f.owner === NO_OWNER ? !!l.owner : l.owner !== f.owner)) return false;
    if (f.ws && (f.ws === NO_WS ? !!l.wsKey : l.wsKey !== f.ws)) return false;
    if (f.key && (l.apiKeyId || NONE_KEY) !== f.key) return false;
    if (f.model && l.model !== f.model) return false;
    if (f.channel != null && f.channel !== '__all' && l.channel !== f.channel) return false;
    if (f.dir && l.ioi.dir !== f.dir) return false;
    if (f.item && l.io !== f.item) return false;
    // 搜索文本在数据加载时按行生成一次（finalize），不在每次过滤 / 级联计算时重新拼接；不含实例 ID（只有部分数据集带实例 ID，会让各图表口径不一致）
    if (q && !(l.hay ??= hayOf(l)).includes(q)) return false;
    return true;
  });
}
const hayOf = l => `${l.apiKeyId} ${keyDesc(l.apiKeyId)} ${l.model} ${wsName(l.wsKey)} ${l.workspaceId} ${l.io} ${l.ioi.label} ${l.channel} ${l.cc} ${l.owner || ''} ${PROVIDERS[l.provider] || ''}`.toLowerCase();
export const activeFilterCount = () => ['provider', 'ws', 'key', 'model', 'cc', 'owner', 'dir', 'item', 'q'].filter(k => ui.f[k]).length + (ui.f.channel !== '__all' ? 1 : 0);

export function newAgg(key) {
  return { key, cost: 0, gross: 0, pretax: 0, after: 0, tIn: 0, tCache: 0, tOut: 0, tEmb: 0, tOther: 0, units: {}, models: new Map(), keys: new Set(), wss: new Set(), days: new Map(), items: new Set(), lines: 0 };
}
export function addAgg(a, l) {
  const c = metricVal(l);
  a.cost += c; a.gross += l.gross; a.pretax += l.pretax; a.after += l.after;
  if (l.tokens != null) {
    const d = l.ioi.dir;
    if (d === 'in') { a.tIn += l.tokens; if (l.ioi.cache === 'hit') a.tCache += l.tokens; }
    else if (d === 'out') a.tOut += l.tokens;
    else if (d === 'emb') a.tEmb += l.tokens;
    else a.tOther += l.tokens;
  } else if (l.usage != null && l.usageUnit) a.units[l.usageUnit] = (a.units[l.usageUnit] || 0) + l.usage;
  a.models.set(l.model, (a.models.get(l.model) || 0) + c);
  a.keys.add(l.apiKeyId || NONE_KEY); a.wss.add(l.wsKey); a.items.add(l.io);
  if (l.date) a.days.set(l.date, (a.days.get(l.date) || 0) + c);
  a.lines++;
}
export function aggregate(lines, keyFn) {
  const m = new Map();
  for (const l of lines) { const k = keyFn(l); let a = m.get(k); if (!a) m.set(k, a = newAgg(k)); addAgg(a, l); }
  return m;
}
export const aggAll = lines => { const a = newAgg('all'); lines.forEach(l => addAgg(a, l)); return a; };
export const totalTokens = a => a.tIn + a.tOut + a.tEmb + a.tOther;
export const topModels = (a, n = 3) => [...a.models.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(e => e[0]);
export const unitsText = a => Object.entries(a.units).map(([u, v]) => `${numFmt(v)} ${u}`).join('；');
export const sortedAggs = (m, f = a => a.cost) => [...m.values()].sort((a, b) => f(b) - f(a));

/* =========================================================================
 * 环比徽标
 * ========================================================================= */
/** goodWhenUp=true 时上升为绿色；neutral 时不着色；pp 表示百分点 */
export function deltaPill(cur, prev, { goodWhenUp = false, neutral = false, pp = false } = {}) {
  if (prev == null || !Number.isFinite(prev)) return '<span class="pill na">—</span>';
  if (!pp && Math.abs(prev) < 1e-9) return cur > 0 ? '<span class="pill info">新增</span>' : '<span class="pill na">—</span>';
  const d = pp ? (cur - prev) * 100 : (cur - prev) / Math.abs(prev) * 100;
  if (Math.abs(d) < 0.05) return '<span class="pill flat">持平</span>';
  const up = d > 0;
  const cls = neutral ? 'neutral' : (up === goodWhenUp ? 'good' : 'bad');
  const v = Math.abs(d) >= 1000 ? Math.round(Math.abs(d)).toLocaleString('zh-CN') : Math.abs(d).toFixed(1);
  return `<span class="pill ${cls}" title="${pp ? '百分点变化' : '变化率'}">${up ? '▲' : '▼'} ${v}${pp ? 'pp' : '%'}</span>`;
}
export function tipRows(title, rows) {
  return `<div class="t">${esc(title)}</div>` + rows.map(([k, v, c]) => `<div class="r"><span>${c ? `<i class="sw" style="background:${c}"></i>` : ''}${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
}
export const tipText = (title, text) => `<div class="t">${esc(title)}</div><div class="p">${esc(text)}</div>`;
export const help = text => `<span class="help" tabindex="0" data-tip="${esc(`<div class="p">${esc(text)}</div>`)}" aria-label="${esc(text)}">${icon('info')}</span>`;
export const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
export function segCtl(key, options, small = true) {
  return `<div class="seg ${small ? 'sm' : ''}" role="group">${Object.entries(options).map(([k, v]) => `<button type="button" data-seg="${key}" data-v="${k}" aria-pressed="${ui[key] === k}">${v}</button>`).join('')}</div>`;
}
/* =========================================================================
 * 预测与预算
 * ========================================================================= */
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;
export const isCurrentMonth = () => state.data?.period?.mode === 'month' && state.data.period.isCurrent;
/**
 * 当月期末预测 = 已完成日（不含今天）合计 + 今天已入账 + 已完成日“日历日”日均 × 今天之后的剩余天数。
 * 无消费的日子计为 0，避免高估；预测值不会低于截至目前的实际费用。
 */
export function forecastOf(dailyLines, valFn = metricVal) {
  const p = state.data?.period;
  if (!p || p.mode !== 'month' || !p.isCurrent) return null;
  const yesterday = addDays(state.today, -1);
  if (yesterday < p.from) return null;
  const fullDays = daysBetween(p.from, yesterday);
  const full = sum(dailyLines.filter(l => l.date && l.date <= yesterday), valFn);
  const today = sum(dailyLines.filter(l => l.date === state.today), valFn);
  const avg = full / fullDays;
  // 今天尚未结束且账单有数小时延迟：今天按“已出账与日均的较大值”计，否则预测会少算今天未出账的部分（与服务端告警一致）
  return { value: full + Math.max(today, avg) + avg * Math.max(0, p.daysInPeriod - fullDays - 1), avg, fullDays };
}
/** 预算按应付金额（税前）计；keyId 为空表示整体月度预算 */
export const budgetOf = keyId => (keyId ? state.budgets.keys?.[keyId] ?? null : state.budgets.monthly ?? null);
export function budgetLevel(value, budget) {
  if (!budget) return '';
  const p = value / budget * 100;
  return p >= 100 ? 'bad' : p >= (state.budgets.alertPct || 80) ? 'warn' : 'good';
}
export function budgetBar(used, budget, forecast) {
  if (!budget) return '';
  const p = used / budget * 100, lv = budgetLevel(used, budget), fl = forecast != null ? budgetLevel(forecast, budget) : '';
  const color = lv === 'bad' ? 'var(--crit)' : lv === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return `<div class="budget"><div class="budget-top"><span>预算 ${money(budget)}</span><b class="${lv === 'bad' ? 'bad-text' : lv === 'warn' ? 'warn-text' : ''}">已用 ${p.toFixed(1)}%</b></div>
    <div class="progress"><i style="width:${Math.min(100, p).toFixed(1)}%;background:${color}"></i></div>
    ${forecast != null ? `<div class="budget-fc ${fl === 'bad' ? 'bad-text' : fl === 'warn' ? 'warn-text' : 'muted'}">预计月末 ${money(forecast)}（${(forecast / budget * 100).toFixed(0)}%）${forecast > budget ? ` · 预计超支 ${money(forecast - budget)}` : ''}</div>` : ''}</div>`;
}
export const periodTag = () => (ui.period.mode === 'month' ? ui.period.cycle : `${ui.period.from}_${ui.period.to}`);
