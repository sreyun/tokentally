/* =========================================================================
 * 应用外壳：路由、导航、周期、筛选、同步状态、用户菜单、主题、提示、轮询
 * ========================================================================= */
import {
  $, $$, esc, LS, state, ui, app, http, toast, icon, opt, applyData, addDays, addMonths, lastDayOf, ago, fmtTime, uniq, sum, money, pct, metricVal,
  keyShort, wsName, channelLabel, ioInfo, NONE_KEY, isAdmin, activeFilterCount, METRICS, filterLines,
  PROVIDERS, multiCloud, NO_CC, NO_WS, NO_OWNER, ccName, ownerName, brandName, hasTags, emptyFilters, isSet, facetValues, dimName, DIM_LABEL,
} from './core.js';
import * as Overview from './views/overview.js';
import * as Keys from './views/keys.js';
import * as Key from './views/key.js';
import * as Models from './views/models.js';
import * as Groups from './views/groups.js';
import * as Pivot from './views/pivot.js';
import * as Detail from './views/detail.js';
import * as Gov from './views/governance.js';
import * as Changes from './views/changes.js';
import * as Admin from './views/admin.js';
import * as Day from './views/day.js';

const ROUTES = {
  overview: { label: '成本概览', icon: 'overview', sub: '本期费用、预算与预测、趋势、关键发现与排行', view: Overview, filters: true },
  keys: { label: 'Key 分析', icon: 'key', sub: '每个 API Key 的费用、用量、效率、预算与属性', view: Keys, filters: true },
  key: { label: 'API Key 详情', nav: 'keys', sub: '单个 Key 的费用、趋势、模型构成、计费项与变更', view: Key, arg: true },
  models: { label: '模型分析', icon: 'model', sub: '模型费用、Token 结构、单位成本与计费维度', view: Models, filters: true },
  workspaces: { label: '业务分析', icon: 'ws', sub: '按业务空间 / 成本中心 / 负责人 / 云厂商汇总费用，逐级下钻到 API Key 与模型', view: Groups, filters: true },
  group: { label: '业务空间详情', nav: 'workspaces', sub: '单个业务空间（或成本中心 / 负责人 / 云厂商）的费用、关联 API Key、模型与趋势', view: { render: (v, arg) => Groups.renderDetail(v, arg) }, arg: true },
  pivot: { label: '成本分摊', icon: 'layers', sub: '多维透视：任选维度交叉汇总，用于成本分摊与结构分析', view: Pivot, filters: true },
  detail: { label: '账单明细', icon: 'list', sub: '逐条账单，与云厂商费用中心账单对应（腾讯云 Key 级费用按用量分摊）', view: Detail, filters: true },
  governance: { label: 'Key 治理', icon: 'shield', sub: '描述、归属、闲置、权限、费用异常与预算检查', view: Gov },
  changes: { label: '变更记录', icon: 'history', sub: '与云厂商同步时检测到的 API Key / 业务空间变化', view: Changes, noData: true, noPeriod: true },
  admin: { label: '系统管理', icon: 'settings', sub: '云厂商接入、数据同步、预算与告警、用户、品牌与备份、安全审计', view: Admin, admin: true, noData: true, noPeriod: true, arg: true },
};
const NAV = [{ sec: '成本分析' }, 'overview', 'keys', 'models', 'workspaces', 'pivot', 'detail', { sec: '治理' }, 'governance', 'changes', { sec: '系统', admin: true }, 'admin'];
let route = { name: 'overview', arg: '' };

/* ---------------- 路由 ----------------
 * 地址格式：#/<页面>[/<参数>]?<统计周期>&<全局筛选>，例如 #/keys?cycle=2026-10&ws=llm-xxx&model=qwen-max
 *  - 统计周期与筛选写入地址：链接可直接分享；每次下钻（点击图表 / 图例 / 单元格）生成一条浏览记录，浏览器“后退”即撤销下钻
 *  - 地址不带查询串时（旧书签、手工输入）沿用当前周期与筛选，并改写为完整地址
 */
