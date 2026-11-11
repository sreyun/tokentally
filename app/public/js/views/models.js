/* 模型分析：模型费用、Token 结构、单位成本、计费维度、Key × 模型矩阵、模型详情抽屉 */
import {
  $, esc, state, ui, app, money, moneyShort, compact, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, DIMS, keyShort,
  filterLines, aggregate, aggAll, sortedAggs, totalTokens, unitsText, deltaPill, tipRows, icon, help, segCtl, ioInfo, num, periodTag, WEEK, weekday, copyBtn, PROVIDERS, provTag, multiCloud, usageFiltered, usageAgg, normModel, REQ_SRC,
  scopeLines, scopeUsage, scopeLabel, scopeFilter, dimVal, dimName, groupHash, NO_WS, callsOn, hasTags, perCall, perCallCovered, coveredCost, failRateOf, scopeColors,
} from '../core.js';
import { tokenStatsHtml, drawDailyTokens, drawDailyRequests, periodDays, reqHelp } from '../stats.js';
import { columnChart, rankList, stackRank, segbar, legendHtml, bindLegend } from '../charts.js';
import { table, dataBar } from '../table.js';

/** 计费项明细的分组键（模型 × 计费项 × 单价 × 用量单位 × 单价单位）与按组汇总的用量（一次遍历） */
export const itemKey = l => `${l.model}\u0001${l.io}\u0001${l.listPrice}\u0001${l.usageUnit}\u0001${l.listPriceUnit}`;
export function itemUsage(lines) {
  const m = new Map();
  for (const l of lines) { const k = itemKey(l); m.set(k, (m.get(k) || 0) + (l.usage || 0)); }
  return m;
}
const TOKEN_PARTS = [{ label: '输入（非缓存）', color: 'var(--s1)' }, { label: '缓存命中', color: 'var(--s3)' }, { label: '输出', color: 'var(--s2)' }, { label: '向量', color: 'var(--s7)' }];

/** 计费维度：Token 类型、时段、输入缓存、思考模式、上下文档位 */
export function billDimsHtml(lines) {
  const block = (title, keyFn, meta) => {
    const m = aggregate(lines, keyFn);
    const ps = Object.keys(meta).filter(k => m.has(k) && m.get(k).cost > 0).map(k => ({ label: meta[k][0], value: m.get(k).cost, color: meta[k][1] }));
    if (!ps.length) return '';
    const tot = sum(ps, p => p.value);
    return `<div class="dim-block"><div class="dim-h"><b>${title}</b><span>${ps.map(p => `${esc(p.label)} ${pct(p.value, tot)}`).join(' · ')}</span></div>${segbar(ps, { thin: true })}</div>`;
  };
  const ctxs = uniq(lines.map(l => l.ioi.ctx).filter(Boolean)).sort();
  const html = block('Token 类型', l => (l.ioi.dir === 'in' ? (l.ioi.cache === 'hit' ? 'hit' : l.ioi.cache === 'create' ? 'create' : 'in') : l.ioi.dir), { in: ['输入', 'var(--s1)'], hit: ['缓存命中', 'var(--s3)'], create: ['缓存创建', 'var(--s4)'], out: ['输出', 'var(--s2)'], emb: ['向量', 'var(--s7)'], other: ['其他', 'var(--other)'] })
    + block('计费时段', l => l.ioi.time || 'std', { peak: ['峰时', 'var(--s2)'], offpeak: ['闲时', 'var(--s1)'], std: ['不分时段', 'var(--other)'] })
    + block('思考模式', l => (l.ioi.thinking ? 'think' : 'normal'), { normal: ['非思考', 'var(--s1)'], think: ['思考', 'var(--s7)'] })
    + (ctxs.length ? block('上下文档位', l => l.ioi.ctx || 'std', Object.fromEntries([['std', ['标准', 'var(--other)']], ...ctxs.map((c, i) => [c, [c, `var(--s${(i % 7) + 1})`]])])) : '');
  return (html || '<div class="nodata">暂无数据</div>') + '<div class="panel-foot">计费项源自账单实例ID，例如 <span class="mono">input_token_cache_peak</span> = 输入 · 缓存命中 · 峰时。</div>';
}

