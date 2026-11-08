/* 成本概览：本期费用、预算与预测、趋势、关键发现、Top Key / 模型、构成、归因、治理摘要 */
import {
  $, esc, state, ui, app, money, moneyShort, compact, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, DIMS, keyShort, wsName,
  filterLines, aggregate, aggAll, sortedAggs, totalTokens, topModels, deltaPill, tipRows, icon, help, segCtl, forecastOf, budgetOf,
  budgetBar, activeFilterCount, channelLabel, addDays, daysBetween, WEEK, weekday, isCurrentMonth, lastDayOf as lastDayOfCycle,
  multiCloud, hasTags, PROVIDERS,
} from '../core.js';
import { sparkline, columnChart, lineChart, rankList, divergingList, segbar, legendList, topParts, legendHtml, bindActivate } from '../charts.js';
import { computeInsights, cacheSavings } from '../insights.js';
import { computeFindings, SEVERITY } from './governance.js';

/** 可选的分组维度：云厂商（多云时）、成本中心（设置了标签时） */
function dimOpts(base) {
  const o = { ...base };
  if (multiCloud()) o.provider = '云厂商';
  if (hasTags()) o.cc = '成本中心';
  return o;
}
function fixSeg(key, opts) { if (!opts[ui[key]]) ui[key] = Object.keys(opts)[0]; return opts; }

