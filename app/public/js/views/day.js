/* 当日明细抽屉：从每日费用图表下钻，查看某一天（可限定某个 Key）的费用构成 */
import { $, esc, state, ui, app, money, compact, intFmt, pct, sum, metricVal, METRICS, NONE_KEY, DIMS, keyShort,
  filterLines, aggregate, aggAll, sortedAggs, totalTokens, deltaPill, icon, ioInfo, WEEK, weekday, addDays } from '../core.js';
import { rankList } from '../charts.js';
import { table } from '../table.js';

export function openDay(date, keyId) {
  const d = $('#drawer');
  const ofKey = l => !keyId || (l.apiKeyId || NONE_KEY) === keyId;
  // Key 详情页的下钻只限定该 Key；其余页面沿用全局筛选
  const pool = keyId ? [...state.daily, ...state.prevDaily] : filterLines([...state.daily, ...state.prevDaily]);
  const lines = pool.filter(l => l.date === date && ofKey(l));
  const prevDay = addDays(date, -1);
  const prevLines = pool.filter(l => l.date === prevDay && ofKey(l));
  const a = aggAll(lines), pa = aggAll(prevLines);
  const t = totalTokens(a), pt = totalTokens(pa);
  $('#drawerTitle').textContent = `${date}（周${WEEK[weekday(date)]}）${keyId ? ' · ' + keyShort(keyId) : ''}`;
  $('#drawerTags').innerHTML = '<span class="pill neutral">当日明细</span>';
  $('#drawerActions').innerHTML = `<button class="btn sm" data-dact="detail" title="切换到“日期”口径并查看该日逐条账单">${icon('list')}该日账单明细</button>`;
  $('#drawerActions').onclick = e => {
    if (!e.target.closest('[data-dact]')) return;
    d.close();
    if (keyId) ui.f.key = keyId;
    app.setPeriod({ mode: 'range', preset: 'custom', from: date, to: date });
    app.go('#/detail');
  };
  $('#drawerBody').innerHTML = `
    <div class="kpi-wrap" style="margin:0"><div class="kpi-row n4">
      ${tile('wallet', `当日费用 · ${METRICS[ui.f.metric]}`, money(a.cost), deltaPill(a.cost, pa.cost), '较前一日', `前一日 ${money(pa.cost)}`)}
      ${tile('token', 'Token', compact(t), deltaPill(t, pt, { neutral: true }), '较前一日', `输入 ${compact(a.tIn)} · 输出 ${compact(a.tOut)}`)}
      ${tile('unit', '每百万 Token', t ? money(a.cost / t * 1e6) : '—', t && pt ? deltaPill(a.cost / t, pa.cost / pt) : '', '较前一日', '费用 ÷ Token × 10⁶')}
      ${tile('cache', '缓存命中率', a.tIn ? pct(a.tCache, a.tIn) : '—', a.tIn && pa.tIn ? deltaPill(a.tCache / a.tIn, pa.tCache / pa.tIn, { pp: true, goodWhenUp: true }) : '', '较前一日', `${a.keys.size} 个 Key · ${a.models.size} 个模型`)}
    </div></div>
    ${keyId ? '' : '<section><h3>按 API Key</h3><div id="dyKeys"></div></section>'}
    <section><h3>按模型</h3><div id="dyModels"></div></section>
    <section><h3>计费项</h3><div id="dyItems"></div></section>`;
  if (!d.open) d.showModal();
  d.querySelector('.dlg-b').scrollTop = 0;
  if (!lines.length) { $('#dyModels').innerHTML = '<div class="nodata">当天没有费用</div>'; return; }
  if (!keyId) {
    const pk = aggregate(prevLines, DIMS.key.of);
    rankList($('#dyKeys'), sortedAggs(aggregate(lines, DIMS.key.of)).map(x => ({ id: x.key, label: keyShort(x.key), sub: x.key !== NONE_KEY ? x.key : '', value: x.cost, prev: pk.get(x.key)?.cost ?? 0, color: DIMS.key.color(x.key) })),
      { total: a.cost, showDelta: true, limit: 20, onClick: it => { if (it.id !== NONE_KEY) { d.close(); app.go(`#/key/${it.id}`); } } });
  }
  const pm = aggregate(prevLines, l => l.model);
  rankList($('#dyModels'), sortedAggs(aggregate(lines, l => l.model)).map(x => ({ id: x.key, label: x.key, sub: `${compact(totalTokens(x))} Token`, value: x.cost, prev: pm.get(x.key)?.cost ?? 0, color: DIMS.model.color(x.key) })),
    { total: a.cost, showDelta: true, limit: 20, onClick: it => app.openModel(it.id) });
  const byItem = aggregate(lines, l => `${l.model}\u0001${l.io}`);
  table('dayItems', $('#dyItems'), {
    sort: 'cost', pageSize: 0, caption: '当日计费项', maxHeight: '420px',
    columns: [
      { key: 'model', label: '模型', cls: 'mono' },
      { key: 'label', label: '计费项', fmt: (x, r) => `${esc(x)}<span class="sub mono">${esc(r.io)}</span>` },
      { key: 'tokens', label: 'Token', align: 'r', fmt: x => intFmt(x) },
      { key: 'cost', label: '费用', align: 'r', fmt: x => money(x) },
      { key: 'share', label: '占比', align: 'r', fmt: x => (x * 100).toFixed(1) + '%' },
    ],
    footer: rs => ['合计', '', intFmt(sum(rs, r => r.tokens)), money(sum(rs, r => r.cost)), ''],
  }).setRows([...byItem.values()].map(x => { const [model, io] = x.key.split('\u0001'); return { model, io, label: ioInfo(io).label, tokens: totalTokens(x), cost: x.cost, share: a.cost ? x.cost / a.cost : 0 }; }));
}

function tile(ic, label, value, delta, cmp, meta) {
  return `<section class="kpi"><div class="kpi-h"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span></div><div class="value">${value}</div>
    <div class="trend">${delta || ''}${delta && cmp ? `<span class="cmp">${esc(cmp)}</span>` : ''}</div><div class="meta" title="${esc(meta)}">${esc(meta)}</div></section>`;
}