function modelRows(lines, prevLines, daily) {
  const by = aggregate(lines, l => l.model), pby = aggregate(prevLines, l => l.model);
  const ub = usageAgg(usageFiltered() || [], u => normModel(u.model));
  const calDays = periodDays(state.data.period);
  const provs = new Map();
  for (const l of lines) { if (!provs.has(l.model)) provs.set(l.model, new Set()); provs.get(l.model).add(l.provider); }
  const total = sum([...by.values()], a => a.cost);
  // 使用天数：一次遍历按模型收集有费用的日期（避免每个模型都扫描一遍全部日账单）
  const daySets = new Map(), dailyOf = new Map();
  for (const l of daily) {
    if (metricVal(l) > 0) { let s = daySets.get(l.model); if (!s) daySets.set(l.model, s = new Set()); s.add(l.date); }
    const nm = normModel(l.model); let arr = dailyOf.get(nm); if (!arr) dailyOf.set(nm, arr = []); arr.push(l);
  }
  return [...by.values()].map(a => {
    const t = totalTokens(a);
    // 与模型详情抽屉一致：该模型的费用全部来自有调用次数数据源的云厂商时才显示请求数与单次指标
    // （同名模型多云在售、阿里云未接入调用次数时，请求数只覆盖部分费用）；单次费用只用有调用数据的日期的费用
    const callsOk = [...(provs.get(a.key) || [])].every(callsOn);
    const um = callsOk ? ub.get(normModel(a.key)) : null;
    const pc = perCallCovered(um, dailyOf.get(normModel(a.key)));
    return {
      model: a.key, cost: a.cost, prev: pby.get(a.key)?.cost || 0, share: total ? a.cost / total : 0, gross: a.gross, tIn: a.tIn, tCache: a.tCache, tOut: a.tOut, tEmb: a.tEmb, tokens: t,
      hit: a.tIn ? a.tCache / a.tIn : null, ioRatio: a.tIn ? a.tOut / a.tIn : null, perM: t ? a.cost / t * 1e6 : null, keys: a.keys.size, keyList: [...a.keys].map(k => keyShort(k)).join('、'), providers: [...(provs.get(a.key) || [])],
      requests: um ? um.requests : null, failRate: failRateOf(um), tokPer: pc?.tokPer ?? null, costPer: pc?.costPer ?? null, uTokens: um ? um.tokens : 0,
      dayTok: t / calDays,
      wss: a.wss.size, items: a.items.size, units: unitsText(a), days: daySets.get(a.key)?.size || 0,
    };
  });
}

