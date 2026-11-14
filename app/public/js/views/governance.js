/* Key 治理：基于规则的风险与合规检查 */
import { $, esc, state, ui, app, money, sum, addDays, keyShort, keyDesc, wsName, budgetOf, forecastOf, isCurrentMonth, NONE_KEY, icon, help, fmtTime, PROVIDERS, provTag, hasTags, dimLink, NO_WS,
  ccBudgetOf, hasCcBudgets, ccName, dimVal, groupHash } from '../core.js';
import { table } from '../table.js';

export const SEVERITY = { high: { label: '高', cls: 'bad', order: 0 }, medium: { label: '中', cls: 'warn', order: 1 }, low: { label: '低', cls: 'neutral', order: 2 } };
const RULES = {
  deleted_billing: { name: '已删除仍产生费用', severity: 'high', advice: '核实该 Key 是否泄露或仍被旧服务调用，必要时联系云厂商核查账单。' },
  disabled_billing: { name: '已禁用仍产生费用', severity: 'high', advice: '核实禁用时间与账单日期，排查是否存在其他调用来源。' },
  over_budget: { name: '已超出预算', severity: 'high', advice: '评估用量合理性，调整预算或在云厂商控制台限制该 Key 的调用（腾讯云 TokenHub 可设置 Key 额度上限）。' },
  forecast_over: { name: '预计超出预算', severity: 'medium', advice: '按当前日均推算月末将超预算，建议提前评估或调整。' },
  cc_over_budget: { name: '成本中心已超出预算', severity: 'high', advice: '与成本中心负责人确认用量是否合理，调整预算；可在“业务分析 → 成本中心”详情中查看主要的 Key 与模型并限制调用。' },
  cc_forecast_over: { name: '成本中心预计超出预算', severity: 'medium', advice: '按当前日均推算月末将超出该成本中心的预算，建议提前与负责人评估或调整预算。' },
  spike: { name: '费用突增', severity: 'medium', advice: '近 7 天日均显著高于此前，排查是否存在异常或滥用调用。' },
  no_desc: { name: '有消费但无描述', severity: 'medium', advice: '在云厂商控制台为该 Key 补充描述（项目/负责人），或在本系统设置成本中心与负责人。' },
  no_cc: { name: '有消费但未分配成本中心', severity: 'low', advice: '在“Key 分析 → 归属设置”中为该 Key 指定成本中心与负责人，便于按部门/项目分摊。' },
  broad: { name: '权限过宽（全部模型 + IP 不限）', severity: 'medium', advice: '按最小权限原则限制可访问模型，并配置 IP 白名单。' },
  idle: { name: '闲置 30 天以上', severity: 'medium', advice: '长期未使用的 Key 建议禁用或删除，降低泄露风险。' },
  open_ip: { name: '未限制访问 IP', severity: 'low', advice: '为调用来源固定的 Key 配置 IP 白名单。' },
  no_ws: { name: '未归属业务空间', severity: 'low', advice: '将 Key 归入对应项目的业务空间，便于按空间分摊成本。' },
};
const ipOpen = k => !(k.accessIps || []).length || (k.accessIps || []).some(ip => ip === '0.0.0.0/0' || ip === '::/0');
/** 时间戳在账单时区中的日期（账单日按账单时区划分，不能用浏览器本地时区） */
const billDay = ts => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: state.tz || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ts))); } catch { return new Date(Number(ts)).toISOString().slice(0, 10); } };

