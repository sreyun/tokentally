/* =========================================================================
 * 成本概览邮件：在服务端按与“成本概览”页面相同的口径汇总，生成邮件客户端可显示的 HTML（表格 + 内联样式，无脚本 / 外链图片）
 * 内容：本期费用（原价 / 折扣 / 优惠券 / 应付）与环比、预算与预测、6 项指标、每日费用与 Token 趋势、
 *      API Key 与模型排行、费用构成（业务空间 / Token 类型）、变动归因、Key 治理、关键发现
 * 口径：应付金额（与费用中心一致）；Token 类型分类与前端一致
 * ========================================================================= */
import { addDays, addMonths } from './sync.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = n => (n < 0 ? '-' : '') + '¥' + Math.abs(Number(n || 0)).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b, d = 1) => (b ? (a / b * 100).toFixed(d) + '%' : '-');
const compact = n => { n = Number(n || 0); const a = Math.abs(n); return a >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : a >= 1e4 ? (n / 1e4).toFixed(2) + '万' : Math.round(n).toLocaleString('zh-CN'); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;
const lastDayOf = c => addDays(addMonths(c, 1) + '-01', -1);
const rowsOf = blk => (blk?.rows || []).map(r => Object.fromEntries(blk.cols.map((c, i) => [c, r[i]])));
/** Token 类型（与前端 ioInfo 一致）：输入（非缓存）/ 缓存命中 / 缓存创建 / 输出 / 向量 / 其他 */
function tokType(io) {
  let s = String(io || '');
  const m = s.match(/^context_([^_]+)_(.+)$/); if (m) s = m[2];
  if (/^thinking_/.test(s)) s = s.slice(9);
  s = s.replace(/_(offpeak|peak)$/, '');
  const dir = /^output/.test(s) ? 'out' : /^input/.test(s) ? 'in' : /^embedding/.test(s) ? 'emb' : 'other';
  if (dir === 'in') return /cache_creation/.test(s) ? 'create' : /cache/.test(s) ? 'hit' : 'in';
  return dir;
}
const TOK = { in: ['输入（非缓存）', '#2a78d6'], hit: ['缓存命中', '#1baf7a'], create: ['缓存创建', '#eda100'], out: ['输出', '#eb6834'], emb: ['向量', '#6250d6'], other: ['其他', '#b5b8bf'] };
const PAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

function agg(lines, keyFn) {
  const m = new Map();
  for (const l of lines) {
    const k = keyFn(l); let a = m.get(k);
    if (!a) m.set(k, a = { key: k, cost: 0, gross: 0, after: 0, tokens: 0, tIn: 0, tHit: 0, tOut: 0 });
    a.cost += l.pretax || 0; a.gross += l.gross || 0; a.after += l.after_discount ?? l.pretax ?? 0;
    if (l.tokens) { a.tokens += l.tokens; const t = tokType(l.io); if (t === 'in' || t === 'hit' || t === 'create') a.tIn += l.tokens; if (t === 'hit') a.tHit += l.tokens; if (t === 'out') a.tOut += l.tokens; }
  }
  return m;
}
const total = lines => agg(lines, () => 'all').get('all') || { cost: 0, gross: 0, after: 0, tokens: 0, tIn: 0, tHit: 0, tOut: 0 };
const delta = (c, p, goodWhenUp = false) => {
  if (!p) return c > 0.005 ? '<span style="color:#475569">新增</span>' : '';
  const d = (c - p) / p * 100, up = d >= 0, good = goodWhenUp ? up : !up;
  return `<span style="color:${Math.abs(d) < 0.05 ? '#475569' : good ? '#15803d' : '#b42318'}">${up ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}%</span>`;
};

/* ---------------- HTML 片段 ---------------- */
const S = {
  card: 'background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin:0 0 14px',
  h2: 'margin:0 0 10px;font-size:15px;font-weight:700;color:#0f172a',
  sub: 'font-size:12px;color:#64748b;font-weight:400;margin-left:6px',
  td: 'padding:6px 8px;border-bottom:1px solid #eef2f7;font-size:13px;color:#0f172a',
  th: 'padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;text-align:left;font-weight:600;background:#f7f9fc',
};
const section = (title, sub, inner) => `<div style="${S.card}"><div style="${S.h2}">${esc(title)}${sub ? `<span style="${S.sub}">${esc(sub)}</span>` : ''}</div>${inner}</div>`;
const bar = (v, max, color = '#2563eb', w = 120) => `<div style="width:${w}px;height:6px;background:#eef2f7;border-radius:3px;overflow:hidden"><div style="width:${max > 0 ? Math.max(1, Math.round(v / max * w)) : 0}px;height:6px;background:${color};border-radius:3px"></div></div>`;

/** 柱状图（表格实现，兼容主流邮件客户端）：xs 横轴，series [{label,color}]，cell(x, i) 值 */
function columns(xs, series, cell, fmt, height = 120) {
  if (!xs.length) return '<div style="color:#64748b;font-size:13px;padding:12px 0">暂无数据</div>';
  const totals = xs.map(x => series.reduce((s, _, i) => s + Math.max(0, cell(x, i)), 0));
  const max = Math.max(...totals, 0) || 1;
  const every = Math.max(1, Math.ceil(xs.length / 12));
  const colW = Math.max(6, Math.min(22, Math.floor(640 / xs.length) - 4));
  const tds = xs.map((x, k) => {
    const segs = series.map((sr, i) => ({ c: sr.color, h: Math.round(Math.max(0, cell(x, i)) / max * height) })).filter(z => z.h > 0).reverse();
    return `<td valign="bottom" align="center" style="padding:0 1px;height:${height}px" title="${esc(x)} ${esc(fmt(totals[k]))}">${segs.map(z => `<div style="width:${colW}px;height:${z.h}px;background:${z.c};margin:0 auto"></div>`).join('')}</td>`;
  }).join('');
  const labels = xs.map((x, k) => `<td align="center" style="font-size:10px;color:#94a3b8;padding-top:4px;white-space:nowrap">${k % every === 0 ? esc(x.length === 10 ? x.slice(5) : x.slice(2)) : ''}</td>`).join('');
  const legend = series.length > 1 ? `<div style="margin:0 0 8px;font-size:12px;color:#334155">${series.map(s => `<span style="display:inline-block;margin-right:12px"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${s.color};margin-right:4px"></span>${esc(s.label)}</span>`).join('')}</div>` : '';
  const peak = totals.indexOf(Math.max(...totals));
  return `${legend}<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse"><tr>${tds}</tr><tr>${labels}</tr></table>
    <div style="font-size:12px;color:#64748b;margin-top:6px">合计 ${esc(fmt(totals.reduce((a, b) => a + b, 0)))} · 峰值 ${esc(xs[peak].length === 10 ? xs[peak].slice(5) : xs[peak])} ${esc(fmt(totals[peak]))}</div>`;
}

function rankTable(items, { total: tot, nameHead, extra }) {
  if (!items.length) return '<div style="color:#64748b;font-size:13px">暂无数据</div>';
  const max = Math.max(...items.map(i => i.cost)) || 1;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
    <tr><th style="${S.th}">#</th><th style="${S.th}">${esc(nameHead)}</th><th style="${S.th};text-align:right">应付金额</th><th style="${S.th}">占比</th><th style="${S.th};text-align:right">环比</th></tr>
    ${items.map((it, i) => `<tr><td style="${S.td};color:#64748b">${i + 1}</td><td style="${S.td}">${esc(it.name)}${it.sub ? `<div style="font-size:11px;color:#64748b">${esc(it.sub)}</div>` : ''}</td>
      <td style="${S.td};text-align:right;font-weight:600;white-space:nowrap">${yuan(it.cost)}</td>
      <td style="${S.td}"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td>${bar(it.cost, max, PAL[i % 8], 90)}</td><td style="font-size:12px;color:#64748b;padding-left:6px">${pct(it.cost, tot)}</td></tr></table></td>
      <td style="${S.td};text-align:right;white-space:nowrap">${delta(it.cost, it.prev)}</td></tr>`).join('')}
    ${extra ? `<tr><td colspan="5" style="font-size:12px;color:#64748b;padding:8px">${esc(extra)}</td></tr>` : ''}</table>`;
}

/**
 * 生成成本概览 HTML。spec: { mode: 'month', cycle } | { mode: 'range', from, to }
 * ctx: { store, today, brand, link, governance }
 */
export function renderOverviewHtml(spec, { store, today, link = '', scope = null }) {
  const keys = new Map(store.listApiKeys().map(k => [k.api_key_id, k]));
  const wsNames = new Map(store.listWorkspaces().map(w => [w.workspace_id, w.name || w.workspace_name]));
  const inScope = scopePredicate(scope, keys);
  const scopeKeys = !inScope ? null : scope.type === 'key' ? new Set(scope.ids) : new Set([...keys.values()].filter(k => scope.ids.includes(k.workspace_id)).map(k => k.api_key_id));
  const keyName = id => (!id ? '无 API Key（控制台 / 订阅等）' : keys.get(id)?.description || id);
  for (const k of keys.values()) if (k.workspace_id && k.workspace_name && !wsNames.has(k.workspace_id)) wsNames.set(k.workspace_id, k.workspace_name);
  const wsName = id => (!id ? '（未归属业务空间）' : wsNames.get(id) || id);
  let lines, daily, prev, from, to, label, prevLabel, isCurrent = false, daysInPeriod;
  if (spec.mode === 'month') {
    const c = spec.cycle, last = lastDayOf(c);
    isCurrent = c === today.slice(0, 7);
    from = c + '-01'; to = isCurrent ? today : last;
    daysInPeriod = daysBetween(from, last);
    lines = rowsOf(store.queryLines('M', c, c));
    daily = rowsOf(store.queryLines('D', from, last, true));
    const pc = addMonths(c, -1);
    if (isCurrent) {
      const n = daysBetween(from, today), pTo = addDays(pc + '-01', n - 1) > lastDayOf(pc) ? lastDayOf(pc) : addDays(pc + '-01', n - 1);
      prev = rowsOf(store.queryAgg('D', pc + '-01', pTo)); prevLabel = `上月同期（${pc}-01 ~ ${pTo.slice(5)}）`;
    } else { prev = rowsOf(store.queryAgg('M', pc, pc)); prevLabel = `上月（${pc}）`; }
    label = `${c} 账期${isCurrent ? `（截至 ${today.slice(5)}，未出账）` : ''}`;
  } else {
    from = spec.from; to = spec.to; daysInPeriod = daysBetween(from, to);
    lines = rowsOf(store.queryLines('D', from, to)); daily = lines;
    const pTo = addDays(from, -1), pFrom = addDays(from, -daysInPeriod);
    prev = rowsOf(store.queryAgg('D', pFrom, pTo)); prevLabel = `上一周期（${pFrom.slice(5)} ~ ${pTo.slice(5)}）`;
    label = `${from} ~ ${to}`;
  }
  if (inScope) { lines = lines.filter(inScope); daily = spec.mode === 'month' ? daily.filter(inScope) : lines; prev = prev.filter(inScope); }
  const cur = total(lines), pv = total(prev);
  const days = [...new Set(daily.map(l => l.period))].sort();
  const elapsed = Math.max(1, Math.min(daysInPeriod, daysBetween(from, (to < today ? to : today))));
  const avgDay = cur.cost / elapsed;
  // 预测（与前端一致）：已完整的日 + max(今日, 日均) + 日均 × 剩余天数
  let forecast = null;
  if (spec.mode === 'month' && isCurrent) {
    const y = addDays(today, -1);
    if (y >= from) {
      const fullDays = daysBetween(from, y);
      const full = daily.filter(l => l.period <= y).reduce((s, l) => s + (l.pretax || 0), 0);
      const td = daily.filter(l => l.period === today).reduce((s, l) => s + (l.pretax || 0), 0);
      const avg = full / fullDays;
      forecast = full + Math.max(td, avg) + avg * Math.max(0, daysInPeriod - fullDays - 1);
    }
  }
  // 预算：全部范围用月度总预算；限定范围时用范围内 API Key 预算之和（未设置则不显示）
  const bset = store.budgets();
  const budget = spec.mode !== 'month' ? null : !inScope ? bset.monthly : ([...scopeKeys].reduce((s, id) => s + (Number(bset.keys?.[id]) || 0), 0) || null);
  const byKey = agg(lines, l => l.api_key_id || ''), pByKey = agg(prev, l => l.api_key_id || '');
  const byModel = agg(lines, l => l.model || '(未知模型)'), pByModel = agg(prev, l => l.model || '(未知模型)');
  const byWs = agg(lines, l => l.workspace_id || '');
  const activeKeys = [...byKey.values()].filter(a => a.key && a.cost > 0).length, pActive = [...pByKey.values()].filter(a => a.key && a.cost > 0).length;
  const models = [...byModel.values()].filter(a => a.cost > 0).length;
  const perM = cur.tokens ? cur.cost / cur.tokens * 1e6 : null, pPerM = pv.tokens ? pv.cost / pv.tokens * 1e6 : null;
  const hit = cur.tIn ? cur.tHit / cur.tIn : null, pHit = pv.tIn ? pv.tHit / pv.tIn : null;
  const discount = cur.gross - cur.after, coupons = cur.after - cur.cost;

  /* 1. 本期费用 */
  const stat = (k, v) => `<td style="padding:6px 10px 0 0;vertical-align:top"><div style="font-size:12px;color:#64748b">${esc(k)}</div><div style="font-size:14px;font-weight:600;color:#0f172a;white-space:nowrap">${esc(v)}</div></td>`;
  const budgetHtml = budget ? (() => {
    const used = cur.cost / budget, color = used >= 1 ? '#d03b3b' : used >= 0.8 ? '#eda100' : '#2563eb';
    return `<div style="margin-top:12px;font-size:12px;color:#64748b">月度预算 ${yuan(budget)} · 已用 <b style="color:#0f172a">${pct(cur.cost, budget)}</b>${forecast != null ? ` · 预计月末 <b style="color:${forecast > budget ? '#b42318' : '#0f172a'}">${yuan(forecast)}</b>${forecast > budget ? `（超出 ${yuan(forecast - budget)}）` : ''}` : ''}</div>
      <div style="margin-top:6px;height:8px;background:#eef2f7;border-radius:4px;overflow:hidden"><div style="width:${Math.min(100, Math.round(used * 100))}%;height:8px;background:${color}"></div></div>`;
  })() : '';
  const hero = `<div style="${S.card};background:#f5f8ff;border-color:#dbe6fd">
    <div style="font-size:13px;color:#334155">${esc(label)} · 应付金额</div>
    <div style="font-size:34px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;margin:6px 0 2px">${yuan(cur.cost)}</div>
    <div style="font-size:13px;color:#64748b">${delta(cur.cost, pv.cost)} 较${esc(prevLabel)} ${yuan(pv.cost)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:10px"><tr>${stat('原价', yuan(cur.gross))}${stat('折扣', yuan(discount))}${stat('优惠券抵扣', yuan(coupons))}${stat('综合折扣', cur.gross ? pct(cur.gross - cur.cost, cur.gross) : '-')}${stat('日均', yuan(avgDay))}</tr></table>
    ${budgetHtml}</div>`;

  /* 2. 指标 */
  const kpi = (k, v, d, meta) => `<td width="33%" style="padding:6px;vertical-align:top"><div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;background:#ffffff">
    <div style="font-size:12px;color:#64748b">${esc(k)}</div><div style="font-size:20px;font-weight:700;color:#0f172a;margin:4px 0 2px;white-space:nowrap">${esc(v)}</div>
    <div style="font-size:12px;min-height:16px">${d || ''}</div><div style="font-size:11px;color:#64748b;margin-top:2px">${esc(meta || '')}</div></div></td>`;
  const top1 = [...byKey.values()].filter(a => a.cost > 0).sort((a, b) => b.cost - a.cost)[0];
  const kpis = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 -6px 8px"><tr>
    ${forecast != null ? kpi('预计本月费用', yuan(forecast), '', '按已完整日的日均推算') : kpi('日均费用', yuan(avgDay), '', `${elapsed} 天`)}
    ${kpi('活跃 API Key', `${activeKeys} / ${inScope ? scopeKeys.size : keys.size}`, delta(activeKeys, pActive, true), top1 ? `最高：${keyName(top1.key)} 占 ${pct(top1.cost, cur.cost)}` : '')}
    ${kpi('Token 总量', compact(cur.tokens), delta(cur.tokens, pv.tokens, true), `输入 ${compact(cur.tIn)} · 输出 ${compact(cur.tOut)}`)}</tr><tr>
    ${kpi('每百万 Token 成本', perM == null ? '—' : yuan(perM), perM != null && pPerM ? delta(perM, pPerM) : '', '应付 ÷ Token × 10⁶')}
    ${kpi('缓存命中率', hit == null ? '—' : (hit * 100).toFixed(1) + '%', hit != null && pHit != null ? `<span style="color:${hit >= pHit ? '#15803d' : '#b42318'}">${hit >= pHit ? '▲' : '▼'} ${Math.abs((hit - pHit) * 100).toFixed(1)}pp</span>` : '', '缓存命中 ÷ 输入 Token')}
    ${kpi('使用模型', String(models), '', models ? `主力：${[...byModel.values()].sort((a, b) => b.cost - a.cost)[0].key}` : '')}</tr></table>`;

  /* 3. 趋势 */
  const topKeys = [...agg(daily, l => l.api_key_id || '').values()].filter(a => a.cost > 0).sort((a, b) => b.cost - a.cost);
  const shown = topKeys.slice(0, 7).map(a => a.key), rest = topKeys.length > 7;
  const cSeries = shown.map((k, i) => ({ label: keyName(k), color: PAL[i] })).concat(rest ? [{ label: `其他 ${topKeys.length - 7} 项`, color: '#b5b8bf' }] : []);
  const cCell = new Map();
  for (const l of daily) { const i = shown.indexOf(l.api_key_id || ''); const k = l.period + '|' + (i >= 0 ? i : shown.length); cCell.set(k, (cCell.get(k) || 0) + (l.pretax || 0)); }
  const costChart = columns(days, cSeries, (x, i) => cCell.get(x + '|' + i) || 0, yuan);
  const tTypes = Object.keys(TOK).filter(t => daily.some(l => l.tokens && tokType(l.io) === t));
  const tCell = new Map();
  for (const l of daily) if (l.tokens) { const k = l.period + '|' + tTypes.indexOf(tokType(l.io)); tCell.set(k, (tCell.get(k) || 0) + l.tokens); }
  const tokChart = columns(days, tTypes.map(t => ({ label: TOK[t][0], color: TOK[t][1] })), (x, i) => tCell.get(x + '|' + i) || 0, compact);

  /* 4. 排行 */
  const keyItems = [...byKey.values()].filter(a => a.cost > 0).sort((a, b) => b.cost - a.cost);
  const kRank = rankTable(keyItems.slice(0, 10).map(a => ({ name: keyName(a.key), sub: a.key ? `${a.key}${keys.get(a.key)?.workspace_name ? ' · ' + keys.get(a.key).workspace_name : ''}` : '', cost: a.cost, prev: pByKey.get(a.key)?.cost || 0 })), { total: cur.cost, nameHead: 'API Key', extra: keyItems.length > 10 ? `另有 ${keyItems.length - 10} 个 Key 未显示` : '' });
  const modelItems = [...byModel.values()].filter(a => a.cost > 0).sort((a, b) => b.cost - a.cost);
  const mRank = rankTable(modelItems.slice(0, 10).map(a => ({ name: a.key, sub: `${compact(a.tokens)} Token`, cost: a.cost, prev: pByModel.get(a.key)?.cost || 0 })), { total: cur.cost, nameHead: '模型', extra: modelItems.length > 10 ? `另有 ${modelItems.length - 10} 个模型未显示` : '' });

  /* 5. 构成 */
  const parts = (items, nameOf) => {
    const tot = items.reduce((s, a) => s + a.v, 0);
    if (!tot) return '<div style="color:#64748b;font-size:13px">暂无数据</div>';
    const top = items.slice(0, 7), other = items.slice(7).reduce((s, a) => s + a.v, 0);
    const rows = top.map((a, i) => ({ name: nameOf(a), v: a.v, c: a.c || PAL[i] })).concat(other > 0.005 ? [{ name: '其他', v: other, c: '#b5b8bf' }] : []);
    const segbar = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:8px"><tr>${rows.filter(r => r.v / tot >= 0.005).map(r => `<td style="height:14px;background:${r.c};width:${(r.v / tot * 100).toFixed(1)}%"></td>`).join('')}</tr></table>`;
    return segbar + `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows.map(r => `<tr><td style="padding:3px 0;font-size:13px"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${r.c};margin-right:6px"></span>${esc(r.name)}</td><td style="text-align:right;font-size:13px;font-weight:600;white-space:nowrap">${esc(yuan(r.v))}</td><td style="text-align:right;font-size:12px;color:#64748b;width:56px">${pct(r.v, tot)}</td></tr>`).join('')}</table>`;
  };
  const wsItems = [...byWs.values()].filter(a => a.cost > 0).sort((a, b) => b.cost - a.cost).map(a => ({ k: a.key, v: a.cost }));
  const typeCost = new Map(); for (const l of lines) { const t = l.tokens != null ? tokType(l.io) : 'other'; typeCost.set(t, (typeCost.get(t) || 0) + (l.pretax || 0)); }
  const typeItems = Object.keys(TOK).filter(t => (typeCost.get(t) || 0) > 0.005).map(t => ({ k: t, v: typeCost.get(t), c: TOK[t][1] }));
  const wsName2 = a => wsName(a.k); const typeName = a => (a.k === 'other' ? '其他 / 订阅 / 按次' : TOK[a.k][0]);
  const comp = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%"><tr>
    <td width="50%" style="vertical-align:top;padding-right:10px"><div style="font-size:12px;color:#64748b;margin-bottom:6px">按业务空间</div>${parts(wsItems, wsName2)}</td>
    <td width="50%" style="vertical-align:top;padding-left:10px"><div style="font-size:12px;color:#64748b;margin-bottom:6px">按 Token 类型</div>${parts(typeItems, typeName)}</td></tr></table>`;

  /* 6. 变动归因（按 API Key） */
  const ids = new Set([...byKey.keys(), ...pByKey.keys()]);
  const vars = [...ids].map(id => ({ id, d: (byKey.get(id)?.cost || 0) - (pByKey.get(id)?.cost || 0), c: byKey.get(id)?.cost || 0, p: pByKey.get(id)?.cost || 0 })).filter(v => Math.abs(v.d) >= 0.005).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 8);
  const vmax = Math.max(...vars.map(v => Math.abs(v.d)), 0) || 1;
  const variance = vars.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${vars.map(v => `<tr><td style="${S.td}">${esc(keyName(v.id))}</td><td style="${S.td}">${bar(Math.abs(v.d), vmax, v.d > 0 ? '#e34948' : '#2a78d6', 110)}</td><td style="${S.td};text-align:right;font-weight:600;white-space:nowrap;color:${v.d > 0 ? '#b42318' : '#15803d'}">${v.d > 0 ? '+' : '−'}${yuan(Math.abs(v.d)).replace('-', '')}</td><td style="${S.td};text-align:right;white-space:nowrap">${delta(v.c, v.p)}</td></tr>`).join('')}</table>` : '<div style="color:#64748b;font-size:13px">与上期相比没有变化</div>';

  /* 7. Key 治理（与页面规则一致的核心项） */
  const spent = new Set(keyItems.map(a => a.key).filter(Boolean));
  const gov = [];
  const disabledSpent = [...spent].filter(id => keys.get(id)?.disabled || keys.get(id)?.deleted_at);
  if (disabledSpent.length) gov.push(['高', '#b42318', '已禁用 / 已删除仍产生费用', disabledSpent]);
  const noDesc = [...spent].filter(id => keys.has(id) && !String(keys.get(id).description || '').trim());
  if (noDesc.length) gov.push(['中', '#8a5a00', '有消费但无描述', noDesc]);
  const broad = [...keys.values()].filter(k => (!scopeKeys || scopeKeys.has(k.api_key_id)) && !k.deleted_at && !k.disabled && k.allow_all_models && !(k.access_ips && !/^\s*(\[\s*\]|0\.0\.0\.0\/0)?\s*$/.test(k.access_ips))).map(k => k.api_key_id);
  if (broad.length) gov.push(['中', '#8a5a00', '权限过宽（全部模型 + IP 不限）', broad]);
  const govHtml = gov.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${gov.map(([lv, c, name, list]) => `<tr><td style="${S.td};width:36px"><span style="display:inline-block;padding:1px 6px;border-radius:9px;background:${c}1a;color:${c};font-size:11px;font-weight:600">${lv}</span></td><td style="${S.td}">${esc(name)}<div style="font-size:11px;color:#64748b">${esc(list.slice(0, 5).map(keyName).join('、'))}${list.length > 5 ? ` 等 ${list.length} 个` : ''}</div></td><td style="${S.td};text-align:right;font-weight:600">${list.length}</td></tr>`).join('')}</table>` : '<div style="color:#15803d;font-size:13px">未发现治理问题</div>';

  /* 8. 关键发现 */
  const ins = [];
  if (budget && forecast != null && forecast > budget) ins.push(`<b>预计超出月度预算 ${yuan(forecast - budget)}</b>：按已完整日的日均推算本月约 ${yuan(forecast)}，预算 ${yuan(budget)}，当前已用 ${pct(cur.cost, budget)}。`);
  else if (budget && cur.cost >= budget) ins.push(`<b>本月已超出预算</b>：应付 ${yuan(cur.cost)}，预算 ${yuan(budget)}。`);
  if (pv.cost > 0.005 && Math.abs(cur.cost - pv.cost) / pv.cost >= 0.1) {
    const drv = vars.filter(v => Math.sign(v.d) === Math.sign(cur.cost - pv.cost)).slice(0, 2).map(v => `${esc(keyName(v.id))}（${v.d > 0 ? '+' : '−'}${yuan(Math.abs(v.d))}）`).join('、');
    ins.push(`<b>费用较${esc(prevLabel)}${cur.cost > pv.cost ? '上升' : '下降'} ${pct(Math.abs(cur.cost - pv.cost), pv.cost)}</b>：本期 ${yuan(cur.cost)}，上期 ${yuan(pv.cost)}${drv ? `，主要来自 ${drv}` : ''}。`);
  }
  if (keyItems.length >= 3 && cur.cost > 0 && keyItems[0].cost / cur.cost >= 0.5) ins.push(`<b>费用高度集中</b>：${esc(keyName(keyItems[0].key))} 占 ${pct(keyItems[0].cost, cur.cost)}，建议设置 Key 预算。`);
  if (coupons > 0.005 || discount > 0.005) ins.push(`<b>本期优惠 ${yuan(discount + coupons)}</b>：折扣 ${yuan(discount)}、优惠券抵扣 ${yuan(coupons)}（按云厂商实际抵扣的日期计入，常集中在某几天）。`);
  if (hit != null) ins.push(`<b>缓存命中率 ${(hit * 100).toFixed(1)}%</b>${pHit != null ? `，较上期 ${hit >= pHit ? '+' : '−'}${Math.abs((hit - pHit) * 100).toFixed(1)}pp` : ''}。`);
  if (gov.length) ins.push(`<b>存在需治理的 API Key</b>：${gov.map(g => `${esc(g[2])} ${g[3].length} 个`).join('，')}。`);
  const insHtml = ins.length ? ins.map(t => `<div style="padding:8px 10px;margin-bottom:6px;background:#f7f9fc;border:1px solid #eef2f7;border-radius:8px;font-size:13px;line-height:1.6;color:#334155">${t}</div>`).join('') : '<div style="color:#64748b;font-size:13px">暂无需要关注的发现</div>';

  const html = `${hero}${kpis}
    ${section('每日费用', '按 API Key 堆叠 · 应付金额', costChart)}
    ${section('每日 Token', '按 Token 类型堆叠', tokChart)}
    ${section('API Key 费用排行', `环比：${prevLabel}`, kRank)}
    ${section('模型费用排行', `环比：${prevLabel}`, mRank)}
    ${section('费用构成', '应付金额', comp)}
    ${section('变动归因', `按 API Key · 对比${prevLabel}`, variance)}
    ${section('Key 治理', '风险与合规检查', govHtml)}
    ${section('关键发现', '', insHtml)}
    ${link ? `<div style="text-align:center;margin:6px 0 4px"><a href="${esc(link)}" style="display:inline-block;padding:9px 18px;background:#2563eb;color:#ffffff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">在系统中查看完整成本概览</a></div>` : ''}`;
  const text = [`${label} 应付金额 ${yuan(cur.cost)}（原价 ${yuan(cur.gross)}，折扣 ${yuan(discount)}，优惠券抵扣 ${yuan(coupons)}）`, `较${prevLabel} ${yuan(pv.cost)}`,
    forecast != null ? `预计本月 ${yuan(forecast)}` : `日均 ${yuan(avgDay)}`, `活跃 API Key ${activeKeys} 个 · Token ${compact(cur.tokens)} · 使用模型 ${models} 个`,
    '', 'API Key 费用排行：', ...keyItems.slice(0, 10).map((a, i) => `${i + 1}. ${keyName(a.key)} ${yuan(a.cost)}（${pct(a.cost, cur.cost)}）`),
    '', '模型费用排行：', ...modelItems.slice(0, 10).map((a, i) => `${i + 1}. ${a.key} ${yuan(a.cost)}（${pct(a.cost, cur.cost)}）`)].join('\n');
  const fullLabel = inScope ? `${label} · ${scope.label || '指定范围'}` : label;
  return { html, text: (inScope ? `范围：${scope.label || ''}\n` : '') + text, label: fullLabel, total: cur.cost,
    stats: { cost: cur.cost, prevCost: pv.cost, prevLabel, forecast, budget, label, topKeys: keyItems.slice(0, 5).map(a => ({ name: keyName(a.key), cost: a.cost })), topModels: modelItems.slice(0, 3).map(a => ({ name: a.key, cost: a.cost })),
      // Token 用量（报表消息中的用量指标与 Token 排行）
      tokens: cur.tokens, prevTokens: pv.tokens,
      tokenKeys: [...byKey.values()].filter(a => a.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 5).map(a => ({ name: keyName(a.key), tokens: a.tokens })),
      tokenModels: [...byModel.values()].filter(a => a.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 3).map(a => ({ name: a.key, tokens: a.tokens })) } };
}

/**
 * 推送范围（按 API Key / 业务空间）：返回账单行过滤函数；全部范围返回 null
 * 业务空间范围同时匹配账单行的业务空间与 Key 当前所属的业务空间（Key 移动过业务空间时以当前归属为准）
 */
export function scopePredicate(scope, keys) {
  if (!scope || scope.type === 'all' || !scope.ids?.length) return null;
  const ids = new Set(scope.ids);
  if (scope.type === 'key') return l => ids.has(l.api_key_id || '');
  return l => ids.has(l.workspace_id || '') || (!!l.api_key_id && ids.has(keys.get(l.api_key_id)?.workspace_id || ''));
}

/** 消息行（**加粗**、#### 小标题、空行）→ HTML */
export function linesToHtml(lines) {
  return (lines || []).map(l => {
    if (l === '') return '<div style="height:6px"></div>';
    if (l.startsWith('#')) return `<div style="font-size:13px;font-weight:700;color:#0f172a;margin:8px 0 2px">${esc(l.replace(/^#+\s*/, ''))}</div>`;
    return `<div style="font-size:13px;line-height:1.7;color:#334155">${esc(l).replace(/\*\*(.+?)\*\*/g, '<b style="color:#0f172a">$1</b>')}</div>`;
  }).join('');
}

/** 整封邮件：标题栏 + 消息内容 + 成本概览 + 页脚 */
export function renderEmail({ brand, title, level = 'info', lines, overview, footer, share = null }) {
  const shareHtml = share?.url ? `<div style="margin:12px 0 2px"><a href="${esc(share.url)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px">在浏览器中查看交互报表</a><span style="font-size:12px;color:#64748b;margin-left:10px">${esc(share.days)} 天内有效，无需登录；请勿转发给无关人员</span></div>` : '';
  const color = { bad: '#d03b3b', warn: '#eda100', good: '#0ca30c' }[level] || '#2563eb';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f3f5f9"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:760px"><tr><td>
  <div style="padding:4px 2px 12px;font-size:13px;color:#64748b"><b style="color:#0f172a;font-size:15px">${esc(brand)}</b> · 成本概览邮件</div>
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:12px;padding:14px 18px;margin:0 0 14px">
    <div style="font-size:17px;font-weight:700;color:#0f172a;margin-bottom:6px">${esc(title)}</div>${linesToHtml(lines)}${shareHtml}</div>
  ${overview?.html ? `<div style="font-size:14px;font-weight:700;color:#334155;margin:18px 2px 10px">成本概览 · ${esc(overview.label)}</div>${overview.html}` : ''}
  <div style="font-size:11px;color:#94a3b8;line-height:1.7;padding:10px 2px 0">${esc(footer || '')}<br>金额口径：应付金额 = 原价 − 折扣 − 优惠券 / 代金券抵扣（税前），与费用中心账单一致。此邮件由系统自动发送，请勿直接回复。</div>
</td></tr></table></td></tr></table></body></html>`;
  const text = [title, '', ...(lines || []).map(l => l.replace(/\*\*/g, '').replace(/^#+\s*/, '')), '', overview?.text ? `—— 成本概览 · ${overview.label} ——\n${overview.text}` : '', share?.url ? `交互报表（${share.days} 天内有效，无需登录）：${share.url}` : '', '', footer || ''].join('\n');
  return { html, text };
}