export function render(v) {
  const lines = filterLines(), prevLines = filterLines(state.prev), daily = filterLines(state.daily);
  const rows = modelRows(lines, prevLines, daily);
  const all = aggAll(lines), tok = totalTokens(all);
  const priciest = rows.filter(r => r.perM != null && r.tokens > 1e5).sort((a, b) => b.perM - a.perM)[0];
  const hasUsage = rows.some(r => r.requests != null);
  const reqN = sum(rows, r => r.requests || 0), reqTok = sum(rows, r => (r.requests ? r.uTokens : 0));
  v.innerHTML = `
    <div class="stat-strip">
      <div><span>使用模型</span><b>${rows.filter(r => r.cost > 0).length}</b></div>
      <div><span>本期费用 · ${METRICS[ui.f.metric]}</span><b>${money(all.cost)}</b></div>
      <div><span>Token 总量</span><b title="${intFmt(tok)}">${compact(tok)}</b></div>
      <div><span>平均 ¥/百万Token</span><b>${tok ? money(all.cost / tok * 1e6) : '-'}</b></div>
      <div><span>缓存命中率</span><b>${all.tIn ? pct(all.tCache, all.tIn) : '-'}</b></div>
      <div><span>输出 / 输入</span><b>${all.tIn ? (all.tOut / all.tIn * 100).toFixed(1) + '%' : '-'}</b></div>
      <div><span>单价最高（>10 万 Token）</span><b title="${esc(priciest?.model || '')}">${priciest ? esc(priciest.model) : '-'}</b></div>
      ${reqN ? `<div><span>请求次数</span><b title="${esc(REQ_SRC)}">${compact(reqN)}</b></div><div><span>单次平均 Token</span><b>${intFmt(reqTok / reqN)}</b></div>` : ''}
    </div>
    <section class="panel"><div class="panel-h"><h3>模型明细</h3><span class="sub">点击行查看模型详情（Token 与调用统计、使用该模型的 Key、每日费用、计费项）</span>
      <div class="actions">${segCtl('density', { normal: '标准', compact: '紧凑' })}<button class="btn sm" id="csvM">${icon('download')}导出</button></div></div><div id="tblM"></div></section>
    <div class="bi" style="margin-top:14px">
      <section class="panel c6"><div class="panel-h"><h3>Token 用量结构</h3><span class="sub">按总 Token 排序</span></div><div id="mdTok"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>单位成本</h3>${help('每百万 Token 费用 = 费用 ÷ 总 Token × 10⁶；不同模型的输入/输出/缓存结构不同，单位成本可用于横向评估性价比。')}<span class="sub">每百万 Token 费用</span></div><div id="mdUnit"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>计费维度</h3><span class="sub">按费用拆分</span></div><div id="mdDims"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>每日费用</h3><span class="sub">按模型堆叠 · 点击图例筛选模型，点击柱段查看当日该模型</span></div><div class="legend" id="mdLegend"></div><div class="chart" id="mdDaily"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>API Key × 模型</h3><span class="sub">交叉分析每个 Key 在各模型上的消耗 · 点击 Key 进入详情，点击模型列头或格子查看模型详情（格子限定该 Key）</span><div class="actions">${segCtl('hmMetric', { cost: '费用', tokens: 'Token' })}</div></div><div id="mx"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>模型 × 计费项明细</h3><span class="sub">按模型、计费项与单价汇总 · 点击行查看对应账单明细</span><div class="actions"><button class="btn sm" id="csvI">${icon('download')}导出</button></div></div><div id="tblI"></div></section>
    </div>`;
  const max = Math.max(0, ...rows.map(r => r.cost));
  let cols;
  const t = table('models', $('#tblM', v), {
    sort: 'cost', pageSize: 0, caption: '模型明细', onRowClick: r => openModel(r.model),
    columns: cols = [
      { key: 'model', label: '模型', fmt: (x, r) => `<span class="sw" style="background:${DIMS.model.color(x)}"></span><span class="mono">${esc(x)}</span>${multiCloud() ? r.providers.map(p => provTag(p)).join('') : ''}`, csv: r => r.model },
      { key: 'cost', label: `费用（${METRICS[ui.f.metric]}）`, align: 'r', fmt: x => dataBar(x, max), csv: r => r.cost.toFixed(6) },
      { key: 'chg', label: state.compareLabel, align: 'r', fmt: (x, r) => deltaPill(r.cost, r.prev), sortVal: r => r.cost - r.prev, csv: r => (r.cost - r.prev).toFixed(6) },
      { key: 'share', label: '占比', align: 'r', fmt: x => (x * 100).toFixed(1) + '%' },
      { key: 'tIn', label: '输入 Token', align: 'r', fmt: x => intFmt(x) },
      { key: 'hit', label: '缓存命中率', align: 'r', fmt: x => (x == null ? '-' : (x * 100).toFixed(1) + '%'), sortVal: r => r.hit ?? -1 },
      { key: 'tOut', label: '输出 Token', align: 'r', fmt: x => intFmt(x) },
      { key: 'ioRatio', label: '输出/输入', align: 'r', fmt: x => (x == null ? '-' : (x * 100).toFixed(1) + '%'), sortVal: r => r.ioRatio ?? -1 },
      { key: 'tEmb', label: '向量 Token', align: 'r', fmt: x => (x ? intFmt(x) : '-') },
      { key: 'perM', label: '¥/百万Token', align: 'r', fmt: x => (x == null ? '-' : money(x)), sortVal: r => r.perM ?? -1 },
      { key: 'dayTok', label: '日均 Token', title: '总 Token ÷ 统计周期内已过的自然日数', align: 'r', fmt: x => (x ? compact(x) : '-'), csv: r => Math.round(r.dayTok) },
      ...(hasUsage ? [
        { key: 'requests', label: '请求数', title: REQ_SRC, align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : intFmt(x)), sortVal: r => r.requests ?? -1 },
        { key: 'failRate', label: '失败率', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : `<span class="${x >= 0.05 ? 'bad-text' : x >= 0.01 ? 'warn-text' : ''}">${(x * 100).toFixed(2)}%</span>`), sortVal: r => r.failRate ?? -1, csv: r => (r.failRate == null ? '' : (r.failRate * 100).toFixed(2) + '%') },
        { key: 'tokPer', label: '单次均 Token', title: '单次平均 Token = 总 Token ÷ 请求数', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : intFmt(x)), sortVal: r => r.tokPer ?? -1, csv: r => (r.tokPer == null ? '' : Math.round(r.tokPer)) },
        { key: 'costPer', label: '单次均费用', title: '单次平均费用 = 有调用数据的日期的费用 ÷ 请求数', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : money(x, x < 0.01 ? 4 : 3)), sortVal: r => r.costPer ?? -1, csv: r => (r.costPer == null ? '' : r.costPer.toFixed(6)) },
      ] : []),
      { key: 'keys', label: 'Key 数', align: 'r', fmt: (x, r) => `<span title="${esc(r.keyList)}">${x}</span>` },
      { key: 'days', label: '使用天数', align: 'r' },
      { key: 'units', label: '其他用量' },
    ],
    csvExtra: [{ label: '使用的 Key', val: r => r.keyList }, { label: '原价', val: r => r.gross.toFixed(6) }, { label: '缓存命中 Token', val: r => Math.round(r.tCache) }],
    footer: rs => cols.map(c => ({ model: `合计 ${rs.length} 个`, cost: money(sum(rs, r => r.cost)), chg: deltaPill(sum(rs, r => r.cost), sum(rs, r => r.prev)), tIn: intFmt(sum(rs, r => r.tIn)), tOut: intFmt(sum(rs, r => r.tOut)), requests: hasUsage ? intFmt(sum(rs, r => r.requests || 0)) : '', tokPer: (() => { const n = sum(rs, r => r.requests || 0); return n ? intFmt(sum(rs, r => (r.requests ? r.uTokens : 0)) / n) : ''; })() }[c.key] ?? '')),
  }).setRows(rows);
  $('#csvM', v).onclick = () => t.csv(`模型消耗_${periodTag()}.csv`);

  stackRank($('#mdTok', v), rows.slice().sort((a, b) => b.tokens - a.tokens).map(r => ({ label: r.model, model: r.model, hit: r.hit, parts: [r.tIn - r.tCache, r.tCache, r.tOut, r.tEmb] })), TOKEN_PARTS,
    { limit: 12, onClick: r => openModel(r.model), meta: r => (r.hit != null ? `命中 ${(r.hit * 100).toFixed(0)}%` : '') });
  // 用量过小的模型单位成本无参考意义：只比较 Token ≥ 10 万的模型
  const unitRows = rows.filter(r => r.perM != null && r.tokens >= 1e5);
  rankList($('#mdUnit', v), (unitRows.length ? unitRows : rows.filter(r => r.perM != null)).sort((a, b) => b.perM - a.perM).map(r => ({ id: r.model, label: r.model, sub: `${compact(r.tokens)} Token`, value: r.perM, color: DIMS.model.color(r.model) })),
    { limit: 12, total: 0, onClick: it => openModel(it.id) });
  const excluded = rows.filter(r => r.perM != null && r.tokens < 1e5).length;
  if (unitRows.length && excluded) $('#mdUnit', v).insertAdjacentHTML('beforeend', `<div class="panel-foot">仅比较 Token ≥ 10 万的模型，另有 ${excluded} 个低用量模型未列入（见上方明细表）。</div>`);
  $('#mdDims', v).innerHTML = billDimsHtml(lines);
  dailyByModel($('#mdDaily', v), $('#mdLegend', v), daily);
  keyModelMatrix($('#mx', v), lines, { cellScope: k => ({ global: true, key: k }) });

  const byItem = aggregate(lines, itemKey);
  const usageOf = itemUsage(lines);
  const t2 = table('items', $('#tblI', v), {
    sort: 'cost', pageSize: 50, caption: '模型计费项明细', onRowClick: r => app.setFilter({ model: r.model, item: r.io }, '#/detail'),
    columns: [
      { key: 'model', label: '模型', cls: 'mono' },
      { key: 'label', label: '计费项', fmt: (x, r) => `${esc(x)}<span class="sub mono">${esc(r.io)}</span>` },
      { key: 'price', label: '单价', align: 'r', fmt: (x, r) => (x !== '' ? `${esc(x)}<span class="sub">${esc(r.priceUnit)}</span>` : '-'), sortVal: r => num(r.price) },
      { key: 'usage', label: '用量', align: 'r', fmt: (x, r) => `${intFmt(x)}<span class="sub">${esc(r.unit)}</span>` },
      { key: 'tokens', label: 'Token', align: 'r', fmt: x => intFmt(x) },
      { key: 'gross', label: '原价', align: 'r', fmt: x => money(x) },
      { key: 'cost', label: `费用（${METRICS[ui.f.metric]}）`, align: 'r', fmt: x => money(x) },
      { key: 'keys', label: 'Key 数', align: 'r' },
    ],
    footer: rs => ['合计', '', '', '', intFmt(sum(rs, r => r.tokens)), money(sum(rs, r => r.gross)), money(sum(rs, r => r.cost)), ''],
  }).setRows([...byItem.values()].map(a => {
    const [model, io, price, unit, priceUnit] = a.key.split('\u0001');
    return { model, io, label: ioInfo(io).label, price, priceUnit, unit, usage: usageOf.get(a.key) || 0, tokens: totalTokens(a), cost: a.cost, gross: a.gross, keys: a.keys.size };
  }));
  $('#csvI', v).onclick = () => t2.csv(`模型计费项_${periodTag()}.csv`);
}

