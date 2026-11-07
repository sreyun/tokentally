/* API Key 分析：全部 Key 的费用、用量、效率、预算与属性 */
import {
  $, esc, state, ui, app, money, moneyShort, compact, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, DIMS, keyObj, keyDesc, keyShort, wsName,
  filterLines, aggregate, sortedAggs, newAgg, totalTokens, topModels, unitsText, deltaPill, tipRows, icon, help, segCtl, fmtTime, budgetOf, budgetLevel,
  forecastOf, isCurrentMonth, periodTag, copyBtn,
} from '../core.js';
import { table, dataBar } from '../table.js';
import { heatmap, dayCols } from '../charts.js';

export function keyRows() {
  const lines = filterLines();
  const byKey = aggregate(lines, DIMS.key.of);
  const pByKey = aggregate(filterLines(state.prev), DIMS.key.of);
  const daily = filterLines(state.daily);
  const dByKey = new Map(); daily.forEach(l => { const id = l.apiKeyId || NONE_KEY; if (!dByKey.has(id)) dByKey.set(id, []); dByKey.get(id).push(l); });
  const total = sum([...byKey.values()], a => a.cost);
  const f = ui.f, q = f.q.trim().toLowerCase();
  const narrowing = f.model || f.dir || f.item || f.channel !== '__all';
  let ids = [...state.apiKeys.keys()];
  if (byKey.has(NONE_KEY)) ids.push(NONE_KEY);
  ids = ids.filter(id => {
    const k = keyObj(id);
    if (f.key && id !== f.key) return false;
    if (f.ws && !byKey.has(id)) { const wk = k ? k.wsKey : ''; if (f.ws === '__nows' ? wk : wk !== f.ws) return false; }
    if (q && !byKey.has(id) && !`${id} ${keyDesc(id)} ${k ? wsName(k.wsKey) : ''}`.toLowerCase().includes(q)) return false;
    if (narrowing && !byKey.has(id)) return false;
    if (ui.onlySpent && !(byKey.get(id)?.cost > 0)) return false;
    return true;
  });
  const month = state.data.period.mode === 'month';
  return { total, rows: ids.map(id => {
    const k = keyObj(id) || {}, a = byKey.get(id) || newAgg(id), p = pByKey.get(id), act = state.keyActivity.get(id);
    let status = '—', st = '';
    if (id === NONE_KEY) status = '非 Key 调用';
    else if (k.source === 'deleted') { status = '已删除'; st = 'off'; }
    else if (k.source === 'bill') { status = '不在列表'; st = 'warn'; }
    else if (k.disabled === true) { status = '已禁用'; st = 'off'; }
    else if (k.disabled === false) { status = '启用'; st = 'on'; }
    const tokens = totalTokens(a);
    const budget = month ? budgetOf(id === NONE_KEY ? null : id) : null;
    const fc = budget && isCurrentMonth() ? forecastOf(dByKey.get(id) || [], l => l.pretax) : null;
    const ipOpen = !(k.accessIps || []).length || (k.accessIps || []).some(x => x === '0.0.0.0/0' || x === '::/0');
    return {
      id, apiKeyId: id === NONE_KEY ? '' : id, desc: keyShort(id), hasDesc: !!k.description, masked: k.apiKeyValue || '', wsName: id === NONE_KEY ? '—' : wsName(k.wsKey), wsId: k.wsKey || '',
      status, st, deletedAt: k.deletedAt,
      perm: id === NONE_KEY || !k.authType ? '—' : k.authType === 'All' || k.allowAllModels ? '全部模型' : `${(k.accessibleModels || []).length} 个模型`,
      permTip: (k.accessibleModels || []).join('、'), ip: id === NONE_KEY ? '—' : ipOpen ? '不限' : `${k.accessIps.length} 条`, ipTip: (k.accessIps || []).join(', '),
      cost: a.cost, pretax: a.pretax, prevCost: p?.cost || 0, chg: a.cost - (p?.cost || 0), share: total ? a.cost / total : 0, gross: a.gross,
      tIn: a.tIn, tCache: a.tCache, tOut: a.tOut, tEmb: a.tEmb, tokens, hit: a.tIn ? a.tCache / a.tIn : null, perM: tokens ? a.cost / tokens * 1e6 : null,
      models: a.models.size, topModels: topModels(a, 2).join('、'), activeDays: uniq((dByKey.get(id) || []).filter(l => metricVal(l) > 0).map(l => l.date)).length,
      lastDay: act?.lastDay || '', c7: act?.c7 || 0, c30: act?.c30 || 0, budget, fc: fc?.value ?? null, gmtCreate: k.gmtCreate ?? null, createdBy: k.createdBy || '', units: unitsText(a),
    };
  }) };
}