const FQ_KEYS = ['provider', 'ws', 'cc', 'owner', 'key', 'model', 'dir', 'item', 'channel', 'q'];
const RANGE_PRESETS = ['today', 'yesterday', '7', '30', '90', 'mtd', 'lastmonth'];
function splitHash(h = location.hash) {
  const s = (h || '').replace(/^#\/?/, ''), i = s.indexOf('?');
  return { path: i < 0 ? s : s.slice(0, i), query: i < 0 ? null : s.slice(i + 1) };
}
function parseHash(h = location.hash) {
  const [name, ...rest] = (splitHash(h).path || 'overview').split('/');
  let arg = rest.join('/');
  try { arg = decodeURIComponent(arg); } catch { /* 保留原样 */ }
  // hasOwn：#/constructor、#/toString 等原型属性名不能被当成页面
  const r = Object.hasOwn(ROUTES, name) ? { name, arg: ROUTES[name].arg ? arg : '' } : { name: 'overview', arg: '' };
  if (ROUTES[r.name].admin && state.me && !isAdmin()) return { name: 'overview', arg: '' };
  return r;
}
const argPath = (name, arg) => {
  if (name !== 'group') return encodeURIComponent(arg);
  const i = arg.indexOf('/');
  return i < 0 ? encodeURIComponent(arg) : `${encodeURIComponent(arg.slice(0, i))}/${encodeURIComponent(arg.slice(i + 1))}`;
};
function stateQuery(name) {
  const r = ROUTES[name];
  if (!r || r.noPeriod) return '';
  const sp = new URLSearchParams(), p = ui.period;
  if (p.mode === 'month') { if (p.cycle) sp.set('cycle', p.cycle); }
  else if (RANGE_PRESETS.includes(p.preset)) sp.set('preset', p.preset);
  else if (p.from && p.to) { sp.set('from', p.from); sp.set('to', p.to); }
  if (r.filters) for (const k of FQ_KEYS) if (isSet(k, ui.f[k])) sp.set(k, ui.f[k]);
  return sp.toString();
}
const buildHash = (name, arg) => { const q = stateQuery(name); return `#/${name}${arg ? '/' + argPath(name, arg) : ''}${q ? '?' + q : ''}`; };
const withState = hash => { if (String(hash).includes('?')) return hash; const r = parseHash(hash); return buildHash(r.name, r.arg); };
const periodKey = p => (p.mode === 'month' ? 'm' + p.cycle : `r${p.from}~${p.to}`);
/** 读取地址中的周期与筛选；返回是否需要重新加载数据（周期变化） */
function applyQuery() {
  const { query } = splitHash();
  if (query == null) return false;
  const sp = new URLSearchParams(query), r = ROUTES[route.name];
  if (r.filters) for (const k of FQ_KEYS) { const v = sp.get(k); ui.f[k] = v == null ? (k === 'channel' ? '__all' : '') : v.slice(0, 300); }
  if (r.noPeriod || !state.today) return false;
  const p = ui.period, before = periodKey(p), snap = JSON.stringify(p), D = /^\d{4}-\d{2}-\d{2}$/;
  const c = sp.get('cycle'), pr = sp.get('preset'), fr = sp.get('from'), to = sp.get('to');
  if (c && /^\d{4}-(0[1-9]|1[0-2])$/.test(c) && c <= state.today.slice(0, 7)) { p.mode = 'month'; p.cycle = c; }
  else if (pr && RANGE_PRESETS.includes(pr)) { p.mode = 'range'; applyPreset(pr); }
  else if (fr && to && D.test(fr) && D.test(to) && fr <= to && fr <= state.today) { p.mode = 'range'; p.preset = 'custom'; p.from = fr; p.to = to > state.today ? state.today : to; }
  if (JSON.stringify(p) !== snap) savePeriod();
  return periodKey(p) !== before;
}
/** 地址规范化：补全 / 修正周期与筛选参数（不新增浏览记录） */
function canonicalize() {
  const full = buildHash(route.name, route.arg);
  if (full !== location.hash) { history.replaceState(history.state, '', full); navStack[navStack.length - 1] = full; lastHash = full; }
}
/*
 * 导航：应用内跳转（app.go）滚动到顶部；同一页面内的筛选 / 下钻保持滚动位置；浏览器前进/后退恢复离开时的滚动位置；
 * 维护应用内历史栈，详情页“返回”优先回到上一个页面。
 */
const scrollMem = new Map();
const navStack = [location.hash || '#/overview'];
let pushNav = false, lastHash = location.hash || '#/overview';
app.dirty = false;
const leaveOk = () => !app.dirty || confirm('当前页面有未保存的修改，确定离开吗？');
app.go = hash => {
  if (!leaveOk()) return;
  app.dirty = false;
  const full = withState(hash);
  if (location.hash === full) { render(); return; }
  pushNav = true;
  location.hash = full;
};
app.back = fallback => {
  if (!leaveOk()) return;
  app.dirty = false;
  if (navStack.length > 1) history.back(); else app.go(fallback);
};
/** 把当前筛选 / 周期写入地址：默认新增一条浏览记录（可后退撤销），replace 时改写当前记录 */
function commitUrl(replace = false) {
  const full = buildHash(route.name, route.arg);
  if (location.hash === full) { render(); return; }
  if (replace) { history.replaceState(history.state, '', full); navStack[navStack.length - 1] = full; lastHash = full; render(); return; }
  pushNav = true;
  location.hash = full;
}
window.addEventListener('hashchange', () => {
  scrollMem.set(lastHash, window.scrollY);
  const now = location.hash || '#/overview';
  if (pushNav) navStack.push(now);
  else if (navStack[navStack.length - 2] === now) navStack.pop();
  else navStack.push(now);
  app.dirty = false;
  const prev = route;
  route = parseHash();
  const reload = applyQuery();
  canonicalize();
  closePop();
  if ($('#drawer').open) $('#drawer').close();
  render();
  if (reload) loadData();
  const same = prev.name === route.name && prev.arg === route.arg;
  const y = pushNav ? (same ? window.scrollY : 0) : (scrollMem.get(location.hash) ?? (same ? window.scrollY : 0));
  requestAnimationFrame(() => window.scrollTo({ top: y }));
  pushNav = false; lastHash = location.hash;
});
window.addEventListener('beforeunload', e => { if (app.dirty) { e.preventDefault(); e.returnValue = ''; } });
app.render = () => render();
app.hasFilters = () => !!ROUTES[route.name]?.filters;
/**
 * 设置全局筛选（下钻）：hash 为空时留在当前页面（不支持筛选的页面跳转到成本概览）；reset 先清空其余筛选。
 * 每次下钻都会新增一条浏览记录，浏览器“后退”可撤销。
 */
app.setFilter = (patch, hash, reset = false) => {
  if (reset) Object.assign(ui.f, emptyFilters());
  Object.assign(ui.f, patch);
  if (hash) app.go(hash);
  else if (!ROUTES[route.name].filters) app.go('#/overview');
  else commitUrl();
};
app.openModel = (m, scope) => Models.openModel(m, scope);
app.openDay = (d, scope) => Day.openDay(d, scope);
/** 切换统计周期：url='push'（下钻，可后退）| 'replace'（顶栏切换）| false（随后由 app.go 写入地址） */
app.setPeriod = (p, { url = 'push' } = {}) => {
  Object.assign(ui.period, p); savePeriod(); renderPeriod();
  if (url) commitPeriodUrl(url === 'replace');
  loadData();
};
function commitPeriodUrl(replace) {
  const full = buildHash(route.name, route.arg);
  if (full === location.hash) return;
  if (replace) { history.replaceState(history.state, '', full); navStack[navStack.length - 1] = full; lastHash = full; }
  else { pushNav = true; location.hash = full; }
}
app.reload = () => loadData({ silent: true });
app.refreshStatus = async (background = false) => { try { state.status = await http('GET', '/api/status', undefined, { background }); } catch { /* ignore */ } renderSyncBtn(); renderSideFoot(); };

/* ---------------- 数据 ---------------- */
let loadSeq = 0;
/** 等待首次数据加载结束（成功或失败）：管理页等先于数据渲染的页面需要完整的 Key 列表时使用 */
let dataWaiters = [];
app.whenData = () => (state.data ? Promise.resolve() : new Promise(r => dataWaiters.push(r)));
async function loadData({ silent = false, background = false } = {}) {
  const seq = ++loadSeq;
  state.loading = true;
  $('#topbar').classList.add('loading');
  if (state.data && !silent) $('#content').classList.add('dim');
  if (!state.data && !ROUTES[parseHash().name]?.noData) renderSkeleton(); // 管理页等不依赖账单数据的页面已渲染，不覆盖
  const p = ui.period;
  const q = p.mode === 'month' ? `mode=month&cycle=${encodeURIComponent(p.cycle)}` : `mode=range&from=${p.from}&to=${p.to}`;
  const errs = [];
  let d = null;
  try { d = await http('GET', '/api/data?' + q, undefined, { background }); }
  catch (e) { if (seq === loadSeq) errs.push({ level: 'err', title: '数据加载失败', why: e.message }); }
  if (seq !== loadSeq) return; // 已有更新的请求（如用户连续切换账期），丢弃过期响应
  if (d) applyData(d);
  for (const f of dataWaiters.splice(0)) f();
  state.loading = false;
  $('#topbar').classList.remove('loading');
  $('#content').classList.remove('dim');
  // 管理页不依赖账单数据：数据加载完成后只刷新导航与提示，不重绘页面，避免清空正在编辑的表单
  // （首次打开管理页时数据在页面渲染后才返回，之前会重绘并丢失已输入的内容）
  if (route.name === 'admin') { renderNav(); if (!silent) renderNotices(ROUTES.admin, errs); return; }
  render(errs);
}

/* ---------------- 渲染 ---------------- */
let refocus = null;
function render(extraNotices = []) {
  route = parseHash();
  const r = ROUTES[route.name];
  renderNav(); renderTitle(r); renderPeriod(); renderSyncBtn(); renderUser(); renderSideFoot();
  $('#periodBox').hidden = !!r.noPeriod;
  $('#btnRefresh').hidden = !!r.noPeriod;
  $('#note').hidden = !!r.noData;
  renderFilters(r);
  if (refocus) { const el = $(`[data-f="${refocus}"]`); refocus = null; el?.focus({ preventScroll: true }); }
  renderNotices(r, extraNotices);
  const v = $('#view');
  if (!r.noData && !state.data) { renderSkeleton(); return; }
  try {
    if (route.name === 'admin') r.view.render(v, route.arg || 'aliyun');
    else if (r.arg) r.view.render(v, route.arg);
    else r.view.render(v);
  } catch (e) {
    console.error(e);
    v.innerHTML = `<div class="notice err">${icon('warn')}<div><b>页面渲染出错</b><span class="why">${esc(e.message)}</span></div></div>`;
  }
}
function renderSkeleton() {
  $('#view').innerHTML = `<div class="kpis">${'<div class="kpi skeleton" style="height:120px"></div>'.repeat(4)}</div><div class="bi"><div class="panel c8 skeleton" style="height:320px"></div><div class="panel c4 skeleton" style="height:320px"></div></div>`;
}
function renderNav() {
  let govCount = 0;
  try { govCount = state.data ? Gov.computeFindings().filter(f => f.severity !== 'low').length : 0; } catch { /* ignore */ }
  const badge = { keys: state.apiKeys.size || '', governance: govCount || '' };
  const active = ROUTES[route.name].nav || route.name;
  $('#nav').innerHTML = NAV.map(n => {
    if (typeof n === 'object') return n.admin && !isAdmin() ? '' : `<div class="nav-sec">${n.sec}</div>`;
    const r = ROUTES[n];
    if (r.admin && !isAdmin()) return '';
    return `<button class="nav-item" data-go="#/${n}" ${active === n ? 'aria-current="page"' : ''} title="${esc(r.label)}">${icon(r.icon)}<span>${r.label}</span>${badge[n] ? `<em class="badge">${badge[n]}</em>` : ''}</button>`;
  }).join('');
}
function renderTitle(r) {
  let title = r.label;
  if (route.name === 'key') title = route.arg === NONE_KEY ? '非 API Key 调用' : (state.data ? keyShort(route.arg) : 'API Key 详情');
  if (route.name === 'group') { const g = Groups.parseGroupArg(route.arg); title = g ? `${DIM_LABEL[g.dim]} · ${state.data ? dimName(g.dim, g.id) : g.id}` : '详情'; }
  if (route.name === 'admin') title = `系统管理 · ${Object.hasOwn(Admin.ADMIN_TABS, route.arg) ? Admin.ADMIN_TABS[route.arg] : '阿里云接入'}`;
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = r.sub;
  document.title = `${title} · ${brandName()}`;
}
function renderSideFoot() {
  const s = state.status;
  if (!s) return;
  const b = s.branding || {};
  $('#brandName').textContent = b.name || '大模型费用分析';
  $('#brandSub').textContent = b.subtitle || '';
  const d = s.data;
  $('#sideFoot').innerHTML = `<div class="side-card"><b>数据范围</b><br>${d.minDay ? `${esc(d.minDay)} ~ ${esc(d.maxDay)}` : '尚无账单数据'}<br>日账单 ${Number(d.dailyLines || 0).toLocaleString()} 条 · ${d.cycles.length} 个账期<br>时区 ${esc(s.tz)} · v${esc(s.version)}</div>`;
}

/* ---------------- 周期 ---------------- */
function savePeriod() { LS.set('bc.period', ui.period); }
function renderPeriod() {
  const p = ui.period;
  $$('#modeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === p.mode)));
  $('#monthBox').hidden = p.mode !== 'month';
  $('#rangeBox').hidden = p.mode !== 'range';
  const cur = (state.today || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const synced = new Map((state.status?.data?.cycles || []).map(c => [c.cycle, c]));
  const sel = $('#cycleSel');
  sel.innerHTML = Array.from({ length: 18 }, (_, i) => addMonths(cur, -i)).map(c => {
    const [y, m] = c.split('-');
    return `<option value="${c}">${y} 年 ${Number(m)} 月${c === cur ? '（本月）' : ''}${synced.has(c) ? '' : ' · 未同步'}</option>`;
  }).join('');
  sel.value = p.cycle;
  const s = synced.get(p.cycle);
  $('#finalBadge').innerHTML = p.mode !== 'month' ? '' : !s ? '<span class="pill neutral period-badge">未同步</span>' : s.final ? '<span class="pill good period-badge" title="次月 3 日后阿里云已出账，为终版账单">已出账</span>' : '<span class="pill warn period-badge" title="账单持续入账中，数据随同步更新">未出账</span>';
  $('#btnNext').disabled = p.cycle >= cur;
  $('#preset').value = p.preset;
  $('#from').value = p.from; $('#to').value = p.to;
  $('#from').max = $('#to').max = state.today || '';
  $('#btnApply').hidden = p.preset !== 'custom';
  const bad = !!(p.from && p.to && p.from > p.to);
  $('#from').classList.toggle('invalid', bad); $('#to').classList.toggle('invalid', bad);
  $('#from').title = bad ? '开始日期不能晚于结束日期' : '开始日期';
}
function applyPreset(preset) {
  const t = state.today, p = ui.period;
  p.preset = preset;
  if (preset === 'today') p.from = p.to = t;
  else if (preset === 'yesterday') p.from = p.to = addDays(t, -1);
  else if (/^\d+$/.test(preset)) { p.to = t; p.from = addDays(t, -(Number(preset) - 1)); }
  else if (preset === 'mtd') { p.from = t.slice(0, 7) + '-01'; p.to = t; }
  else if (preset === 'lastmonth') { const c = addMonths(t.slice(0, 7), -1); p.from = c + '-01'; p.to = lastDayOf(c); }
}
/** 顶栏切换周期：改写当前地址（不新增浏览记录）并重新加载 */
function periodApplied() { savePeriod(); renderPeriod(); commitPeriodUrl(true); loadData(); }
$('#modeSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]'); if (!b || ui.period.mode === b.dataset.mode) return;
  ui.period.mode = b.dataset.mode;
  if (ui.period.mode === 'range' && (ui.period.preset !== 'custom' || !ui.period.from)) applyPreset(ui.period.preset === 'custom' ? '30' : ui.period.preset || '30');
  periodApplied();
});
$('#cycleSel').addEventListener('change', e => { ui.period.cycle = e.target.value; periodApplied(); });
$('#btnPrev').onclick = () => app.setPeriod({ cycle: addMonths(ui.period.cycle, -1) }, { url: 'replace' });
$('#btnNext').onclick = () => { const n = addMonths(ui.period.cycle, 1); if (n <= state.today.slice(0, 7)) app.setPeriod({ cycle: n }, { url: 'replace' }); };
$('#preset').addEventListener('change', e => {
  if (e.target.value === 'custom') { ui.period.preset = 'custom'; savePeriod(); renderPeriod(); $('#from').focus(); return; }
  applyPreset(e.target.value); periodApplied();
});
['from', 'to'].forEach(id => {
  $('#' + id).addEventListener('change', e => { ui.period[id] = e.target.value; ui.period.preset = 'custom'; savePeriod(); renderPeriod(); });
  $('#' + id).addEventListener('keydown', e => { if (e.key === 'Enter') { ui.period[id] = e.target.value; $('#btnApply').click(); } });
});
$('#btnApply').onclick = () => {
  const p = ui.period;
  if (!p.from || !p.to || p.from > p.to) return toast('请选择有效的日期范围', 'err');
  periodApplied();
};
$('#btnRefresh').onclick = () => loadData();

/* ---------------- 筛选 ---------------- */
const FILTER_LABEL = { provider: '云厂商', ws: '业务空间', cc: '成本中心', owner: '负责人', key: 'API Key', model: '模型', dir: 'Token 类型', item: '计费项', channel: '渠道', q: '关键字' };
const DIR_LABEL = { in: '输入（含缓存）', out: '输出', emb: '向量', other: '其他' };
function filterValueLabel(k, v) {
  if (k === 'ws') return v === NO_WS ? '（未归属）' : wsName(v);
  if (k === 'provider') return PROVIDERS[v] || v;
  if (k === 'cc') return v === NO_CC ? '（未分配）' : ccName(v);
  if (k === 'owner') return v === NO_OWNER ? '（未指定）' : ownerName(v);
  if (k === 'key') return keyShort(v);
  if (k === 'dir') return DIR_LABEL[v] || v;
  if (k === 'item') return ioInfo(v).label;
  if (k === 'channel') return channelLabel(v);
  return v;
}
const byName = (a, b) => a[1].localeCompare(b[1], 'zh-CN');
/**
 * 级联筛选栏：每个下拉框只列出在其余筛选条件下有关联的取值（例如选择业务空间后，API Key 只列出该空间内的 Key，
 * 模型只列出这些 Key 使用过的模型）；当前选中值即使不在范围内也保留显示，避免“看不到自己选了什么”。
 */
function renderFilters(r) {
  const bar = $('#filterbar'), more = $('#moreFilters'), chips = $('#chips');
  if (!r.filters || !state.data) { bar.hidden = more.hidden = chips.hidden = true; return; }
  const f = ui.f;
  const fv = d => { const s = new Set(facetValues(d)); if (isSet(d, f[d])) s.add(f[d]); return s; };
  /**
   * 上级维度（云厂商 / 业务空间 / 成本中心 / 负责人 / 模型）：匹配的取值在前，不匹配当前筛选的取值放在“其他”分组，
   * 仍可直接切换（选择后自动清除冲突的筛选）；API Key 只列出匹配的取值。
   */
  const others = (d, match, toOpt, sort = (a, b) => String(a).localeCompare(String(b), 'zh-CN')) => {
    const rest = [...facetValues(d, emptyFilters())].filter(v => !match.has(v)).sort(sort);
    return rest.length ? `<optgroup label="其他（不匹配当前筛选，选择后清除冲突条件）">${rest.map(toOpt).join('')}</optgroup>` : '';
  };
  const cls = v => (v ? 'inp active' : 'inp');
  const sel = (d, label, allLabel, body, extra = '') => `<select class="${cls(isSet(d, f[d]))}" data-f="${d}" aria-label="${label}" title="${label}${extra}">${opt(d === 'channel' ? '__all' : '', allLabel, f[d])}${body}</select>`;
  // Key 元数据按维度分组计数（业务空间 / 成本中心 下拉显示关联 Key 数）
  const keySet = fv('key');
  const keyCount = dim => { const m = new Map(); for (const id of keySet) { const k = state.apiKeys.get(id); if (!k) continue; const v = dim === 'ws' ? k.wsKey || NO_WS : dim === 'cc' ? k.costCenter || NO_CC : dim === 'owner' ? k.owner || NO_OWNER : k.provider || 'aliyun'; m.set(v, (m.get(v) || 0) + 1); } return m; };
  const withCount = (m, v, name) => (m.get(v) ? `${name} · ${m.get(v)} 个 Key` : name);
  // 业务空间
  const wsCnt = keyCount('ws');
  const wsLabel = v => (v === NO_WS ? '（未归属业务空间）' : (wsName(v) + (state.workspaces.get(v)?.deletedAt ? '（已删除）' : '')));
  const wsSet = fv('ws');
  const wsOpts = [...wsSet].map(v => [v, wsLabel(v)]).sort((a, b) => (a[0] === NO_WS) - (b[0] === NO_WS) || byName(a, b));
  const wsOther = others('ws', wsSet, v => opt(v, wsLabel(v), f.ws), (a, b) => (a === NO_WS) - (b === NO_WS) || wsLabel(a).localeCompare(wsLabel(b), 'zh-CN'));
  // API Key：未选业务空间时按业务空间分组（optgroup），选中后只列出该空间的 Key
  const keyIds = [...keySet].filter(id => id !== NONE_KEY).sort((a, b) => keyShort(a).localeCompare(keyShort(b), 'zh-CN'));
  const keyOpt = id => opt(id, `${keyShort(id)} · ${id}`, f.key);
  let keyBody;
  const groups = new Map();
  for (const id of keyIds) { const w = state.apiKeys.get(id)?.wsKey || NO_WS; if (!groups.has(w)) groups.set(w, []); groups.get(w).push(id); }
  if (!f.ws && groups.size > 1) {
    keyBody = [...groups.entries()].map(([w, ids]) => [w, w === NO_WS ? '（未归属业务空间）' : wsName(w), ids]).sort((a, b) => (a[0] === NO_WS) - (b[0] === NO_WS) || a[1].localeCompare(b[1], 'zh-CN'))
      .map(([w, name, ids]) => `<optgroup label="${esc(`${name}${multiCloud() ? ' · ' + (PROVIDERS[state.workspaces.get(w)?.provider] || '') : ''}（${ids.length}）`)}">${ids.map(keyOpt).join('')}</optgroup>`).join('');
  } else keyBody = keyIds.map(keyOpt).join('');
  if (keySet.has(NONE_KEY)) keyBody += opt(NONE_KEY, '无 API Key（控制台/订阅）', f.key);
  // 模型：多云时按云厂商分组
  const modelSet = fv('model');
  const models = [...modelSet].sort();
  let modelBody = models.map(m => opt(m, m, f.model)).join('');
  if (multiCloud() && !f.provider) {
    const pm = new Map();
    for (const l of state.lines) if (modelSet.has(l.model)) { if (!pm.has(l.provider)) pm.set(l.provider, new Set()); pm.get(l.provider).add(l.model); }
    if (pm.size > 1) modelBody = state.providers.filter(p => pm.has(p)).map(p => `<optgroup label="${esc(PROVIDERS[p])}">${[...pm.get(p)].sort().map(m => opt(m, m, f.model)).join('')}</optgroup>`).join('');
  }
  modelBody += others('model', modelSet, m => opt(m, m, f.model));
  const ccSet = fv('cc'), ccVals = [...ccSet], ccCnt = keyCount('cc');
  const showCc = hasTags() || f.cc;
  const ccLabel = v => (v === NO_CC ? '（未分配成本中心）' : v);
  const ccBody = ccVals.filter(v => v !== NO_CC).map(v => [v, v]).sort(byName).map(([v, n]) => opt(v, withCount(ccCnt, v, n), f.cc)).join('') + (ccVals.includes(NO_CC) ? opt(NO_CC, withCount(ccCnt, NO_CC, '（未分配成本中心）'), f.cc) : '')
    + others('cc', ccSet, v => opt(v, ccLabel(v), f.cc), (a, b) => (a === NO_CC) - (b === NO_CC) || a.localeCompare(b, 'zh-CN'));
  const provVals = fv('provider');
  const moreCount = ['owner', 'dir', 'item'].filter(k => f[k]).length + (f.channel !== '__all' ? 1 : 0);
  bar.hidden = false;
  bar.innerHTML = `<div class="fgroup">
    ${multiCloud() || f.provider ? sel('provider', '云厂商', '全部云厂商', state.providers.filter(p => provVals.has(p) || p === f.provider).map(p => opt(p, PROVIDERS[p], f.provider)).join('') + others('provider', provVals, p => opt(p, PROVIDERS[p] || p, f.provider))) : ''}
    ${sel('ws', '业务空间', `全部业务空间（${wsOpts.length}）`, wsOpts.map(([k, n]) => opt(k, withCount(wsCnt, k, n), f.ws)).join('') + wsOther, '：选择后 API Key、模型等下拉框只列出该空间关联的取值')}
    ${sel('key', 'API Key', `全部 API Key（${keyIds.length + (keySet.has(NONE_KEY) ? 1 : 0)}）`, keyBody, f.ws ? `（${filterValueLabel('ws', f.ws)}）` : '：按业务空间分组')}
    ${sel('model', '模型', `全部模型（${models.length}）`, modelBody)}
    ${showCc ? sel('cc', '成本中心', '全部成本中心', ccBody) : ''}
    <button class="btn" id="btnMore" aria-expanded="${ui.moreFilters}" aria-controls="moreFilters">${icon('filter')}更多筛选${moreCount ? `<span class="count">${moreCount}</span>` : ''}</button>
    <div class="search">${icon('search')}<input class="inp" type="search" data-f="q" value="${esc(f.q)}" placeholder="搜索 Key、模型、成本中心…（/）" title="搜索 Key、描述、模型、业务空间、成本中心、负责人（快捷键 /）" aria-label="关键字搜索（快捷键 /）"></div>
    </div>
    <div class="metric"><span class="lbl">费用口径</span><div class="seg sm" role="group" aria-label="费用口径">${Object.entries(METRICS).map(([k, l]) => `<button type="button" data-metric="${k}" aria-pressed="${f.metric === k}" title="${k === 'pretax' ? '扣除优惠与优惠券后的税前金额' : k === 'gross' ? '官网目录价金额' : '扣除优惠后的金额'}">${l.replace('金额', '')}</button>`).join('')}</div></div>`;
  more.hidden = !ui.moreFilters;
  if (ui.moreFilters) {
    const dirs = fv('dir'), items = [...fv('item')].filter(Boolean).sort(), channels = [...fv('channel')].sort();
    const ownSet = fv('owner'), owners = [...ownSet], ownCnt = keyCount('owner');
    const ownLabel = v => (v === NO_OWNER ? '（未指定负责人）' : v);
    more.innerHTML = `
      ${hasTags() || f.owner ? sel('owner', '负责人', '全部负责人', owners.filter(v => v !== NO_OWNER).map(v => [v, v]).sort(byName).map(([v, n]) => opt(v, withCount(ownCnt, v, n), f.owner)).join('') + (owners.includes(NO_OWNER) ? opt(NO_OWNER, withCount(ownCnt, NO_OWNER, '（未指定负责人）'), f.owner) : '')
        + others('owner', ownSet, v => opt(v, ownLabel(v), f.owner), (a, b) => (a === NO_OWNER) - (b === NO_OWNER) || a.localeCompare(b, 'zh-CN'))) : ''}
      ${sel('dir', 'Token 类型', '全部 Token 类型', Object.entries(DIR_LABEL).filter(([k]) => dirs.has(k)).map(([k, l]) => opt(k, l, f.dir)).join(''))}
      ${sel('item', '计费项', `全部计费项（${items.length}）`, items.map(i => opt(i, `${ioInfo(i).label}（${i}）`, f.item)).join(''))}
      ${sel('channel', '调用渠道', '全部调用渠道', channels.map(c => opt(c, channelLabel(c), f.channel)).join(''))}`;
  }
  const act = Object.keys(FILTER_LABEL).filter(k => isSet(k, f[k]));
  chips.hidden = !act.length;
  chips.innerHTML = act.map(k => `<span class="fchip">${FILTER_LABEL[k]}：<b>${esc(filterValueLabel(k, f[k]))}</b><button type="button" data-unf="${k}" aria-label="移除筛选 ${FILTER_LABEL[k]}">${icon('x')}</button></span>`).join('')
    + (act.length > 1 ? '<button class="link" data-unf="*" style="font-size:12px;margin-left:4px">清除全部</button>' : '')
    + (act.length ? scopeSummary() : '');
}
/** 当前筛选范围摘要：关联的业务空间 / Key / 模型数量与费用占比 */
function scopeSummary() {
  const L = filterLines();
  if (!state.lines.length) return '';
  const cost = sum(L, metricVal), all = sum(state.lines, metricVal);
  const n = fn => new Set(L.filter(l => metricVal(l) || l.tokens).map(fn)).size;
  const wsN = n(l => l.wsKey), keyN = n(l => l.apiKeyId || NONE_KEY), mN = n(l => l.model);
  return `<span class="scope-sum" title="当前筛选范围内有费用或用量的业务空间、API Key、模型数量，以及费用占全部的比例">范围：<b>${wsN}</b> 个业务空间 · <b>${keyN}</b> 个 Key · <b>${mN}</b> 个模型 · <b>${esc(money(cost))}</b>${all > 0 ? `（占全部 ${pct(cost, all)}）` : ''}</span>`;
}
/**
 * 联动校验：改变某个筛选后，清除与之不再匹配的其他筛选（例如切换业务空间后，原先选中的其他空间的 Key 会被清除），
 * 返回被清除的 [维度, 原值] 列表。
 */
function resolveConflicts(changed) {
  const out = [];
  if (!state.lines.length && !state.apiKeys.size) return out;
  for (const d of ['item', 'dir', 'channel', 'model', 'key', 'owner', 'cc', 'ws', 'provider']) {
    if (d === changed || !isSet(d, ui.f[d])) continue;
    if (!state.lines.length && ['item', 'dir', 'channel', 'model'].includes(d)) continue; // 本期无账单时无法判断，保留
    if (!facetValues(d).has(ui.f[d])) { out.push([d, ui.f[d]]); ui.f[d] = d === 'channel' ? '__all' : ''; }
  }
  return out;
}

/* ---------------- 提示 ---------------- */
function renderNotices(r, extra) {
  const list = extra.slice();
  const s = state.status;
  const demoHidden = (() => { try { return sessionStorage.getItem('bc.demoHide') === '1'; } catch { return false; } })();
  if (s?.demo && !demoHidden) list.push({ dismiss: 'demo', level: 'info', title: '演示模式 · 当前为随机生成的演示数据', why: isAdmin() ? '在“系统管理 → 阿里云接入 / 腾讯云接入”中配置真实访问密钥后，演示数据会被自动清除并开始同步真实账单。' : '演示数据仅用于体验功能，金额与 Key 均为虚构。', go: isAdmin() ? '#/admin/aliyun' : null });
  else if (s && !s.anyConfigured && !s.demo) list.push({ level: 'warn', title: '尚未配置云厂商访问密钥', why: isAdmin() ? '请在“系统管理”中配置阿里云 RAM AccessKey（百炼只读 + 费用中心只读）或腾讯云 CAM API 密钥（TokenHub 只读 + 计费只读），保存后系统会自动同步数据。' : '请联系管理员完成配置。', go: isAdmin() ? '#/admin/aliyun' : null });
  for (const p of Object.keys(PROVIDERS)) if (s?.providers?.[p]?.secretState === 'undecryptable') list.push({ level: 'warn', title: `已保存的${PROVIDERS[p]}访问密钥无法解密`, why: '主密钥（APP_MASTER_KEY）已变化，请重新填写访问密钥。', go: isAdmin() ? `#/admin/${p}` : null });
  const d = state.data;
  if (d && !r.noData && route.name !== 'governance' && route.name !== 'key' && !state.lines.length && s?.anyConfigured) {
    list.push({ level: 'info', title: '所选周期暂无账单数据', why: d.period.mode === 'month' && !d.period.syncedAt ? '该账期尚未同步。管理员可在“系统管理 → 数据同步”中同步指定账期，或调大回溯月数。' : '该周期内没有大模型费用，或账单仍在同步中。' });
  } else if (d && r.filters && state.lines.length && activeFilterCount() && !filterLines().length) {
    list.push({ level: 'info', title: '当前筛选条件下没有数据', why: '可移除部分筛选条件，或切换统计周期。', unf: true });
  }
  $('#notices').innerHTML = list.map(n => `<div class="notice ${n.level}">${icon(n.level === 'info' ? 'info' : 'warn')}<div><b>${esc(n.title)}</b>${n.why ? `<span class="why">${esc(n.why)}</span>` : ''}${n.go ? `<button class="link" data-go="${n.go}">前往配置 →</button>` : ''}${n.unf ? '<button class="link" data-unf="*">清除全部筛选 →</button>' : ''}</div>${n.dismiss ? `<button class="btn ghost icon sm notice-x" data-act="dismiss-${n.dismiss}" aria-label="本次不再提示" title="本次不再提示">${icon('x')}</button>` : ''}</div>`).join('');
}

/* ---------------- 同步状态 / 用户菜单 ---------------- */
function syncSummary() {
  const s = state.status?.sync;
  if (!s) return { dot: '', text: '检测中…' };
  if (s.meta.running || s.bills.running) return { dot: 'busy', text: '同步中…' };
  const last = Math.max(s.meta.lastSuccessAt || 0, s.bills.lastSuccessAt || 0);
  const bad = s.meta.last?.status === 'error' || s.bills.last?.status === 'error';
  const warn = !s.bills.lastSuccessAt || s.meta.last?.status === 'partial' || s.bills.last?.status === 'partial';
  return { dot: bad ? 'bad' : warn ? 'warn' : 'ok', text: s.bills.lastSuccessAt ? `已同步 · ${ago(s.bills.lastSuccessAt)}` : last ? '部分已同步' : '尚未同步' };
}
function renderSyncBtn() {
  const x = syncSummary();
  $('#btnSync').innerHTML = `<span class="dot ${x.dot}"></span><span>${esc(x.text)}</span>`;
  if (popKind === 'sync') renderSyncPop();
}
function renderUser() {
  if (!state.me) return;
  $('#btnUser').innerHTML = `<span class="avatar">${esc(state.me.username.slice(0, 1))}</span><span class="tb-hide-md">${esc(state.me.username)}</span><svg class="ico tb-hide-md" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`;
}
let pop = null, popKind = '';
function closePop() { if (pop) { pop.remove(); pop = null; popKind = ''; } }
function openPop(kind, anchor, html) {
  closePop();
  pop = document.createElement('div');
  pop.className = kind === 'sync' ? 'pop wide' : 'pop'; pop.setAttribute('role', kind === 'user' ? 'menu' : 'dialog');
  pop.setAttribute('aria-label', kind === 'user' ? '用户菜单' : '数据同步状态');
  pop.innerHTML = html;
  document.body.appendChild(pop);
  popKind = kind;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = r.bottom + 6 + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  pop.querySelector('button, [tabindex]')?.focus();
}
function renderSyncPop() {
  const s = state.status;
  if (!s || !pop) return;
  const row = (name, x) => {
    const st = x.running ? 'busy' : x.last?.status === 'error' ? 'bad' : x.last?.status === 'partial' || !x.lastSuccessAt ? 'warn' : 'ok';
    const pr = x.progress;
    return `<div class="sync-row"><span class="dot ${st}" aria-hidden="true"></span><div class="sync-body"><b>${name}</b>
      <span>${x.running ? esc(pr?.text || '同步中…') : x.lastSuccessAt ? `最近成功 ${esc(fmtTime(x.lastSuccessAt))}（${esc(ago(x.lastSuccessAt))}）` : '尚未成功同步'}</span>
      ${x.running && pr?.total ? `<div class="progress"><i style="width:${Math.round(pr.done / pr.total * 100)}%"></i></div>` : ''}
      ${!x.running && x.last?.status === 'error' ? `<span class="bad-text">上次失败：${esc(x.last.error || '')}</span>` : ''}
      <span>每 ${x.intervalMin} 分钟自动同步${x.nextAt && !x.running ? ` · 下次约 ${esc(fmtTime(x.nextAt).slice(11))}` : ''}</span></div></div>`;
  };
  const p = state.data?.period;
  const conf = s.sync.configured || [];
  const rows = conf.length > 1
    ? conf.map(pv => `<div class="sync-prov">${esc(PROVIDERS[pv])}</div>${row('API Key / 业务空间', s.sync.providers[pv].meta)}${row('费用账单', s.sync.providers[pv].bills)}`).join('')
    : row('API Key / 业务空间', s.sync.meta) + row('费用账单', s.sync.bills);
  pop.innerHTML = `<div class="pop-h">数据同步状态${conf.length === 1 ? ` · ${esc(PROVIDERS[conf[0]])}` : ''}</div><div class="pop-body">
    ${rows}
    ${p ? `<div class="hint">${p.mode === 'month' ? `当前账期 ${esc(p.cycle)}：${p.final ? '已出账，为终版账单' : '未出账，账单持续入账中（约延迟数小时）'}` : `当前查询 ${esc(p.from)} ~ ${esc(p.to)}`}</div>` : ''}
    ${isAdmin() ? `<div class="row"><button class="btn sm primary" data-sync-now="meta">${icon('sync')}同步 Key</button><button class="btn sm" data-sync-now="bills">同步账单</button><button class="btn sm ghost" data-go="#/admin/sync">更多…</button></div>` : ''}
  </div>`;
}
$('#btnSync').onclick = e => {
  e.stopPropagation();
  if (popKind === 'sync') return closePop();
  openPop('sync', $('#btnSync'), '');
  renderSyncPop();
};
$('#btnUser').onclick = e => {
  e.stopPropagation();
  if (popKind === 'user') return closePop();
  openPop('user', $('#btnUser'), `<div class="pop-h">${esc(state.me.username)} · ${isAdmin() ? '管理员' : '只读用户'}</div>
    <button class="pop-item" role="menuitem" data-act="pwd">${icon('lock')}修改密码</button>
    ${isAdmin() ? `<button class="pop-item" role="menuitem" data-go="#/admin/users">${icon('user')}用户管理</button>` : ''}
    <div class="pop-sep"></div>
    <button class="pop-item" role="menuitem" data-act="logout">${icon('logout')}退出登录</button>`);
};
document.addEventListener('click', async e => {
  if (pop && !pop.contains(e.target)) closePop();
  const syncNow = e.target.closest('[data-sync-now]');
  if (syncNow) {
    try { const r = await http('POST', '/api/admin/sync', { kind: syncNow.dataset.syncNow, cycles: syncNow.dataset.syncNow === 'bills' && ui.period.mode === 'month' ? [ui.period.cycle] : undefined }); toast(r.alreadyRunning ? '已有同类同步任务在运行' : '同步任务已启动'); await app.refreshStatus(); }
    catch (ex) { toast('启动失败：' + ex.message, 'err', 4000); }
    return;
  }
  const cp = e.target.closest('[data-copy]');
  if (cp) { e.preventDefault(); copyText(cp.dataset.copy); return; }
  const back = e.target.closest('[data-back]');
  if (back) { e.preventDefault(); app.back(back.dataset.back); return; }
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); closePop(); if ($('#drawer').open && go.closest('#drawer')) $('#drawer').close(); app.go(go.dataset.go); return; }
  // 行内下钻链接：模型详情抽屉 / 当日明细抽屉 / 追加筛选（data-scope 为 JSON 范围）
  const dm = e.target.closest('[data-model]');
  if (dm) { e.preventDefault(); app.openModel(dm.dataset.model, parseScope(dm.dataset.scope)); return; }
  const dd = e.target.closest('[data-day]');
  if (dd) { e.preventDefault(); app.openDay(dd.dataset.day, parseScope(dd.dataset.scope)); return; }
  const fp = e.target.closest('[data-fpatch]');
  if (fp) { e.preventDefault(); let patch = null; try { patch = JSON.parse(fp.dataset.fpatch); } catch { /* ignore */ } if (patch && typeof patch === 'object') { if ($('#drawer').open && fp.closest('#drawer')) $('#drawer').close(); app.setFilter(patch, fp.dataset.fgo || null, fp.dataset.freset === '1'); } return; }
  const seg = e.target.closest('[data-seg]');
  if (seg) { ui[seg.dataset.seg] = seg.dataset.v; if (seg.dataset.seg === 'density') LS.set('bc.density', seg.dataset.v); render(); return; }
  const met = e.target.closest('[data-metric]');
  if (met) { ui.f.metric = met.dataset.metric; LS.set('bc.metric', ui.f.metric); render(); return; }
  const unf = e.target.closest('[data-unf]');
  if (unf) { if (unf.dataset.unf === '*') app.setFilter({}, null, true); else app.setFilter({ [unf.dataset.unf]: unf.dataset.unf === 'channel' ? '__all' : '' }); return; }
  if (e.target.closest('#btnMore')) { ui.moreFilters = !ui.moreFilters; render(); return; }
  const act = e.target.closest('[data-act]');
  if (act?.dataset.act === 'pwd') { closePop(); openPwd(false); }
  if (act?.dataset.act === 'dismiss-demo') { try { sessionStorage.setItem('bc.demoHide', '1'); } catch { /* ignore */ } render(); return; }
  if (act?.dataset.act === 'logout') { closePop(); try { await http('POST', '/api/logout'); } finally { location.href = '/login'; } }
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
});
const parseScope = s => { if (!s) return null; try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch { return null; } };
document.addEventListener('change', e => {
  const t = e.target.closest('[data-f]');
  if (!t || t.dataset.f === 'q') return;
  const d = t.dataset.f;
  ui.f[d] = t.value;
  const cleared = isSet(d, t.value) ? resolveConflicts(d) : [];
  if (cleared.length) toast(`已联动清除不再匹配的筛选：${cleared.map(([k, v]) => `${FILTER_LABEL[k]}「${filterValueLabel(k, v)}」`).join('、')}`, '', 3600);
  refocus = d; // 重绘后焦点回到刚操作的下拉框，便于继续用键盘调整
  commitUrl();
});
let qTimer;
document.addEventListener('input', e => {
  const t = e.target.closest('[data-f="q"]'); if (!t) return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    ui.f.q = t.value;
    const pos = t.selectionStart;
    commitUrl(true);
    const n = $('[data-f="q"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); }
  }, 300);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pop) { closePop(); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if (typing || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { const q = $('[data-f="q"]'); if (q) { e.preventDefault(); q.focus(); } }
  if ((route.name === 'key' || route.name === 'group') && (e.key === '[' || e.key === ']')) { const b = $(`[data-nav="${e.key === '[' ? 'prev' : 'next'}"]`); if (b) { e.preventDefault(); b.click(); } }
});
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(`已复制：${t.length > 40 ? t.slice(0, 40) + '…' : t}`, '', 1800);
}
$('#btnCollapse').onclick = () => { $('#app').classList.toggle('collapsed'); LS.set('bc.collapsed', $('#app').classList.contains('collapsed')); setTimeout(render, 60); };
$('#drawer').addEventListener('click', e => { if (e.target === $('#drawer')) $('#drawer').close(); });

