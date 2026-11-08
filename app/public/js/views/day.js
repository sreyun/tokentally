/* 当日明细抽屉：从每日费用图表 / 热力图 / 明细下钻，查看某一天（可限定 Key、业务空间、模型等范围）的费用构成 */
import { $, esc, state, ui, app, money, compact, intFmt, pct, sum, metricVal, METRICS, NONE_KEY, DIMS, keyShort,
  aggregate, aggAll, sortedAggs, totalTokens, deltaPill, icon, ioInfo, WEEK, weekday, addDays, scopeLines, scopeUsage, scopeLabel, scopeFilter,
  dimVal, dimName, groupHash, callsOn, usageAgg } from '../core.js';
import { rankList } from '../charts.js';
import { table } from '../table.js';

/**
 * scope：
 *  - 字符串：Key ID（兼容旧调用，等同 { key }）
 *  - { key?, ws?, cc?, owner?, provider?, model?, global? }：global=true 在全局筛选基础上再限定；否则只按范围限定
 *  - 空：沿用全局筛选
 */
export function openDay(date, scope = null) {
  const s = typeof scope === 'string' ? { key: scope } : scope;
  const d = $('#drawer');
  const pool = scopeLines([...state.daily, ...state.prevDaily], s);
  const lines = pool.filter(l => l.date === date);
  const prevDay = addDays(date, -1);
  const prevLines = pool.filter(l => l.date === prevDay);
  const a = aggAll(lines), pa = aggAll(prevLines);
  const t = totalTokens(a), pt = totalTokens(pa);
  // 当日请求数：只有当天账单全部来自有调用次数数据源的云厂商时才显示（否则单次平均会被低估）
  const uf = scopeUsage(s);
  const du = uf && lines.length && lines.every(l => callsOn(l.provider)) ? usageAgg(uf.filter(u => u.day === date), () => 'd').get('d') : null;
  const sLabel = scopeLabel(s);
  $('#drawerTitle').textContent = `${date}（周${WEEK[weekday(date)]}）`;
  $('#drawerTags').innerHTML = `<span class="pill neutral">当日明细</span>${sLabel ? `<span class="pill info" title="限定范围">${esc(sLabel)}</span>` : ''}`;
  $('#drawerActions').innerHTML = `<button class="btn sm" data-dact="detail" title="切换到“日期”口径并查看该日逐条账单">${icon('list')}该日账单明细</button>`;
  $('#drawerActions').onclick = e => {
    if (!e.target.closest('[data-dact]')) return;
    d.close();
    const entity = s && !s.global; // 实体范围：替换其余筛选
    app.setPeriod({ mode: 'range', preset: 'custom', from: date, to: date }, { url: false });
    app.setFilter(scopeFilter(s), '#/detail', !!entity);
  };
  const showKeys = !s || s.key == null, showModels = !s || s.model == null;
  const wsSet = new Set(lines.map(dimVal.ws));
  const showWs = (!s || (s.ws == null && s.key == null)) && wsSet.size > 1;
  $('#drawerBody').innerHTML = `
    <div class="kpi-wrap" style="margin:0"><div class="kpi-row n4">
      ${tile('wallet', `当日费用 · ${METRICS[ui.f.metric]}`, money(a.cost), deltaPill(a.cost, pa.cost), '较前一日', `前一日 ${money(pa.cost)}`)}
      ${tile('token', 'Token', compact(t), deltaPill(t, pt, { neutral: true }), '较前一日', du && du.requests ? `请求 ${intFmt(du.requests)} 次 · 单次 ${intFmt(du.tokens / du.requests)} Token` : `输入 ${compact(a.tIn)} · 输出 ${compact(a.tOut)}`)}
      ${tile('unit', '每百万 Token', t ? money(a.cost / t * 1e6) : '—', t && pt ? deltaPill(a.cost / t, pa.cost / pt) : '', '较前一日', '费用 ÷ Token × 10⁶')}
      ${tile('cache', '缓存命中率', a.tIn ? pct(a.tCache, a.tIn) : '—', a.tIn && pa.tIn ? deltaPill(a.tCache / a.tIn, pa.tCache / pa.tIn, { pp: true, goodWhenUp: true }) : '', '较前一日', `${a.keys.size} 个 Key · ${a.models.size} 个模型`)}
    </div></div>
    ${showKeys ? '<section><h3>按 API Key <span class="sub">点击进入 Key 详情</span></h3><div id="dyKeys"></div></section>' : ''}
    ${showWs ? '<section><h3>按业务空间 <span class="sub">点击查看业务空间详情</span></h3><div id="dyWs"></div></section>' : ''}
    ${showModels ? '<section><h3>按模型 <span class="sub">点击查看模型详情</span></h3><div id="dyModels"></div></section>' : ''}
    <section><h3>计费项 <span class="sub">点击查看该日对应账单</span></h3><div id="dyItems"></div></section>`;
  if (!d.open) d.showModal();
  d.querySelector('.dlg-b').scrollTop = 0;
  if (!lines.length) { $('#dyItems').innerHTML = '<div class="nodata">当天没有费用</div>'; ['#dyKeys', '#dyWs', '#dyModels'].forEach(x => { const el = $(x); if (el) el.innerHTML = ''; }); return; }
  if (showKeys) {
    const pk = aggregate(prevLines, DIMS.key.of);
    rankList($('#dyKeys'), sortedAggs(aggregate(lines, DIMS.key.of)).map(x => ({ id: x.key, label: keyShort(x.key), sub: x.key !== NONE_KEY ? [dimName('ws', state.apiKeys.get(x.key)?.wsKey || '__nows'), x.key].join(' · ') : '', value: x.cost, prev: pk.get(x.key)?.cost ?? 0, color: DIMS.key.color(x.key) })),
      { total: a.cost, showDelta: true, limit: 20, onClick: it => { if (it.id !== NONE_KEY) { d.close(); app.go(`#/key/${encodeURIComponent(it.id)}`); } } });
  }
  if (showWs) {
    const pw = aggregate(prevLines, dimVal.ws);
    rankList($('#dyWs'), sortedAggs(aggregate(lines, dimVal.ws)).map(x => ({ id: x.key, label: dimName('ws', x.key), sub: `${x.keys.size} 个 Key`, value: x.cost, prev: pw.get(x.key)?.cost ?? 0, color: DIMS.ws.color(x.key) })),
      { total: a.cost, showDelta: true, limit: 12, onClick: it => { d.close(); app.go(groupHash('ws', it.id)); } });
  }
  if (showModels) {
    const pm = aggregate(prevLines, l => l.model);
    // 模型详情沿用当前范围（不限定日期）
    const mScope = s ? { ...s } : null;
    rankList($('#dyModels'), sortedAggs(aggregate(lines, l => l.model)).map(x => ({ id: x.key, label: x.key, sub: `${compact(totalTokens(x))} Token`, value: x.cost, prev: pm.get(x.key)?.cost ?? 0, color: DIMS.model.color(x.key) })),
      { total: a.cost, showDelta: true, limit: 20, onClick: it => app.openModel(it.id, mScope) });
  }
  const byItem = aggregate(lines, l => `${l.model}\u0001${l.io}`);
  table('dayItems', $('#dyItems'), {
    sort: 'cost', pageSize: 0, caption: '当日计费项', maxHeight: '420px',
    onRowClick: r => {
      d.close();
      app.setPeriod({ mode: 'range', preset: 'custom', from: date, to: date }, { url: false });
      app.setFilter({ ...scopeFilter(s), model: r.model, item: r.io }, '#/detail', !!(s && !s.global));
    },
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