function dailyByModel(el, lg, daily) {
  const days = uniq(daily.map(l => l.date)).sort();
  const ranked = sortedAggs(aggregate(daily, l => l.model)).map(a => a.key);
  const cmap = scopeColors(ranked, DIMS.model.color);
  const colored = ranked.filter(m => cmap.has(m)), others = ranked.filter(m => !cmap.has(m));
  const series = colored.map(m => ({ id: m, label: m, color: cmap.get(m) }));
  if (others.length) series.push({ id: '__other', label: `其他 ${others.length} 个`, color: 'var(--other)' });
  const cell = new Map();
  daily.forEach(l => { const k = l.date + '|' + (colored.includes(l.model) ? l.model : '__other'); cell.set(k, (cell.get(k) || 0) + metricVal(l)); });
  lg.innerHTML = series.length > 1 ? legendHtml(series, '点击按此模型筛选') : '';
  bindLegend(lg, m => app.setFilter({ model: m }));
  columnChart(el, {
    xs: days, series, cell: (x, s) => cell.get(x + '|' + s) || 0, height: 240, xLabel: x => x.slice(5), tipTitle: x => `${x}（周${WEEK[weekday(x)]}）`, empty: '暂无按日数据',
    onX: x => app.openDay(x), onSeg: (x, m) => app.openDay(x, { global: true, model: m }), clickHint: '点击查看当日明细', segHint: '点击柱段只看该模型',
  });
}