/* ---------------- 主题 ---------------- */
const THEMES = ['auto', 'light', 'dark'];
const getTheme = () => { try { const t = localStorage.getItem('bc.theme'); return THEMES.includes(t) ? t : 'auto'; } catch { return 'auto'; } };
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const b = $('#btnTheme');
  b.innerHTML = icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'auto');
  b.title = `主题：${{ auto: '跟随系统', light: '浅色', dark: '深色' }[t]}（点击切换）`;
}
$('#btnTheme').onclick = () => {
  const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
  try { localStorage.setItem('bc.theme', next); } catch { /* ignore */ }
  applyTheme(next);
  toast(`已切换为${{ auto: '跟随系统', light: '浅色', dark: '深色' }[next]}主题`, '', 1500);
};

/* ---------------- 提示框 ---------------- */
const tipEl = $('#tip');
function showTip(t, x, y) {
  const html = t && t.getAttribute('data-tip');
  if (!html) { tipEl.style.display = 'none'; return; }
  tipEl.innerHTML = html; tipEl.style.display = 'block';
  placeTip(x, y);
}
function placeTip(x, y) {
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > innerWidth - 8) left = x - w - 14;
  if (top + h > innerHeight - 8) top = y - h - 14;
  tipEl.style.left = Math.max(8, left) + 'px'; tipEl.style.top = Math.max(8, top) + 'px';
}
document.addEventListener('mouseover', e => showTip(e.target.closest?.('[data-tip]'), e.clientX, e.clientY));
document.addEventListener('mousemove', e => { if (tipEl.style.display === 'block') placeTip(e.clientX, e.clientY); });
document.addEventListener('focusin', e => { const t = e.target.closest?.('[data-tip]'); if (t) { const r = t.getBoundingClientRect(); showTip(t, r.left, r.bottom - 8); } });
document.addEventListener('focusout', () => { tipEl.style.display = 'none'; });
document.addEventListener('scroll', () => { tipEl.style.display = 'none'; }, true);
// 触屏：轻触显示提示，2.5 秒后自动隐藏
let tipTimer;
document.addEventListener('touchstart', e => {
  const t = e.target.closest?.('[data-tip]');
  clearTimeout(tipTimer);
  if (!t) { tipEl.style.display = 'none'; return; }
  const p = e.touches[0];
  showTip(t, p.clientX, p.clientY);
  tipTimer = setTimeout(() => { tipEl.style.display = 'none'; }, 2500);
}, { passive: true });
let rTimer, lastW = innerWidth;
addEventListener('resize', () => { clearTimeout(rTimer); rTimer = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; render(); } }, 250); });

