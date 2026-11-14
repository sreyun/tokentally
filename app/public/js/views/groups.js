/* =========================================================================
 * 业务分析：按业务空间 / 成本中心 / 负责人 / 云厂商汇总费用，联动关联的 API Key 与模型
 *  - 列表页（#/workspaces）：分组排行、每日趋势、层级钻取（分组 → API Key → 模型）、明细表、变动归因、单位成本
 *  - 详情页（#/group/<维度>/<ID>）：该分组的费用、关联 Key（含无消费的 Key）、模型、Key × 模型、关联维度、月度与变更
 * ========================================================================= */
import {
  $, esc, state, ui, app, LS, http, money, moneyShort, compact, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, DIMS,
  keyObj, keyShort, filterLines, aggregate, addAgg, aggAll, sortedAggs, newAgg, totalTokens, topModels, deltaPill, icon, help, segCtl,
  fmtTime, periodTag, copyBtn, PROVIDERS, provTag, multiCloud, hasTags, NO_WS, NO_CC, NO_OWNER, dimVal, keyDimVal, dimName, DIM_LABEL,
  scopeLines, scopeUsage, groupHash, dimLink, isSet, keyMatch, usageFiltered, usageAgg, callsOn, perCallCovered, perCall, coveredCost, daysBetween, WEEK, weekday, channelLabel, toneOf,
  ccBudgetOf, hasCcBudgets, forecastOf, isCurrentMonth, budgetLevel } from '../core.js';
import { columnChart, rankList, divergingList, segbar, legendList, legendHtml, bindLegend, bindActivate } from '../charts.js';
import { table, dataBar } from '../table.js';
import { billDimsHtml, keyModelMatrix } from './models.js';
import { budgetTile } from './key.js';