/* 治理检查只依赖本期数据与预算（与筛选无关），但导航徽标每次重绘都会调用：按数据数组 + 预算缓存结果 */
const findMemo = new WeakMap();
export function computeFindings() {
  const sig = JSON.stringify(state.budgets) + '|' + state.today;
  const hit = findMemo.get(state.lines);
  if (hit && hit.sig === sig) return hit.out;
  const out = computeFindingsRaw();
  findMemo.set(state.lines, { sig, out });
  return out;
}
function computeFindingsRaw() {
  const out = [];
  const cost = new Map(), daily = new Map();
  for (const l of state.lines) cost.set(l.apiKeyId || NONE_KEY, (cost.get(l.apiKeyId || NONE_KEY) || 0) + l.pretax);
  for (const l of state.daily) { const id = l.apiKeyId || NONE_KEY; if (!daily.has(id)) daily.set(id, []); daily.get(id).push(l); }
  const month = state.data?.period?.mode === 'month';
  const idleBefore = addDays(state.today, -30);
  const useCc = hasTags();
  for (const k of state.apiKeys.values()) {
    const id = k.apiKeyId, c = cost.get(id) || 0, act = state.keyActivity.get(id);
    const add = (rule, detail) => out.push({ rule, ruleName: RULES[rule].name, severity: RULES[rule].severity, advice: RULES[rule].advice, keyId: id, detail, cost: c });
    const live = k.source === 'api';
    if (k.source === 'deleted' && k.deletedAt) {
      // 只统计删除日之后（账单时区）的费用：删除前的正常消费（如轮换 Key、查看历史账期）不是风险
      const delDay = billDay(k.deletedAt);
      const after = sum((daily.get(id) || []).filter(l => l.date > delDay), l => l.pretax);
      if (after > 0.005) add('deleted_billing', `${delDay} 已从${PROVIDERS[k.provider || 'aliyun']}删除，此后仍产生 ${money(after)}`);
    } else if ((k.source === 'deleted' || k.source === 'bill') && c > 0) add('deleted_billing', `${k.source === 'deleted' ? '已删除' : '不在当前 Key 列表'}，本期仍产生 ${money(c)}`);
    // 禁用没有时间记录：只在近 7 天仍有费用时提示（本期早些时候、禁用前的消费不算）
    if (live && k.disabled === true && c > 0 && (act?.c7 || 0) > 0.005) add('disabled_billing', `已禁用，近 7 天仍产生 ${money(act.c7)}（本期合计 ${money(c)}）`);
    const budget = month ? budgetOf(id) : null;
    if (budget) {
      if (c >= budget) add('over_budget', `本期 ${money(c)}，预算 ${money(budget)}，超出 ${money(c - budget)}`);
      else if (isCurrentMonth()) {
        const fc = forecastOf(daily.get(id) || [], l => l.pretax);
        if (fc && fc.value >= budget) add('forecast_over', `预计月末 ${money(fc.value)}，预算 ${money(budget)}`);
      }
    }
    if (act && act.c7 >= 10) {
      // 此前的日均只按 Key 已存在的天数计算：创建不足 30 天的 Key 不能把尚未存在的日子记为 0，误报“费用突增”
      const age = k.gmtCreate ? Math.floor((Date.now() - Number(k.gmtCreate)) / 864e5) : 30;
      const prevDays = Math.min(23, Math.max(0, age - 7));
      const a7 = act.c7 / 7, a23 = prevDays ? (act.c30 - act.c7) / prevDays : null;
      if (a23 != null && a7 > a23 * 2) add('spike', `近 7 天日均 ${money(a7)}，此前 ${prevDays} 天日均 ${money(a23)}（${a23 ? (a7 / a23).toFixed(1) + ' 倍' : '新增'}）`);
    }
    if (!k.description && (c > 0 || (act && act.c30 > 0))) add('no_desc', `本期 ${money(c)}，近 30 天 ${money(act?.c30 || 0)}`);
    if (useCc && !k.costCenter && c > 0) add('no_cc', `本期 ${money(c)}，未分配成本中心`);
    if (live && k.disabled !== true) {
      const broad = (k.authType === 'All' || k.allowAllModels) && ipOpen(k);
      if (broad) add('broad', `${k.authType === 'All' ? '授权类型：全部' : '可访问全部模型'}，IP ${(k.accessIps || []).length ? k.accessIps.join(', ') : '不限'}`);
      else if (ipOpen(k)) add('open_ip', `IP 白名单：${(k.accessIps || []).join(', ') || '未配置'}`);
      // 创建不足 30 天的新 Key 不计入闲置（尚未到观察期）
      const ageDays = k.gmtCreate ? Math.floor((Date.now() - Number(k.gmtCreate)) / 864e5) : Infinity;
      if (ageDays >= 30 && (!act?.lastDay || act.lastDay < idleBefore)) {
        const created = Number.isFinite(ageDays) ? `，创建于 ${fmtTime(k.gmtCreate, false)}` : '';
        if (k.provider !== 'tencent' || k.disabled !== true) add('idle', (act?.lastDay ? `最近消费 ${act.lastDay}（${Math.round((Date.parse(state.today) - Date.parse(act.lastDay)) / 864e5)} 天前）` : '同步范围内无消费记录') + created);
      }
      if (!k.workspaceId && k.provider !== 'tencent') add('no_ws', '未归属任何业务空间');
    }
  }
  // 成本中心预算（自然月）：按应付金额统计整个成本中心本期的费用（未分配成本中心含无 API Key 的费用），与预算告警口径一致
  if (month && hasCcBudgets()) {
    const ccCost = new Map(), ccDaily = new Map();
    for (const l of state.lines) { const g = dimVal.cc(l); ccCost.set(g, (ccCost.get(g) || 0) + l.pretax); }
    for (const l of state.daily) { const g = dimVal.cc(l); if (!ccDaily.has(g)) ccDaily.set(g, []); ccDaily.get(g).push(l); }
    for (const cc of Object.keys(state.budgets.costCenters || {})) {
      const budget = ccBudgetOf(cc);
      if (!budget) continue;
      const c = ccCost.get(cc) || 0;
      const add = (rule, detail) => out.push({ rule, ruleName: RULES[rule].name, severity: RULES[rule].severity, advice: RULES[rule].advice, keyId: null, ccId: cc, detail, cost: c });
      if (c >= budget) add('cc_over_budget', `本期 ${money(c)}，预算 ${money(budget)}，超出 ${money(c - budget)}`);
      else if (isCurrentMonth()) {
        const fc = forecastOf(ccDaily.get(cc) || [], l => l.pretax);
        if (fc && fc.value >= budget) add('cc_forecast_over', `预计月末 ${money(fc.value)}，预算 ${money(budget)}（本期已用 ${money(c)}）`);
      }
    }
  }
  return out.sort((a, b) => SEVERITY[a.severity].order - SEVERITY[b.severity].order || b.cost - a.cost);
}