/* ---------------- 修改密码 ---------------- */
function openPwd(force) {
  const d = $('#dlgPwd');
  $('#pwdForce').hidden = !force;
  $('#btnPwdClose').hidden = force;
  d.dataset.force = force ? '1' : '';
  $('#pwdUser').value = state.me?.username || '';
  $('#pwdErr').textContent = '';
  $('#pwdOld').value = $('#pwdNew').value = $('#pwdNew2').value = '';
  if (!d.open) d.showModal();
  $('#pwdOld').focus();
}
$('#dlgPwd').addEventListener('cancel', e => { if ($('#dlgPwd').dataset.force) e.preventDefault(); });
$('#pwdForm').addEventListener('submit', async e => {
  e.preventDefault();
  const np = $('#pwdNew').value;
  if (np !== $('#pwdNew2').value) { $('#pwdErr').textContent = '两次输入的新密码不一致'; return; }
  try {
    await http('POST', '/api/me/password', { oldPassword: $('#pwdOld').value, newPassword: np });
    const forced = !!$('#dlgPwd').dataset.force;
    $('#dlgPwd').dataset.force = '';
    $('#dlgPwd').close();
    toast('密码已修改');
    if (forced) { state.me.mustChange = false; await start(); }
  } catch (ex) { $('#pwdErr').textContent = ex.message; }
});