export const GROUP_DIMS = {
  ws: { label: '业务空间', icon: 'ws', when: () => true },
  cc: { label: '成本中心', icon: 'tag', when: hasTags },
  owner: { label: '负责人', icon: 'user', when: hasTags },
  provider: { label: '云厂商', icon: 'cloud', when: multiCloud },
};
const availDims = () => Object.keys(GROUP_DIMS).filter(d => GROUP_DIMS[d].when());
/** 路由参数 "ws/<ID>" → { dim, id } */
export function parseGroupArg(arg) {
  const s = String(arg || ''), i = s.indexOf('/');
  if (i < 0) return null;
  const dim = s.slice(0, i), id = s.slice(i + 1);
  return Object.hasOwn(GROUP_DIMS, dim) && id ? { dim, id } : null; // hasOwn：constructor 等原型属性名不是维度
}
/** 用量行（请求次数）在分组维度上的取值：通过 Key 元数据关联 */
const NONE_OF = { ws: NO_WS, cc: NO_CC, owner: NO_OWNER };
const usageDim = (dim, u) => { if (dim === 'provider') return u.provider; const k = state.apiKeys.get(u.apiKeyId); return k ? keyDimVal[dim](k) : NONE_OF[dim]; };
const SEP = '\u0001';
const lineOnlyFilter = () => ['model', 'dir', 'item', 'channel', 'q'].some(k => isSet(k, ui.f[k]));
function keyStatus(id) {
  const k = keyObj(id);
  if (id === NONE_KEY) return ['非 Key 调用', ''];
  if (!k) return ['—', ''];
  if (k.source === 'deleted') return ['已删除', 'off'];
  if (k.source === 'bill') return ['不在列表', 'warn'];
  if (k.disabled === true) return ['已禁用', 'off'];
  if (k.disabled === false) return ['启用', 'on'];
  return ['—', ''];
}
/** 为按费用排序的分组分配颜色：业务空间 / 云厂商沿用全局配色（跨页面一致），其余按排名，最多 8 色 */
function colorize(ids, dim) {
  const out = new Map();
  if (dim === 'ws' || dim === 'provider') for (const id of ids) { const c = DIMS[dim].color(id); if (c !== 'var(--other)') out.set(id, c); }
  const used = new Set(out.values());
  const free = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--s${i})`).filter(c => !used.has(c));
  for (const id of ids.slice(0, 8)) { if (out.has(id)) continue; if (!free.length) break; out.set(id, free.shift()); }
  return out;
}
const periodDaysOf = p => Math.max(1, daysBetween(p.from, p.to < state.today ? p.to : state.today));

/* ======================================================================
 * 列表页
 * ====================================================================== */
export function render(v) {
  const dims = availDims();
  if (!dims.includes(ui.grpBy)) { const s = LS.get('bc.grpBy', 'ws'); ui.grpBy = dims.includes(s) ? s : 'ws'; }
  LS.set('bc.grpBy', ui.grpBy);
  const dim = ui.grpBy, G = GROUP_DIMS[dim], of = dimVal[dim], f = ui.f;
  const lines = filterLines(), prevLines = filterLines(state.prev), daily = filterLines(state.daily);
  const cur = aggregate(lines, of), prev = aggregate(prevLines, of);
  const total = sum(lines, metricVal);
  const lineOnly = lineOnlyFilter();
  // 成员 Key：满足元数据筛选的 Key（含无消费的 Key）+ 账单中出现的 Key
  const members = new Map();
  const addM = (g, id) => { if (!members.has(g)) members.set(g, new Set()); members.get(g).add(id); };
  if (!lineOnly) for (const k of state.apiKeys.values()) if (keyMatch(k)) addM(keyDimVal[dim](k), k.apiKeyId);
  for (const l of lines) addM(of(l), l.apiKeyId || NONE_KEY);
  const ids = new Set([...cur.keys(), ...members.keys()]);
  if (dim === 'ws' && !lineOnly && !f.key && !f.cc && !f.owner) {
    for (const w of state.workspaces.values()) if (!w.deletedAt && (!f.provider || (w.provider || 'aliyun') === f.provider)) ids.add(w.workspaceId);
  }
  if (isSet(dim, f[dim])) for (const x of [...ids]) if (x !== f[dim]) ids.delete(x);
  // 请求次数：分组内账单全部来自有调用次数数据源的云厂商时才计算单次平均
  const uf = usageFiltered();
  const ub = uf ? usageAgg(uf, u => usageDim(dim, u)) : new Map();
  const callsOk = new Map(), provs = new Map();
  for (const l of lines) {
    const g = of(l);
    callsOk.set(g, (callsOk.get(g) ?? true) && callsOn(l.provider));
    if (!provs.has(g)) provs.set(g, new Set());
    provs.get(g).add(l.provider);
  }
  // 单次平均费用只用有调用数据的日期的费用：按分组收集按日账单
  const dailyBy = new Map();
  for (const l of daily) { const g = of(l); let a = dailyBy.get(g); if (!a) dailyBy.set(g, a = []); a.push(l); }
  /*
   * 成本中心预算（按成本中心分组、统计周期为自然月时）：与预算告警一致，按应付金额统计整个成本中心本期的费用，
   * 不受全局筛选与费用口径影响（筛选只决定列表中显示哪些成本中心）；本月进行中时附预计月末
   */
  const ccBud = dim === 'cc' && state.data.period.mode === 'month' && hasCcBudgets();
  const ccFull = new Map(), ccDaily = new Map();
  if (ccBud) {
    for (const l of state.lines) { const g = of(l); ccFull.set(g, (ccFull.get(g) || 0) + l.pretax); }
    if (isCurrentMonth()) for (const l of state.daily) { const g = of(l); let a = ccDaily.get(g); if (!a) ccDaily.set(g, a = []); a.push(l); }
  }
  const gk = aggregate(lines, l => of(l) + SEP + DIMS.key.of(l));
  const topKeysOf = new Map();
  for (const a of sortedAggs(gk)) { const [g, k] = a.key.split(SEP); if (a.cost <= 0) continue; if (!topKeysOf.has(g)) topKeysOf.set(g, []); if (topKeysOf.get(g).length < 2) topKeysOf.get(g).push(k); }
  const rows = [...ids].map(id => {
    const a = cur.get(id) || newAgg(id), p = prev.get(id);
    const mem = [...(members.get(id) || [])].filter(x => x !== NONE_KEY);
    const t = totalTokens(a);
    const us = callsOk.get(id) ? ub.get(id) : null;
    const pc = perCallCovered(us, dailyBy.get(id));
    const w = dim === 'ws' && id !== NO_WS ? state.workspaces.get(id) : null;
    const pset = provs.get(id) || new Set(w ? [w.provider || 'aliyun'] : dim === 'provider' ? [id] : []);
    const budget = ccBud ? ccBudgetOf(id) : null, bUsed = budget ? ccFull.get(id) || 0 : 0;
    const bFc = budget && isCurrentMonth() ? forecastOf(ccDaily.get(id) || [], l => l.pretax)?.value ?? null : null;
    return {
      budget, bUsed, bFc, bPct: budget ? bUsed / budget : null,
      id, name: dimName(dim, id), sub: w ? id : '', deleted: !!w?.deletedAt, providers: [...pset],
      keys: mem.length, active: [...a.keys].filter(k => k !== NONE_KEY).length, cost: a.cost, prev: p?.cost || 0, chg: a.cost - (p?.cost || 0),
      share: total ? a.cost / total : 0, tokens: t, perM: t ? a.cost / t * 1e6 : null, hit: a.tIn ? a.tCache / a.tIn : null,
      requests: us ? us.requests : null, tokPer: pc?.tokPer ?? null, costPer: pc?.costPer ?? null,
      models: a.models.size, topKeys: topKeysOf.get(id) || [], topModels: topModels(a, 2), region: w?.region || '', created: w?.gmtCreate ?? null,
    };
  }).filter(r => r.cost > 0 || r.keys > 0 || r.tokens > 0);
  rows.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name, 'zh-CN'));
  const withCost = rows.filter(r => r.cost > 0);
  const unassigned = NONE_OF[dim] ? rows.find(r => r.id === NONE_OF[dim]) : null;
  const hasUsage = rows.some(r => r.requests != null);
  const dimOpts = Object.fromEntries(dims.map(d => [d, GROUP_DIMS[d].label]));
  const budRows = rows.filter(r => r.budget), overN = budRows.filter(r => r.bUsed >= r.budget).length;
  const fcOverN = budRows.filter(r => r.bUsed < r.budget && r.bFc != null && r.bFc >= r.budget).length;

  v.innerHTML = `
    ${dims.length > 1 ? `<div class="page-tools"><span class="lbl">分组维度</span>${segCtl('grpBy', dimOpts, false)}<span class="muted">切换后各图表与明细按所选维度汇总；全局筛选同样生效</span></div>` : ''}
    <div class="stat-strip">
      <div><span>${G.label}数</span><b>${rows.length}</b></div>
      <div><span>本期有费用</span><b>${withCost.length}</b></div>
      <div><span>关联 API Key</span><b>${sum(rows, r => r.keys)}</b></div>
      <div><span>本期费用 · ${METRICS[ui.f.metric]}</span><b>${money(total)}</b></div>
      <div><span>最高占比</span><b title="${esc(withCost[0]?.name || '')}">${withCost[0] ? `${esc(withCost[0].name)} ${pct(withCost[0].cost, total)}` : '—'}</b></div>
      ${budRows.length ? `<div title="整个成本中心本期的应付金额（不受全局筛选影响）与月度预算比较"><span>预算超支 / 已设预算</span><b class="${overN ? 'bad-text' : fcOverN ? 'warn-text' : ''}">${overN}<small class="muted"> / ${budRows.length}</small>${fcOverN ? `<small class="warn-text"> · 预计超支 ${fcOverN}</small>` : ''}</b></div>` : ''}
      ${unassigned ? `<div><span>${esc(dimName(dim, NONE_OF[dim]))}</span><b class="${unassigned.cost > 0 ? 'warn-text' : ''}">${money(unassigned.cost)}${total ? `<small class="muted"> ${pct(unassigned.cost, total)}</small>` : ''}</b></div>` : ''}
    </div>
    <div class="bi">
      <section class="panel c8"><div class="panel-h"><h3>每日费用（按${G.label}）</h3>${help(`按${G.label}堆叠的每日费用。点击图例进入该${G.label}详情；点击柱查看当日明细，点击柱中的某一段只看该${G.label}。`)}</div>
        <div class="legend" id="gLegend"></div><div class="chart" id="gDaily"></div></section>
      <section class="panel c4"><div class="panel-h"><h3>费用构成</h3><span class="sub">点击进入${G.label}详情</span></div><div id="gComp"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>层级钻取</h3>${help(`${G.label} → API Key → 模型 三级汇总，展开查看每一级的费用、环比与占上级比例。点击名称进入对应详情：${G.label}详情 / Key 详情 / 模型详情（限定在该${G.label}与 Key 内）。`)}
        <span class="sub">${esc(G.label)} → API Key → 模型</span><div class="actions"><button class="btn sm" id="tExpand">全部展开</button><button class="btn sm" id="tCollapse">全部收起</button></div></div><div id="gTree"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>${G.label}明细</h3><span class="sub">含本期无费用但有关联 Key 的${G.label} · 点击行查看详情</span>
        <div class="actions">${segCtl('density', { normal: '标准', compact: '紧凑' })}<button class="btn sm" id="csv">${icon('download')}导出</button></div></div><div id="gTbl"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>变动归因</h3>${help(`本期与上期（${state.compareRange || ''}）相比，各${G.label}的费用增减额。`)}<span class="sub">点击进入详情</span></div><div id="gVar"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>单位成本</h3>${help('每百万 Token 费用 = 费用 ÷ 总 Token × 10⁶；只比较 Token ≥ 10 万的分组。')}<span class="sub">每百万 Token 费用</span></div><div id="gUnit"></div></section>
    </div>`;

  // 每日趋势
  const days = uniq(daily.map(l => l.date)).sort();
  const ranked = sortedAggs(aggregate(daily, of)).filter(a => a.cost > 0).map(a => a.key);
  const colorOf = colorize(ranked, dim);
  const colored = ranked.filter(id => colorOf.has(id)), others = ranked.filter(id => !colorOf.has(id));
  const series = colored.map(id => ({ id, label: dimName(dim, id), color: colorOf.get(id) }));
  if (others.length) series.push({ id: '__other', label: others.length === 1 ? dimName(dim, others[0]) : `其他 ${others.length} 项`, color: 'var(--other)' });
  const cell = new Map();
  for (const l of daily) { const g = of(l); const k = l.date + '|' + (colorOf.has(g) ? g : '__other'); cell.set(k, (cell.get(k) || 0) + metricVal(l)); }
  $('#gLegend', v).innerHTML = series.length > 1 ? legendHtml(series, `点击进入${G.label}详情`) : '';
  bindLegend($('#gLegend', v), id => app.go(groupHash(dim, id)));
  columnChart($('#gDaily', v), {
    xs: days, series, cell: (x, s) => cell.get(x + '|' + s) || 0, height: 300, avg: days.length ? sum(daily, metricVal) / periodDaysOf(state.data.period) : null,
    xLabel: x => x.slice(5), tipTitle: x => `${x}（周${WEEK[weekday(x)]}）`, empty: '暂无按日账单数据',
    onX: x => app.openDay(x), onSeg: (x, id) => app.openDay(x, { global: true, [dim]: id }), clickHint: '点击查看当日明细', segHint: `点击柱段只看该${G.label}`,
  });

  // 构成
  const parts = withCost.slice(0, 7).map(r => ({ id: r.id, label: r.name, value: r.cost, color: colorOf.get(r.id) || 'var(--other)' }));
  if (withCost.length > 7) parts.push({ id: '__other', label: `其他 ${withCost.length - 7} 项`, value: sum(withCost.slice(7), r => r.cost), color: 'var(--other)' });
  $('#gComp', v).innerHTML = segbar(parts) + legendList(parts, total, true, `点击进入${G.label}详情`);
  bindActivate($('#gComp', v), '.li.clickable', li => app.go(groupHash(dim, li.dataset.pid)));

  // 层级钻取
  const tree = $('#gTree', v);
  const drawTree = () => drillTree(tree, lines, prevLines, dim);
  drawTree();
  $('#tExpand', v).onclick = () => { treeOpenAll(lines, dim); drawTree(); };
  $('#tCollapse', v).onclick = () => { treeState(dim).clear(); drawTree(); };

  // 明细表
  const max = Math.max(0, ...rows.map(r => r.cost));
  const cols = [
    { key: 'name', label: G.label, fmt: (x, r) => `<span class="sw" style="background:${colorOf.get(r.id) || 'var(--other)'}"></span><b style="font-weight:600">${esc(x)}</b>${multiCloud() && dim !== 'provider' ? r.providers.map(p => provTag(p)).join('') : ''}${r.deleted ? '<span class="tag warn">已删除</span>' : ''}${r.sub ? `<span class="sub mono">${esc(r.sub)}${copyBtn(r.sub, '复制业务空间ID')}</span>` : ''}` },
    { key: 'keys', label: 'API Key', title: '本期有账单的 Key / 关联的全部 Key', align: 'r', fmt: (x, r) => `${r.active}<span class="muted"> / ${x}</span>`, csv: r => `${r.active}/${r.keys}` },
    { key: 'cost', label: `费用（${METRICS[ui.f.metric]}）`, align: 'r', fmt: x => dataBar(x, max), csv: r => r.cost.toFixed(6) },
    { key: 'chg', label: state.compareLabel, align: 'r', fmt: (x, r) => deltaPill(r.cost, r.prev), csv: r => r.chg.toFixed(6) },
    { key: 'share', label: '占比', align: 'r', fmt: x => (x ? (x * 100).toFixed(1) + '%' : '—'), csv: r => (r.share * 100).toFixed(2) + '%' },
    ...(ccBud ? [{
      key: 'bPct', label: '预算使用', align: 'r', title: '整个成本中心本期的应付金额（不受全局筛选影响）÷ 月度预算', sortVal: r => r.bPct ?? -1, csv: r => (r.budget ? (r.bPct * 100).toFixed(2) + '%' : ''),
      fmt: (x, r) => {
        if (!r.budget) return '<span class="muted">—</span>';
        const lv = budgetLevel(r.bUsed, r.budget), fl = r.bFc != null ? budgetLevel(r.bFc, r.budget) : '';
        const cls = l => (l === 'bad' ? 'bad-text' : l === 'warn' ? 'warn-text' : '');
        return `<b class="${cls(lv)}">${(x * 100).toFixed(1)}%</b><span class="sub">${money(r.bUsed)} / ${money(r.budget)}</span>${r.bFc != null ? `<span class="sub ${cls(fl)}">预计月末 ${(r.bFc / r.budget * 100).toFixed(0)}%</span>` : ''}`;
      },
    }] : []),
    { key: 'tokens', label: '总 Token', align: 'r', fmt: x => (x ? compact(x) : '—'), csv: r => Math.round(r.tokens) },
    { key: 'perM', label: '¥/百万Token', align: 'r', fmt: x => (x == null ? '—' : money(x)), sortVal: r => r.perM ?? -1, csv: r => (r.perM == null ? '' : r.perM.toFixed(4)) },
    { key: 'hit', label: '缓存命中率', align: 'r', fmt: x => (x == null ? '—' : (x * 100).toFixed(1) + '%'), sortVal: r => r.hit ?? -1, csv: r => (r.hit == null ? '' : (r.hit * 100).toFixed(2) + '%') },
    ...(hasUsage ? [
      { key: 'requests', label: '请求数', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : intFmt(x)), sortVal: r => r.requests ?? -1 },
      { key: 'tokPer', label: '单次均 Token', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : intFmt(x)), sortVal: r => r.tokPer ?? -1, csv: r => (r.tokPer == null ? '' : Math.round(r.tokPer)) },
      { key: 'costPer', label: '单次均费用', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : money(x, x < 0.01 ? 4 : 3)), sortVal: r => r.costPer ?? -1, csv: r => (r.costPer == null ? '' : r.costPer.toFixed(6)) },
    ] : []),
    { key: 'models', label: '模型数', align: 'r' },
    { key: 'topKeys', label: '主要 Key', sortable: false, fmt: x => x.map(k => dimLink('key', k, keyShort(k))).join('、') || '<span class="muted">—</span>', csv: r => r.topKeys.map(keyShort).join('、') },
    { key: 'topModels', label: '主要模型', sortable: false, fmt: (x, r) => x.map(m => dimLink('model', m, m, { global: true, [dim]: r.id })).join('、') || '<span class="muted">—</span>', csv: r => r.topModels.join('、') },
    ...(dim === 'ws' ? [
      { key: 'region', label: '地域', fmt: x => (x ? esc(x) : '<span class="muted">—</span>') },
      { key: 'created', label: '创建时间', fmt: x => (x ? fmtTime(x, false) : '<span class="muted">—</span>'), csv: r => (r.created ? fmtTime(r.created) : '') },
    ] : []),
  ];
  const t = table('groups:' + dim, $('#gTbl', v), {
    sort: 'cost', pageSize: 100, caption: `${G.label}明细`, rowClass: r => (r.deleted ? 'deleted' : ''),
    onRowClick: r => app.go(groupHash(dim, r.id)), columns: cols, empty: `当前筛选下没有${G.label}`,
    csvExtra: [{ label: `${G.label} ID`, val: r => r.id }, { label: '上期费用', val: r => r.prev.toFixed(6) }, { label: '云厂商', val: r => r.providers.map(p => PROVIDERS[p] || p).join('、') },
      ...(ccBud ? [{ label: '月度预算', val: r => (r.budget ? r.budget.toFixed(2) : '') }, { label: '本期应付（预算口径）', val: r => (r.budget ? r.bUsed.toFixed(6) : '') }, { label: '预计月末', val: r => (r.bFc != null ? r.bFc.toFixed(2) : '') }] : [])],
    footer: rs => cols.map(c => ({ name: `合计 ${rs.length} 个`, keys: String(sum(rs, r => r.keys)), cost: money(sum(rs, r => r.cost)), chg: deltaPill(sum(rs, r => r.cost), sum(rs, r => r.prev)), tokens: compact(sum(rs, r => r.tokens)), requests: hasUsage ? intFmt(sum(rs, r => r.requests || 0)) : '' }[c.key] ?? '')),
  }).setRows(rows);
  $('#csv', v).onclick = () => t.csv(`${G.label}费用_${periodTag()}.csv`);

  // 变动归因
  divergingList($('#gVar', v), uniq([...cur.keys(), ...prev.keys()]).map(id => {
    const c = cur.get(id)?.cost || 0, p = prev.get(id)?.cost || 0;
    return { id, label: dimName(dim, id), cur: c, prev: p, delta: c - p };
  }), { limit: 8, onClick: it => app.go(groupHash(dim, it.id)) });

  // 单位成本
  const unit = rows.filter(r => r.perM != null && r.tokens >= 1e5).sort((a, b) => b.perM - a.perM);
  rankList($('#gUnit', v), unit.map(r => ({ id: r.id, label: r.name, sub: `${compact(r.tokens)} Token`, value: r.perM, color: colorOf.get(r.id) || 'var(--other)' })),
    { limit: 10, total: 0, empty: 'Token ≥ 10 万的分组不足', onClick: it => app.go(groupHash(dim, it.id)) });
}

/* ---------------- 层级钻取（分组 → API Key → 模型） ---------------- */
const TREE_LIMIT = 30;
const treeStates = {};
const treeState = dim => (treeStates[dim] ||= new Set());
function treeOpenAll(lines, dim) {
  const s = treeState(dim), of = dimVal[dim];
  const top = sortedAggs(aggregate(lines, of)).slice(0, 20);
  for (const g of top) {
    s.add(g.key);
    const ks = sortedAggs(aggregate(lines.filter(l => of(l) === g.key), DIMS.key.of)).slice(0, TREE_LIMIT);
    for (const k of ks) s.add(g.key + SEP + k.key);
  }
}
function drillTree(el, lines, prevLines, dim) {
  const of = dimVal[dim];
  const lv = [of, DIMS.key.of, l => l.model];
  const root = new Map();
  const node = (m, id) => { let n = m.get(id); if (!n) m.set(id, n = { id, agg: newAgg(id), prev: 0, kids: new Map() }); return n; };
  for (const l of lines) { let m = root; for (let i = 0; i < 3; i++) { const n = node(m, lv[i](l)); addAgg(n.agg, l); m = n.kids; } }
  for (const l of prevLines) { let m = root; for (let i = 0; i < 3; i++) { const n = m.get(lv[i](l)); if (!n) break; n.prev += metricVal(l); m = n.kids; } }
  const open = treeState(dim);
  if (root.size === 1) open.add([...root.keys()][0]); // 只有一个分组时自动展开
  const total = sum([...root.values()], n => n.agg.cost);
  if (!root.size) { el.innerHTML = '<div class="nodata">当前筛选下没有账单数据</div>'; return; }
  const sorted = m => [...m.values()].sort((a, b) => b.agg.cost - a.agg.cost);
  const out = [];
  const nameCell = (lvl, n, path, anc) => {
    if (lvl === 0) return dimLink(dim, n.id, dimName(dim, n.id));
    if (lvl === 1) return n.id === NONE_KEY ? esc(keyShort(n.id)) : dimLink('key', n.id, keyShort(n.id));
    return dimLink('model', n.id, n.id, { global: true, [dim]: anc[0], key: anc[1] });
  };
  const walk = (m, lvl, parentPath, parentCost, anc) => {
    const list = sorted(m), shown = list.slice(0, TREE_LIMIT);
    for (const n of shown) {
      const path = parentPath ? parentPath + SEP + n.id : n.id;
      const isOpen = lvl < 2 && open.has(path);
      const tok = totalTokens(n.agg);
      const sub = lvl === 0 ? `${[...n.agg.keys].filter(k => k !== NONE_KEY).length} 个 Key · ${n.agg.models.size} 个模型` : lvl === 1 ? `${n.agg.models.size} 个模型` : '';
      out.push(`<tr class="tr-lv${lvl}"><td class="tree-name" style="--lv:${lvl}">${lvl < 2 ? `<button type="button" class="tg" data-tg="${esc(path)}" aria-expanded="${isOpen}" aria-label="${isOpen ? '收起' : '展开'}">${icon('chevR')}</button>` : '<span class="tg-sp"></span>'}<span class="tree-label">${nameCell(lvl, n, path, anc)}</span>${sub ? `<span class="muted tree-sub">${esc(sub)}</span>` : ''}</td>
        <td class="r">${esc(money(n.agg.cost))}</td><td class="r">${deltaPill(n.agg.cost, n.prev)}</td>
        <td class="r"><span class="share-bar" title="占上级 ${pct(n.agg.cost, parentCost)}"><i style="width:${parentCost ? Math.min(100, n.agg.cost / parentCost * 100).toFixed(1) : 0}%"></i></span>${pct(n.agg.cost, parentCost)}</td>
        <td class="r">${tok ? compact(tok) : '—'}</td><td class="r">${tok ? money(n.agg.cost / tok * 1e6) : '—'}</td></tr>`);
      if (isOpen) walk(n.kids, lvl + 1, path, n.agg.cost, [...anc, n.id]);
    }
    if (list.length > shown.length) out.push(`<tr class="tr-more"><td colspan="6" style="--lv:${lvl}" class="tree-name muted">另有 ${list.length - shown.length} 项（合计 ${esc(money(sum(list.slice(TREE_LIMIT), n => n.agg.cost)))}）未展开显示，可在明细表或成本分摊中查看</td></tr>`);
  };
  walk(root, 0, '', total, []);
  el.innerHTML = `<div class="tbl-wrap" style="max-height:70vh"><table class="dt tree ${ui.density === 'compact' ? 'compact' : ''}" aria-label="层级钻取"><thead><tr><th>名称</th><th class="r">费用（${esc(METRICS[ui.f.metric])}）</th><th class="r">${esc(state.compareLabel)}</th><th class="r">占上级</th><th class="r">Token</th><th class="r">¥/百万Token</th></tr></thead><tbody>${out.join('')}</tbody></table></div>`;
  el.onclick = e => {
    const b = e.target.closest('[data-tg]'); if (!b) return;
    const p = b.dataset.tg;
    if (open.has(p)) { for (const x of [...open]) if (x === p || x.startsWith(p + SEP)) open.delete(x); } else open.add(p);
    drillTree(el, lines, prevLines, dim);
    el.querySelector(`[data-tg="${CSS.escape(p)}"]`)?.focus();
  };
}

/* ======================================================================
 * 详情页：#/group/<维度>/<ID>（不受全局筛选影响，与 Key 详情一致）
 * ====================================================================== */
export function renderDetail(v, arg) {
  const g = parseGroupArg(arg);
  if (!g) { v.innerHTML = notFound('无效的地址'); return; }
  const { dim, id } = g, G = GROUP_DIMS[dim], of = dimVal[dim], scope = { [dim]: id };
  const lines = scopeLines(state.lines, scope), prevLines = scopeLines(state.prev, scope), daily = scopeLines(state.daily, scope), hist = scopeLines(state.history, scope);
  const a = aggAll(lines), pa = aggAll(prevLines);
  const p = state.data.period;
  const ws = dim === 'ws' && id !== NO_WS ? state.workspaces.get(id) : null;
  // 关联 Key：元数据属于该分组的 Key（含无消费的 Key）+ 本期 / 上期账单中出现的 Key
  const memberIds = new Set([...state.apiKeys.values()].filter(k => keyDimVal[dim](k) === id).map(k => k.apiKeyId));
  for (const l of [...lines, ...prevLines]) memberIds.add(l.apiKeyId || NONE_KEY);
  if (!memberIds.size && !lines.length && !ws && !(dim === 'provider' && Object.hasOwn(PROVIDERS, id))) {
    v.innerHTML = notFound(`${G.label}“${dimName(dim, id)}”在当前周期没有关联的 API Key 或费用。`);
    return;
  }
  // 排名与上一个 / 下一个（按本期费用）
  const allBy = aggregate(state.lines, of);
  const ranked = sortedAggs(allBy).filter(x => x.cost > 0);
  const rank = ranked.findIndex(x => x.key === id) + 1;
  const totalAll = sum(state.lines, metricVal);
  const orderSet = new Set([...allBy.keys(), ...[...state.apiKeys.values()].map(k => keyDimVal[dim](k))]);
  if (dim === 'ws') for (const w of state.workspaces.values()) if (!w.deletedAt) orderSet.add(w.workspaceId);
  if ((dim === 'cc' || dim === 'owner') && !hasTags()) orderSet.clear();
  orderSet.add(id); // 当前分组总在列表中（如已删除且无 Key 的业务空间），否则“上一个 / 下一个”显示 0 / N
  const order = [...orderSet].sort((x, y) => (allBy.get(y)?.cost || 0) - (allBy.get(x)?.cost || 0) || dimName(dim, x).localeCompare(dimName(dim, y), 'zh-CN'));
  const pos = order.indexOf(id), prevId = pos > 0 ? order[pos - 1] : null, nextId = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : null;
  // 用量（请求次数）
  const callsOk = lines.length > 0 && lines.every(l => callsOn(l.provider));
  const ur = scopeUsage(scope) || [];
  const us = callsOk && ur.length ? usageAgg(ur, () => 'a').get('a') : null;
  const usByKey = usageAgg(ur, u => u.apiKeyId || NONE_KEY);
  const tokens = totalTokens(a), ptokens = totalTokens(pa);
  const perM = tokens ? a.cost / tokens * 1e6 : null, pPerM = ptokens ? pa.cost / ptokens * 1e6 : null;
  const hit = a.tIn ? a.tCache / a.tIn : null, pHit = pa.tIn ? pa.tCache / pa.tIn : null;
  // 成本中心预算（自然月）：按应付金额比较，本月进行中时附预计月末（与预算告警口径一致）；设置了预算时替换“缓存命中率”指标卡
  const ccBudget = dim === 'cc' && p.mode === 'month' ? ccBudgetOf(id) : null;
  const ccFc = ccBudget && isCurrentMonth() ? forecastOf(daily, l => l.pretax)?.value ?? null : null;
  const memKeys = [...memberIds].filter(x => x !== NONE_KEY);
  const st = memKeys.map(k => keyStatus(k)[1]);
  const activeKeys = [...a.keys].filter(k => k !== NONE_KEY).length;
  const filterAttr = (go, title, label, ic) => `<button class="btn" data-fpatch="${esc(JSON.stringify(scope))}" data-fgo="${go}" data-freset="1" title="${esc(title)}">${ic ? icon(ic) : ''}${label}</button>`;
  const sub = dim === 'ws'
    ? (id === NO_WS ? '账单与 Key 中未归属任何业务空间的部分' : `ID <span class="mono">${esc(id)}</span>${copyBtn(id, '复制业务空间ID')}${ws?.region ? ` · 地域 ${esc(ws.region)}` : ''}${ws?.gmtCreate ? ` · 创建于 ${fmtTime(ws.gmtCreate, false)}` : ''}`)
    : dim === 'provider' ? `${esc(PROVIDERS[id] || id)}下的全部 API Key 与费用`
      : `本地标签：在“Key 分析 → 归属设置”中维护`;
  const relDims = ['ws', 'cc', 'owner', 'provider'].filter(d => d !== dim && GROUP_DIMS[d].when());
  const relOpts = Object.fromEntries([...relDims.map(d => [d, GROUP_DIMS[d].label]), ['channel', '调用渠道']]);
  if (!relOpts[ui.grpRel]) ui.grpRel = Object.keys(relOpts)[0];

  v.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <button class="back" style="margin:0" data-back="#/workspaces">${icon('chevL')}返回</button>
      <div class="pager-nav" role="group" aria-label="切换${G.label}">
        <button class="btn sm" ${prevId != null ? `data-go="${esc(groupHash(dim, prevId))}" data-nav="prev" title="上一个（[）：${esc(dimName(dim, prevId))}"` : 'disabled'}>${icon('chevL')}上一个</button>
        <span class="muted">${pos + 1} / ${order.length}</span>
        <button class="btn sm" ${nextId != null ? `data-go="${esc(groupHash(dim, nextId))}" data-nav="next" title="下一个（]）：${esc(dimName(dim, nextId))}"` : 'disabled'}>下一个${icon('chevR')}</button>
      </div>
    </div>
    <div class="entity-h">
      <span class="entity-ico">${icon(G.icon)}</span>
      <div class="entity-t"><h2>${esc(dimName(dim, id))} <span class="pill neutral">${esc(G.label)}</span>${ws ? provTag(ws.provider || 'aliyun', multiCloud()) : ''}${ws?.deletedAt ? `<span class="pill bad">已删除 ${fmtTime(ws.deletedAt, false)}</span>` : ''}</h2>
        <div class="sub">${sub}</div>
        <div class="tag-line">${icon('key')}<span>关联 API Key <b>${memKeys.length}</b></span><span>本期有账单 <b>${activeKeys}</b></span><span>启用 <b>${st.filter(x => x === 'on').length}</b></span>${st.some(x => x === 'off') ? `<span>禁用 / 已删除 <b>${st.filter(x => x === 'off').length}</b></span>` : ''}</div></div>
      <div class="row">${filterAttr('#/overview', `把全部页面筛选为该${G.label}`, '按此筛选', 'filter')}${filterAttr('#/detail', '查看该范围的逐条账单', '账单明细', 'list')}</div>
    </div>
    <div class="kpi-wrap"><div class="kpi-row">
      ${tile('wallet', `本期费用 · ${METRICS[ui.f.metric]}`, money(a.cost), deltaPill(a.cost, pa.cost), state.compareLabel, `上期 ${money(pa.cost)} · 原价 ${moneyShort(a.gross)}`)}
      ${tile('layers', '费用排名', rank ? `第 ${rank}<small>/ ${ranked.length}</small>` : '—', '', '', `占全部费用 ${pct(a.cost, totalAll)}`)}
      ${tile('key', '活跃 Key', `${activeKeys}<small>/ ${memKeys.length}</small>`, '', '', (top => (top ? `最高：${keyShort(top.key)} 占 ${pct(top.cost, a.cost)}` : '—'))(sortedAggs(aggregate(lines, DIMS.key.of)).filter(x => x.cost > 0)[0]))}
      ${tile('token', 'Token 总量', compact(tokens), deltaPill(tokens, ptokens, { neutral: true }), state.compareLabel, us && us.requests ? `请求 ${compact(us.requests)} 次 · 单次 ${intFmt(us.tokens / us.requests)} Token` : `输入 ${compact(a.tIn)} · 输出 ${compact(a.tOut)}`)}
      ${tile('unit', '每百万 Token 成本', perM == null ? '—' : money(perM), perM == null ? '' : deltaPill(perM, pPerM), perM == null ? '' : state.compareLabel, '费用 ÷ 总 Token × 10⁶')}
      ${ccBudget ? budgetTile(a.pretax, ccBudget, ccFc)
        : tile('cache', '缓存命中率', hit == null ? '—' : (hit * 100).toFixed(1) + '%', hit == null ? '' : deltaPill(hit, pHit, { pp: true, goodWhenUp: true }), hit == null ? '' : state.compareLabel, `${a.models.size} 个模型`)}
    </div></div>
    <div class="bi">
      <section class="panel c8"><div class="panel-h"><h3>每日费用</h3><span class="sub">按 API Key 堆叠 · 点击图例进入 Key 详情；点击柱查看当日明细，点击柱段只看该 Key</span></div><div class="legend" id="gdLegend"></div><div class="chart" id="gdDaily"></div></section>
      <section class="panel c4"><div class="panel-h"><h3>API Key 构成</h3><span class="sub">点击进入 Key 详情</span></div><div id="gdComp"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>关联的 API Key</h3><span class="sub">含本期无费用的 Key · 点击行进入 Key 详情</span><div class="actions">${segCtl('density', { normal: '标准', compact: '紧凑' })}<button class="btn sm" id="csvK">${icon('download')}导出</button></div></div><div id="gdKeys"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>模型排行</h3><span class="sub">${esc(state.compareLabel)} · 点击查看该${G.label}内的模型详情</span></div><div id="gdModels"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>关联维度</h3>${help(`该${G.label}的费用在其他维度上的分布，点击进入对应详情（调用渠道则查看账单明细）。`)}<div class="actions">${segCtl('grpRel', relOpts)}</div></div><div id="gdRel"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>API Key × 模型</h3><span class="sub">点击 Key 进入详情，点击模型列头或格子查看模型详情（格子限定该 Key）</span><div class="actions">${segCtl('hmMetric', { cost: '费用', tokens: 'Token' })}</div></div><div id="gdMx"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>月度费用</h3>${help('近 12 个账期的账期账单，按 API Key 堆叠；范围取决于同步回溯月数。点击柱切换到该账期。')}</div><div class="legend" id="gdHLegend"></div><div class="chart" id="gdHist"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>计费维度</h3><span class="sub">按费用拆分</span></div><div id="gdDims"></div></section>
      ${dim === 'ws' && id !== NO_WS ? '<section class="panel c12"><div class="panel-h"><h3>变更记录</h3>' + help('该业务空间及其下 API Key 在同步时检测到的新增、修改、删除与恢复（最近 30 条）。') + '</div><div id="gdChanges"><div class="nodata">加载中…</div></div></section>' : ''}
    </div>`;

  // 每日（按 Key）
  const days = uniq(daily.map(l => l.date)).sort();
  const kRank = sortedAggs(aggregate(daily, DIMS.key.of)).filter(x => x.cost > 0).map(x => x.key);
  const kColored = kRank.slice(0, 7), kOthers = kRank.slice(7);
  const kColor = new Map(kColored.map((k, i) => [k, `var(--s${i + 1})`]));
  const series = kColored.map(k => ({ id: k, label: keyShort(k), color: kColor.get(k) }));
  if (kOthers.length) series.push({ id: '__other', label: `其他 ${kOthers.length} 个 Key`, color: 'var(--other)' });
  const cell = new Map();
  daily.forEach(l => { const k = DIMS.key.of(l); const kk = l.date + '|' + (kColor.has(k) ? k : '__other'); cell.set(kk, (cell.get(kk) || 0) + metricVal(l)); });
  $('#gdLegend', v).innerHTML = series.length > 1 ? legendHtml(series.map(s => ({ ...s, id: s.id === NONE_KEY ? null : s.id })), '点击进入 Key 详情') : '';
  bindLegend($('#gdLegend', v), k => app.go(`#/key/${encodeURIComponent(k)}`));
  columnChart($('#gdDaily', v), {
    xs: days, series, cell: (x, s) => cell.get(x + '|' + s) || 0, height: 260, avg: days.length ? sum(daily, metricVal) / periodDaysOf(p) : null,
    xLabel: x => x.slice(5), tipTitle: x => `${x}（周${WEEK[weekday(x)]}）`, empty: '本期无按日费用',
    onX: x => app.openDay(x, scope), onSeg: (x, k) => app.openDay(x, { ...scope, key: k }), clickHint: '点击查看当日明细', segHint: '点击柱段只看该 Key',
  });

  // Key 构成
  const kAgg = sortedAggs(aggregate(lines, DIMS.key.of)).filter(x => x.cost > 0);
  const parts = kAgg.slice(0, 7).map(x => ({ id: x.key === NONE_KEY ? null : x.key, label: keyShort(x.key), value: x.cost, color: kColor.get(x.key) || 'var(--other)' }));
  if (kAgg.length > 7) parts.push({ id: '__other', label: `其他 ${kAgg.length - 7} 个`, value: sum(kAgg.slice(7), x => x.cost), color: 'var(--other)' });
  $('#gdComp', v).innerHTML = segbar(parts) + legendList(parts, a.cost, true, '点击进入 Key 详情');
  bindActivate($('#gdComp', v), '.li.clickable', li => app.go(`#/key/${encodeURIComponent(li.dataset.pid)}`));

  // 关联的 API Key
  const byKey = aggregate(lines, DIMS.key.of), pByKey = aggregate(prevLines, DIMS.key.of);
  const calDays = periodDaysOf(p);
  const dailyByKey = new Map();
  for (const l of daily) { const kk = l.apiKeyId || NONE_KEY; let arr = dailyByKey.get(kk); if (!arr) dailyByKey.set(kk, arr = []); arr.push(l); }
  const krows = [...memberIds].map(k => {
    const ko = keyObj(k) || {}, x = byKey.get(k) || newAgg(k), t = totalTokens(x), u = callsOk ? usByKey.get(k) : null, pc = perCallCovered(u, dailyByKey.get(k)), act = state.keyActivity.get(k);
    const [status, stc] = keyStatus(k);
    return {
      id: k, desc: keyShort(k), provider: ko.provider || (k === NONE_KEY ? '' : 'aliyun'), hasDesc: !!ko.description, status, stc,
      wsKey: ko.wsKey || '', cc: ko.costCenter || '', owner: ko.owner || '',
      cost: x.cost, prev: pByKey.get(k)?.cost || 0, share: a.cost ? x.cost / a.cost : 0, tokens: t, perM: t ? x.cost / t * 1e6 : null, hit: x.tIn ? x.tCache / x.tIn : null,
      dayTok: t / calDays, requests: u ? u.requests : null, tokPer: pc?.tokPer ?? null, costPer: pc?.costPer ?? null,
      topModels: topModels(x, 2), lastDay: act?.lastDay || '', c7: act?.c7 || 0,
    };
  });
  const kmax = Math.max(0, ...krows.map(r => r.cost));
  const kHasUsage = krows.some(r => r.requests != null);
  const kcols = [
    { key: 'desc', label: 'API Key', fmt: (x, r) => `<span class="sw" style="background:${kColor.get(r.id) || 'var(--other)'}"></span><b style="font-weight:600">${esc(x)}</b>${provTag(r.provider)}${!r.hasDesc && r.id !== NONE_KEY ? '<span class="tag warn">无描述</span>' : ''}<span class="sub mono">${esc(r.id === NONE_KEY ? '—' : r.id)}${r.id !== NONE_KEY ? copyBtn(r.id, '复制 Key ID') : ''}</span>` },
    ...(dim !== 'ws' ? [{ key: 'wsKey', label: '业务空间', fmt: (x, r) => (r.id === NONE_KEY ? '—' : dimLink('ws', x || NO_WS)), sortVal: r => dimName('ws', r.wsKey || NO_WS), csv: r => dimName('ws', r.wsKey || NO_WS) }] : []),
    ...(dim !== 'cc' && hasTags() ? [{ key: 'cc', label: '成本中心', fmt: (x, r) => (x ? dimLink('cc', x, x) : r.id === NONE_KEY ? '—' : '<span class="muted">未分配</span>') + (r.owner && dim !== 'owner' ? `<span class="sub">负责人 ${dimLink('owner', r.owner, r.owner)}</span>` : '') }] : []),
    { key: 'status', label: '状态', fmt: (x, r) => `<span class="state ${r.stc}">${esc(x)}</span>` },
    { key: 'cost', label: `费用（${METRICS[ui.f.metric]}）`, align: 'r', fmt: x => dataBar(x, kmax), csv: r => r.cost.toFixed(6) },
    { key: 'chg', label: state.compareLabel, align: 'r', fmt: (x, r) => deltaPill(r.cost, r.prev), sortVal: r => r.cost - r.prev, csv: r => (r.cost - r.prev).toFixed(6) },
    { key: 'share', label: '占比', align: 'r', fmt: x => (x ? (x * 100).toFixed(1) + '%' : '—'), csv: r => (r.share * 100).toFixed(2) + '%' },
    { key: 'tokens', label: '总 Token', align: 'r', fmt: x => (x ? compact(x) : '—'), csv: r => Math.round(r.tokens) },
    { key: 'perM', label: '¥/百万Token', align: 'r', fmt: x => (x == null ? '—' : money(x)), sortVal: r => r.perM ?? -1 },
    { key: 'hit', label: '缓存命中率', align: 'r', fmt: x => (x == null ? '—' : (x * 100).toFixed(1) + '%'), sortVal: r => r.hit ?? -1 },
    ...(kHasUsage ? [
      { key: 'requests', label: '请求数', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : intFmt(x)), sortVal: r => r.requests ?? -1 },
      { key: 'tokPer', label: '单次均 Token', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : intFmt(x)), sortVal: r => r.tokPer ?? -1, csv: r => (r.tokPer == null ? '' : Math.round(r.tokPer)) },
      { key: 'costPer', label: '单次均费用', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : money(x, x < 0.01 ? 4 : 3)), sortVal: r => r.costPer ?? -1, csv: r => (r.costPer == null ? '' : r.costPer.toFixed(6)) },
    ] : []),
    { key: 'topModels', label: '主要模型', sortable: false, fmt: (x, r) => x.map(m => dimLink('model', m, m, { ...scope, key: r.id })).join('、') || '<span class="muted">—</span>', csv: r => r.topModels.join('、') },
    { key: 'lastDay', label: '最近消费', fmt: x => (x ? esc(x) : '<span class="muted">—</span>') },
    { key: 'c7', label: '近 7 天', title: '近 7 天应付金额（与所选周期无关）', align: 'r', fmt: x => money(x) },
  ];
  const tk = table('groupKeys', $('#gdKeys', v), {
    sort: 'cost', pageSize: 100, caption: '关联的 API Key', columns: kcols, empty: '没有关联的 API Key',
    rowClass: r => (r.status === '已删除' ? 'deleted' : ''),
    onRowClick: r => (r.id === NONE_KEY ? app.setFilter({ ...scope, key: NONE_KEY }, '#/detail', true) : app.go(`#/key/${encodeURIComponent(r.id)}`)),
    csvExtra: [{ label: 'API Key ID', val: r => (r.id === NONE_KEY ? '' : r.id) }, { label: '上期费用', val: r => r.prev.toFixed(6) }],
    footer: rs => kcols.map(c => ({ desc: `合计 ${rs.length} 个`, cost: money(sum(rs, r => r.cost)), chg: deltaPill(sum(rs, r => r.cost), sum(rs, r => r.prev)), tokens: compact(sum(rs, r => r.tokens)), requests: kHasUsage ? intFmt(sum(rs, r => r.requests || 0)) : '', c7: money(sum(rs, r => r.c7)) }[c.key] ?? '')),
  }).setRows(krows);
  $('#csvK', v).onclick = () => tk.csv(`${G.label}_${dimName(dim, id)}_API_Key_${periodTag()}.csv`);

  // 模型排行
  const pm = aggregate(prevLines, l => l.model);
  rankList($('#gdModels', v), sortedAggs(aggregate(lines, l => l.model)).map(x => ({ id: x.key, label: x.key, sub: `${x.keys.size} 个 Key · ${compact(totalTokens(x))} Token`, value: x.cost, prev: pm.get(x.key)?.cost ?? 0, color: DIMS.model.color(x.key) })),
    { total: a.cost, showDelta: true, limit: 12, onClick: it => app.openModel(it.id, scope) });

  // 关联维度
  const rel = ui.grpRel;
  if (rel === 'channel') {
    rankList($('#gdRel', v), sortedAggs(aggregate(lines, l => l.channel)).map(x => ({ id: x.key, label: channelLabel(x.key), sub: x.key || '', value: x.cost })),
      { total: a.cost, limit: 10, onClick: it => app.setFilter({ ...scope, channel: it.id }, '#/detail', true) });
  } else {
    const rp = aggregate(prevLines, dimVal[rel]);
    rankList($('#gdRel', v), sortedAggs(aggregate(lines, dimVal[rel])).map(x => ({ id: x.key, label: dimName(rel, x.key), sub: `${[...x.keys].filter(k => k !== NONE_KEY).length} 个 Key`, value: x.cost, prev: rp.get(x.key)?.cost ?? 0, color: DIMS[rel].color(x.key) })),
      { total: a.cost, showDelta: true, limit: 10, onClick: it => app.go(groupHash(rel, it.id)) });
  }

  // Key × 模型
  keyModelMatrix($('#gdMx', v), lines, { cellScope: k => ({ ...scope, key: k }), headScope: scope });

  // 月度（按 Key）
  const hm = uniq(hist.map(l => l.date)).sort();
  const hRank = sortedAggs(aggregate(hist, DIMS.key.of)).map(x => x.key);
  const hColored = hRank.slice(0, 6);
  const free = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--s${i})`).filter(c => ![...kColor.values()].includes(c));
  const hColor = new Map(hColored.map(k => [k, kColor.get(k) || free.shift() || 'var(--other)']));
  const hSeries = hColored.map(k => ({ id: k, label: keyShort(k), color: hColor.get(k) }));
  if (hRank.length > 6) hSeries.push({ id: '__other', label: '其他 Key', color: 'var(--other)' });
  const hc = new Map(); hist.forEach(l => { const k = DIMS.key.of(l); const kk = l.date + '|' + (hColor.has(k) ? k : '__other'); hc.set(kk, (hc.get(kk) || 0) + metricVal(l)); });
  $('#gdHLegend', v).innerHTML = hSeries.length > 1 ? legendHtml(hSeries) : '';
  columnChart($('#gdHist', v), { xs: hm, series: hSeries, cell: (x, s) => hc.get(x + '|' + s) || 0, height: 220, xLabel: x => x.slice(2), tipTitle: x => `${x} 账期`, weekend: false, empty: '暂无历史账期数据', onX: x => app.setPeriod({ mode: 'month', cycle: x }), clickHint: '点击切换到该账期' });

  $('#gdDims', v).innerHTML = billDimsHtml(lines);
  if (dim === 'ws' && id !== NO_WS) loadChanges(v, id, memberIds);
}

const CHG = { create: ['新增', 'good'], update: ['修改', 'warn'], delete: ['删除', 'bad'], restore: ['恢复', 'good'] };
async function loadChanges(v, wsId, memberIds) {
  const el = $('#gdChanges', v);
  if (!el) return;
  if (state.share) { el.innerHTML = '<div class="nodata">只读分享视图不包含变更记录</div>'; return; }
  try {
    if (!state.changes) state.changes = (await http('GET', '/api/changes')).changes;
    const list = state.changes.filter(c => (c.entity === 'workspace' && c.entity_id === wsId) || (c.entity === 'api_key' && memberIds.has(c.entity_id))).slice(0, 30);
    if (!el.isConnected) return;
    el.innerHTML = list.length ? `<ul class="timeline">${list.map(c => `<li><span class="pill ${CHG[c.change]?.[1] || 'neutral'}">${CHG[c.change]?.[0] || esc(c.change)}</span><div><b>${fmtTime(c.ts)}</b> · ${c.entity === 'workspace' ? '业务空间' : `API Key ${c.entity_id ? dimLink('key', c.entity_id, c.name || c.entity_id) : ''}`}${c.entity === 'workspace' && c.name ? ` ${esc(c.name)}` : ''}</div></li>`).join('')}</ul>` : '<div class="nodata">暂无变更记录</div>';
  } catch (e) { if (el.isConnected) el.innerHTML = `<div class="nodata bad-text">${esc(e.message)}</div>`; }
}

function notFound(msg) {
  return `<button class="back" data-back="#/workspaces">${icon('chevL')}返回</button><div class="panel empty"><h2>没有可显示的数据</h2><div>${esc(msg)}</div><div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" data-go="#/workspaces">查看业务分析</button></div></div>`;
}
function tile(ic, label, value, delta, cmp, meta) {
  return `<section class="kpi" data-tone="${toneOf(ic)}"><div class="kpi-h"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span></div><div class="value">${value}</div>
    <div class="trend">${delta || ''}${delta && cmp ? `<span class="cmp">${esc(cmp)}</span>` : ''}</div><div class="meta" title="${esc(meta)}">${esc(meta)}</div></section>`;
}
