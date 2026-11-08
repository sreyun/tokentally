/* API Key 详情：单个 Key 的费用、趋势、模型构成、计费项、渠道、权限与变更历史 */
import {
  $, esc, state, ui, app, http, money, moneyShort, compact, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, DIMS, keyObj, keyShort, keyDesc, wsName,
  aggregate, aggAll, sortedAggs, totalTokens, deltaPill, tipRows, icon, help, segCtl, fmtTime, budgetOf, budgetLevel, forecastOf, channelLabel,
  WEEK, weekday, ioInfo, num, periodTag, daysBetween, copyBtn, PROVIDERS, provTag, isAdmin, usageAgg, normModel,
} from '../core.js';
import { columnChart, rankList, segbar, legendList, legendHtml } from '../charts.js';
import { table, dataBar } from '../table.js';
import { billDimsHtml } from './models.js';
import { editTags } from './keys.js';
import { tokenStatsHtml, drawDailyTokens, drawDailyRequests } from '../stats.js';

export function render(v, id) {
  const k = keyObj(id);
  if (!k && id !== NONE_KEY) { v.innerHTML = `<button class="back" data-back="#/keys">${icon('chevL')}返回</button><div class="panel empty"><h2>未找到该 API Key</h2><div>ID ${esc(id)} 不在已同步的 Key 列表和当前账单中。</div><div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" data-go="#/keys">查看全部 API Key</button></div></div>`; return; }
  const of = l => (l.apiKeyId || NONE_KEY) === id;
  const lines = state.lines.filter(of), prevLines = state.prev.filter(of), daily = state.daily.filter(of), hist = state.history.filter(of);
  const a = aggAll(lines), pa = aggAll(prevLines);
  const p = state.data.period;
  const allByKey = sortedAggs(aggregate(state.lines, DIMS.key.of)).filter(x => x.cost > 0);
  const rank = allByKey.findIndex(x => x.key === id) + 1;
  const totalAll = sum(state.lines, metricVal);
  const tokens = totalTokens(a), ptokens = totalTokens(pa);
  const perM = tokens ? a.cost / tokens * 1e6 : null, pPerM = ptokens ? pa.cost / ptokens * 1e6 : null;
  const hit = a.tIn ? a.tCache / a.tIn : null, pHit = pa.tIn ? pa.tCache / pa.tIn : null;
  const budget = p.mode === 'month' ? budgetOf(id) : null;
  const fc = forecastOf(daily, l => l.pretax);
  const act = state.keyActivity.get(id);
  const kRows = state.usageRows.filter(u => u.apiKeyId === id);
  const us = kRows.length ? usageAgg(kRows, () => id).get(id) : null;
  const usByModel = usageAgg(kRows, u => normModel(u.model));
  const days = uniq(daily.map(l => l.date)).sort();
  const statusPill = id === NONE_KEY ? '<span class="pill neutral">非 Key 调用</span>'
    : k.source === 'deleted' ? `<span class="pill bad">已删除 ${fmtTime(k.deletedAt, false)}</span>` : k.source === 'bill' ? '<span class="pill warn">不在 Key 列表</span>'
      : k.disabled ? '<span class="pill bad">已禁用</span>' : '<span class="pill good">启用</span>';
  const ipOpen = k && (!(k.accessIps || []).length || k.accessIps.some(x => x === '0.0.0.0/0' || x === '::/0'));
  // 上一个 / 下一个：按本期费用从高到低，其次按 ID
  const costOf = new Map(allByKey.map(x => [x.key, x.cost]));
  const order = [...state.apiKeys.keys(), ...(costOf.has(NONE_KEY) ? [NONE_KEY] : [])]
    .sort((x, y) => (costOf.get(y) || 0) - (costOf.get(x) || 0) || String(y).localeCompare(String(x), 'en', { numeric: true }));
  const pos = order.indexOf(id), prevId = pos > 0 ? order[pos - 1] : null, nextId = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : null;

  v.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <button class="back" style="margin:0" data-back="#/keys">${icon('chevL')}返回</button>
      <div class="pager-nav" role="group" aria-label="切换 API Key">
        <button class="btn sm" ${prevId ? `data-go="#/key/${esc(prevId)}" data-nav="prev" title="上一个（[）：${esc(keyShort(prevId))}"` : 'disabled'}>${icon('chevL')}上一个</button>
        <span class="muted">${pos + 1} / ${order.length}</span>
        <button class="btn sm" ${nextId ? `data-go="#/key/${esc(nextId)}" data-nav="next" title="下一个（]）：${esc(keyShort(nextId))}"` : 'disabled'}>下一个${icon('chevR')}</button>
      </div>
    </div>
    <div class="entity-h">
      <span class="entity-ico">${icon('key')}</span>
      <div class="entity-t"><h2>${esc(keyShort(id))} ${provTag(k?.provider, !!k)} ${statusPill}${k && !k.description && id !== NONE_KEY ? '<span class="pill warn">无描述</span>' : ''}</h2>
        <div class="sub">${id === NONE_KEY ? '账单中 API Key 为空：控制台体验、订阅套餐、托管智能体、Batch 等非 API Key 调用，或腾讯云中未匹配到 Key 用量的费用'
          : `ID <span class="mono">${esc(id)}</span>${copyBtn(id, '复制 Key ID')} · <span class="mono">${esc(k.apiKeyValue || '—')}</span> · 业务空间 ${esc(wsName(k.wsKey))}${k.wsKey ? ` <span class="mono">${esc(k.wsKey)}</span>${copyBtn(k.wsKey, '复制业务空间ID')}` : ''} · 创建于 ${fmtTime(k.gmtCreate, false)}`}</div>
        ${k && id !== NONE_KEY ? `<div class="tag-line">${icon('tag')}<span>成本中心 <b>${esc(k.costCenter || '未分配')}</b></span><span>负责人 <b>${esc(k.owner || '—')}</b></span>${k.note || k.remark ? `<span class="muted" title="${esc(k.note ? '本地备注' : '云厂商备注')}">${esc(k.note || k.remark)}</span>` : ''}${isAdmin() ? `<button class="link" data-edit-tags>编辑</button>` : ''}</div>` : ''}</div>
      <div class="row"><span class="lbl muted" style="font-size:12px">费用口径</span>${segMetric()}<button class="btn" data-key-detail>${icon('list')}账单明细</button></div>
    </div>
    ${lines.some(l => l.alloc === 1) ? `<div class="notice info">${icon('info')}<div><b>费用按用量分摊</b><span class="why">腾讯云账单按推理服务 / 模型出账、不含 API Key。该 Key 的费用 = 每天各模型（输入 / 缓存命中 / 输出）真实账单金额 × 该 Key 在对应 Token 用量中的占比，所有 Key 合计与腾讯云账单一致。</span></div></div>` : ''}
    ${lines.some(l => l.alloc === 2) ? `<div class="notice warn">${icon('warn')}<div><b>费用为目录价估算</b><span class="why">腾讯云 CAM 子用户缺少计费只读权限，当前按 TokenHub 模型目录价 × 用量估算，未含折扣与阶梯价。</span></div></div>` : ''}
    <div class="kpi-wrap"><div class="kpi-row">
      ${tile('wallet', `本期费用 · ${METRICS[ui.f.metric]}`, money(a.cost), deltaPill(a.cost, pa.cost), state.compareLabel, `上期 ${money(pa.cost)} · 原价 ${moneyShort(a.gross)}`)}
      ${us ? tile('activity', '请求次数', compact(us.requests), '', '', `成功率 ${us.requests ? ((1 - us.fails / us.requests) * 100).toFixed(2) + '%' : '—'}`)
        : tile('layers', '费用排名', rank ? `第 ${rank}<small>/ ${allByKey.length}</small>` : '—', '', '', `占全部费用 ${pct(a.cost, totalAll)}`)}
      ${tile('token', 'Token 总量', compact(tokens), deltaPill(tokens, ptokens, { neutral: true }), state.compareLabel, `输入 ${compact(a.tIn)} · 输出 ${compact(a.tOut)}`)}
      ${tile('unit', '每百万 Token 成本', perM == null ? '—' : money(perM), perM == null ? '' : deltaPill(perM, pPerM), perM == null ? '' : state.compareLabel, '费用 ÷ 总 Token × 10⁶')}
      ${tile('cache', '缓存命中率', hit == null ? '—' : (hit * 100).toFixed(1) + '%', hit == null ? '' : deltaPill(hit, pHit, { pp: true, goodWhenUp: true }), hit == null ? '' : state.compareLabel, hit == null ? '—' : `命中 ${compact(a.tCache)} Token`)}
      ${budget ? budgetTile(a.pretax, budget, fc?.value ?? null)
        : tile('calendar', fc ? '预计本月' : '近 7 天', fc ? money(fc.value) : moneyShort(act?.c7 || 0), '', '', fc ? `日均 ${money(fc.avg)}` : `近 30 天 ${moneyShort(act?.c30 || 0)} · 最近 ${act?.lastDay ? act.lastDay.slice(5) : '—'}`)}
    </div></div>
    <div class="bi">
      <section class="panel c12"><div class="panel-h"><h3>Token 消耗与调用统计</h3>${help('Token 来自账单用量；请求次数、成功率与单次平均来自腾讯云 TokenHub 用量统计（阿里云账单不提供调用次数）。单次平均费用 = 本期费用 ÷ 请求次数。')}<span class="sub">${esc(p.mode === 'month' ? p.cycle + ' 账期' : `${p.from} ~ ${p.to}`)} · ${METRICS[ui.f.metric]}</span></div>
        ${tokenStatsHtml({ a, pa, daily, us, period: p, scope: 'key', provider: k?.provider || 'aliyun' })}</section>
      <section class="panel ${us ? 'c6' : 'c12'}"><div class="panel-h"><h3>每日 Token 消耗</h3><span class="sub">按 Token 类型堆叠 · 虚线为日均</span></div><div class="legend" id="kTokLegend"></div><div class="chart" id="kTok"></div></section>
      ${us ? `<section class="panel c6"><div class="panel-h"><h3>每日调用次数</h3>${help('来自腾讯云 TokenHub 用量统计（按 API Key × 模型 × 日）。悬停查看当日请求数、失败数与单次平均 Token。')}<span class="sub">成功 / 失败</span></div><div class="legend" id="kReqLegend"></div><div class="chart" id="kReq"></div></section>` : ''}
      <section class="panel c8"><div class="panel-h"><h3>每日费用</h3><span class="sub">按模型堆叠 · 虚线为日均</span></div><div class="legend" id="kLegend"></div><div class="chart" id="kDaily"></div></section>
      <section class="panel c4"><div class="panel-h"><h3>模型构成</h3><span class="sub">${a.models.size} 个模型</span></div><div id="kModels"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>月度费用</h3>${help('近 12 个账期的账期账单，按模型堆叠；范围取决于同步回溯月数。')}</div><div class="legend" id="kHLegend"></div><div class="chart" id="kHist"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>计费维度</h3><span class="sub">按费用拆分</span></div><div id="kDims"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>模型明细</h3><span class="sub">${esc(state.compareLabel)} · 点击查看模型详情</span><div class="actions"><button class="btn sm" id="csvM">${icon('download')}导出</button></div></div><div id="kModelTbl"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>计费项明细</h3><span class="sub">模型 × 计费项 × 单价</span><div class="actions"><button class="btn sm" id="csvI">${icon('download')}导出</button></div></div><div id="kItemTbl"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>调用渠道</h3></div><div id="kCh"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>权限与变更记录</h3>${help(`权限来自${PROVIDERS[k?.provider || 'aliyun']}同步；变更记录为每次同步检测到的描述、归属、权限等变化。`)}</div>
        <div class="kv" style="margin-bottom:14px">
          <div><span>模型权限</span><b>${!k ? '—' : k.authType === 'All' || k.allowAllModels ? '<span class="warn-text">全部模型</span>' : esc((k.accessibleModels || []).join('、') || '—')}</b></div>
          <div><span>IP 白名单</span><b class="mono">${!k ? '—' : ipOpen ? '<span class="warn-text">不限</span>' : esc(k.accessIps.join(', '))}</b></div>
          <div><span>最近消费 / 近 30 天</span><b>${esc(act?.lastDay || '—')} / ${money(act?.c30 || 0)}</b></div>
          <div><span>首次同步 / 最近同步</span><b>${fmtTime(k?.firstSeen)} / ${fmtTime(k?.lastSeen)}</b></div>
        </div>
        <div id="kChanges"><div class="nodata">加载中…</div></div></section>
    </div>`;

  // 每日（按模型）
  const ranked = sortedAggs(aggregate(daily, l => l.model)).map(x => x.key);
  const colored = ranked.slice(0, 7), others = ranked.slice(7);
  const series = colored.map((m, i) => ({ id: m, label: m, color: `var(--s${i + 1})` }));
  if (others.length) series.push({ id: '__other', label: `其他 ${others.length} 个模型`, color: 'var(--other)' });
  const cell = new Map();
  daily.forEach(l => { const kk = l.date + '|' + (colored.includes(l.model) ? l.model : '__other'); cell.set(kk, (cell.get(kk) || 0) + metricVal(l)); });
  $('#kLegend', v).innerHTML = series.length > 1 ? legendHtml(series) : '';
  const totalDaily = sum(daily, metricVal);
  const calDays = daysBetween(p.from, p.to < state.today ? p.to : state.today);
  columnChart($('#kDaily', v), { xs: days, series, cell: (x, s) => cell.get(x + '|' + s) || 0, avg: days.length ? totalDaily / Math.max(1, calDays) : null, height: 260, xLabel: x => x.slice(5), tipTitle: x => `${x}（周${WEEK[weekday(x)]}）`, empty: '本期无按日费用', onX: x => app.openDay(x, id), clickHint: '点击查看当日明细' });

  // 每日 Token（按类型堆叠）与每日调用次数
  drawDailyTokens($('#kTok', v), $('#kTokLegend', v), daily, p, { onX: x => app.openDay(x, id) });
  if (us) drawDailyRequests($('#kReq', v), $('#kReqLegend', v), us, p);

  // 模型构成
  const mAgg = sortedAggs(aggregate(lines, l => l.model)).filter(x => x.cost > 0);
  const colorOfModel = m => { const i = colored.indexOf(m); return i >= 0 ? `var(--s${i + 1})` : 'var(--other)'; };
  const parts = mAgg.slice(0, 7).map(x => ({ id: x.key, label: x.key, value: x.cost, color: colorOfModel(x.key) }));
  if (mAgg.length > 7) parts.push({ id: '__other', label: `其他 ${mAgg.length - 7} 个`, value: sum(mAgg.slice(7), x => x.cost), color: 'var(--other)' });
  $('#kModels', v).innerHTML = segbar(parts) + legendList(parts, a.cost);

  // 月度
  const hm = uniq(hist.map(l => l.date)).sort();
  const hRank = sortedAggs(aggregate(hist, l => l.model)).map(x => x.key);
  const hColored = hRank.slice(0, 6), hSeries = hColored.map(m => ({ id: m, label: m, color: colorOfModel(m) !== 'var(--other)' ? colorOfModel(m) : `var(--s${(hColored.indexOf(m) % 8) + 1})` }));
  if (hRank.length > 6) hSeries.push({ id: '__other', label: '其他模型', color: 'var(--other)' });
  const hc = new Map(); hist.forEach(l => { const kk = l.date + '|' + (hColored.includes(l.model) ? l.model : '__other'); hc.set(kk, (hc.get(kk) || 0) + metricVal(l)); });
  $('#kHLegend', v).innerHTML = hSeries.length > 1 ? legendHtml(hSeries) : '';
  columnChart($('#kHist', v), { xs: hm, series: hSeries, cell: (x, s) => hc.get(x + '|' + s) || 0, height: 220, xLabel: x => x.slice(2), tipTitle: x => `${x} 账期`, weekend: false, empty: '暂无历史账期数据', onX: x => app.setPeriod({ mode: 'month', cycle: x }), clickHint: '点击切换到该账期' });

  $('#kDims', v).innerHTML = billDimsHtml(lines);

  // 模型明细
  const pm = aggregate(prevLines, l => l.model);
  const max = Math.max(0, ...mAgg.map(x => x.cost));
  const tm = table('keyModels', $('#kModelTbl', v), {
    sort: 'cost', pageSize: 0, caption: '模型明细', onRowClick: r => app.openModel(r.model),
    columns: [
      { key: 'model', label: '模型', fmt: x => `<span class="sw" style="background:${colorOfModel(x)}"></span><span class="mono">${esc(x)}</span>` },
      { key: 'cost', label: `费用（${METRICS[ui.f.metric]}）`, align: 'r', fmt: x => dataBar(x, max) },
      { key: 'chg', label: state.compareLabel, align: 'r', fmt: (x, r) => deltaPill(r.cost, r.prev), sortVal: r => r.cost - r.prev },
      { key: 'share', label: '占比', align: 'r', fmt: x => (x * 100).toFixed(1) + '%' },
      { key: 'tIn', label: '输入 Token', align: 'r', fmt: x => intFmt(x) },
      { key: 'hit', label: '缓存命中率', align: 'r', fmt: x => (x == null ? '-' : (x * 100).toFixed(1) + '%'), sortVal: r => r.hit ?? -1 },
      { key: 'tOut', label: '输出 Token', align: 'r', fmt: x => intFmt(x) },
      { key: 'perM', label: '¥/百万Token', align: 'r', fmt: x => (x == null ? '-' : money(x)), sortVal: r => r.perM ?? -1 },
      { key: 'days', label: '使用天数', align: 'r' },
      ...(us ? [
        { key: 'req', label: '请求数', align: 'r', fmt: x => (x == null ? '—' : intFmt(x)), sortVal: r => r.req ?? -1 },
        { key: 'fail', label: '失败率', align: 'r', fmt: x => (x == null ? '—' : (x * 100).toFixed(2) + '%'), sortVal: r => r.fail ?? -1 },
        { key: 'tokPer', label: '单次均 Token', align: 'r', fmt: x => (x == null ? '—' : intFmt(x)), sortVal: r => r.tokPer ?? -1 },
        { key: 'costPer', label: '单次均费用', align: 'r', fmt: x => (x == null ? '—' : money(x, x < 0.01 ? 4 : 3)), sortVal: r => r.costPer ?? -1 },
      ] : []),
    ],
    footer: rs => ['合计', money(sum(rs, r => r.cost)), deltaPill(sum(rs, r => r.cost), sum(rs, r => r.prev)), '', intFmt(sum(rs, r => r.tIn)), '', intFmt(sum(rs, r => r.tOut)), '', '', ...(us ? [intFmt(us.requests), us.requests ? (us.fails / us.requests * 100).toFixed(2) + '%' : '—', us.requests ? intFmt(us.tokens / us.requests) : '—', us.requests ? money(a.cost / us.requests, 4) : '—'] : [])],
  }).setRows(mAgg.map(x => {
    const t = totalTokens(x), um = usByModel.get(normModel(x.key));
    return { model: x.key, cost: x.cost, prev: pm.get(x.key)?.cost || 0, share: a.cost ? x.cost / a.cost : 0, tIn: x.tIn, tOut: x.tOut, hit: x.tIn ? x.tCache / x.tIn : null, perM: t ? x.cost / t * 1e6 : null, days: uniq(daily.filter(l => l.model === x.key && metricVal(l) > 0).map(l => l.date)).length, req: um ? um.requests : null, fail: um && um.requests ? um.fails / um.requests : null, tokPer: um && um.requests ? um.tokens / um.requests : null, costPer: um && um.requests ? x.cost / um.requests : null };
  }));
  $('#csvM', v).onclick = () => tm.csv(`Key_${id}_模型明细_${periodTag()}.csv`);

  // 计费项
  const byItem = aggregate(lines, l => `${l.model}\u0001${l.io}\u0001${l.listPrice}\u0001${l.usageUnit}\u0001${l.listPriceUnit}`);
  const ti = table('keyItems', $('#kItemTbl', v), {
    sort: 'cost', pageSize: 50, caption: '计费项明细',
    columns: [
      { key: 'model', label: '模型', cls: 'mono' },
      { key: 'label', label: '计费项', fmt: (x, r) => `${esc(x)}<span class="sub mono">${esc(r.io)}</span>` },
      { key: 'price', label: '单价', align: 'r', fmt: (x, r) => (x !== '' ? `${esc(x)}<span class="sub">${esc(r.priceUnit)}</span>` : '-'), sortVal: r => num(r.price) },
      { key: 'usage', label: '用量', align: 'r', fmt: (x, r) => `${intFmt(x)}<span class="sub">${esc(r.unit)}</span>` },
      { key: 'tokens', label: 'Token', align: 'r', fmt: x => intFmt(x) },
      { key: 'gross', label: '原价', align: 'r', fmt: x => money(x) },
      { key: 'cost', label: '费用', align: 'r', fmt: x => money(x) },
      { key: 'share', label: '占比', align: 'r', fmt: x => (x * 100).toFixed(1) + '%' },
    ],
    footer: rs => ['合计', '', '', '', intFmt(sum(rs, r => r.tokens)), money(sum(rs, r => r.gross)), money(sum(rs, r => r.cost)), ''],
  }).setRows([...byItem.values()].map(x => {
    const [model, io, price, unit, priceUnit] = x.key.split('\u0001');
    return { model, io, label: ioInfo(io).label, price, priceUnit, unit, usage: sum(lines.filter(l => `${l.model}\u0001${l.io}\u0001${l.listPrice}\u0001${l.usageUnit}\u0001${l.listPriceUnit}` === x.key), l => l.usage || 0), tokens: totalTokens(x), gross: x.gross, cost: x.cost, share: a.cost ? x.cost / a.cost : 0 };
  }));
  $('#csvI', v).onclick = () => ti.csv(`Key_${id}_计费项_${periodTag()}.csv`);

  rankList($('#kCh', v), sortedAggs(aggregate(lines, l => l.channel)).map(x => ({ id: x.key, label: channelLabel(x.key), sub: x.key || '', value: x.cost })), { total: a.cost });
  v.querySelector('[data-key-detail]').onclick = () => app.setFilter({ key: id }, '#/detail', true);
  v.querySelector('[data-edit-tags]')?.addEventListener('click', () => editTags([id]));
  loadChanges(v, id);
}

function budgetTile(used, budget, fcv) {
  const p = used / budget * 100, lv = budgetLevel(used, budget), fl = fcv != null ? budgetLevel(fcv, budget) : '';
  const color = lv === 'bad' ? 'var(--crit)' : lv === 'warn' ? 'var(--warn)' : 'var(--accent)';
  const cls = x => (x === 'bad' ? 'bad-text' : x === 'warn' ? 'warn-text' : '');
  return `<section class="kpi"><div class="kpi-h"><span class="kpi-ico">${icon('wallet')}</span><span>月度预算 ${esc(moneyShort(budget))}</span></div>
    <div class="value ${cls(lv)}">${p.toFixed(1)}%<small>已用</small></div>
    <div class="progress" style="margin:6px 0 2px"><i style="width:${Math.min(100, p).toFixed(1)}%;background:${color}"></i></div>
    <div class="meta ${cls(fl)}" title="${fcv != null ? esc(`预计月末 ${money(fcv)}`) : ''}">${fcv != null ? `预计月末 ${esc(moneyShort(fcv))}（${(fcv / budget * 100).toFixed(0)}%）${fcv > budget ? ' · 将超支' : ''}` : `剩余 ${esc(moneyShort(Math.max(0, budget - used)))}`}</div></section>`;
}
function segMetric() {
  return `<div class="seg sm" role="group" aria-label="费用口径">${Object.entries(METRICS).map(([k, l]) => `<button type="button" data-metric="${k}" aria-pressed="${ui.f.metric === k}">${l.replace('金额', '')}</button>`).join('')}</div>`;
}
function tile(ic, label, value, delta, cmp, meta) {
  return `<section class="kpi"><div class="kpi-h"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span></div><div class="value">${value}</div>
    <div class="trend">${delta || ''}${delta && cmp ? `<span class="cmp">${esc(cmp)}</span>` : ''}</div><div class="meta" title="${esc(meta)}">${esc(meta)}</div></section>`;
}
const FIELD = { remark: '备注', description: '描述', workspace_id: '业务空间ID', workspace_name: '业务空间', disabled: '禁用', auth_type: '授权类型', allow_all_models: '全部模型', accessible_models: '可访问模型', access_ips: 'IP 白名单', api_key_masked: 'API Key' };
const CHG = { create: ['新增', 'good'], update: ['修改', 'warn'], delete: ['删除', 'bad'], restore: ['恢复', 'good'] };
async function loadChanges(v, id) {
  const el = $('#kChanges', v);
  if (!el) return;
  try {
    if (!state.changes) state.changes = (await http('GET', '/api/changes')).changes;
    const list = state.changes.filter(c => c.entity === 'api_key' && c.entity_id === id);
    const fmt = s => { try { const o = JSON.parse(s || 'null'); return o ? Object.entries(o).map(([kk, x]) => `${FIELD[kk] || kk}：${x == null || x === '' ? '（空）' : x}`).join('；') : ''; } catch { return ''; } };
    el.innerHTML = list.length ? `<ul class="timeline">${list.map(c => `<li><span class="pill ${CHG[c.change]?.[1] || 'neutral'}">${CHG[c.change]?.[0] || esc(c.change)}</span><div><b>${fmtTime(c.ts)}</b>${c.change === 'update' ? `<div class="muted">${esc(fmt(c.before_json))} → ${esc(fmt(c.after_json))}</div>` : ''}</div></li>`).join('')}</ul>` : '<div class="nodata">暂无变更记录</div>';
  } catch (e) { el.innerHTML = `<div class="nodata bad-text">${esc(e.message)}</div>`; }
}