/* ---------------- 启动 & 轮询 ---------------- */
let lastSyncSeen = 0, lastBillsSeen = 0;
async function poll() {
  if (document.hidden) return; // 页面在后台时不轮询，切回时立即刷新
  await app.refreshStatus(true);
  const s = state.status?.sync;
  if (!s) return;
  const latest = Math.max(s.meta.changedAt || 0, s.bills.changedAt || 0);
  if (latest > lastSyncSeen) {
    const first = !lastSyncSeen;
    const billsChanged = (s.bills.changedAt || 0) > lastBillsSeen;
    lastSyncSeen = latest; lastBillsSeen = s.bills.changedAt || 0;
    if (!first && !$('#drawer').open && !document.querySelector('#dlgPwd[open]')) {
      await loadData({ silent: true, background: true });
      if (billsChanged && route.name !== 'admin') toast('账单数据已同步更新', '', 2200);
    }
  }
}
async function start() {
  await app.refreshStatus();
  const s = state.status?.sync;
  lastSyncSeen = Math.max(s?.meta.changedAt || 0, s?.bills.changedAt || 0);
  lastBillsSeen = s?.bills.changedAt || 0;
  if (!ui.period.cycle || ui.period.cycle > state.today.slice(0, 7)) ui.period.cycle = state.today.slice(0, 7);
  if (ui.period.mode === 'range' && ui.period.preset !== 'custom') applyPreset(ui.period.preset);
  route = parseHash();
  applyQuery(); // 分享链接 / 书签中的周期与筛选优先
  canonicalize();
  render();
  await loadData();
  setInterval(poll, 20_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}
(async function boot() {
  applyTheme(getTheme());
  if (LS.get('bc.collapsed', false)) $('#app').classList.add('collapsed');
  try {
    const me = await http('GET', '/api/me');
    state.me = me.user; state.csrf = me.csrf; state.today = me.today; state.tz = me.tz;
  } catch { return; }
  renderUser();
  if (state.me.mustChange) { route = parseHash(); renderNav(); openPwd(true); return; }
  await start();
})();
