/* Key 分析：全部 API Key 的用量、费用、效率、多维分布、模型分布、变动、治理与明细（用量在前、费用在后） */
import {
  $, esc, state, ui, app, money, moneyShort, tokFmt, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, DIMS, keyObj, keyDesc, keyShort, wsName,
  filterLines, aggregate, aggAll, sortedAggs, newAgg, totalTokens, topModels, unitsText, deltaPill, tipRows, icon, help, segCtl, fmtTime, budgetOf, budgetLevel,
  forecastOf, isCurrentMonth, periodTag, copyBtn, PROVIDERS, provTag, multiCloud, isAdmin, modal, http, toast, NO_CC, NO_WS, NO_OWNER, perCallCovered, perCall, daysBetween, usageFiltered, usageAgg, REQ_SRC,
  dimLink, groupHash, hasTags, callsOn, coveredCost, failRateOf, addDays, rankVal, scopeColors, dimVal, dimName, toneOf, WEEK, weekday,
} from '../core.js';
import { table, dataBar } from '../table.js';
import { heatmap, dayCols, columnChart, rankList, divergingList, stackRank, segbar, legendHtml, bindLegend, bindActivate, sparkline, scatterChart } from '../charts.js';

/** 成本中心 / 负责人 / 备注 编辑（单个或批量），保存后刷新数据 */
export async function editTags(ids) {
  const keys = ids.map(id => keyObj(id)).filter(Boolean);
  if (!keys.length) return;
  const ccList = uniq([...state.apiKeys.values()].map(k => k.costCenter).filter(Boolean)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const ownerList = uniq([...state.apiKeys.values()].map(k => k.owner).filter(Boolean)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const single = keys.length === 1;
  const row = k => `<tr><td><b style="font-weight:600">${esc(keyShort(k.apiKeyId))}</b>${provTag(k.provider)}<span class="sub mono">${esc(k.apiKeyId)}</span></td>
    <td><input class="inp sm" data-t="costCenter" data-id="${esc(k.apiKeyId)}" value="${esc(k.costCenter || '')}" maxlength="40" list="ccList" placeholder="如：客服中心" aria-label="成本中心"></td>
    <td><input class="inp sm" data-t="owner" data-id="${esc(k.apiKeyId)}" value="${esc(k.owner || '')}" maxlength="40" list="ownerList" placeholder="如：张三" aria-label="负责人"></td>
    <td><input class="inp sm" data-t="note" data-id="${esc(k.apiKeyId)}" value="${esc(k.note || '')}" maxlength="200" placeholder="用途、项目编号等" aria-label="备注"></td></tr>`;
  const body = `<p class="hint" style="margin:0 0 10px">成本中心与负责人是本系统的本地标签（不会修改云厂商上的 Key），用于按部门 / 项目分摊成本、筛选与报表。留空表示清除。</p>
    <datalist id="ccList">${ccList.map(c => `<option value="${esc(c)}">`).join('')}</datalist><datalist id="ownerList">${ownerList.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    ${single ? '' : `<div class="row" style="margin-bottom:10px;gap:8px"><input class="inp sm" id="bulkCc" list="ccList" placeholder="批量填写成本中心" style="width:180px" maxlength="40"><button type="button" class="btn sm" id="bulkApply">填入空白行</button><button type="button" class="btn sm" id="bulkAll">覆盖全部行</button></div>`}
    <div class="tbl-wrap" style="max-height:58vh"><table class="dt tag-tbl"><thead><tr><th>API Key</th><th>成本中心</th><th>负责人</th><th>备注</th></tr></thead><tbody>${keys.map(row).join('')}</tbody></table></div>`;
  const saved = await modal({
    title: single ? `归属设置 · ${keyShort(keys[0].apiKeyId)}` : `批量设置成本中心与负责人（${keys.length} 个 Key）`, body, submit: '保存', wide: !single || true,
    onOpen: form => {
      const fill = all => { const v = form.querySelector('#bulkCc').value.trim(); if (!v) return; form.querySelectorAll('[data-t=costCenter]').forEach(i => { if (all || !i.value.trim()) i.value = v; }); };
      form.querySelector('#bulkApply')?.addEventListener('click', () => fill(false));
      form.querySelector('#bulkAll')?.addEventListener('click', () => fill(true));
    },
    onSubmit: async form => {
      const items = keys.map(k => {
        const g = t => form.querySelector(`[data-t="${t}"][data-id="${CSS.escape(k.apiKeyId)}"]`).value.trim();
        return { id: k.apiKeyId, costCenter: g('costCenter'), owner: g('owner'), note: g('note') };
      }).filter(it => { const k = keyObj(it.id); return (k.costCenter || '') !== it.costCenter || (k.owner || '') !== it.owner || (k.note || '') !== it.note; });
      if (!items.length) return { count: 0 };
      // 分批保存：服务端每次最多 2000 条，请求体也有大小限制
      for (let i = 0; i < items.length; i += 500) await http('PUT', '/api/admin/key-tags', { items: items.slice(i, i + 500) });
      return { count: items.length };
    },
  });
  if (saved) { toast(saved.count ? `已保存 ${saved.count} 个 Key 的归属信息` : '没有变化'); if (saved.count) await app.reload(); }
}

export function keyRows() {
  const lines = filterLines();
  const byKey = aggregate(lines, DIMS.key.of);
  const pByKey = aggregate(filterLines(state.prev), DIMS.key.of);
  const daily = filterLines(state.daily);
  const dByKey = new Map(); daily.forEach(l => { const id = l.apiKeyId || NONE_KEY; if (!dByKey.has(id)) dByKey.set(id, []); dByKey.get(id).push(l); });
  // 预算是每个 Key 的整月总额：预算使用与预计月末按该 Key 的全部费用计算，不受模型 / Token 类型等筛选影响（与治理页一致）
  const fullByKey = new Map(), fullDaily = new Map();
  for (const l of state.lines) { const id = l.apiKeyId || NONE_KEY; fullByKey.set(id, (fullByKey.get(id) || 0) + l.pretax); }
  for (const l of state.daily) { const id = l.apiKeyId || NONE_KEY; let a = fullDaily.get(id); if (!a) fullDaily.set(id, a = []); a.push(l); }
  const total = sum([...byKey.values()], a => a.cost);
  const f = ui.f, q = f.q.trim().toLowerCase();
  const narrowing = f.model || f.dir || f.item || f.channel !== '__all';
  let ids = [...state.apiKeys.keys()];
  if (byKey.has(NONE_KEY)) ids.push(NONE_KEY);
  ids = ids.filter(id => {
    const k = keyObj(id);
    if (f.key && id !== f.key) return false;
    if (f.ws && !byKey.has(id)) { const wk = k ? k.wsKey : ''; if (f.ws === NO_WS ? wk : wk !== f.ws) return false; }
    if (f.provider && (k?.provider || 'aliyun') !== f.provider && !byKey.has(id)) return false;
    if (f.provider && id === NONE_KEY && !byKey.has(id)) return false;
    if (f.cc && !byKey.has(id) && (f.cc === NO_CC ? !!k?.costCenter : k?.costCenter !== f.cc)) return false;
    if (f.owner && !byKey.has(id) && (f.owner === NO_OWNER ? !!k?.owner : k?.owner !== f.owner)) return false;
    if ((f.cc || f.owner) && id === NONE_KEY && !byKey.has(id)) return false;
    if (q && !byKey.has(id) && !`${id} ${keyDesc(id)} ${k ? wsName(k.wsKey) : ''} ${k?.costCenter || ''} ${k?.owner || ''}`.toLowerCase().includes(q)) return false;
    if (narrowing && !byKey.has(id)) return false;
    // “有消费”按用量判断（金额、原价或 Token 大于 0，与“活跃 Key”同一口径）：被优惠券或订阅抵扣全额覆盖、应付为 0 的 Key，
    // 以及只有免费额度 Token 的 Key 同样算有消费（否则勾选后总用量、用量排行会少掉这些 Key）
    if (ui.onlySpent && !((u => u && (u.cost > 0 || u.gross >= 0.005 || totalTokens(u) > 0))(byKey.get(id)))) return false;
    return true;
  });
  const month = state.data.period.mode === 'month';
  // 费用口径按 Key 记录最大值：1 = 按用量分摊真实账单，2 = 按目录价估算（不能把估算标成“分摊”）
  const allocKeys = new Map();
  for (const l of lines) if (l.alloc) { const id = l.apiKeyId || NONE_KEY; allocKeys.set(id, Math.max(allocKeys.get(id) || 0, l.alloc)); }
  const usageByKey = usageAgg(usageFiltered() || [], u => u.apiKeyId);
  const pp = state.data.period, calDays = Math.max(1, daysBetween(pp.from, pp.to < state.today ? pp.to : state.today));
  return { total, rows: ids.map(id => {
    const k = keyObj(id) || {}, a = byKey.get(id) || newAgg(id), p = pByKey.get(id), act = state.keyActivity.get(id);
    let status = '—', st = '';
    if (id === NONE_KEY) status = '非 Key 调用';
    else if (k.source === 'deleted') { status = '已删除'; st = 'off'; }
    else if (k.source === 'bill') { status = '不在列表'; st = 'warn'; }
    else if (k.disabled === true) { status = '已禁用'; st = 'off'; }
    else if (k.disabled === false) { status = '启用'; st = 'on'; }
    const tokens = totalTokens(a);
    // “无 API Key”的预算保存在 keys.__none__（预算管理页同名条目），不能取月度总预算
    const budget = month ? budgetOf(id) : null;
    const fc = budget && isCurrentMonth() ? forecastOf(fullDaily.get(id) || [], l => l.pretax) : null;
    const ipOpen = !(k.accessIps || []).length || (k.accessIps || []).some(x => x === '0.0.0.0/0' || x === '::/0');
    // 只有该云厂商有调用次数数据源时才使用用量行（阿里云关闭调用次数后库里残留的旧数据不能出现）
    const us = id !== NONE_KEY && callsOn(k.provider || 'aliyun') ? usageByKey.get(id) : null;
    const pc = perCallCovered(us, dByKey.get(id));
    return {
      provider: k.provider || (id === NONE_KEY ? '' : 'aliyun'), costCenter: k.costCenter || '', owner: k.owner || '', note: k.note || '', remark: k.remark || '',
      requests: us ? us.requests : null, failRate: failRateOf(us), alloc: allocKeys.get(id) || 0,
      tokPer: pc?.tokPer ?? null, costPer: pc?.costPer ?? null, dayTok: totalTokens(a) / calDays, budgetUsed: fullByKey.get(id) || 0,
      id, apiKeyId: id === NONE_KEY ? '' : id, desc: keyShort(id), hasDesc: !!k.description, masked: k.apiKeyValue || '', wsName: id === NONE_KEY ? '—' : wsName(k.wsKey), wsId: k.wsKey || '',
      status, st, deletedAt: k.deletedAt,
      perm: id === NONE_KEY || !k.authType ? '—' : k.authType === 'All' || k.allowAllModels ? '全部模型' : `${(k.accessibleModels || []).length} 个模型`,
      permTip: (k.accessibleModels || []).join('、'), ip: id === NONE_KEY ? '—' : ipOpen ? '不限' : `${k.accessIps.length} 条`, ipTip: (k.accessIps || []).join(', '),
      cost: a.cost, pretax: a.pretax, prevCost: p?.cost || 0, prevTok: p ? totalTokens(p) : 0, prevTIn: p?.tIn || 0, prevTCache: p?.tCache || 0, chg: a.cost - (p?.cost || 0), share: total ? a.cost / total : 0, gross: a.gross,
      tIn: a.tIn, tCache: a.tCache, tOut: a.tOut, tEmb: a.tEmb, tokens, hit: a.tIn ? a.tCache / a.tIn : null, perM: tokens ? a.cost / tokens * 1e6 : null,
      models: a.models.size, topModels: topModels(a, 2).join('、'), topModelList: topModels(a, 2), activeDays: uniq((dByKey.get(id) || []).filter(l => metricVal(l) > 0).map(l => l.date)).length,
      lastDay: act?.lastDay || '', c7: act?.c7 || 0, c30: act?.c30 || 0, budget, fc: fc?.value ?? null, gmtCreate: k.gmtCreate ?? null, createdBy: k.createdBy || '', units: unitsText(a),
    };
  }) };
}

const TOKEN_PARTS = [{ label: '输入（非缓存）', color: 'var(--s1)' }, { label: '缓存命中', color: 'var(--s3)' }, { label: '输出', color: 'var(--s2)' }, { label: '向量', color: 'var(--s7)' }];
const tokT = n => `${tokFmt(n)} tokens`;
const goKey = id => (id === NONE_KEY ? app.setFilter({ key: NONE_KEY }, '#/detail') : app.go(`#/key/${encodeURIComponent(id)}`));
/** 治理概览的检查项：点击后只在明细表中显示命中的 Key（已禁用 / 已删除的 Key 不计入风险项） */
const live = r => r.id !== NONE_KEY && r.st !== 'off';
const KFLAGS = {
  idle: { label: '闲置 Key', tip: '启用中，但近 30 天没有任何消费或用量，可考虑禁用或删除', test: r => r.st === 'on' && (!r.lastDay || r.lastDay < addDays(state.today, -29)) },
  ipOpen: { label: 'IP 不限', tip: '未设置 IP 白名单（或包含 0.0.0.0/0），Key 泄露后可在任意地址调用', test: r => live(r) && r.ip === '不限' },
  allModels: { label: '全部模型权限', tip: '可调用全部模型（含高价模型），建议按需授权', test: r => live(r) && r.perm === '全部模型' },
  noCc: { label: '未分配成本中心', tip: '无法按部门 / 项目分摊成本', test: r => live(r) && !r.costCenter, show: () => hasTags() || isAdmin() },
  noDesc: { label: '未填描述', tip: '只能看到 Key ID，难以识别用途', test: r => live(r) && !r.hasDesc },
  overBudget: { label: '超预算 / 预计超', tip: '本月已超出 Key 预算，或按日均推算月末将超出', test: r => !!r.budget && (r.budgetUsed >= r.budget || (r.fc != null && r.fc >= r.budget)), show: () => state.data.period.mode === 'month' },
};
const kpi = (ic, label, value, delta, cmp, meta, spark = '') => `<section class="kpi" data-tone="${toneOf(ic)}"><div class="kpi-h"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span></div>
    <div class="value">${value}</div><div class="trend">${delta || ''}${delta && cmp ? `<span class="cmp">${esc(cmp)}</span>` : ''}</div>${spark}<div class="meta" title="${esc(meta)}">${esc(meta)}</div></section>`;

export function render(v) {
  const { rows, total } = keyRows();
  const month = state.data.period.mode === 'month', pp = state.data.period;
  const all = [...state.apiKeys.values()];
  const lines = filterLines(), daily = filterLines(state.daily);
  const days = uniq(daily.map(l => l.date)).sort();
  const calDays = Math.max(1, daysBetween(pp.from, pp.to < state.today ? pp.to : state.today));
  const used = r => r.id !== NONE_KEY && (r.cost > 0 || r.gross >= 0.005 || r.tokens > 0);
  // 上期基准直接取上期账单（不经 rows 过滤）：只在上期有用量的 Key 也要计入环比基准与变动归因
  const prevLines = filterLines(state.prev), pByKey = aggregate(prevLines, DIMS.key.of), pAll = aggAll(prevLines);
  const usedAgg = a => a.key !== NONE_KEY && (a.cost > 0 || a.gross >= 0.005 || totalTokens(a) > 0);
  const spent = rows.filter(used), pActive = [...pByKey.values()].filter(usedAgg).length;
  const tok = sum(rows, r => r.tokens), pTok = totalTokens(pAll), prevCost = pAll.cost, gross = sum(rows, r => r.gross);
  const tIn = sum(rows, r => r.tIn), tCache = sum(rows, r => r.tCache), tOut = sum(rows, r => r.tOut), pTIn = pAll.tIn, pTCache = pAll.tCache;
  const perM = tok ? total / tok * 1e6 : null, pPerM = pTok ? prevCost / pTok * 1e6 : null;
  const hit = tIn ? tCache / tIn : null, pHit = pTIn ? pTCache / pTIn : null;
  const byTok = rows.filter(r => r.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const byCost = rows.filter(r => r.cost > 0 || r.gross >= 0.005).sort((a, b) => rankVal(b) - rankVal(a));
  const withBudget = rows.filter(r => r.budget), over = rows.filter(KFLAGS.overBudget.test);
  const st = { on: all.filter(k => k.source === 'api' && k.disabled !== true).length, off: all.filter(k => k.disabled === true && k.source !== 'deleted').length, del: all.filter(k => k.source === 'deleted').length };
  const dTok = new Map(), dCost = new Map();
  for (const l of daily) { dTok.set(l.date, (dTok.get(l.date) || 0) + (l.tokens || 0)); dCost.set(l.date, (dCost.get(l.date) || 0) + metricVal(l)); }
  const spk = (tone, map, title, fmt) => (days.length > 1 ? `<div class="kspark" data-tip="${esc(tipRows(title, [['峰值', fmt(Math.max(...days.map(d => map.get(d) || 0)))], ['日均', fmt(sum(days, d => map.get(d) || 0) / days.length)]]))}">${sparkline(days.map(d => map.get(d) || 0), `var(--t-${tone})`, { height: 36 })}</div>` : '');
  const flags = Object.entries(KFLAGS).filter(([, f]) => !f.show || f.show());
  if (ui.kFlag && !flags.some(([k]) => k === ui.kFlag)) ui.kFlag = '';
  const flag = ui.kFlag ? KFLAGS[ui.kFlag] : null, tblRows = flag ? rows.filter(flag.test) : rows;
  const dimOpts = { ws: '业务空间', ...(hasTags() ? { cc: '成本中心', owner: '负责人' } : {}), ...(multiCloud() ? { provider: '云厂商' } : {}) };
  if (!dimOpts[ui.kDim]) ui.kDim = 'ws';
  const TC = { tok: '用量', cost: '费用' };
  const top1 = byTok[0], topC = rows.filter(r => r.cost > 0).sort((a, b) => b.cost - a.cost)[0];

  v.innerHTML = `
    <div class="kpis even">
      ${kpi('token', '总用量', tok ? `${tokFmt(tok)} <small>tokens</small>` : '—', tok ? deltaPill(tok, pTok, { neutral: true }) : '', state.compareLabel, tok ? `输入 ${tokFmt(tIn)} · 输出 ${tokFmt(tOut)} · 日均 ${tokFmt(tok / calDays)}` : '当前数据无 Token 用量', spk('sky', dTok, '每日用量', tokT))}
      ${kpi('key', '活跃 Key', `${spent.length}<small>/ ${all.length}</small>`, deltaPill(spent.length, pActive, { neutral: true }), state.compareLabel, `启用 ${st.on} · 禁用 ${st.off} · 已删除 ${st.del}`)}
      ${kpi('unit', '单位成本', perM == null ? '—' : `${money(perM)} <small>/ M tokens</small>`, perM == null ? '' : deltaPill(perM, pPerM), state.compareLabel, `${METRICS[ui.f.metric]} ÷ 用量 × 10⁶`)}
      ${kpi('cache', '缓存命中率', hit == null ? '—' : (hit * 100).toFixed(1) + '%', hit == null ? '' : deltaPill(hit, pHit, { pp: true, goodWhenUp: true }), state.compareLabel, hit == null ? '无输入 Token' : `命中 ${tokT(tCache)}`)}
      ${kpi('wallet', `本期${METRICS[ui.f.metric]}`, money(total), deltaPill(total, prevCost), state.compareLabel, gross - total >= 0.005 ? `原价 ${moneyShort(gross)} · 优惠与抵扣 ${moneyShort(gross - total)}` : `原价 ${moneyShort(gross)}`, spk('blue', dCost, '每日费用', v => money(v)))}
      ${kpi('layers', '用量集中度', top1 ? pct(top1.tokens, tok) : '—', '', '', top1 ? `最高：${top1.desc} · 前 5 个占 ${pct(sum(byTok.slice(0, 5), r => r.tokens), tok)}` : '—')}
      ${kpi('model', '费用集中度', topC ? pct(topC.cost, total) : '—', '', '', topC ? `最高：${topC.desc} · ${money(topC.cost)}` : '—')}
      ${month ? kpi('calendar', '超预算 / 已设预算', `<span class="${over.length ? 'bad-text' : ''}">${over.length}</span><small>/ ${withBudget.length}</small>`, '', '', withBudget.length ? '含按日均推算月末将超出的 Key' : '尚未为 Key 设置月度预算')
        : kpi('calendar', '日均费用', money(total / calDays), '', '', `${calDays} 天 · 日均用量 ${tokT(tok / calDays)}`)}
    </div>
    <div class="bi">
      <section class="panel c6"><div class="panel-h"><h3>用量排行</h3><span class="sub">按 tokens 排序 · 占比 = 占总用量 · 点击查看 Key 详情</span></div><div id="kRkTok"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>费用排行</h3><span class="sub">按原价排序，金额为${esc(METRICS[ui.f.metric])} · 点击查看 Key 详情</span></div><div id="kRkCost"></div></section>
      <section class="panel c8"><div class="panel-h"><h3>每日${TC[ui.kTrend] || '用量'}（按 Key）</h3>${help('按 API Key 堆叠，取前 7 个 Key，其余合并为“其他”。点击图例查看 Key 详情；点击柱查看当日明细，点击柱中的某一段只看该 Key。')}
        <div class="actions">${segCtl('kTrend', TC)}</div></div><div class="legend" id="kTrLegend"></div><div class="chart" id="kTrend"></div></section>
      <section class="panel c4"><div class="panel-h"><h3>多维分布</h3>${help('按所选维度汇总全部 Key 的用量与费用（取自账单行的归属）。点击条目进入该维度详情。')}
        <div class="actions">${Object.keys(dimOpts).length > 1 ? segCtl('kDim', dimOpts) : ''}</div></div><div id="kDim"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>效率象限</h3>${help('每个气泡是一个 Key：横轴为用量（对数刻度），纵轴为单位成本（每百万 tokens 费用），气泡越大费用越高。虚线为中位数，右上象限的 Key 用量大且单价高，优先考虑换用更便宜的模型、提高缓存命中或使用资源包。只统计用量 ≥ 10 K tokens 的 Key。')}
        <span class="sub">横轴用量 · 纵轴 ¥ / M tokens · 点击查看 Key 详情</span></div><div class="chart" id="kScatter"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>Token 结构</h3>${help('各 Key 的输入（非缓存）、缓存命中、输出与向量 Token 构成；右侧为缓存命中率（缓存命中 ÷ 输入）。')}<span class="sub">按用量前 10 个 Key</span></div><div id="kTokMix"></div></section>
      <section class="panel c12"><div class="panel-h"><h3>Key × 模型</h3>${help('前 15 个 Key 在前 8 个模型上的分布，颜色越深数值越大（平方根刻度）。点击 Key 名称查看详情，点击格子查看该 Key 在该模型上的消耗。')}
        <div class="actions">${segCtl('kMx', TC)}<span class="scale">低 ${[1, 2, 3, 4, 5, 6, 7].map(i => `<i style="background:var(--q${i})"></i>`).join('')} 高</span></div></div><div id="kMx"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>变动归因</h3>${help(`本期与上期（${state.compareRange || ''}）相比，各 Key 的${TC[ui.kVar] || '用量'}增减。`)}<div class="actions">${segCtl('kVar', TC)}</div></div><div id="kVar"></div></section>
      <section class="panel c6"><div class="panel-h"><h3>治理概览</h3>${help('按当前筛选统计；已禁用 / 已删除的 Key 不计入风险项。点击检查项只在下方明细表中显示命中的 Key，再次点击取消。')}<span class="sub">点击筛选明细表</span></div><div id="kGov"></div></section>
    <section class="panel c12" id="kTblP">
      <div class="panel-h"><h3>API Key 明细</h3>${flag ? `<span class="pill info kflag-on">只看：${esc(flag.label)}（${tblRows.length}）<button type="button" class="link" data-kflag="" aria-label="清除">×</button></span>` : ''}<span class="sub">描述、业务空间、状态与权限实时同步自${multiCloud() ? '各云厂商' : PROVIDERS[state.providers[0] || 'aliyun']} · 点击行查看 Key 详情</span>
        <div class="actions"><label class="chk"><input type="checkbox" id="onlySpent" ${ui.onlySpent ? 'checked' : ''}> 仅显示有消费</label>${segCtl('density', { normal: '标准', compact: '紧凑' })}${isAdmin() ? `<button class="btn sm" id="tags" title="为 Key 设置成本中心、负责人与备注，用于成本分摊">${icon('tag')}归属设置</button>` : ''}<button class="btn sm" id="csv">${icon('download')}导出</button></div></div>
      <div id="tbl"></div>
    </section>
      <section class="panel c12"><div class="panel-h"><h3>每日消耗热力</h3><span class="sub">按 Key × 日期，颜色越深${TC[ui.kHm] || '用量'}越高（平方根刻度）· 点击 Key 名称查看详情，点击格子查看该 Key 当日明细</span>
        <div class="actions">${segCtl('kHm', TC)}<span class="scale">低 ${[1, 2, 3, 4, 5, 6, 7].map(i => `<i style="background:var(--q${i})"></i>`).join('')} 高</span></div></div><div id="heat"></div></section>
    </div>`;

  // 双排行
  rankList($('#kRkTok', v), byTok.map(r => ({ id: r.id, label: r.desc, sub: r.wsName !== '—' ? r.wsName : '', value: r.tokens, prev: r.prevTok, color: 'var(--s3)' })),
    // 用量涨跌不代表好坏：与指标卡、变动归因一致用中性颜色
    { fmt: tokT, total: tok, showDelta: true, neutral: true, onClick: it => goKey(it.id), empty: '本期无 Token 用量' });
  rankList($('#kRkCost', v), byCost.map(r => ({ id: r.id, label: r.desc, sub: r.wsName !== '—' ? r.wsName : '', value: r.cost, gross: r.gross, prev: r.prevCost })),
    { total, showDelta: true, onClick: it => goKey(it.id) });

  // 每日趋势（按 Key 堆叠）
  const isTok = ui.kTrend !== 'cost', val = isTok ? (l => l.tokens || 0) : metricVal;
  const ranked = (isTok ? byTok : byCost).map(r => r.id), head = ranked.slice(0, 7), colorOf = scopeColors(head, DIMS.key.color, 7);
  const series = head.map(id => ({ id, label: keyShort(id), color: colorOf.get(id) || 'var(--other)' }));
  const rest = ranked.length - head.length;
  if (rest > 0) series.push({ id: '__other', label: `其他 ${rest} 个`, color: 'var(--other)' });
  const tc = new Map(), inHead = new Set(head);
  for (const l of daily) { const id = l.apiKeyId || NONE_KEY, k = l.date + '|' + (inHead.has(id) ? id : '__other'); tc.set(k, (tc.get(k) || 0) + val(l)); }
  $('#kTrLegend', v).innerHTML = series.length > 1 ? legendHtml(series, '点击查看 Key 详情') : '';
  bindLegend($('#kTrLegend', v), goKey);
  columnChart($('#kTrend', v), {
    xs: days, series, cell: (x, s) => tc.get(x + '|' + s) || 0, height: 300, fmt: isTok ? tokFmt : null, avg: days.length ? sum(daily, val) / calDays : null,
    xLabel: x => x.slice(5), tipTitle: x => `${x}（周${WEEK[weekday(x)]}）`, empty: isTok ? '本期无 Token 用量' : '暂无按日账单数据',
    onX: x => app.openDay(x), onSeg: (x, id) => (id === '__other' ? app.openDay(x) : app.openDay(x, { global: true, key: id })), clickHint: '点击查看当日明细', segHint: '点击柱段只看该 Key',
  });

  // 多维分布
  const dim = ui.kDim, groups = [...aggregate(lines, dimVal[dim]).values()].map(a => ({ id: a.key, label: dimName(dim, a.key), tok: totalTokens(a), cost: a.cost, keys: a.keys.size, color: DIMS[dim].color(a.key) }))
    .filter(g => g.tok > 0 || g.cost > 0).sort((a, b) => b.tok - a.tok || b.cost - a.cost);
  const partsOf = f => { const top = groups.slice(0, 6).map(g => ({ id: g.id, label: g.label, value: f(g), color: g.color })); if (groups.length > 6) top.push({ id: '__other', label: `其他 ${groups.length - 6} 项`, value: sum(groups.slice(6), f), color: 'var(--other)' }); return top; };
  const gTok = sum(groups, g => g.tok), gCost = sum(groups, g => g.cost);
  $('#kDim', v).innerHTML = groups.length ? `<div class="dim-block"><div class="dim-h"><b>用量</b><span>${tokT(gTok)}</span></div>${segbar(partsOf(g => g.tok), { thin: true, fmt: tokT, label: '用量' })}</div>
    <div class="dim-block"><div class="dim-h"><b>费用</b><span>${money(gCost)}</span></div>${segbar(partsOf(g => g.cost), { thin: true })}</div>
    <div class="lgl wide" style="margin-top:12px">${groups.slice(0, 10).map(g => `<div class="li clickable" data-pid="${esc(g.id)}" tabindex="0" role="button" title="${esc(`${g.label} · 点击进入详情`)}"><i style="background:${g.color}"></i><span>${esc(g.label)}<small class="muted"> · ${g.keys} 个 Key</small></span><b>${esc(tokT(g.tok))}</b><em>${esc(money(g.cost))}</em></div>`).join('')}</div>
    ${groups.length > 10 ? `<div class="more">另有 ${groups.length - 10} 项未显示</div>` : ''}` : '<div class="nodata">暂无数据</div>';
  bindActivate($('#kDim', v), '.li.clickable', li => app.go(groupHash(dim, li.dataset.pid)));

  // 效率象限
  scatterChart($('#kScatter', v), {
    points: rows.filter(r => r.tokens >= 1e4 && r.perM != null).map(r => ({ id: r.id, label: r.desc, x: r.tokens, y: r.perM, r: rankVal(r),
      tip: tipRows(r.desc, [['用量', tokT(r.tokens)], ['单位成本', `${money(r.perM)} / M tokens`], ['费用', money(r.cost)], ...(r.gross - r.cost >= 0.005 ? [['原价', money(r.gross)]] : []), ['缓存命中率', r.hit == null ? '—' : (r.hit * 100).toFixed(1) + '%']]) })),
    xFmt: n => tokFmt(n), yFmt: n => money(n, n && n < 1 ? 2 : 0), xTitle: '用量（tokens，对数刻度）', yTitle: '¥ / M tokens', height: 300,
    quad: { tr: '用量大 · 单价高', tl: '用量小 · 单价高', br: '用量大 · 单价低', bl: '用量小 · 单价低' }, onClick: p => goKey(p.id), aria: 'API Key 用量与单位成本散点图', empty: '没有用量 ≥ 10 K tokens 的 Key',
  });

  // Token 结构
  stackRank($('#kTokMix', v), byTok.map(r => ({ id: r.id, label: r.desc, hit: r.hit, parts: [r.tIn - r.tCache, r.tCache, r.tOut, r.tEmb] })), TOKEN_PARTS,
    { limit: 10, fmt: tokT, onClick: r => goKey(r.id), meta: r => (r.hit != null ? `命中 ${(r.hit * 100).toFixed(0)}%` : '') });

  // Key × 模型
  const mxTok = ui.kMx !== 'cost', mv = mxTok ? (l => l.tokens || 0) : metricVal, mxCell = new Map(), mTot = new Map(), kTot = new Map();
  for (const l of lines) { const id = l.apiKeyId || NONE_KEY, x = mv(l); if (!x) continue; mxCell.set(id + '|' + l.model, (mxCell.get(id + '|' + l.model) || 0) + x); mTot.set(l.model, (mTot.get(l.model) || 0) + x); kTot.set(id, (kTot.get(id) || 0) + x); }
  const mxKeys = [...kTot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(e => e[0]);
  const mxModels = [...mTot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);
  heatmap($('#kMx', v), {
    rows: mxKeys.map(id => ({ id, label: keyShort(id).slice(0, 16), color: DIMS.key.color(id), full: keyShort(id) })),
    cols: mxModels.map(m => ({ id: m, label: m.length > 18 ? m.slice(0, 17) + '…' : m, title: m })),
    cell: (r, c) => mxCell.get(r + '|' + c) || 0, total: r => kTot.get(r) || 0, fmt: mxTok ? tokT : money, tipLabel: mxTok ? '用量' : '费用',
    rowTip: r => r.full, onRow: goKey, onCell: (id, m) => app.openModel(m, { global: true, key: id }), cellHint: '点击查看该 Key 在该模型上的消耗',
  });
  $('#kMx table', v)?.classList.add('mx');

  // 变动归因
  const vTok = ui.kVar !== 'cost';
  const cByKey = aggregate(lines, DIMS.key.of), vOf = a => (a ? (vTok ? totalTokens(a) : a.cost) : 0);
  divergingList($('#kVar', v), uniq([...cByKey.keys(), ...pByKey.keys()]).map(id => { const c = vOf(cByKey.get(id)), q = vOf(pByKey.get(id)); return { id, label: keyShort(id), cur: c, prev: q, delta: c - q }; }),
    { limit: 8, onClick: it => goKey(it.id), ...(vTok ? { fmt: tokT, noun: '用量', neutral: true } : {}) });

  // 治理概览
  const stParts = [{ label: '启用', value: st.on, color: 'var(--s3)' }, { label: '禁用', value: st.off, color: 'var(--warn)' }, { label: '已删除', value: st.del, color: 'var(--other)' }];
  $('#kGov', v).innerHTML = `<div class="dim-block"><div class="dim-h"><b>Key 状态</b><span>${stParts.map(p => `${p.label} ${p.value}`).join(' · ')}</span></div>${segbar(stParts, { thin: true, fmt: n => `${n} 个`, label: '数量' })}</div>
    <div class="gchips">${flags.map(([k, f]) => { const n = rows.filter(f.test).length; return `<button type="button" class="gchip ${ui.kFlag === k ? 'on' : ''} ${n ? 'hit' : ''}" data-kflag="${k}" aria-pressed="${ui.kFlag === k}" title="${esc(f.tip)}"><b>${n}</b><span>${esc(f.label)}</span><small>${esc(f.tip)}</small></button>`; }).join('')}</div>`;
  v.querySelectorAll('[data-kflag]').forEach(b => { b.onclick = () => {
    const k = b.dataset.kflag; ui.kFlag = k && ui.kFlag !== k ? k : '';
    if (ui.kFlag === 'idle') ui.onlySpent = false;
    app.render();
    if (ui.kFlag) requestAnimationFrame(() => document.getElementById('kTblP')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }; });

  // 明细表
  const max = Math.max(0, ...rows.map(r => r.cost));
  const tagged = rows.some(r => r.costCenter || r.owner);
  const hasUsage = rows.some(r => r.requests != null);
  const cols = [
    { key: 'desc', label: 'API Key', csvLabel: '描述', fmt: (x, r) => `<span class="sw" style="background:${DIMS.key.color(r.id)}"></span><b style="font-weight:600">${esc(x)}</b>${provTag(r.provider)}${!r.hasDesc && r.id !== NONE_KEY ? '<span class="tag warn">无描述</span>' : ''}${r.alloc === 2 ? '<span class="tag warn" title="缺少腾讯云计费权限，按 TokenHub 目录价 × 用量估算（不含折扣与阶梯价）">估算</span>' : r.alloc ? '<span class="tag" title="腾讯云账单不含 API Key，费用按 TokenHub 用量占比分摊">分摊</span>' : ''}<span class="sub mono">${esc(r.apiKeyId || '—')}${copyBtn(r.apiKeyId, '复制 Key ID')}${r.masked ? ' · ' + esc(r.masked) : ''}</span>` },
    { key: 'wsName', label: '业务空间', title: '点击业务空间名称查看该空间的全部 Key、模型与趋势', fmt: (x, r) => (r.id === NONE_KEY ? '—' : dimLink('ws', r.wsId || NO_WS, x)) + (r.wsId ? `<span class="sub mono">${esc(r.wsId)}</span>` : '') },
  ];
  if (tagged || isAdmin()) cols.push(
    { key: 'costCenter', label: '成本中心', fmt: (x, r) => (x ? dimLink('cc', x, x) : r.id === NONE_KEY ? '—' : '<span class="muted">未分配</span>') + (r.owner ? `<span class="sub">负责人 ${dimLink('owner', r.owner, r.owner)}</span>` : ''), csv: r => r.costCenter },
  );
  cols.push(
    { key: 'status', label: '状态', fmt: (x, r) => `<span class="state ${r.st}">${esc(x)}</span>${r.deletedAt ? `<span class="sub">${fmtTime(r.deletedAt, false)}</span>` : ''}` },
    { key: 'tokens', label: '用量', title: '总 Token（输入 + 输出 + 向量 + 其他）', align: 'r', fmt: x => (x ? tokT(x) : '—'), csv: r => Math.round(r.tokens) },
    { key: 'cost', label: `费用（${METRICS[ui.f.metric]}）`, align: 'r', fmt: x => dataBar(x, max), csv: r => r.cost.toFixed(6) },
    { key: 'chg', label: state.compareLabel, align: 'r', fmt: (x, r) => deltaPill(r.cost, r.prevCost), csv: r => r.chg.toFixed(6) },
    { key: 'share', label: '占比', align: 'r', fmt: x => (x ? (x * 100).toFixed(1) + '%' : '—'), csv: r => (r.share * 100).toFixed(2) + '%' },
  );
  if (month) cols.push({ key: 'budgetUse', label: '预算使用', fmt: (x, r) => budgetCell(r), sortVal: r => (r.budget ? r.budgetUsed / r.budget : -1), csv: r => (r.budget ? `${(r.budgetUsed / r.budget * 100).toFixed(1)}%` : '') });
  cols.push(
    { key: 'tIn', label: '输入', align: 'r', fmt: x => (x ? tokT(x) : '—'), csv: r => Math.round(r.tIn) },
    { key: 'tOut', label: '输出', align: 'r', fmt: x => (x ? tokT(x) : '—'), csv: r => Math.round(r.tOut) },
    { key: 'hit', label: '缓存命中率', align: 'r', fmt: x => (x == null ? '—' : (x * 100).toFixed(1) + '%'), sortVal: r => r.hit ?? -1, csv: r => (r.hit == null ? '' : (r.hit * 100).toFixed(2) + '%') },
    { key: 'perM', label: '单位成本', title: '费用 ÷ 用量 × 10⁶，单位 ¥ / M tokens', align: 'r', fmt: x => (x == null ? '—' : money(x)), sortVal: r => r.perM ?? -1 },
    { key: 'dayTok', label: '日均用量', title: '用量 ÷ 统计周期内已过的自然日数', align: 'r', fmt: x => (x ? tokT(x) : '—'), csv: r => Math.round(r.dayTok) },
    ...(hasUsage ? [
      { key: 'requests', label: '请求数', title: REQ_SRC, align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : intFmt(x)), sortVal: r => r.requests ?? -1 },
      { key: 'tokPer', label: '单次均 Token', title: '单次平均 Token = 总 Token ÷ 请求数（阿里云取同日同 Key 同模型的账单 Token）', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : intFmt(x)), sortVal: r => r.tokPer ?? -1, csv: r => (r.tokPer == null ? '' : Math.round(r.tokPer)) },
      { key: 'costPer', label: '单次均费用', title: '单次平均费用 = 有调用数据的日期的费用 ÷ 请求数', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : money(x, x < 0.01 ? 4 : 3)), sortVal: r => r.costPer ?? -1, csv: r => (r.costPer == null ? '' : r.costPer.toFixed(6)) },
      { key: 'failRate', label: '失败率', title: '失败请求 ÷ 请求数', align: 'r', fmt: x => (x == null ? '<span class="muted">—</span>' : `<span class="${x >= 0.05 ? 'bad-text' : x >= 0.01 ? 'warn-text' : ''}">${(x * 100).toFixed(2)}%</span>`), sortVal: r => r.failRate ?? -1, csv: r => (r.failRate == null ? '' : (r.failRate * 100).toFixed(2) + '%') },
    ] : []),
    { key: 'topModels', label: '主要模型', title: '点击模型查看该 Key 在该模型上的消耗', fmt: (x, r) => r.topModelList.map(m => dimLink('model', m, m, { global: true, key: r.id })).join('、') || '<span class="muted">—</span>' },
    { key: 'activeDays', label: '消费天数', align: 'r' },
    { key: 'lastDay', label: '最近消费', fmt: x => (x ? esc(x) : '<span class="muted">—</span>') },
    { key: 'c7', label: '近 7 天', title: '近 7 天应付金额（与所选周期无关）', align: 'r', fmt: x => money(x) },
    { key: 'perm', label: '模型权限', fmt: (x, r) => `<span title="${esc(r.permTip)}">${esc(x)}</span>` },
    { key: 'ip', label: 'IP 白名单', fmt: (x, r) => (x === '不限' ? '<span class="warn-text">不限</span>' : `<span title="${esc(r.ipTip)}">${esc(x)}</span>`), csv: r => r.ipTip || r.ip },
    { key: 'gmtCreate', label: '创建时间', fmt: x => fmtTime(x, false), csv: r => fmtTime(r.gmtCreate) },
  );
  const t = table('keys', $('#tbl', v), {
    sort: 'cost', pageSize: 100, caption: 'API Key 明细', rowClass: r => (r.deletedAt ? 'deleted' : ''),
    onRowClick: r => (r.id === NONE_KEY ? app.setFilter({ key: NONE_KEY }, '#/detail') : app.go(`#/key/${encodeURIComponent(r.id)}`)),
    columns: cols,
    csvExtra: [{ label: '云厂商', val: r => PROVIDERS[r.provider] || '' }, { label: 'API Key ID', val: r => r.apiKeyId }, { label: 'API Key（脱敏）', val: r => r.masked }, { label: '负责人', val: r => r.owner }, { label: '备注', val: r => r.note || r.remark }, { label: '费用口径', val: r => (r.alloc === 2 ? '目录价估算' : r.alloc ? '按用量分摊' : '账单直接归属') }, { label: '业务空间ID', val: r => r.wsId }, { label: '原价', val: r => r.gross.toFixed(6) }, { label: '上期费用', val: r => r.prevCost.toFixed(6) }, { label: '缓存命中 Token', val: r => Math.round(r.tCache) }, { label: '向量 Token', val: r => Math.round(r.tEmb) }, { label: '其他用量', val: r => r.units }, { label: '近30天', val: r => r.c30.toFixed(2) }, { label: '月度预算', val: r => r.budget ?? '' }, { label: '可访问模型', val: r => r.permTip }, { label: '创建人', val: r => r.createdBy }],
    footer: rs => cols.map(c => (c.key === 'desc' ? `合计 ${rs.length} 个` : c.key === 'cost' ? money(sum(rs, r => r.cost)) : c.key === 'chg' ? deltaPill(sum(rs, r => r.cost), sum(rs, r => r.prevCost)) : c.key === 'tokens' ? tokT(sum(rs, r => r.tokens)) : c.key === 'tIn' ? tokT(sum(rs, r => r.tIn)) : c.key === 'tOut' ? tokT(sum(rs, r => r.tOut)) : c.key === 'c7' ? money(sum(rs, r => r.c7)) : '')),
  }).setRows(tblRows);
  $('#onlySpent', v).onchange = e => { ui.onlySpent = e.target.checked; app.render(); };
  $('#csv', v).onclick = () => t.csv(`API_Key费用_${periodTag()}.csv`);
  $('#tags', v)?.addEventListener('click', () => editTags(rows.filter(r => r.id !== NONE_KEY && keyObj(r.id)?.source !== 'deleted').map(r => r.id)));

  // 热力
  const hTok = ui.kHm !== 'cost', hv = hTok ? (l => l.tokens || 0) : metricVal;
  const cell = new Map(), hTot = new Map();
  daily.forEach(l => { const id = l.apiKeyId || NONE_KEY, x = hv(l); if (!x) return; cell.set(id + '|' + l.date, (cell.get(id + '|' + l.date) || 0) + x); hTot.set(id, (hTot.get(id) || 0) + x); });
  const hRanked = [...hTot.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  heatmap($('#heat', v), {
    rows: hRanked.slice(0, 30).map(id => ({ id, label: keyShort(id).slice(0, 16), color: DIMS.key.color(id), full: keyShort(id) })),
    cols: dayCols(days), cell: (r, c) => cell.get(r + '|' + c) || 0, total: r => hTot.get(r) || 0, fmt: hTok ? tokT : money, tipLabel: hTok ? '用量' : '费用',
    rowTip: r => r.full, onRow: id => (id !== NONE_KEY ? app.go(`#/key/${encodeURIComponent(id)}`) : null),
    onCell: (id, day) => app.openDay(day, { global: true, key: id }), cellHint: '点击查看该 Key 当日明细',
  });
}

export function budgetCell(r) {
  if (!r.budget) return '<span class="muted">未设置</span>';
  const p = r.budgetUsed / r.budget * 100, lv = budgetLevel(r.budgetUsed, r.budget), fl = r.fc != null ? budgetLevel(r.fc, r.budget) : '';
  const color = lv === 'bad' ? 'var(--crit)' : lv === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return `<div class="mini-budget" title="预算 ${esc(money(r.budget))}${r.fc != null ? `，预计月末 ${esc(money(r.fc))}` : ''}"><span><b>${p.toFixed(0)}%</b> <span class="muted">/ ${esc(moneyShort(r.budget))}</span>${fl === 'bad' && lv !== 'bad' ? ' <span class="pill bad">预计超</span>' : ''}</span>
    <div class="progress"><i style="width:${Math.min(100, p).toFixed(1)}%;background:${color}"></i></div></div>`;
}
