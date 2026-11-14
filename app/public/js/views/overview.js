/* 成本概览：本期费用、预算与预测、趋势、关键发现、Top Key / 模型、构成、归因、治理摘要 */
import {
  $, esc, state, ui, app, money, moneyShort, compact, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, DIMS, keyShort, wsName,
  filterLines, aggregate, aggAll, sortedAggs, totalTokens, topModels, deltaPill, tipRows, icon, help, segCtl, forecastOf, budgetOf,
  budgetBar, activeFilterCount, channelLabel, addDays, daysBetween, WEEK, weekday, isCurrentMonth, lastDayOf as lastDayOfCycle,
  multiCloud, hasTags, PROVIDERS, usageFiltered, usageAgg, callsOn, NO_WS, NO_CC, NO_OWNER, groupHash, dimVal, dimName, toneOf,
} from '../core.js';
import { sparkline, columnChart, lineChart, rankList, divergingList, segbar, legendList, topParts, legendHtml, bindActivate, bindLegend } from '../charts.js';
import { computeInsights, cacheSavings } from '../insights.js';
import { TOKS, tType } from '../stats.js';
import { computeFindings, SEVERITY } from './governance.js';
import { setupVisible, setupCard, noBillData, freshenStatus } from '../setup.js';

/** 可选的分组维度：云厂商（多云时）、成本中心（设置了标签时） */
function dimOpts(base) {
  const o = { ...base };
  if (multiCloud()) o.provider = '云厂商';
  if (hasTags()) o.cc = '成本中心';
  return o;
}
function fixSeg(key, opts) { if (!opts[ui[key]]) ui[key] = Object.keys(opts)[0]; return opts; }