export function render(v) {
  const all = computeFindings();
  const rules = Object.keys(RULES).map(r => ({ r, n: all.filter(f => f.rule === r).length })).filter(x => x.n);
  if (ui.govRule && !rules.some(x => x.r === ui.govRule)) ui.govRule = '';
  const list = ui.govRule ? all.filter(f => f.rule === ui.govRule) : all;
  const keysWithIssue = new Set(all.filter(f => f.keyId != null).map(f => f.keyId)).size;
  const live = [...state.apiKeys.values()].filter(k => k.source === 'api').length;
  v.innerHTML = `
    <div class="stat-strip">
      <div><span>检查的 API Key</span><b>${state.apiKeys.size}</b></div>
      <div><span>存在问题的 Key</span><b>${keysWithIssue}</b></div>
      <div><span>高风险</span><b class="${all.some(f => f.severity === 'high') ? 'bad-text' : ''}">${all.filter(f => f.severity === 'high').length}</b></div>
      <div><span>中风险</span><b class="${all.some(f => f.severity === 'medium') ? 'warn-text' : ''}">${all.filter(f => f.severity === 'medium').length}</b></div>
      <div><span>低风险</span><b>${all.filter(f => f.severity === 'low').length}</b></div>
      <div><span>有效 Key（云端存在）</span><b>${live}</b></div>
    </div>
    <section class="panel">
      <div class="panel-h"><h3>治理问题清单</h3>${help('基于云厂商同步的 Key 属性（描述、归属、状态、权限、IP 白名单）、本地成本中心标签、本期账单、近 30 天消费与预算设置自动检查。费用口径为应付金额。')}
        <div class="actions"><button class="btn sm" id="csv">${icon('download')}导出</button></div></div>
      <div class="rule-chips" role="group" aria-label="按规则筛选">
        <button class="rule-chip" data-rule="" aria-pressed="${!ui.govRule}">全部 <b>${all.length}</b></button>
        ${rules.map(x => `<button class="rule-chip" data-rule="${x.r}" aria-pressed="${ui.govRule === x.r}"><span class="pill ${SEVERITY[RULES[x.r].severity].cls}">${SEVERITY[RULES[x.r].severity].label}</span>${esc(RULES[x.r].name)} <b>${x.n}</b></button>`).join('')}
      </div>
      <div id="tbl"></div>
    </section>`;
  v.querySelectorAll('[data-rule]').forEach(b => b.onclick = () => { ui.govRule = b.dataset.rule; render(v); });
  const t = table('gov', $('#tbl', v), {
    sort: 'sev', dir: 'asc', pageSize: 100, caption: '治理问题清单', empty: '未发现治理问题',
    // 成本中心预算的条目（ccId）进入成本中心详情
    onRowClick: r => (r.ccId != null ? app.go(groupHash('cc', r.ccId)) : r.keyId !== NONE_KEY ? app.go(`#/key/${encodeURIComponent(r.keyId)}`) : null),
    columns: [
      { key: 'key', label: 'API Key / 成本中心', fmt: (x, r) => (r.ccId != null ? `<b style="font-weight:600">${esc(ccName(r.ccId))}</b><span class="sub">成本中心</span>`
        : `<b style="font-weight:600">${esc(keyShort(r.keyId))}</b>${provTag(state.apiKeys.get(r.keyId)?.provider)}<span class="sub mono">${esc(r.keyId)}</span>`),
      sortVal: r => (r.ccId != null ? ccName(r.ccId) : keyShort(r.keyId)), csv: r => (r.ccId != null ? `成本中心：${ccName(r.ccId)}` : `${keyDesc(r.keyId)} (${r.keyId})`) },
      { key: 'sev', label: '等级', fmt: (x, r) => `<span class="pill ${SEVERITY[r.severity].cls}">${SEVERITY[r.severity].label}</span>`, sortVal: r => SEVERITY[r.severity].order, csv: r => SEVERITY[r.severity].label },
      { key: 'ruleName', label: '问题' },
      { key: 'detail', label: '说明', cls: 'wrap-cell' },
      { key: 'advice', label: '建议', cls: 'wrap-cell' },
      { key: 'ws', label: '业务空间', fmt: (x, r) => (r.ccId != null ? '<span class="muted">—</span>' : (w => dimLink('ws', w || NO_WS, wsName(w)))(state.apiKeys.get(r.keyId)?.wsKey || '')),
        sortVal: r => (r.ccId != null ? '' : wsName(state.apiKeys.get(r.keyId)?.wsKey || '')), csv: r => (r.ccId != null ? '' : wsName(state.apiKeys.get(r.keyId)?.wsKey || '')) },
      { key: 'cost', label: '本期费用', align: 'r', fmt: x => money(x) },
    ],
  }).setRows(list);
  $('#csv', v).onclick = () => t.csv('API_Key治理清单.csv');
}