export function render(v) {
  const p = state.data.period;
  const trendOpts = fixSeg('trendBy', dimOpts({ key: 'Key', model: '模型', ws: '业务空间' }));
  const compOpts = fixSeg('compBy', dimOpts({ ws: '业务空间', dir: 'Token 类型', channel: '渠道' }));
  const varOpts = fixSeg('varBy', dimOpts({ key: 'Key', model: '模型', ws: '空间' }));
  const lines = filterLines(), prevLines = filterLines(state.prev), daily = filterLines(state.daily);
  const cur = aggAll(lines), prev = aggAll(prevLines);
  const days = uniq(daily.map(l => l.date)).sort();
  const dayCost = new Map(); daily.forEach(l => dayCost.set(l.date, (dayCost.get(l.date) || 0) + metricVal(l)));
  const fc = forecastOf(daily);
  const calDays = Math.max(1, daysBetween(p.from, p.to));
  const avgDay = fc ? fc.avg : cur.cost / calDays;
  const tokens = totalTokens(cur), pTokens = totalTokens(prev);
  const perM = tokens ? cur.cost / tokens * 1e6 : null, pPerM = pTokens ? prev.cost / pTokens * 1e6 : null;
  const hit = cur.tIn ? cur.tCache / cur.tIn : null, pHit = prev.tIn ? prev.tCache / prev.tIn : null;
  const byKey = aggregate(lines, DIMS.key.of), pByKey = aggregate(prevLines, DIMS.key.of);
  const byModel = aggregate(lines, DIMS.model.of), pByModel = aggregate(prevLines, DIMS.model.of);
  const active = [...byKey.values()].filter(a => a.cost > 0 && a.key !== NONE_KEY).length;
  const pActive = [...pByKey.values()].filter(a => a.cost > 0 && a.key !== NONE_KEY).length;
  const top1 = sortedAggs(byKey)[0];
  const disc = cur.gross ? 1 - cur.pretax / cur.gross : 0;
  const noTok = !lines.some(l => l.tokens != null);
  const budget = p.mode === 'month' && !activeFilterCount() ? budgetOf() : null;
  const saved = cacheSavings(lines);
  const prevFullCost = sum(filterLines(state.prevFull), metricVal);

  v.innerHTML = `
  <div class="kpis">
    <section class="kpi hero" aria-label="本期费用">
      <div class="kpi-h"><span class="kpi-ico">${icon('wallet')}</span><span>${p.mode === 'month' ? `${esc(p.cycle)} 账期费用` : '所选周期费用'} · ${METRICS[ui.f.metric]}</span></div>
      <div class="value" title="${esc(money(cur.cost, 4))}">${money(cur.cost)}</div>
      <div class="trend">${deltaPill(cur.cost, prev.cost)}<span class="cmp">${esc(state.compareLabel)} ${money(prev.cost)}</span></div>
      <div class="stats">
        <div><span>原价</span><b>${moneyShort(cur.gross)}</b></div>
        <div><span>优惠与券</span><b>${moneyShort(cur.gross - cur.pretax)}</b></div>
        <div><span>综合折扣</span><b>${cur.gross ? (disc * 100).toFixed(1) + '%' : '-'}</b></div>
        <div><span>日均</span><b>${moneyShort(avgDay)}</b></div>
      </div>
      ${budget ? budgetBar(sum(lines, l => l.pretax), budget, fc ? forecastOf(daily, l => l.pretax).value : null) : ''}
      <div class="spark" data-tip="${esc(tipRows('每日费用', [['天数', days.length], ['日均', money(avgDay)]]))}">${sparkline(days.map(x => dayCost.get(x) || 0))}</div>
    </section>
    ${fc ? kpi('forecast', '预计本月费用', moneyShort(fc.value), deltaPill(fc.value, prevFullCost), '较上月全月', `按 ${fc.fullDays} 个完整日的日均推算`)
      : kpi('calendar', '日均费用', money(avgDay), '', '', `${calDays} 天 · 峰值 ${peakText(days, dayCost)}`)}
    ${kpi('key', '活跃 API Key', `${active}<small>/ ${state.apiKeys.size}</small>`, deltaPill(active, pActive, { neutral: true }), state.compareLabel, top1 ? `最高：${keyShort(top1.key)} 占 ${pct(top1.cost, cur.cost)}` : '—')}
    ${kpi('token', 'Token 总量', noTok ? '—' : compact(tokens), noTok ? '' : deltaPill(tokens, pTokens, { neutral: true }), noTok ? '' : state.compareLabel, noTok ? '当前数据无用量' : `输入 ${compact(cur.tIn)} · 输出 ${compact(cur.tOut)}`, intFmt(tokens))}
    ${kpi('unit', '每百万 Token 成本', perM == null ? '—' : money(perM), perM == null ? '' : deltaPill(perM, pPerM), perM == null ? '' : state.compareLabel, '费用 ÷ 总 Token × 10⁶')}
    ${kpi('cache', '缓存命中率', hit == null ? '—' : (hit * 100).toFixed(1) + '%', hit == null ? '' : deltaPill(hit, pHit, { pp: true, goodWhenUp: true }), hit == null ? '' : state.compareLabel, saved > 0.01 ? `估算节省 ${moneyShort(saved)}` : hit == null ? '—' : `命中 ${compact(cur.tCache)} Token`)}
    ${kpi('model', '使用模型', String(byModel.size), '', '', byModel.size ? `主力：${sortedAggs(byModel)[0].key}` : '—')}
  </div>

  <div class="bi">
    <section class="panel c8">
      <div class="panel-h"><h3>费用趋势</h3>${help('每日：按日账单堆叠；累计：本期与上期按天累计对比（当月含月末预测）；月度：近 12 个账期的账期账单（取决于同步回溯月数）。')}
        <div class="actions">${ui.trendMode !== 'cum' ? segCtl('trendBy', trendOpts) : ''}${segCtl('trendMode', { daily: '每日', cum: '累计', monthly: '月度' })}</div></div>
      <div class="legend" id="trLegend"></div><div class="chart" id="trChart"></div>
    </section>
    <section class="panel c4 ins-panel">
      <div class="panel-h"><h3>关键发现</h3>${help('基于当前筛选数据自动生成：费用变化与驱动因素、预算与预测、集中度、异常日、缓存效率、治理风险等。')}</div>
      <ul class="insights" id="insights"></ul>
    </section>

    <section class="panel c6">
      <div class="panel-h"><h3>API Key 费用排行</h3><span class="sub">${esc(state.compareLabel)} · 点击进入 Key 详情</span><div class="actions"><button class="btn ghost sm" data-go="#/keys">全部 Key</button></div></div>
      <div id="rkKeys"></div>
    </section>
    <section class="panel c6">
      <div class="panel-h"><h3>模型费用排行</h3><span class="sub">${esc(state.compareLabel)} · 点击查看模型详情</span><div class="actions"><button class="btn ghost sm" data-go="#/models">模型分析</button></div></div>
      <div id="rkModels"></div>
    </section>

    <section class="panel c4">
      <div class="panel-h"><h3>费用构成</h3><div class="actions">${segCtl('compBy', compOpts)}</div></div>
      <div id="comp"></div>
    </section>
    <section class="panel c4">
      <div class="panel-h"><h3>变动归因</h3>${help(`本期与上期（${state.compareRange || ''}）相比，各维度费用增减额，按绝对值排序。`)}<div class="actions">${segCtl('varBy', varOpts)}</div></div>
      <div id="variance"></div>
    </section>
    <section class="panel c4">
      <div class="panel-h"><h3>Key 治理</h3><span class="sub">风险与合规检查</span><div class="actions"><button class="btn ghost sm" data-go="#/governance">查看全部</button></div></div>
      <div id="gov"></div>
    </section>
  </div>`;

  drawTrend(daily, days, avgDay, fc);

  // 关键发现
  const ins = computeInsights();
  $('#insights').innerHTML = ins.length ? ins.map(x => `<li class="ins ${x.level}"><span class="ins-ico">${icon(x.icon)}</span><div><div class="ins-t">${esc(x.title)}</div><div class="ins-d">${x.html}</div>${x.go ? `<button class="link" data-go="${esc(x.go)}">${esc(x.goLabel || '查看')} →</button>` : ''}</div></li>`).join('') : '<li class="nodata">暂无需要关注的发现</li>';

  rankList($('#rkKeys'), sortedAggs(byKey).map(a => ({
    id: a.key, label: keyShort(a.key), sub: a.key === NONE_KEY ? '' : [multiCloud() ? PROVIDERS[state.apiKeys.get(a.key)?.provider || 'aliyun'] : '', state.apiKeys.get(a.key)?.costCenter || wsName(state.apiKeys.get(a.key)?.wsKey || [...a.wss][0] || '')].filter(Boolean).join(' · '),
    value: a.cost, prev: pByKey.get(a.key)?.cost ?? 0, color: DIMS.key.color(a.key),
    tip: tipRows(DIMS.key.short(a.key), [['费用', money(a.cost)], ['占比', pct(a.cost, cur.cost)], ['上期', money(pByKey.get(a.key)?.cost || 0)], ['Token', compact(totalTokens(a))], ['主要模型', topModels(a, 2).join('、')]]),
  })), { total: cur.cost, showDelta: true, onClick: it => (it.id === NONE_KEY ? app.setFilter({ key: NONE_KEY }, '#/detail') : app.go(`#/key/${it.id}`)) });
  rankList($('#rkModels'), sortedAggs(byModel).map(a => ({
    id: a.key, label: a.key, sub: `${a.keys.size} 个 Key`, value: a.cost, prev: pByModel.get(a.key)?.cost ?? 0, color: DIMS.model.color(a.key),
    tip: tipRows(a.key, [['费用', money(a.cost)], ['占比', pct(a.cost, cur.cost)], ['上期', money(pByModel.get(a.key)?.cost || 0)], ['Token', compact(totalTokens(a))], ['每百万 Token', totalTokens(a) ? money(a.cost / totalTokens(a) * 1e6) : '-']]),
  })), { total: cur.cost, showDelta: true, onClick: it => app.openModel(it.id) });

  // 构成
  let parts;
  if (ui.compBy === 'provider' || ui.compBy === 'cc') {
    const dm = DIMS[ui.compBy];
    parts = sortedAggs(aggregate(lines, dm.of)).filter(a => a.cost > 0).map(a => ({ id: a.key, label: dm.short(a.key), value: a.cost, color: dm.color(a.key), f: ui.compBy }));
  } else if (ui.compBy === 'ws') parts = topParts(aggregate(lines, DIMS.ws.of), 'ws');
  else if (ui.compBy === 'channel') parts = sortedAggs(aggregate(lines, l => l.channel)).filter(a => a.cost > 0).map((a, i) => ({ id: a.key, label: channelLabel(a.key), value: a.cost, color: i < 7 ? `var(--s${i + 1})` : 'var(--other)', f: 'channel' }));
  else {
    const m = aggregate(lines, l => (l.ioi.dir === 'in' ? (l.ioi.cache === 'hit' ? 'hit' : l.ioi.cache === 'create' ? 'create' : 'in') : l.ioi.dir));
    const meta = { in: ['输入（非缓存）', 'var(--s1)'], hit: ['缓存命中', 'var(--s3)'], create: ['缓存创建', 'var(--s4)'], out: ['输出', 'var(--s2)'], emb: ['向量', 'var(--s7)'], other: ['其他 / 订阅', 'var(--other)'] };
    parts = Object.keys(meta).filter(k => m.has(k)).map(k => ({ id: null, label: meta[k][0], value: m.get(k).cost, color: meta[k][1] }));
  }
  const comp = $('#comp');
  comp.innerHTML = segbar(parts) + legendList(parts, sum(parts, x => x.value), ui.compBy !== 'dir');
  if (ui.compBy !== 'dir') bindActivate(comp, '.li.clickable', li => app.setFilter(ui.compBy === 'ws' ? { ws: li.dataset.pid || '__nows' } : ui.compBy === 'provider' ? { provider: li.dataset.pid } : ui.compBy === 'cc' ? { cc: li.dataset.pid || '__nocc__' } : { channel: li.dataset.pid }));

  // 归因
  const dim = DIMS[ui.varBy];
  const vc = aggregate(lines, dim.of), vp = aggregate(prevLines, dim.of);
  divergingList($('#variance'), uniq([...vc.keys(), ...vp.keys()]).map(id => {
    const c = vc.get(id)?.cost || 0, pv = vp.get(id)?.cost || 0;
    return { id, label: dim.short(id), cur: c, prev: pv, delta: c - pv };
  }), { limit: 6, onClick: it => (ui.varBy === 'key' ? (it.id !== NONE_KEY && app.go(`#/key/${it.id}`)) : ui.varBy === 'model' ? app.openModel(it.id) : ui.varBy === 'provider' ? app.setFilter({ provider: it.id }) : ui.varBy === 'cc' ? app.setFilter({ cc: it.id || '__nocc__' }) : app.setFilter({ ws: it.id || '__nows' })) });

  // 治理摘要
  const f = computeFindings();
  const bySev = s => f.filter(x => x.severity === s).length;
  const rules = Object.values(f.reduce((m, x) => { (m[x.rule] ||= { rule: x.rule, name: x.ruleName, severity: x.severity, n: 0 }).n++; return m; }, {})).sort((a, c) => SEVERITY[a.severity].order - SEVERITY[c.severity].order || c.n - a.n);
  $('#gov').innerHTML = `<div class="gov-sum">${['high', 'medium', 'low'].map(s => `<div class="gov-c ${s} ${bySev(s) ? "" : "zero"}"><b>${bySev(s)}</b><span>${SEVERITY[s].label}</span></div>`).join('')}</div>
    ${rules.length ? `<ul class="gov-list">${rules.slice(0, 6).map(r => `<li><span class="pill ${SEVERITY[r.severity].cls}">${SEVERITY[r.severity].label}</span><span>${esc(r.name)}</span><b>${r.n}</b></li>`).join('')}</ul>` : '<div class="nodata">未发现治理问题</div>'}`;
}