/**
 * API Key × 模型 矩阵（模型分析、业务空间详情共用）
 * 点击行 → Key 详情；点击模型列头 → 模型详情（headScope 范围）；点击格子 → 模型详情（cellScope(key) 范围，限定该 Key）
 */
export function keyModelMatrix(el, lines, { cellScope = k => ({ key: k }), headScope = null } = {}) {
  const useTok = ui.hmMetric === 'tokens';
  const val = l => (useTok ? (l.tokens || 0) : metricVal(l));
  const byModel = aggregate(lines, l => l.model);
  let models = sortedAggs(byModel, a => (useTok ? totalTokens(a) : a.cost)).map(a => a.key);
  const extra = models.slice(12); models = models.slice(0, 12);
  const allKeys = sortedAggs(aggregate(lines, DIMS.key.of)).map(a => a.key);
  if (!allKeys.length) { el.innerHTML = '<div class="nodata">暂无数据</div>'; return; }
  // 只渲染费用最高的 100 个 Key：上千个 Key 全部渲染（每个单元格带提示）会阻塞页面数秒
  const KEY_LIMIT = 100, keys = allKeys.slice(0, KEY_LIMIT);
  const cell = new Map(); let max = 0;
  for (const l of lines) { const mk = models.includes(l.model) ? l.model : '__other'; const k = (l.apiKeyId || NONE_KEY) + '|' + mk; cell.set(k, (cell.get(k) || 0) + val(l)); }
  for (const x of cell.values()) max = Math.max(max, x);
  const cols = models.concat(extra.length ? ['__other'] : []);
  const fmt = x => (useTok ? compact(x) : moneyShort(x));
  const shade = x => (x > 0 && max ? Math.min(7, Math.max(1, Math.ceil(Math.sqrt(x / max) * 7))) : 0);
  const sc = s => esc(JSON.stringify(s));
  el.innerHTML = `<div class="tbl-wrap"><table class="dt ${ui.density === 'compact' ? 'compact' : ''}"><thead><tr><th class="sticky">API Key</th>${cols.map(c => (c === '__other' ? `<th class="r">其他 ${extra.length} 个</th>` : `<th class="r mono"><button type="button" class="lnk" data-model="${esc(c)}"${headScope ? ` data-scope="${sc(headScope)}"` : ''} title="查看模型详情：${esc(c)}">${esc(c)}</button></th>`)).join('')}<th class="r">合计</th></tr></thead><tbody>
    ${keys.map(k => {
      let rs = 0;
      const tds = cols.map(c => {
        const x = cell.get(k + '|' + c) || 0; rs += x; const s = shade(x);
        if (!x) return '<td class="r"><span class="muted">·</span></td>'; // 空单元格不生成提示
        const tip = esc(tipRows(`${keyShort(k)} × ${c === '__other' ? '其他模型' : c}`, [[useTok ? 'Token' : '费用', useTok ? intFmt(x) : money(x)]]) + (x > 0 && c !== '__other' ? '<div class="tip-hint">点击查看该 Key 的该模型详情</div>' : ''));
        const inner = esc(fmt(x));
        return `<td class="r ${s ? 'cell-heat' : ''} ${s >= 4 ? 'dk' : ''}" style="${s ? `background:var(--q${s})` : ''}" data-tip="${tip}">${x > 0 && c !== '__other' ? `<button type="button" class="cell-btn" data-model="${esc(c)}" data-scope="${sc(cellScope(k))}" aria-label="${esc(`${keyShort(k)} × ${c}`)}">${inner}</button>` : inner}</td>`;
      }).join('');
      return `<tr class="${k !== NONE_KEY ? 'clickable' : ''}" data-key="${esc(k)}" ${k !== NONE_KEY ? 'tabindex="0"' : ''}><td class="sticky"><span class="sw" style="background:${DIMS.key.color(k)}"></span>${esc(keyShort(k))}</td>${tds}<td class="r"><b>${esc(fmt(rs))}</b></td></tr>`;
    }).join('')}</tbody></table></div>${allKeys.length > KEY_LIMIT ? `<div class="panel-foot">仅显示费用最高的 ${KEY_LIMIT} 个 Key（共 ${allKeys.length} 个），其余可在“成本分摊”中按 API Key × 模型查看与导出</div>` : ''}`;
  const go = tr => { if (tr && tr.dataset.key !== NONE_KEY) app.go(`#/key/${encodeURIComponent(tr.dataset.key)}`); };
  el.onclick = e => { if (e.target.closest('button')) return; go(e.target.closest('tr[data-key]')); };
  el.onkeydown = e => { if (e.key === 'Enter' && e.target.matches('tr[data-key]')) go(e.target); };
}