export function render(v) {
  const { rows, total } = keyRows();
  const month = state.data.period.mode === 'month';
  const all = [...state.apiKeys.values()];
  const spent = rows.filter(r => r.cost > 0 && r.id !== NONE_KEY);
  const top = rows.slice().sort((a, b) => b.cost - a.cost)[0];
  const withBudget = rows.filter(r => r.budget);
  const over = withBudget.filter(r => r.pretax >= r.budget || (r.fc != null && r.fc >= r.budget));
  v.innerHTML = `
    <div class="stat-strip">
      <div><span>API Key 总数</span><b>${all.length}</b></div>
      <div><span>启用 / 禁用 / 已删除</span><b>${all.filter(k => k.source === 'api' && k.disabled !== true).length} / ${all.filter(k => k.disabled === true).length} / ${all.filter(k => k.source === 'deleted').length}</b></div>
      <div><span>本期有消费</span><b>${spent.length}</b></div>
      <div><span>本期费用 · ${METRICS[ui.f.metric]}</span><b>${money(total)}</b></div>
      <div><span>最高占比</span><b title="${esc(top ? top.desc : '')}">${top && top.cost > 0 ? pct(top.cost, total) : '-'}</b></div>
      ${month ? `<div><span>设预算 / 超（预计超）</span><b>${withBudget.length} / <span class="${over.length ? 'bad-text' : ''}">${over.length}</span></b></div>` : ''}
    </div>
    <section class="panel">
      <div class="panel-h"><h3>API Key 明细</h3><span class="sub">描述、业务空间、状态与权限实时同步自阿里云 · 点击行查看 Key 详情</span>
        <div class="actions"><label class="chk"><input type="checkbox" id="onlySpent" ${ui.onlySpent ? 'checked' : ''}> 仅显示有消费</label>${segCtl('density', { normal: '标准', compact: '紧凑' })}<button class="btn sm" id="csv">${icon('download')}导出</button></div></div>
      <div id="tbl"></div>
    </section>
    <div class="bi" style="margin-top:14px">
      <section class="panel c12"><div class="panel-h"><h3>每日消耗热力</h3><span class="sub">按 Key × 日期，颜色越深费用越高（平方根刻度）· 点击 Key 名称查看详情</span>
        <div class="actions"><span class="scale">低 ${[1, 2, 3, 4, 5, 6, 7].map(i => `<i style="background:var(--q${i})"></i>`).join('')} 高</span></div></div><div id="heat"></div></section>
    </div>`;
  const max = Math.max(0, ...rows.map(r => r.cost));
  const cols = [
    { key: 'desc', label: 'API Key', csvLabel: '描述', fmt: (x, r) => `<span class="sw" style="background:${DIMS.key.color(r.id)}"></span><b style="font-weight:600">${esc(x)}</b>${!r.hasDesc && r.id !== NONE_KEY ? '<span class="tag warn">无描述</span>' : ''}<span class="sub mono">${esc(r.apiKeyId || '—')}${copyBtn(r.apiKeyId, '复制 Key ID')}${r.masked ? ' · ' + esc(r.masked) : ''}</span>` },
    { key: 'wsName', label: '业务空间', fmt: (x, r) => `${esc(x)}${r.wsId ? `<span class="sub mono">${esc(r.wsId)}</span>` : ''}` },
    { key: 'status', label: '状态', fmt: (x, r) => `<span class="state ${r.st}">${esc(x)}</span>${r.deletedAt ? `<span class="sub">${fmtTime(r.deletedAt, false)}</span>` : ''}` },
    { key: 'cost', label: `费用（${METRICS[ui.f.metric]}）`, align: 'r', fmt: x => dataBar(x, max), csv: r => r.cost.toFixed(6) },
    { key: 'chg', label: state.compareLabel, align: 'r', fmt: (x, r) => deltaPill(r.cost, r.prevCost), csv: r => r.chg.toFixed(6) },
    { key: 'share', label: '占比', align: 'r', fmt: x => (x ? (x * 100).toFixed(1) + '%' : '-'), csv: r => (r.share * 100).toFixed(2) + '%' },
  ];
  if (month) cols.push({ key: 'budgetUse', label: '预算使用', fmt: (x, r) => budgetCell(r), sortVal: r => (r.budget ? r.pretax / r.budget : -1), csv: r => (r.budget ? `${(r.pretax / r.budget * 100).toFixed(1)}%` : '') });
  cols.push(
    { key: 'tIn', label: '输入 Token', align: 'r', fmt: x => intFmt(x) },
    { key: 'tOut', label: '输出 Token', align: 'r', fmt: x => intFmt(x) },
    { key: 'hit', label: '缓存命中率', align: 'r', fmt: x => (x == null ? '-' : (x * 100).toFixed(1) + '%'), sortVal: r => r.hit ?? -1, csv: r => (r.hit == null ? '' : (r.hit * 100).toFixed(2) + '%') },
    { key: 'perM', label: '¥/百万Token', title: '费用 ÷ 总 Token × 10⁶', align: 'r', fmt: x => (x == null ? '-' : money(x)), sortVal: r => r.perM ?? -1 },
    { key: 'topModels', label: '主要模型' },
    { key: 'activeDays', label: '消费天数', align: 'r' },
    { key: 'lastDay', label: '最近消费', fmt: x => (x ? esc(x) : '<span class="muted">—</span>') },
    { key: 'c7', label: '近 7 天', title: '近 7 天应付金额（与所选周期无关）', align: 'r', fmt: x => money(x) },
    { key: 'perm', label: '模型权限', fmt: (x, r) => `<span title="${esc(r.permTip)}">${esc(x)}</span>` },
    { key: 'ip', label: 'IP 白名单', fmt: (x, r) => (x === '不限' ? '<span class="warn-text">不限</span>' : `<span title="${esc(r.ipTip)}">${esc(x)}</span>`), csv: r => r.ipTip || r.ip },
    { key: 'gmtCreate', label: '创建时间', fmt: x => fmtTime(x, false), csv: r => fmtTime(r.gmtCreate) },
  );
  const t = table('keys', $('#tbl', v), {
    sort: 'cost', pageSize: 100, caption: 'API Key 明细', rowClass: r => (r.deletedAt ? 'deleted' : ''),
    onRowClick: r => (r.id === NONE_KEY ? app.setFilter({ key: NONE_KEY }, '#/detail') : app.go(`#/key/${r.id}`)),
    columns: cols,
    csvExtra: [{ label: 'API Key ID', val: r => r.apiKeyId }, { label: 'API Key（脱敏）', val: r => r.masked }, { label: '业务空间ID', val: r => r.wsId }, { label: '原价', val: r => r.gross.toFixed(6) }, { label: '上期费用', val: r => r.prevCost.toFixed(6) }, { label: '缓存命中 Token', val: r => Math.round(r.tCache) }, { label: '向量 Token', val: r => Math.round(r.tEmb) }, { label: '其他用量', val: r => r.units }, { label: '近30天', val: r => r.c30.toFixed(2) }, { label: '月度预算', val: r => r.budget ?? '' }, { label: '可访问模型', val: r => r.permTip }, { label: '创建人', val: r => r.createdBy }],
    footer: rs => cols.map(c => (c.key === 'desc' ? `合计 ${rs.length} 个` : c.key === 'cost' ? money(sum(rs, r => r.cost)) : c.key === 'chg' ? deltaPill(sum(rs, r => r.cost), sum(rs, r => r.prevCost)) : c.key === 'tIn' ? intFmt(sum(rs, r => r.tIn)) : c.key === 'tOut' ? intFmt(sum(rs, r => r.tOut)) : c.key === 'c7' ? money(sum(rs, r => r.c7)) : '')),
  }).setRows(rows);
  $('#onlySpent', v).onchange = e => { ui.onlySpent = e.target.checked; app.render(); };
  $('#csv', v).onclick = () => t.csv(`API_Key费用_${periodTag()}.csv`);

  // 热力
  const daily = filterLines(state.daily);
  const days = uniq(daily.map(l => l.date)).sort();
  const cell = new Map();
  daily.forEach(l => { const k = (l.apiKeyId || NONE_KEY) + '|' + l.date; cell.set(k, (cell.get(k) || 0) + metricVal(l)); });
  const ranked = sortedAggs(aggregate(daily, DIMS.key.of)).filter(a => a.cost > 0);
  heatmap($('#heat', v), {
    rows: ranked.slice(0, 30).map(a => ({ id: a.key, label: keyShort(a.key).slice(0, 16), color: DIMS.key.color(a.key), full: keyShort(a.key) })),
    cols: dayCols(days), cell: (r, c) => cell.get(r + '|' + c) || 0, total: r => ranked.find(a => a.key === r)?.cost || 0, fmt: money,
    rowTip: r => r.full, onRow: id => (id !== NONE_KEY ? app.go(`#/key/${id}`) : null),
  });
}

export function budgetCell(r) {
  if (!r.budget) return '<span class="muted">未设置</span>';
  const p = r.pretax / r.budget * 100, lv = budgetLevel(r.pretax, r.budget), fl = r.fc != null ? budgetLevel(r.fc, r.budget) : '';
  const color = lv === 'bad' ? 'var(--crit)' : lv === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return `<div class="mini-budget" title="预算 ${esc(money(r.budget))}${r.fc != null ? `，预计月末 ${esc(money(r.fc))}` : ''}"><span><b>${p.toFixed(0)}%</b> <span class="muted">/ ${esc(moneyShort(r.budget))}</span>${fl === 'bad' && lv !== 'bad' ? ' <span class="pill bad">预计超</span>' : ''}</span>
    <div class="progress"><i style="width:${Math.min(100, p).toFixed(1)}%;background:${color}"></i></div></div>`;
}