function kpi(ic, label, value, delta, cmp, meta, title) {
  return `<section class="kpi"><div class="kpi-h"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span></div>
    <div class="value" ${title ? `title="${esc(title)}"` : ''}>${value}</div>
    <div class="trend">${delta || ''}${delta && cmp ? `<span class="cmp">${esc(cmp)}</span>` : ''}</div>
    <div class="meta" title="${esc(meta)}">${esc(meta)}</div></section>`;
}
function peakText(days, dayCost) {
  if (!days.length) return '-';
  const d = days.reduce((a, c) => ((dayCost.get(c) || 0) > (dayCost.get(a) || 0) ? c : a), days[0]);
  return `${d.slice(5)} ${moneyShort(dayCost.get(d) || 0)}`;
}

function drawTrend(daily, days, avgDay, fc) {
  const el = $('#trChart'), lg = $('#trLegend');
  const p = state.data.period;
  if (ui.trendMode === 'cum') {
    // 本期 vs 上期 按天累计
    const prevDaily = filterLines(state.prevDaily);
    const curDays = [];
    for (let d = p.from; d <= (p.mode === 'month' ? addDays(p.from, p.daysInPeriod - 1) : p.to); d = addDays(d, 1)) curDays.push(d);
    const [pStart, pEnd] = p.mode === 'month' ? [p.prevLabel + '-01', lastDayOfCycle(p.prevLabel)] : p.prevLabel.split(' ~ ');
    const n = Math.max(curDays.length, daysBetween(pStart, pEnd));
    const cm = new Map(), pm = new Map();
    daily.forEach(l => cm.set(l.date, (cm.get(l.date) || 0) + metricVal(l)));
    prevDaily.forEach(l => pm.set(l.date, (pm.get(l.date) || 0) + metricVal(l)));
    const lastData = [...cm.keys()].sort().pop() || p.from;
    const xs = Array.from({ length: n }, (_, i) => i);
    let c = 0, q = 0;
    const curV = xs.map(i => { const d = addDays(p.from, i); if (d > lastData || d > state.today) return null; c += cm.get(d) || 0; return c; });
    const prevV = xs.map(i => { const d = addDays(pStart, i); if (d > pEnd) return null; q += pm.get(d) || 0; return q; });
    const lines = [];
    if (prevDaily.length) lines.push({ label: p.mode === 'month' ? `${p.prevLabel} 累计` : '上一周期累计', color: 'var(--other)', values: prevV });
    lines.push({ label: '本期累计', color: 'var(--s1)', values: curV });
    if (fc && isCurrentMonth()) {
      // 从最后一个有数据的日子线性延伸到本月最后一天，终点与 KPI 的“预计本月费用”一致
      const lastI = curV.reduce((m, v, i) => (v != null ? i : m), -1);
      const endI = curDays.length - 1;
      const fv = xs.map(i => (i < lastI || i > endI ? null : i === lastI ? curV[lastI] : curV[lastI] + (fc.value - curV[lastI]) * (i - lastI) / Math.max(1, endI - lastI)));
      if (lastI >= 0 && endI > lastI) lines.push({ label: '月末预测', color: 'var(--s1)', values: fv, dashed: true, endLabel: `预测 ${moneyShort(fc.value)}` });
    }
    lg.innerHTML = legendHtml(lines.map(l => ({ label: l.label, color: l.color, line: true })));
    lineChart(el, { xs, lines, height: 340, xLabel: i => (p.mode === 'month' ? `${i + 1}日` : addDays(p.from, i).slice(5)), tipTitle: i => (p.mode === 'month' ? `第 ${i + 1} 天（${addDays(p.from, i).slice(5)}）` : `第 ${i + 1} 天`), aria: '累计费用对比' });
    return;
  }
  const dim = DIMS[ui.trendBy];
  const src = ui.trendMode === 'monthly' ? filterLines(state.history) : daily;
  const xs = ui.trendMode === 'monthly' ? uniq(src.map(l => l.date)).sort() : days;
  const ranked = [...aggregate(src, dim.of).values()].filter(a => a.cost > 0).sort((a, b) => b.cost - a.cost).map(a => a.key);
  // 已分配颜色的实体保持原色（跨视图一致）；月度视图中空闲的色位依次分给历史费用较高的实体，最多 8 色
  const colorOf = new Map(ranked.filter(id => dim.color(id) !== 'var(--other)').map(id => [id, dim.color(id)]));
  if (ui.trendMode === 'monthly') {
    const free = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--s${i})`).filter(c => ![...colorOf.values()].includes(c));
    for (const id of ranked) { if (!free.length) break; if (!colorOf.has(id)) colorOf.set(id, free.shift()); }
  }
  const colored = ranked.filter(id => colorOf.has(id));
  const others = ranked.filter(id => !colorOf.has(id));
  const series = colored.map(id => ({ id, label: dim.short(id), color: colorOf.get(id) }));
  if (others.length) series.push({ id: '__other', label: others.length === 1 ? dim.short(others[0]) : `其他 ${others.length} 项`, color: 'var(--other)' });
  const cell = new Map();
  for (const l of src) { const id = dim.of(l); const k = l.date + '|' + (colored.includes(id) ? id : '__other'); cell.set(k, (cell.get(k) || 0) + metricVal(l)); }
  lg.innerHTML = series.length > 1 ? legendHtml(series) : '';
  const monthly = ui.trendMode === 'monthly';
  columnChart(el, {
    xs, series, cell: (x, id) => cell.get(x + "|" + id) || 0, height: 340, avg: monthly ? null : avgDay,
    xLabel: x => (monthly ? x.slice(2) : x.slice(5)), tipTitle: x => (monthly ? `${x} 账期` : `${x}（周${WEEK[weekday(x)]}）`), weekend: !monthly,
    aria: monthly ? '月度费用趋势' : '每日费用趋势', empty: monthly ? '暂无历史账期数据（可在系统管理中调大回溯月数）' : '暂无按日账单数据',
    onX: monthly ? x => app.setPeriod({ mode: 'month', cycle: x }) : x => app.openDay(x),
    clickHint: monthly ? '点击切换到该账期' : '点击查看当日明细',
  });
}