/* ---------------- 模型详情抽屉 ----------------
 * scope 为空：沿用全局筛选；scope 为对象：限定在某个 Key / 业务空间等范围内（见 core.scopeLines）
 */
export function openModel(model, scope = null) {
  const d = $('#drawer');
  const of = l => l.model === model;
  const base = scopeLines(state.lines, scope);
  const lines = base.filter(of), prevLines = scopeLines(state.prev, scope).filter(of), daily = scopeLines(state.daily, scope).filter(of);
  const a = aggAll(lines), pa = aggAll(prevLines), tot = sum(base, metricVal);
  const t = totalTokens(a), pt = totalTokens(pa);
  const uf = scopeUsage(scope), nm = normModel(model);
  const mRows = (uf || []).filter(u => normModel(u.model) === nm);
  // 只有该模型的账单全部来自有调用次数数据源的云厂商时才显示请求数（否则单次平均会被低估）
  const callsOk = lines.length > 0 && lines.every(l => callsOn(l.provider));
  const us = mRows.length && callsOk ? usageAgg(mRows, () => 'm').get('m') : null;
  const usByKey = usageAgg(mRows.filter(u => callsOn(u.provider)), u => u.apiKeyId); // 没有调用次数数据源的云厂商（如已关闭）不显示残留的请求数
  const sLabel = scopeLabel(scope);
  const keyScoped = scope && typeof scope === 'object' && scope.key != null;
  $('#drawerTitle').textContent = model;
  $('#drawerTags').innerHTML = `<span class="pill neutral">模型</span>${sLabel ? `<span class="pill info" title="限定范围">${esc(sLabel)}</span>` : ''}${copyBtn(model, '复制模型名')}`;
  $('#drawerActions').innerHTML = `<button class="btn sm" data-dact="filter" title="${esc(sLabel ? `按“${sLabel} · ${model}”筛选全部页面` : '按此模型筛选全部页面')}">按此筛选</button><button class="btn sm" data-dact="detail">${icon('list')}账单明细</button>`;
  $('#drawerActions').onclick = e => {
    const b = e.target.closest('[data-dact]'); if (!b) return;
    d.close();
    const entity = scope && typeof scope === 'object' && !scope.global; // 实体范围（Key / 业务空间详情）：替换其余筛选
    const patch = { ...scopeFilter(scope), model };
    if (b.dataset.dact === 'filter') app.setFilter(patch, null, !!entity);
    else app.setFilter(patch, '#/detail', !!entity);
  };
  $('#drawerBody').innerHTML = `
    <div class="kpi-wrap" style="margin:0"><div class="kpi-row n4">
      ${tile('wallet', `费用 · ${METRICS[ui.f.metric]}`, money(a.cost), deltaPill(a.cost, pa.cost), state.compareLabel, `占全部 ${pct(a.cost, tot)}`)}
      ${tile('token', 'Token', compact(t), deltaPill(t, pt, { neutral: true }), state.compareLabel, `输入 ${compact(a.tIn)} · 输出 ${compact(a.tOut)}`)}
      ${tile('unit', '每百万 Token', t ? money(a.cost / t * 1e6) : '—', t && pt ? deltaPill(a.cost / t, pa.cost / pt) : '', state.compareLabel, '费用 ÷ Token × 10⁶')}
      ${tile('cache', '缓存命中率', a.tIn ? pct(a.tCache, a.tIn) : '—', a.tIn && pa.tIn ? deltaPill(a.tCache / a.tIn, pa.tCache / pa.tIn, { pp: true, goodWhenUp: true }) : '', state.compareLabel, `${a.keys.size} 个 Key 使用`)}
    </div></div>
    <section><h3>Token 消耗与调用统计 ${help(`Token 来自账单用量；请求次数与单次平均：${REQ_SRC}。${sLabel ? `限定范围：${sLabel}。` : '受当前全局筛选影响。'}`)}</h3>${tokenStatsHtml({ a, pa, daily, us, period: state.data.period, scope: 'model', provider: lines.length && lines.every(l => l.provider === 'tencent') ? 'tencent' : 'aliyun', compact: true, unavailable: uf === null })}</section>
    <section><h3>每日 Token 消耗</h3><div class="legend" id="dmTokLegend"></div><div class="chart" id="dmTok"></div></section>
    ${us ? `<section><h3>每日调用次数 ${reqHelp()}</h3><div class="legend" id="dmReqLegend"></div><div class="chart" id="dmReq"></div></section>` : ''}
    ${keyScoped ? '' : '<section><h3>每日费用（按 API Key）</h3><div class="legend" id="dmLegend"></div><div class="chart" id="dmDaily"></div></section>'}
    ${keyScoped ? '' : '<section><h3>使用该模型的 API Key <span class="sub">点击进入 Key 详情</span></h3><div id="dmKeys"></div></section>'}
    ${keyScoped || (scope && scope.ws != null) ? '' : '<section><h3>按业务空间 <span class="sub">点击查看业务空间详情</span></h3><div id="dmWs"></div></section>'}
    <section><h3>计费项 <span class="sub">点击查看对应账单明细</span></h3><div id="dmItems"></div></section>`;
  if (!d.open) d.showModal();
  d.querySelector('.dlg-b').scrollTop = 0;
  const dayScope = extra => (scope && typeof scope === 'object' ? { ...scope, model, ...extra } : { global: true, model, ...extra });
  drawDailyTokens($('#dmTok'), $('#dmTokLegend'), daily, state.data.period, { height: 200, onX: x => app.openDay(x, dayScope()) });
  if (us) drawDailyRequests($('#dmReq'), $('#dmReqLegend'), us, state.data.period, { height: 200 });
  const pk = aggregate(prevLines, DIMS.key.of);
  if (!keyScoped) {
    const days = uniq(daily.map(l => l.date)).sort();
    const ranked = sortedAggs(aggregate(daily, DIMS.key.of)).map(x => x.key);
    const kmap = scopeColors(ranked, DIMS.key.color);
    const colored = ranked.filter(k => kmap.has(k)), others = ranked.filter(k => !kmap.has(k));
    const series = colored.map(k => ({ id: k, label: keyShort(k), color: kmap.get(k) }));
    if (others.length) series.push({ id: '__other', label: `其他 ${others.length} 个 Key`, color: 'var(--other)' });
    const cell = new Map(); daily.forEach(l => { const id = DIMS.key.of(l); const k = l.date + '|' + (colored.includes(id) ? id : '__other'); cell.set(k, (cell.get(k) || 0) + metricVal(l)); });
    $('#dmLegend').innerHTML = series.length > 1 ? legendHtml(series.map(s => ({ ...s, id: s.id === NONE_KEY ? null : s.id })), '点击进入 Key 详情') : '';
    bindLegend($('#dmLegend'), k => { d.close(); app.go(`#/key/${encodeURIComponent(k)}`); });
    columnChart($('#dmDaily'), {
      xs: days, series, cell: (x, s) => cell.get(x + '|' + s) || 0, height: 220, xLabel: x => x.slice(5), tipTitle: x => `${x}（周${WEEK[weekday(x)]}）`, empty: '暂无按日数据',
      onX: x => app.openDay(x, dayScope()), onSeg: (x, k) => app.openDay(x, dayScope({ key: k })), clickHint: '点击查看当日明细', segHint: '点击柱段只看该 Key',
    });
    rankList($('#dmKeys'), sortedAggs(aggregate(lines, DIMS.key.of)).map(x => {
      const k = state.apiKeys.get(x.key);
      return { id: x.key, label: keyShort(x.key), sub: [k ? dimName('ws', k.wsKey || NO_WS) : '', `${compact(totalTokens(x))} Token`, (u => (u && u.requests ? `${intFmt(u.requests)} 次 · 单次 ${intFmt(u.tokens / u.requests)} Token` : ''))(usByKey.get(x.key === NONE_KEY ? '' : x.key))].filter(Boolean).join(' · '), value: x.cost, prev: pk.get(x.key)?.cost ?? 0, color: DIMS.key.color(x.key) };
    }), { total: a.cost, showDelta: true, limit: 20, onClick: it => { if (it.id !== NONE_KEY) { d.close(); app.go(`#/key/${encodeURIComponent(it.id)}`); } } });
  }
  if ($('#dmWs')) {
    const pw = aggregate(prevLines, dimVal.ws);
    rankList($('#dmWs'), sortedAggs(aggregate(lines, dimVal.ws)).map(x => ({ id: x.key, label: dimName('ws', x.key), sub: `${x.keys.size} 个 Key · ${compact(totalTokens(x))} Token`, value: x.cost, prev: pw.get(x.key)?.cost ?? 0, color: DIMS.ws.color(x.key) })),
      { total: a.cost, showDelta: true, limit: 12, onClick: it => { d.close(); app.go(groupHash('ws', it.id)); } });
  }
  const byItem = aggregate(lines, l => `${l.io}\u0001${l.listPrice}\u0001${l.listPriceUnit}`);
  table('modelItems', $('#dmItems'), {
    sort: 'cost', pageSize: 0, caption: '模型计费项',
    onRowClick: r => { d.close(); const entity = scope && typeof scope === 'object' && !scope.global; app.setFilter({ ...scopeFilter(scope), model, item: r.io }, '#/detail', !!entity); },
    columns: [
      { key: 'label', label: '计费项', fmt: (x, r) => `${esc(x)}<span class="sub mono">${esc(r.io)}</span>` },
      { key: 'price', label: '单价', align: 'r', fmt: (x, r) => (x !== '' ? `${esc(x)}<span class="sub">${esc(r.unit)}</span>` : '-'), sortVal: r => num(r.price) },
      { key: 'tokens', label: 'Token', align: 'r', fmt: x => intFmt(x) },
      { key: 'cost', label: '费用', align: 'r', fmt: x => money(x) },
      { key: 'share', label: '占比', align: 'r', fmt: x => (x * 100).toFixed(1) + '%' },
    ],
  }).setRows([...byItem.values()].map(x => { const [io, price, unit] = x.key.split('\u0001'); return { io, label: ioInfo(io).label, price, unit, tokens: totalTokens(x), cost: x.cost, share: a.cost ? x.cost / a.cost : 0 }; }));
}
function tile(ic, label, value, delta, cmp, meta) {
  return `<section class="kpi"><div class="kpi-h"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span></div><div class="value">${value}</div>
    <div class="trend">${delta || ''}${delta && cmp ? `<span class="cmp">${esc(cmp)}</span>` : ''}</div><div class="meta">${esc(meta)}</div></section>`;
}
