/* =========================================================================
 * 应用外壳：路由、导航、周期、筛选、同步状态、用户菜单、主题、提示、轮询
 * ========================================================================= */
import {
  $, $$, esc, LS, state, ui, app, http, toast, icon, opt, applyData, addDays, addMonths, lastDayOf, ago, fmtTime, uniq,
  keyShort, wsName, channelLabel, ioInfo, NONE_KEY, isAdmin, activeFilterCount, METRICS, filterLines,
  PROVIDERS, multiCloud, NO_CC, ccName, brandName,
} from './core.js';
import * as Overview from './views/overview.js';
import * as Keys from './views/keys.js';
import * as Key from './views/key.js';
import * as Models from './views/models.js';
import * as Pivot from './views/pivot.js';
import * as Detail from './views/detail.js';
import * as Gov from './views/governance.js';
import * as Changes from './views/changes.js';
import * as Admin from './views/admin.js';
import * as Day from './views/day.js';

const ROUTES = {
  overview: { label: '成本概览', icon: 'overview', sub: '本期费用、预算与预测、趋势、关键发现与排行', view: Overview, filters: true },
  keys: { label: 'API Key 分析', icon: 'key', sub: '每个 API Key 的费用、用量、效率、预算与属性', view: Keys, filters: true },
  key: { label: 'API Key 详情', nav: 'keys', sub: '单个 Key 的费用、趋势、模型构成、计费项与变更', view: Key },
  models: { label: '模型分析', icon: 'model', sub: '模型费用、Token 结构、单位成本与计费维度', view: Models, filters: true },
  pivot: { label: '成本分摊', icon: 'layers', sub: '多维透视：任选维度交叉汇总，用于成本分摊与结构分析', view: Pivot, filters: true },
  detail: { label: '账单明细', icon: 'list', sub: '逐条账单，与云厂商费用中心账单对应（腾讯云 Key 级费用按用量分摊）', view: Detail, filters: true },
  governance: { label: 'Key 治理', icon: 'shield', sub: '描述、归属、闲置、权限、费用异常与预算检查', view: Gov },
  changes: { label: '变更记录', icon: 'history', sub: '与云厂商同步时检测到的 API Key / 业务空间变化', view: Changes, noData: true, noPeriod: true },
  admin: { label: '系统管理', icon: 'settings', sub: '云厂商接入、数据同步、预算与告警、用户、品牌与备份、安全审计', view: Admin, admin: true, noData: true, noPeriod: true },
};
const NAV = [{ sec: '成本分析' }, 'overview', 'keys', 'models', 'pivot', 'detail', { sec: '治理' }, 'governance', 'changes', { sec: '系统', admin: true }, 'admin'];
let route = { name: 'overview', arg: '' };

/* ---------------- 路由 ---------------- */
function parseHash() {
  const [name, ...rest] = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
  const r = ROUTES[name] ? { name, arg: decodeURIComponent(rest.join('/')) } : { name: 'overview', arg: '' };
  if (ROUTES[r.name].admin && state.me && !isAdmin()) return { name: 'overview', arg: '' };
  return r;
}
/*
 * 导航：应用内跳转（app.go）滚动到顶部；浏览器前进/后退恢复离开时的滚动位置；
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
  if (location.hash === hash) { render(); return; }
  pushNav = true;
  location.hash = hash;
};
app.back = fallback => {
  if (!leaveOk()) return;
  app.dirty = false;
  if (navStack.length > 1) history.back(); else app.go(fallback);
};
window.addEventListener('hashchange', () => {
  scrollMem.set(lastHash, window.scrollY);
  const now = location.hash || '#/overview';
  if (pushNav) navStack.push(now);
  else if (navStack[navStack.length - 2] === now) navStack.pop();
  else navStack.push(now);
  app.dirty = false;
  route = parseHash();
  closePop();
  if ($('#drawer').open) $('#drawer').close();
  render();
  const y = pushNav ? 0 : (scrollMem.get(now) || 0);
  requestAnimationFrame(() => window.scrollTo({ top: y }));
  pushNav = false; lastHash = now;
});
window.addEventListener('beforeunload', e => { if (app.dirty) { e.preventDefault(); e.returnValue = ''; } });
app.render = () => render();
app.setFilter = (patch, hash, reset = false) => {
  if (reset) Object.assign(ui.f, { provider: '', ws: '', key: '', model: '', cc: '', channel: '__all', dir: '', item: '', q: '' });
  Object.assign(ui.f, patch);
  if (hash) app.go(hash); else render();
};
app.openModel = m => Models.openModel(m);
app.openDay = (d, keyId) => Day.openDay(d, keyId);
app.setPeriod = p => { Object.assign(ui.period, p); savePeriod(); renderPeriod(); loadData(); };
app.reload = () => loadData({ silent: true });
app.refreshStatus = async () => { try { state.status = await http('GET', '/api/status'); } catch { /* ignore */ } renderSyncBtn(); renderSideFoot(); };