export function render(v) {
  // 初始设置清单（管理员、非演示、未完成）：系统中还没有任何账单时代替整页（不显示一整页 ¥0.00），否则显示在概览上方
  const setup = setupVisible();
  if (setup) freshenStatus(1500); // 刚在系统管理中完成某一步后回到首页：立即刷新状态，清单随之勾选
  if (setup && noBillData()) { v.innerHTML = setupCard(true); return; }
  const p = state.data.period;
  const trendOpts = fixSeg('trendBy', dimOpts({ key: 'Key', model: '模型', ws: '业务空间' }));
  const compOpts = fixSeg('compBy', dimOpts({ ws: '业务空间', dir: 'Token 类型', channel: '渠道' }));
  const varOpts = fixSeg('varBy', dimOpts({ key: 'Key', model: '模型', ws: '空间' }));
  const tokOpts = fixSeg('tokBy', { type: '类型', model: '模型', key: 'Key' });
  if (!['daily', 'monthly'].includes(ui.tokMode)) ui.tokMode = 'daily';
  const lines = filterLines(), prevLines = filterLines(state.prev), daily = filterLines(state.daily);
  const cur = aggAll(lines), prev = aggAll(prevLines);
  const days = uniq(daily.map(l => l.date)).sort();
  const dayCost = new Map(); daily.forEach(l => dayCost.set(l.date, (dayCost.get(l.date) || 0) + metricVal(l)));
  // 本期还没有任何账单（如尚未同步、新账期刚开始）：金额类指标显示“—”与“尚无账单数据”，不显示 ¥0.00 与“按 N 个完整日推算”的预测
  const noBills = !state.lines.length;
  const fc = state.daily.length ? forecastOf(daily) : null;
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
  // 仅当筛选后的账单全部来自有调用次数数据源的云厂商时，Token 卡片附带请求数与单次平均（否则会低估单次平均，不展示以免误导）
  const uf = usageFiltered(), ua = uf && lines.length && lines.every(l => callsOn(l.provider)) ? usageAgg(uf, () => "a").get("a") : null;
  // KPI 迷你趋势：按日计算各指标（与卡片口径一致），比率类指标按最小 ~ 最大值缩放只看走势
  const ds = dailySeries(daily, days);
  const spk = (tone, vals, title, fmt, opts = {}) => (days.length > 1 ? `<div class="kspark" data-tip="${esc(sparkTip(title, days, vals, fmt))}">${sparkline(vals, `var(--t-${tone})`, { height: 36, ...opts })}</div>` : '');
  const cum = cumulative(days, dayCost, p.from);
  const monthDays = p.mode === 'month' ? daysBetween(p.from, lastDayOfCycle(p.cycle)) : cum.length;
  const cnt = v => `${v} 个`, pctF = v => (v * 100).toFixed(1) + '%';
  const ms = n => (noBills ? '—' : moneyShort(n)), NB = '尚无账单数据';

  v.innerHTML = `${setup ? setupCard(false) : ''}
  <div class="kpis">
    <section class="kpi hero" aria-label="本期费用">
      <div class="kpi-h"><span class="kpi-ico">${icon('wallet')}</span><span>${p.mode === 'month' ? `${esc(p.cycle)} 账期费用` : '所选周期费用'} · ${METRICS[ui.f.metric]}</span></div>
      ${noBills ? `<div class="value">—</div>
      <div class="trend"><span class="cmp">${NB}${prev.cost ? ` · ${esc(state.compareLabel)} ${money(prev.cost)}` : ''}</span></div>`
      : `<div class="value" title="${esc(money(cur.cost, 4))}">${money(cur.cost)}</div>
      <div class="trend">${deltaPill(cur.cost, prev.cost)}<span class="cmp">${esc(state.compareLabel)} ${money(prev.cost)}</span></div>`}
      <div class="stats">
        <div title="按官网目录价计算"><span>原价</span><b>${ms(cur.gross)}</b></div>
        <div title="折扣与促销优惠（账单“优惠金额”）"><span>折扣</span><b>${ms(cur.gross - cur.after)}</b></div>
        <div title="优惠券 / 代金券 / 储值卡抵扣：按云厂商实际抵扣的日期计入，常集中在某几天"><span>优惠券抵扣</span><b>${ms(cur.after - cur.pretax)}</b></div>
        ${ui.f.metric === 'pretax' ? `<div title="原价 − 折扣，未扣除优惠券"><span>优惠后（未扣券）</span><b>${ms(cur.after)}</b></div>` : `<div title="与费用中心账单一致"><span>应付金额</span><b>${ms(cur.pretax)}</b></div>`}
        <div title="1 − 应付 ÷ 原价"><span>综合折扣</span><b>${cur.gross ? (disc * 100).toFixed(1) + '%' : '—'}</b></div>
        <div><span>日均</span><b>${ms(avgDay)}</b></div>
      </div>
      ${budget ? budgetBar(sum(lines, l => l.pretax), budget, fc ? forecastOf(daily, l => l.pretax).value : null) : ''}
      <div class="spark" data-tip="${esc(sparkTip('每日费用', days, days.map(x => dayCost.get(x) || 0), v => money(v)))}">${sparkline(days.map(x => dayCost.get(x) || 0), 'var(--accent)')}</div>
    </section>
    ${fc ? kpi('forecast', '预计本月费用', moneyShort(fc.value), deltaPill(fc.value, prevFullCost), '较上月全月', `按 ${fc.fullDays} 个完整日的日均推算`, '', '', '',
        cum.length ? `<div class="kspark" data-tip="${esc(tipRows('本月累计与预测', [['已累计', money(cum.at(-1))], ['月末预测', money(fc.value)], ['剩余天数', `${Math.max(0, monthDays - cum.length)} 天`]]))}">${sparkline(cum, 'var(--t-violet)', { height: 36, proj: { n: monthDays, end: fc.value } })}</div>` : '')
      : kpi('calendar', '日均费用', noBills ? '—' : money(avgDay), '', '', noBills ? NB : `${calDays} 天 · 峰值 ${peakText(days, dayCost)}`, '', '', '', spk('violet', ds.map(d => d.cost), '每日费用', v => money(v)))}
    ${noBills ? kpi('key', '活跃 API Key', `—<small>/ ${state.apiKeys.size}</small>`, '', '', NB, '', '#/keys', '查看 Key 分析')
      : kpi('key', '活跃 API Key', `${active}<small>/ ${state.apiKeys.size}</small>`, deltaPill(active, pActive, { neutral: true }), state.compareLabel, top1 ? `最高：${keyShort(top1.key)} 占 ${pct(top1.cost, cur.cost)}` : '—', '', '#/keys', '查看 Key 分析', spk('teal', ds.map(d => d.keys), '每日有消费的 API Key', cnt))}
    ${kpi('token', 'Token 总量', noTok ? '—' : compact(tokens), noTok ? '' : deltaPill(tokens, pTokens, { neutral: true }), noTok ? '' : state.compareLabel, noBills ? NB : noTok ? '当前数据无用量' : ua && ua.requests ? `请求 ${compact(ua.requests)} 次 · 单次 ${intFmt(ua.tokens / ua.requests)} Token` : `输入 ${compact(cur.tIn)} · 输出 ${compact(cur.tOut)}`, intFmt(tokens), '#/models', '查看模型 Token 结构', noTok ? '' : spk('sky', ds.map(d => d.tok), '每日 Token', compact))}
    ${kpi('unit', '每百万 Token 成本', perM == null ? '—' : money(perM), perM == null ? '' : deltaPill(perM, pPerM), perM == null ? '' : state.compareLabel, '费用 ÷ 总 Token × 10⁶', '', '', '', perM == null ? '' : spk('amber', ds.map(d => d.perM), '每日每百万 Token 成本', v => money(v), { zero: false }))}
    ${kpi('cache', '缓存命中率', hit == null ? '—' : (hit * 100).toFixed(1) + '%', hit == null ? '' : deltaPill(hit, pHit, { pp: true, goodWhenUp: true }), hit == null ? '' : state.compareLabel, saved > 0.01 ? `估算节省 ${moneyShort(saved)}` : hit == null ? '—' : `命中 ${compact(cur.tCache)} Token`, '', '', '', hit == null ? '' : spk('indigo', ds.map(d => d.hit), '每日缓存命中率', pctF, { zero: false }))}
    ${kpi('model', '使用模型', noBills ? '—' : String([...byModel.values()].filter(a => a.cost > 0).length), '', '', noBills ? NB : byModel.size ? `主力：${sortedAggs(byModel)[0].key}` : '—', '', '#/models', '查看模型分析', spk('fuchsia', ds.map(d => d.models), '每日使用的模型', cnt))}
  </div>

  <div class="bi">
    <section class="panel c6">
      <div class="panel-h"><h3>费用趋势</h3>${help('每日：按日账单堆叠；累计：本期与上期按天累计对比（当月含月末预测）；月度：近 12 个账期的账期账单（取决于同步回溯月数）。点击图例按该项筛选全部页面；点击柱查看当日明细，点击柱中的某一段只看该项。')}
        <div class="actions">${ui.trendMode !== 'cum' ? segCtl('trendBy', trendOpts) : ''}${segCtl('trendMode', { daily: '每日', cum: '累计', monthly: '月度' })}</div></div>
      <div class="legend" id="trLegend"></div><div class="chart" id="trChart"></div>
    </section>
    <section class="panel c6">
      <div class="panel-h"><h3>Token 趋势</h3>${help('每日：按日账单的 Token 用量堆叠；月度：近 12 个账期。可按 Token 类型（输入 / 缓存命中 / 输出 / 向量）、模型或 API Key 拆分；点击图例按该项筛选全部页面，点击柱查看当日明细。')}
        <div class="actions">${segCtl('tokBy', tokOpts)}${segCtl('tokMode', { daily: '每日', monthly: '月度' })}</div></div>
      <div class="legend" id="tkLegend"></div><div class="chart" id="tkChart"></div>
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
      <div class="panel-h"><h3>费用构成</h3>${help('点击图例项按该项筛选全部页面（可用浏览器“后退”撤销）。')}<div class="actions">${segCtl('compBy', compOpts)}</div></div>
      <div id="comp"></div>
    </section>
    <section class="panel c4">
      <div class="panel-h"><h3>变动归因</h3>${help(`本期与上期（${state.compareRange || ''}）相比，各维度费用增减额，按绝对值排序。点击进入对应的 Key / 模型 / 业务空间详情。`)}<div class="actions">${segCtl('varBy', varOpts)}</div></div>
      <div id="variance"></div>
    </section>
    <section class="panel c4">
      <div class="panel-h"><h3>Key 治理</h3><span class="sub">风险与合规检查</span><div class="actions"><button class="btn ghost sm" data-go="#/governance">查看全部</button></div></div>
      <div id="gov"></div>
    </section>

    <section class="panel c12 ins-panel">
      <div class="panel-h"><h3>关键发现</h3>${help('基于当前筛选数据自动生成：费用变化与驱动因素、预算与预测、集中度、异常日、缓存效率、治理风险等。')}</div>
      <ul class="insights" id="insights"></ul>
    </section>
  </div>`;

  drawTrend(daily, days, avgDay, fc);
  drawTokens(daily, days);

  // 关键发现
  const ins = computeInsights();
  $('#insights').innerHTML = ins.length ? ins.map(x => `<li class="ins ${x.level}"><span class="ins-ico">${icon(x.icon)}</span><div><div class="ins-t">${esc(x.title)}</div><div class="ins-d">${x.html}</div>${x.go ? `<button class="link" data-go="${esc(x.go)}">${esc(x.goLabel || '查看')} →</button>` : ''}${x.day ? `<button class="link" data-day="${esc(x.day)}">${esc(x.dayLabel || '查看当日明细')} →</button>` : ''}${x.model ? `<button class="link" data-model="${esc(x.model)}">${esc(x.modelLabel || '查看模型')} →</button>` : ''}</div></li>`).join('') : '<li class="nodata">暂无需要关注的发现</li>';

  // 排行只显示前 10 项：只为前面的项生成提示内容（上千个 Key 时逐个生成会明显拖慢页面）
  rankList($('#rkKeys'), sortedAggs(byKey).map((a, i) => ({
    id: a.key, label: keyShort(a.key), sub: a.key === NONE_KEY ? '' : [multiCloud() ? PROVIDERS[state.apiKeys.get(a.key)?.provider || 'aliyun'] : '', state.apiKeys.get(a.key)?.costCenter || wsName(state.apiKeys.get(a.key)?.wsKey || [...a.wss][0] || '')].filter(Boolean).join(' · '),
    value: a.cost, prev: pByKey.get(a.key)?.cost ?? 0, color: DIMS.key.color(a.key),
    tip: i >= 12 ? '' : tipRows(DIMS.key.short(a.key), [['费用', money(a.cost)], ['占比', pct(a.cost, cur.cost)], ['上期', money(pByKey.get(a.key)?.cost || 0)], ['Token', compact(totalTokens(a))], ['主要模型', topModels(a, 2).join('、')]]),
  })), { total: cur.cost, showDelta: true, onClick: it => (it.id === NONE_KEY ? app.setFilter({ key: NONE_KEY }, '#/detail') : app.go(`#/key/${encodeURIComponent(it.id)}`)) });
  rankList($('#rkModels'), sortedAggs(byModel).map((a, i) => ({
    id: a.key, label: a.key, sub: `${a.keys.size} 个 Key`, value: a.cost, prev: pByModel.get(a.key)?.cost ?? 0, color: DIMS.model.color(a.key),
    tip: i >= 12 ? '' : tipRows(a.key, [['费用', money(a.cost)], ['占比', pct(a.cost, cur.cost)], ['上期', money(pByModel.get(a.key)?.cost || 0)], ['Token', compact(totalTokens(a))], ['每百万 Token', totalTokens(a) ? money(a.cost / totalTokens(a) * 1e6) : '—']]),
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
  comp.innerHTML = segbar(parts) + legendList(parts, sum(parts, x => x.value), ui.compBy !== 'dir', '点击按此筛选');
  if (ui.compBy !== 'dir') bindActivate(comp, '.li.clickable', li => app.setFilter(ui.compBy === 'ws' ? { ws: li.dataset.pid || NO_WS } : ui.compBy === 'provider' ? { provider: li.dataset.pid } : ui.compBy === 'cc' ? { cc: li.dataset.pid || NO_CC } : { channel: li.dataset.pid }));

  // 归因：Key → Key 详情；模型 → 模型详情（沿用筛选）；业务空间 / 成本中心 / 云厂商 → 分组详情
  const dim = DIMS[ui.varBy], vOf = dimVal[ui.varBy] || dim.of;
  const vc = aggregate(lines, vOf), vp = aggregate(prevLines, vOf);
  divergingList($('#variance'), uniq([...vc.keys(), ...vp.keys()]).map(id => {
    const c = vc.get(id)?.cost || 0, pv = vp.get(id)?.cost || 0;
    return { id, label: dimName(ui.varBy, id), cur: c, prev: pv, delta: c - pv };
  }), { limit: 6, onClick: it => (ui.varBy === 'key' ? (it.id !== NONE_KEY && app.go(`#/key/${encodeURIComponent(it.id)}`)) : ui.varBy === 'model' ? app.openModel(it.id) : app.go(groupHash(ui.varBy, it.id))) });

  // 治理摘要
  const f = computeFindings();
  const bySev = s => f.filter(x => x.severity === s).length;
  const rules = Object.values(f.reduce((m, x) => { (m[x.rule] ||= { rule: x.rule, name: x.ruleName, severity: x.severity, n: 0 }).n++; return m; }, {})).sort((a, c) => SEVERITY[a.severity].order - SEVERITY[c.severity].order || c.n - a.n);
  $('#gov').innerHTML = `<div class="gov-sum">${['high', 'medium', 'low'].map(s => `<div class="gov-c ${s} ${bySev(s) ? "" : "zero"}"><b>${bySev(s)}</b><span>${SEVERITY[s].label}</span></div>`).join('')}</div>
    ${rules.length ? `<ul class="gov-list">${rules.slice(0, 6).map(r => `<li><span class="pill ${SEVERITY[r.severity].cls}">${SEVERITY[r.severity].label}</span><span>${esc(r.name)}</span><b>${r.n}</b></li>`).join('')}</ul>` : '<div class="nodata">未发现治理问题</div>'}`;
}

/** KPI 卡片；go 不为空时整张卡片可点击跳转（沿用当前筛选） */
function kpi(ic, label, value, delta, cmp, meta, title, go = '', goTip = '', spark = '') {
  return `<section class="kpi ${go ? 'kpi-go' : ''}" data-tone="${toneOf(ic)}" ${go ? `data-go="${esc(go)}" role="link" tabindex="0" title="${esc(goTip)}"` : ''}><div class="kpi-h"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span>${go ? `<span class="kpi-arrow" aria-hidden="true">${icon('chevR')}</span>` : ''}</div>
    <div class="value" ${title ? `title="${esc(title)}"` : ''}>${value}</div>
    <div class="trend">${delta || ''}${delta && cmp ? `<span class="cmp">${esc(cmp)}</span>` : ''}</div>${spark}
    <div class="meta" title="${esc(meta)}">${esc(meta)}</div></section>`;
}
/** 按日指标：费用、有消费的 Key 数、模型数、Token、每百万 Token 成本、缓存命中率 */
function dailySeries(daily, days) {
  const m = new Map(days.map(d => [d, { cost: 0, keys: new Map(), models: new Map(), tok: 0, tIn: 0, tCache: 0 }]));
  for (const l of daily) {
    const o = m.get(l.date); if (!o) continue;
    const c = metricVal(l); o.cost += c;
    const k = l.apiKeyId || NONE_KEY;
    if (k !== NONE_KEY) o.keys.set(k, (o.keys.get(k) || 0) + c);
    o.models.set(l.model, (o.models.get(l.model) || 0) + c);
    if (l.tokens != null) { o.tok += l.tokens; if (l.ioi.dir === 'in') { o.tIn += l.tokens; if (l.ioi.cache === 'hit') o.tCache += l.tokens; } }
  }
  const pos = mp => [...mp.values()].filter(v => v > 0).length;
  return days.map(d => { const o = m.get(d); return { cost: o.cost, keys: pos(o.keys), models: pos(o.models), tok: o.tok, perM: o.tok ? o.cost / o.tok * 1e6 : null, hit: o.tIn ? o.tCache / o.tIn : null }; });
}
/** 本期累计费用（按自然日，无账单的日期沿用前一日累计值） */
function cumulative(days, dayCost, from) {
  if (!days.length) return [];
  const out = []; let acc = 0;
  for (let d = from; d <= days.at(-1); d = addDays(d, 1)) { acc += dayCost.get(d) || 0; out.push(acc); }
  return out;
}
/** 迷你趋势提示：最高 / 最低 / 最近 */
function sparkTip(title, days, vals, fmt) {
  const pts = days.map((d, i) => [d, vals[i]]).filter(x => x[1] != null && Number.isFinite(x[1]));
  if (!pts.length) return tipRows(title, [['暂无数据', '']]);
  const hi = pts.reduce((a, b) => (b[1] > a[1] ? b : a)), lo = pts.reduce((a, b) => (b[1] < a[1] ? b : a)), last = pts.at(-1);
  return tipRows(title, [['最高', `${fmt(hi[1])}（${hi[0].slice(5)}）`], ['最低', `${fmt(lo[1])}（${lo[0].slice(5)}）`], ['最近', `${fmt(last[1])}（${last[0].slice(5)}）`]]);
}
function peakText(days, dayCost) {
  if (!days.length) return '—';
  const d = days.reduce((a, c) => ((dayCost.get(c) || 0) > (dayCost.get(a) || 0) ? c : a), days[0]);
  return `${d.slice(5)} ${moneyShort(dayCost.get(d) || 0)}`;
}

/** 系列 ID → 全局筛选取值（空的业务空间 / 成本中心 / 负责人转换为“未归属”哨兵值） */
const filterVal = (by, id) => (by === 'ws' ? id || NO_WS : by === 'cc' ? id || NO_CC : by === 'owner' ? id || NO_OWNER : id);
/**
 * 系列配色：已分配颜色的实体保持原色（跨视图一致）；空闲的色位依次分给当前范围内排名靠前的实体，最多 8 色，其余并为“其他”。
 * 按日视图同样处理：筛选到全局前 7 名以外的实体时，不能全部并成一个灰色“其他”
 */
function colorSeries(dim, ranked) {
  const colorOf = new Map(ranked.filter(id => dim.color(id) !== 'var(--other)').map(id => [id, dim.color(id)]));
  const free = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--s${i})`).filter(c => ![...colorOf.values()].includes(c));
  for (const id of ranked) { if (!free.length || colorOf.size >= 8) break; if (!colorOf.has(id)) colorOf.set(id, free.shift()); }
  const colored = ranked.filter(id => colorOf.has(id));
  const others = ranked.filter(id => !colorOf.has(id));
  const series = colored.map(id => ({ id, label: dim.short(id), color: colorOf.get(id) }));
  if (others.length) series.push({ id: '__other', label: others.length === 1 ? dim.short(others[0]) : `其他 ${others.length} 项`, color: 'var(--other)' });
  return { series, colored };
}

/** Token 趋势：每日（按日账单）/ 月度（近 12 个账期），按 Token 类型、模型或 API Key 堆叠 */
function drawTokens(daily, days) {
  const el = $('#tkChart'), lg = $('#tkLegend');
  if (!el) return;
  const monthly = ui.tokMode === 'monthly', by = ui.tokBy;
  const src = (monthly ? filterLines(state.history) : daily).filter(l => l.tokens > 0);
  const xs = monthly ? uniq(src.map(l => l.date)).sort() : days;
  let series, idOf, clickable = false;
  if (by === 'type') {
    idOf = tType;
    const present = new Set(src.map(tType));
    series = TOKS.filter(([t]) => present.has(t)).map(([id, label, color]) => ({ id, label, color }));
  } else {
    const dim = DIMS[by];
    idOf = dim.of;
    const tok = new Map(); for (const l of src) { const k = dim.of(l); tok.set(k, (tok.get(k) || 0) + l.tokens); }
    const ranked = [...tok.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const cs = colorSeries(dim, ranked);
    const set = new Set(cs.colored);
    const raw = idOf; idOf = l => (set.has(raw(l)) ? raw(l) : '__other');
    series = cs.series; clickable = true;
  }
  const cell = new Map(); let total = 0;
  for (const l of src) { const k = l.date + '|' + idOf(l); cell.set(k, (cell.get(k) || 0) + l.tokens); total += l.tokens; }
  if (clickable) { lg.innerHTML = series.length > 1 ? legendHtml(series.map(s => ({ ...s, id: s.id === '__other' ? null : s.id })), '点击按此筛选') : ''; bindLegend(lg, id => app.setFilter({ [by]: filterVal(by, id) })); }
  else lg.innerHTML = series.length > 1 ? legendHtml(series) : '';
  const p = state.data.period, elapsed = Math.max(1, p.elapsedDays || xs.length);
  columnChart(el, {
    xs, series, cell: (x, id) => cell.get(x + '|' + id) || 0, height: 300, fmt: compact, avg: monthly || !total ? null : total / elapsed,
    xLabel: x => (monthly ? x.slice(2) : x.slice(5)), tipTitle: x => (monthly ? `${x} 账期` : `${x}（周${WEEK[weekday(x)]}）`), weekend: !monthly,
    aria: monthly ? '月度 Token 趋势' : '每日 Token 趋势', empty: monthly ? '暂无历史账期的 Token 用量' : '本期无 Token 用量（可能为按次计费的模型）',
    onX: monthly ? x => app.setPeriod({ mode: 'month', cycle: x }) : x => app.openDay(x),
    clickHint: monthly ? '点击切换到该账期' : '点击查看当日明细',
  });
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
    lineChart(el, { xs, lines, height: 300, xLabel: i => (p.mode === 'month' ? `${i + 1}日` : addDays(p.from, i).slice(5)), tipTitle: i => (p.mode === 'month' ? `第 ${i + 1} 天（${addDays(p.from, i).slice(5)}）` : `第 ${i + 1} 天`), aria: '累计费用对比' });
    return;
  }
  const dim = DIMS[ui.trendBy], by = ui.trendBy;
  const src = ui.trendMode === 'monthly' ? filterLines(state.history) : daily;
  const xs = ui.trendMode === 'monthly' ? uniq(src.map(l => l.date)).sort() : days;
  const ranked = [...aggregate(src, dim.of).values()].filter(a => a.cost > 0).sort((a, b) => b.cost - a.cost).map(a => a.key);
  const fval = id => filterVal(by, id);
  const { series, colored } = colorSeries(dim, ranked);
  const cell = new Map(), dayAmt = new Map();
  for (const l of src) {
    const id = dim.of(l); const k = l.date + '|' + (colored.includes(id) ? id : '__other'); cell.set(k, (cell.get(k) || 0) + metricVal(l));
    const a = dayAmt.get(l.date) || dayAmt.set(l.date, { gross: 0, pretax: 0 }).get(l.date); a.gross += l.gross || 0; a.pretax += l.pretax || 0;
  }
  /** 当日原价与优惠：优惠券、折扣按云厂商实际抵扣的日期计入（常集中在某几天），不按天均摊 */
  const discNote = x => { const a = dayAmt.get(x); return a && a.gross - a.pretax >= 0.005 ? ` · 原价 ${money(a.gross)}，优惠与券 ${money(a.gross - a.pretax)}` : ''; };
  // 图例可点击：按该项筛选全部页面（单一系列时无图例）
  lg.innerHTML = series.length > 1 ? legendHtml(series.map(s => ({ ...s, id: s.id === '__other' ? null : s.id })), '点击按此筛选') : '';
  bindLegend(lg, id => app.setFilter({ [by]: fval(id) }));
  const monthly = ui.trendMode === 'monthly';
  columnChart(el, {
    xs, series, cell: (x, id) => cell.get(x + "|" + id) || 0, height: 300, avg: monthly ? null : avgDay,
    xLabel: x => (monthly ? x.slice(2) : x.slice(5)), tipTitle: x => (monthly ? `${x} 账期` : `${x}（周${WEEK[weekday(x)]}）`) + discNote(x), weekend: !monthly,
    aria: monthly ? '月度费用趋势' : '每日费用趋势', empty: monthly ? '暂无历史账期数据（可在系统管理中调大回溯月数）' : '暂无按日账单数据',
    onX: monthly ? x => app.setPeriod({ mode: 'month', cycle: x }) : x => app.openDay(x),
    // 每日：点击柱段 → 当日明细（限定该项）；月度：点击柱段 → 切换到该账期并按该项筛选
    onSeg: monthly ? (x, id) => { app.setPeriod({ mode: 'month', cycle: x }, { url: false }); app.setFilter({ [by]: fval(id) }); } : (x, id) => app.openDay(x, { global: true, [by]: dimVal[by] ? fval(id) : id }),
    clickHint: monthly ? '点击切换到该账期' : '点击查看当日明细',
    segHint: monthly ? '点击柱段切换账期并按该项筛选' : '点击柱段只看该项',
  });
}
