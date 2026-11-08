/* 模型分析：模型费用、Token 结构、单位成本、计费维度、Key × 模型矩阵、模型详情抽屉 */
import {
  $, esc, state, ui, app, money, moneyShort, compact, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, DIMS, keyShort,
  filterLines, aggregate, aggAll, sortedAggs, totalTokens, unitsText, deltaPill, tipRows, icon, help, segCtl, ioInfo, num, periodTag, WEEK, weekday, copyBtn, PROVIDERS, provTag, multiCloud,
} from '../core.js';
import { columnChart, rankList, stackRank, segbar, legendHtml } from '../charts.js';
import { table, dataBar } from '../table.js';

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
  const provs = new Map();
  for (const l of lines) { if (!provs.has(l.model)) provs.set(l.model, new Set()); provs.get(l.model).add(l.provider); }
  const total = sum([...by.values()], a => a.cost);
  return [...by.values()].map(a => {
    const t = totalTokens(a);
    return {
      model: a.key, cost: a.cost, prev: pby.get(a.key)?.cost || 0, share: total ? a.cost / total : 0, gross: a.gross, tIn: a.tIn, tCache: a.tCache, tOut: a.tOut, tEmb: a.tEmb, tokens: t,
      hit: a.tIn ? a.tCache / a.tIn : null, ioRatio: a.tIn ? a.tOut / a.tIn : null, perM: t ? a.cost / t * 1e6 : null, keys: a.keys.size, keyList: [...a.keys].map(k => keyShort(k)).join('、'), providers: [...(provs.get(a.key) || [])],
      wss: a.wss.size, items: a.items.size, units: unitsText(a), days: uniq(daily.filter(l => l.model === a.key && metricVal(l) > 0).map(l => l.date)).length,
    };
  });
}