/* ---------------- 数据 ---------------- */
async function loadData({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#topbar').classList.add('loading');
  if (state.data && !silent) $('#content').classList.add('dim');
  if (!state.data) renderSkeleton();
  const p = ui.period;
  const q = p.mode === 'month' ? `mode=month&cycle=${encodeURIComponent(p.cycle)}` : `mode=range&from=${p.from}&to=${p.to}`;
  const errs = [];
  try {
    applyData(await http('GET', '/api/data?' + q));
  } catch (e) { errs.push({ level: 'err', title: '数据加载失败', why: e.message }); }
  finally {
    state.loading = false;
    $('#topbar').classList.remove('loading');
    $('#content').classList.remove('dim');
  }
  // 在管理页面静默刷新时不重绘，避免清空正在编辑的表单
  if (silent && route.name === 'admin') { renderNav(); return; }
  render(errs);
}

/* ---------------- 渲染 ---------------- */
function render(extraNotices = []) {
  route = parseHash();
  const r = ROUTES[route.name];
  renderNav(); renderTitle(r); renderPeriod(); renderSyncBtn(); renderUser(); renderSideFoot();
  $('#periodBox').hidden = !!r.noPeriod;
  $('#btnRefresh').hidden = !!r.noPeriod;
  $('#note').hidden = !!r.noData;
  renderFilters(r);
  renderNotices(r, extraNotices);
  const v = $('#view');
  if (!r.noData && !state.data) { renderSkeleton(); return; }
  try {
    if (route.name === 'key') r.view.render(v, route.arg);
    else if (route.name === 'admin') r.view.render(v, route.arg || 'aliyun');
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
  if (route.name === 'admin') title = `系统管理 · ${Admin.ADMIN_TABS[route.arg] || '阿里云接入'}`;
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
$('#modeSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]'); if (!b || ui.period.mode === b.dataset.mode) return;
  ui.period.mode = b.dataset.mode;
  if (ui.period.mode === 'range' && (ui.period.preset !== 'custom' || !ui.period.from)) applyPreset(ui.period.preset === 'custom' ? '30' : ui.period.preset || '30');
  savePeriod(); renderPeriod(); loadData();
});
$('#cycleSel').addEventListener('change', e => { ui.period.cycle = e.target.value; savePeriod(); loadData(); });
$('#btnPrev').onclick = () => app.setPeriod({ cycle: addMonths(ui.period.cycle, -1) });
$('#btnNext').onclick = () => { const n = addMonths(ui.period.cycle, 1); if (n <= state.today.slice(0, 7)) app.setPeriod({ cycle: n }); };
$('#preset').addEventListener('change', e => {
  if (e.target.value === 'custom') { ui.period.preset = 'custom'; savePeriod(); renderPeriod(); $('#from').focus(); return; }
  applyPreset(e.target.value); savePeriod(); renderPeriod(); loadData();
});
['from', 'to'].forEach(id => {
  $('#' + id).addEventListener('change', e => { ui.period[id] = e.target.value; ui.period.preset = 'custom'; savePeriod(); renderPeriod(); });
  $('#' + id).addEventListener('keydown', e => { if (e.key === 'Enter') { ui.period[id] = e.target.value; $('#btnApply').click(); } });
});
$('#btnApply').onclick = () => {
  const p = ui.period;
  if (!p.from || !p.to || p.from > p.to) return toast('请选择有效的日期范围', 'err');
  loadData();
};
$('#btnRefresh').onclick = () => loadData();

/* ---------------- 筛选 ---------------- */
const FILTER_LABEL = { provider: '云厂商', ws: '业务空间', key: 'API Key', model: '模型', cc: '成本中心', dir: 'Token 类型', item: '计费项', channel: '渠道', q: '关键字' };
const DIR_LABEL = { in: '输入（含缓存）', out: '输出', emb: '向量', other: '其他' };
function filterValueLabel(k, v) {
  if (k === 'ws') return v === '__nows' ? '（未归属）' : wsName(v);
  if (k === 'provider') return PROVIDERS[v] || v;
  if (k === 'cc') return v === NO_CC ? '（未分配）' : ccName(v);
  if (k === 'key') return keyShort(v);
  if (k === 'dir') return DIR_LABEL[v] || v;
  if (k === 'item') return ioInfo(v).label;
  if (k === 'channel') return channelLabel(v);
  return v;
}
function renderFilters(r) {
  const bar = $('#filterbar'), more = $('#moreFilters'), chips = $('#chips');
  if (!r.filters || !state.data) { bar.hidden = more.hidden = chips.hidden = true; return; }
  const f = ui.f, L = state.lines;
  const wsOpts = [...state.workspaces.entries()].map(([k, w]) => [k, (w.workspaceName || w.workspaceId) + (w.deletedAt ? '（已删除）' : '')]).sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  if (L.some(l => !l.wsKey)) wsOpts.push(['__nows', '（未归属业务空间）']);
  const keyIds = [...state.apiKeys.keys()].sort((a, b) => keyShort(a).localeCompare(keyShort(b), 'zh-CN'));
  if (L.some(l => !l.apiKeyId)) keyIds.push(NONE_KEY);
  const models = uniq(L.map(l => l.model)).sort();
  const ccs = uniq([...state.apiKeys.values()].map(k => k.costCenter).filter(Boolean)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const cls = v => (v ? 'inp active' : 'inp');
  const moreCount = ['dir', 'item'].filter(k => f[k]).length + (f.channel !== '__all' ? 1 : 0);
  bar.hidden = false;
  bar.innerHTML = `<div class="fgroup">
    ${multiCloud() || f.provider ? `<select class="${cls(f.provider)}" data-f="provider" aria-label="云厂商" title="云厂商">${opt('', '全部云厂商', f.provider)}${state.providers.map(p => opt(p, PROVIDERS[p], f.provider)).join('')}</select>` : ''}
    <select class="${cls(f.ws)}" data-f="ws" aria-label="业务空间" title="业务空间">${opt('', '全部业务空间', f.ws)}${wsOpts.map(([k, n]) => opt(k, n, f.ws)).join('')}</select>
    <select class="${cls(f.key)}" data-f="key" aria-label="API Key" title="API Key">${opt('', '全部 API Key', f.key)}${keyIds.map(id => opt(id, id === NONE_KEY ? '无 API Key（控制台/订阅）' : `${keyShort(id)} · ${id}`, f.key)).join('')}</select>
    <select class="${cls(f.model)}" data-f="model" aria-label="模型" title="模型">${opt('', '全部模型', f.model)}${models.map(m => opt(m, m, f.model)).join('')}</select>
    ${ccs.length || f.cc ? `<select class="${cls(f.cc)}" data-f="cc" aria-label="成本中心" title="成本中心">${opt('', '全部成本中心', f.cc)}${ccs.map(c => opt(c, c, f.cc)).join('')}${opt(NO_CC, '（未分配成本中心）', f.cc)}</select>` : ''}
    <button class="btn" id="btnMore" aria-expanded="${ui.moreFilters}" aria-controls="moreFilters">${icon('filter')}更多筛选${moreCount ? `<span class="count">${moreCount}</span>` : ''}</button>
    <div class="search">${icon('search')}<input class="inp" type="search" data-f="q" value="${esc(f.q)}" placeholder="搜索 Key、模型、成本中心…（/）" title="搜索 Key、描述、模型、业务空间、成本中心、负责人（快捷键 /）" aria-label="关键字搜索（快捷键 /）"></div>
    </div>
    <div class="metric"><span class="lbl">费用口径</span><div class="seg sm" role="group" aria-label="费用口径">${Object.entries(METRICS).map(([k, l]) => `<button type="button" data-metric="${k}" aria-pressed="${f.metric === k}" title="${k === 'pretax' ? '扣除优惠与优惠券后的税前金额' : k === 'gross' ? '官网目录价金额' : '扣除优惠后的金额'}">${l.replace('金额', '')}</button>`).join('')}</div></div>`;
  more.hidden = !ui.moreFilters;
  if (ui.moreFilters) {
    const channels = uniq(L.map(l => l.channel)).sort();
    const items = uniq(L.map(l => l.io).filter(Boolean)).sort();
    more.innerHTML = `
      <select class="${cls(f.dir)}" data-f="dir" aria-label="Token 类型">${opt('', '全部 Token 类型', f.dir)}${Object.entries(DIR_LABEL).map(([k, l]) => opt(k, l, f.dir)).join('')}</select>
      <select class="${cls(f.item)}" data-f="item" aria-label="计费项">${opt('', '全部计费项', f.item)}${items.map(i => opt(i, `${ioInfo(i).label}（${i}）`, f.item)).join('')}</select>
      <select class="${cls(f.channel !== '__all')}" data-f="channel" aria-label="调用渠道">${opt('__all', '全部调用渠道', f.channel)}${channels.map(c => opt(c, channelLabel(c), f.channel)).join('')}</select>`;
  }
  const act = Object.keys(FILTER_LABEL).filter(k => (k === 'channel' ? f.channel !== '__all' : f[k]));
  chips.hidden = !act.length;
  chips.innerHTML = act.map(k => `<span class="fchip">${FILTER_LABEL[k]}：<b>${esc(filterValueLabel(k, f[k]))}</b><button type="button" data-unf="${k}" aria-label="移除筛选 ${FILTER_LABEL[k]}">${icon('x')}</button></span>`).join('')
    + (act.length > 1 ? '<button class="link" data-unf="*" style="font-size:12px;margin-left:4px">清除全部</button>' : '');
}

/* ---------------- 提示 ---------------- */
function renderNotices(r, extra) {
  const list = extra.slice();
  const s = state.status;
  if (s && !s.anyConfigured) list.push({ level: 'warn', title: '尚未配置云厂商访问密钥', why: isAdmin() ? '请在“系统管理”中配置阿里云 RAM AccessKey（百炼只读 + 费用中心只读）或腾讯云 CAM API 密钥（TokenHub 只读 + 计费只读），保存后系统会自动同步数据。' : '请联系管理员完成配置。', go: isAdmin() ? '#/admin/aliyun' : null });
  for (const p of Object.keys(PROVIDERS)) if (s?.providers?.[p]?.secretState === 'undecryptable') list.push({ level: 'warn', title: `已保存的${PROVIDERS[p]}访问密钥无法解密`, why: '主密钥（APP_MASTER_KEY）已变化，请重新填写访问密钥。', go: isAdmin() ? `#/admin/${p}` : null });
  const d = state.data;
  if (d && !r.noData && route.name !== 'governance' && route.name !== 'key' && !state.lines.length && s?.anyConfigured) {
    list.push({ level: 'info', title: '所选周期暂无账单数据', why: d.period.mode === 'month' && !d.period.syncedAt ? '该账期尚未同步。管理员可在“系统管理 → 数据同步”中同步指定账期，或调大回溯月数。' : '该周期内没有大模型费用，或账单仍在同步中。' });
  } else if (d && r.filters && state.lines.length && activeFilterCount() && !filterLines().length) {
    list.push({ level: 'info', title: '当前筛选条件下没有数据', why: '可移除部分筛选条件，或切换统计周期。', unf: true });
  }
  $('#notices').innerHTML = list.map(n => `<div class="notice ${n.level}">${icon(n.level === 'info' ? 'info' : 'warn')}<div><b>${esc(n.title)}</b>${n.why ? `<span class="why">${esc(n.why)}</span>` : ''}${n.go ? `<button class="link" data-go="${n.go}">前往配置 →</button>` : ''}${n.unf ? '<button class="link" data-unf="*">清除全部筛选 →</button>' : ''}</div></div>`).join('');
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
  if (go) { e.preventDefault(); closePop(); app.go(go.dataset.go); return; }
  const seg = e.target.closest('[data-seg]');
  if (seg) { ui[seg.dataset.seg] = seg.dataset.v; if (seg.dataset.seg === 'density') LS.set('bc.density', seg.dataset.v); render(); return; }
  const met = e.target.closest('[data-metric]');
  if (met) { ui.f.metric = met.dataset.metric; LS.set('bc.metric', ui.f.metric); render(); return; }
  const unf = e.target.closest('[data-unf]');
  if (unf) { if (unf.dataset.unf === '*') app.setFilter({}, null, true); else app.setFilter({ [unf.dataset.unf]: unf.dataset.unf === 'channel' ? '__all' : '' }); return; }
  if (e.target.closest('#btnMore')) { ui.moreFilters = !ui.moreFilters; render(); return; }
  const act = e.target.closest('[data-act]');
  if (act?.dataset.act === 'pwd') { closePop(); openPwd(false); }
  if (act?.dataset.act === 'logout') { closePop(); try { await http('POST', '/api/logout'); } finally { location.href = '/login'; } }
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
});
document.addEventListener('change', e => {
  const t = e.target.closest('[data-f]');
  if (t && t.dataset.f !== 'q') { ui.f[t.dataset.f] = t.value; render(); }
});
let qTimer;
document.addEventListener('input', e => {
  const t = e.target.closest('[data-f="q"]'); if (!t) return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    ui.f.q = t.value;
    const pos = t.selectionStart;
    render();
    const n = $('[data-f="q"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); }
  }, 300);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pop) { closePop(); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if (typing || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { const q = $('[data-f="q"]'); if (q) { e.preventDefault(); q.focus(); } }
  if (route.name === 'key' && (e.key === '[' || e.key === ']')) { const b = $(`[data-nav="${e.key === '[' ? 'prev' : 'next'}"]`); if (b) { e.preventDefault(); b.click(); } }
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
  await app.refreshStatus();
  const s = state.status?.sync;
  if (!s) return;
  const latest = Math.max(s.meta.changedAt || 0, s.bills.changedAt || 0);
  if (latest > lastSyncSeen) {
    const first = !lastSyncSeen;
    const billsChanged = (s.bills.changedAt || 0) > lastBillsSeen;
    lastSyncSeen = latest; lastBillsSeen = s.bills.changedAt || 0;
    if (!first && !$('#drawer').open && !document.querySelector('#dlgPwd[open]')) {
      await loadData({ silent: true });
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
  render();
  await loadData();
  setInterval(poll, 20_000);
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