export function render(v) {
  const lines = filterLines(), prevLines = filterLines(state.prev), daily = filterLines(state.daily);
  const rows = modelRows(lines, prevLines, daily);
  const all = aggAll(lines), tok = totalTokens(all);
  const priciest = rows.filter(r => r.perM != null && r.tokens > 1e5).sort((a, b) => b.perM - a.perM)[0];
  v.innerHTML = `
    <div class="stat-strip">
      <div><span>使用模型</span><b>${rows.filter(r => r.cost > 0).length}</b></div>
      <div><span>本期费用 · ${METRICS[ui.f.metric]}</span><b>${money(all.cost)}</b></div>
      <div><span>Token 总量</span><b title="${intFmt(tok)}">${compact(tok)}</b></div>
      <div><span>平均 ¥/百万Token</span><b>${tok ? money(all.cost / tok * 1e6) : '-'}</b></div>
      <div><span>缓存命中率</span><b>${all.tIn ? pct(all.tCache, all.tIn) : '-'}</b></div>
      <div><span>输出 / 输入</span><b>${all.tIn ? (all.tOut / all.tIn * 100).toFixed(1) + '%' : '-'}</b></div>
      <div><span>单价最高（>10 万 Token）</span><b title="${esc(priciest?.model || '')}">${priciest ? esc(priciest.model) : '-'}</b></div>
    </div>
    <section class="panel"><div class="panel-h"><h3>模型明细</h3><span class="sub">点击行查看模型详情（使用该模型的 Key、每日费用、计费项）</span>
      <div class="actions">${segCtl('density', { normal: '标准', compact: '紧凑' })}<button class="btn sm" id="csvM">${icon('download')}导出</button></div></div><div id="tblM"></div></section>
    <div class="bi" style="margin-top:14px">
      <section class="panel c6"><div class="panel-h"><h3>Token 用量结构</h3><span class="sub">按总 Token 排序</span></div><div id="mdTok"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>单位成本</h3>${help('每百万 Token 费用 = 费用 ÷ 总 Token × 10⁶；不同模型的输入/输出/缓存结构不同，单位成本可用于横向评估性价比。')}<span class="sub">每百万 Token 费用</span></div><div id="mdUnit"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>计费维度</h3><span class="sub">按费用拆分</span></div><div id="mdDims"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>每日费用</h3><span class="sub">按模型堆叠</span></div><div class="legend" id="mdLegend"></div><div class="chart" id="mdDaily"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>API Key × 模型</h3><span class="sub">交叉分析每个 Key 在各模型上的消耗 · 点击 Key 进入详情</span><div class="actions">${segCtl('hmMetric', { cost: '费用', tokens: 'Token' })}</div></div><div id="mx"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>模型 × 计费项明细</h3><span class="sub">按模型、计费项与单价汇总</span><div class="actions"><button class="btn sm" id="csvI">${icon('download')}导出</button></div></div><div id="tblI"></div></section>
    </div>`;
  const max = Math.max(0, ...rows.map(r => r.cost));
  const t = table('models', $('#tblM', v), {
    sort: 'cost', pageSize: 0, caption: '模型明细', onRowClick: r => openModel(r.model),
    columns: [
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
      { key: 'keys', label: 'Key 数', align: 'r', fmt: (x, r) => `<span title="${esc(r.keyList)}">${x}</span>` },
      { key: 'days', label: '使用天数', align: 'r' },
      { key: 'units', label: '其他用量' },
    ],
    csvExtra: [{ label: '使用的 Key', val: r => r.keyList }, { label: '原价', val: r => r.gross.toFixed(6) }, { label: '缓存命中 Token', val: r => Math.round(r.tCache) }],
    footer: rs => ['合计', money(sum(rs, r => r.cost)), deltaPill(sum(rs, r => r.cost), sum(rs, r => r.prev)), '', intFmt(sum(rs, r => r.tIn)), '', intFmt(sum(rs, r => r.tOut)), '', '', '', '', '', ''],
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
  matrix($('#mx', v), lines);

  const byItem = aggregate(lines, l => `${l.model}\u0001${l.io}\u0001${l.listPrice}\u0001${l.usageUnit}\u0001${l.listPriceUnit}`);
  const t2 = table('items', $('#tblI', v), {
    sort: 'cost', pageSize: 50, caption: '模型计费项明细',
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
    return { model, io, label: ioInfo(io).label, price, priceUnit, unit, usage: sum(lines.filter(l => `${l.model}\u0001${l.io}\u0001${l.listPrice}\u0001${l.usageUnit}\u0001${l.listPriceUnit}` === a.key), l => l.usage || 0), tokens: totalTokens(a), cost: a.cost, gross: a.gross, keys: a.keys.size };
  }));
  $('#csvI', v).onclick = () => t2.csv(`模型计费项_${periodTag()}.csv`);
}

function dailyByModel(el, lg, daily) {
  const days = uniq(daily.map(l => l.date)).sort();
  const ranked = sortedAggs(aggregate(daily, l => l.model)).map(a => a.key);
  const colored = ranked.filter(m => DIMS.model.color(m) !== 'var(--other)'), others = ranked.filter(m => !colored.includes(m));
  const series = colored.map(m => ({ id: m, label: m, color: DIMS.model.color(m) }));
  if (others.length) series.push({ id: '__other', label: `其他 ${others.length} 个`, color: 'var(--other)' });
  const cell = new Map();
  daily.forEach(l => { const k = l.date + '|' + (colored.includes(l.model) ? l.model : '__other'); cell.set(k, (cell.get(k) || 0) + metricVal(l)); });
  lg.innerHTML = series.length > 1 ? legendHtml(series) : '';
  columnChart(el, { xs: days, series, cell: (x, s) => cell.get(x + '|' + s) || 0, height: 240, xLabel: x => x.slice(5), tipTitle: x => `${x}（周${WEEK[weekday(x)]}）`, empty: '暂无按日数据' });
}

function matrix(el, lines) {
  const useTok = ui.hmMetric === 'tokens';
  const val = l => (useTok ? (l.tokens || 0) : metricVal(l));
  const byModel = aggregate(lines, l => l.model);
  let models = sortedAggs(byModel, a => (useTok ? totalTokens(a) : a.cost)).map(a => a.key);
  const extra = models.slice(12); models = models.slice(0, 12);
  const keys = sortedAggs(aggregate(lines, DIMS.key.of)).map(a => a.key);
  if (!keys.length) { el.innerHTML = '<div class="nodata">暂无数据</div>'; return; }
  const cell = new Map(); let max = 0;
  for (const l of lines) { const mk = models.includes(l.model) ? l.model : '__other'; const k = (l.apiKeyId || NONE_KEY) + '|' + mk; cell.set(k, (cell.get(k) || 0) + val(l)); }
  for (const x of cell.values()) max = Math.max(max, x);
  const cols = models.concat(extra.length ? ['__other'] : []);
  const fmt = x => (useTok ? compact(x) : moneyShort(x));
  const shade = x => (x > 0 && max ? Math.min(7, Math.max(1, Math.ceil(Math.sqrt(x / max) * 7))) : 0);
  el.innerHTML = `<div class="tbl-wrap"><table class="dt ${ui.density === 'compact' ? 'compact' : ''}"><thead><tr><th class="sticky">API Key</th>${cols.map(c => `<th class="r mono">${esc(c === '__other' ? `其他 ${extra.length} 个` : c)}</th>`).join('')}<th class="r">合计</th></tr></thead><tbody>
    ${keys.map(k => {
      let rs = 0;
      const tds = cols.map(c => {
        const x = cell.get(k + '|' + c) || 0; rs += x; const s = shade(x);
        return `<td class="r ${s ? 'cell-heat' : ''} ${s >= 4 ? 'dk' : ''}" style="${s ? `background:var(--q${s})` : ''}" data-tip="${esc(tipRows(`${keyShort(k)} × ${c === '__other' ? '其他模型' : c}`, [[useTok ? 'Token' : '费用', useTok ? intFmt(x) : money(x)]]))}">${x > 0 ? esc(fmt(x)) : '<span class="muted">·</span>'}</td>`;
      }).join('');
      return `<tr class="${k !== NONE_KEY ? 'clickable' : ''}" data-key="${esc(k)}" ${k !== NONE_KEY ? 'tabindex="0"' : ''}><td class="sticky"><span class="sw" style="background:${DIMS.key.color(k)}"></span>${esc(keyShort(k))}</td>${tds}<td class="r"><b>${esc(fmt(rs))}</b></td></tr>`;
    }).join('')}</tbody></table></div>`;
  const go = tr => { if (tr && tr.dataset.key !== NONE_KEY) app.go(`#/key/${tr.dataset.key}`); };
  el.onclick = e => go(e.target.closest('tr[data-key]'));
  el.onkeydown = e => { if (e.key === 'Enter') go(e.target.closest('tr[data-key]')); };
}

/* ---------------- 模型详情抽屉 ---------------- */
export function openModel(model) {
  const d = $('#drawer');
  const of = l => l.model === model;
  const lines = filterLines().filter(of), prevLines = filterLines(state.prev).filter(of), daily = filterLines(state.daily).filter(of);
  const a = aggAll(lines), pa = aggAll(prevLines), tot = sum(filterLines(), metricVal);
  const t = totalTokens(a), pt = totalTokens(pa);
  $('#drawerTitle').textContent = model;
  $('#drawerTags').innerHTML = `<span class="pill neutral">模型</span>${copyBtn(model, '复制模型名')}`;
  $('#drawerActions').innerHTML = `<button class="btn sm" data-dact="filter">按此模型筛选</button><button class="btn sm" data-dact="detail">账单明细</button>`;
  $('#drawerActions').onclick = e => {
    const b = e.target.closest('[data-dact]'); if (!b) return;
    d.close();
    if (b.dataset.dact === 'filter') app.setFilter({ model });
    else app.setFilter({ model }, '#/detail');
  };
  $('#drawerBody').innerHTML = `
    <div class="kpi-wrap" style="margin:0"><div class="kpi-row n4">
      ${tile('wallet', `费用 · ${METRICS[ui.f.metric]}`, money(a.cost), deltaPill(a.cost, pa.cost), state.compareLabel, `占全部 ${pct(a.cost, tot)}`)}
      ${tile('token', 'Token', compact(t), deltaPill(t, pt, { neutral: true }), state.compareLabel, `输入 ${compact(a.tIn)} · 输出 ${compact(a.tOut)}`)}
      ${tile('unit', '每百万 Token', t ? money(a.cost / t * 1e6) : '—', t && pt ? deltaPill(a.cost / t, pa.cost / pt) : '', state.compareLabel, '费用 ÷ Token × 10⁶')}
      ${tile('cache', '缓存命中率', a.tIn ? pct(a.tCache, a.tIn) : '—', a.tIn && pa.tIn ? deltaPill(a.tCache / a.tIn, pa.tCache / pa.tIn, { pp: true, goodWhenUp: true }) : '', state.compareLabel, `${a.keys.size} 个 Key 使用`)}
    </div></div>
    <section><h3>每日费用（按 API Key）</h3><div class="legend" id="dmLegend"></div><div class="chart" id="dmDaily"></div></section>
    <section><h3>使用该模型的 API Key</h3><div id="dmKeys"></div></section>
    <section><h3>计费项</h3><div id="dmItems"></div></section>`;
  if (!d.open) d.showModal();
  d.querySelector('.dlg-b').scrollTop = 0;
  const days = uniq(daily.map(l => l.date)).sort();
  const ranked = sortedAggs(aggregate(daily, DIMS.key.of)).map(x => x.key);
  const colored = ranked.filter(k => DIMS.key.color(k) !== 'var(--other)'), others = ranked.filter(k => !colored.includes(k));
  const series = colored.map(k => ({ id: k, label: keyShort(k), color: DIMS.key.color(k) }));
  if (others.length) series.push({ id: '__other', label: `其他 ${others.length} 个 Key`, color: 'var(--other)' });
  const cell = new Map(); daily.forEach(l => { const id = DIMS.key.of(l); const k = l.date + '|' + (colored.includes(id) ? id : '__other'); cell.set(k, (cell.get(k) || 0) + metricVal(l)); });
  $('#dmLegend').innerHTML = series.length > 1 ? legendHtml(series) : '';
  columnChart($('#dmDaily'), { xs: days, series, cell: (x, s) => cell.get(x + '|' + s) || 0, height: 220, xLabel: x => x.slice(5), tipTitle: x => x, empty: '暂无按日数据' });
  const pk = aggregate(prevLines, DIMS.key.of);
  rankList($('#dmKeys'), sortedAggs(aggregate(lines, DIMS.key.of)).map(x => ({ id: x.key, label: keyShort(x.key), sub: x.key !== NONE_KEY ? x.key : '', value: x.cost, prev: pk.get(x.key)?.cost ?? 0, color: DIMS.key.color(x.key) })),
    { total: a.cost, showDelta: true, limit: 20, onClick: it => { if (it.id !== NONE_KEY) { d.close(); app.go(`#/key/${it.id}`); } } });
  const byItem = aggregate(lines, l => `${l.io}\u0001${l.listPrice}\u0001${l.listPriceUnit}`);
  table('modelItems', $('#dmItems'), {
    sort: 'cost', pageSize: 0, caption: '模型计费项',
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
