/* =========================================================================
 * 自动洞察：基于当前筛选数据的确定性规则（不调用任何外部服务）
 * ========================================================================= */
import { esc, money, pct, sum, uniq, metricVal, aggregate, aggAll, sortedAggs, DIMS, NONE_KEY, keyObj, keyShort,
  forecastOf, budgetOf, state, addDays, daysBetween, filterLines, activeFilterCount } from './core.js';

const b = v => `<b>${esc(v)}</b>`;

/** 缓存命中节省估算：同模型 + 同时段 + 同上下文档位的常规输入单价 − 缓存命中单价 */
export function cacheSavings(lines) {
  const normal = new Map();
  for (const l of lines) {
    if (l.ioi.dir !== 'in' || l.ioi.cache || l.ioi.thinking || !/千tokens/.test(l.listPriceUnit)) continue;
    const p = parseFloat(l.listPrice);
    if (Number.isFinite(p)) normal.set(`${l.model}|${l.ioi.time}|${l.ioi.ctx}`, p);
  }
  let saved = 0;
  for (const l of lines) {
    if (l.ioi.cache !== 'hit' || l.tokens == null || !/千tokens/.test(l.listPriceUnit)) continue;
    const np = normal.get(`${l.model}|${l.ioi.time}|${l.ioi.ctx}`), hp = parseFloat(l.listPrice);
    if (np != null && Number.isFinite(hp) && np > hp) saved += l.tokens / 1000 * (np - hp);
  }
  return saved;
}

export function computeInsights() {
  const p = state.data.period;
  const lines = filterLines(), prevLines = filterLines(state.prev), daily = filterLines(state.daily);
  const cur = aggAll(lines), prev = aggAll(prevLines);
  const out = [];
  const byKey = aggregate(lines, DIMS.key.of), pByKey = aggregate(prevLines, DIMS.key.of);

  // 1. 费用变化与驱动因素
  if (prev.cost > 0 || cur.cost > 0) {
    const d = cur.cost - prev.cost;
    const drivers = uniq([...byKey.keys(), ...pByKey.keys()])
      .map(id => ({ id, d: (byKey.get(id)?.cost || 0) - (pByKey.get(id)?.cost || 0) }))
      .filter(x => Math.sign(x.d) === Math.sign(d) && Math.abs(x.d) >= 0.01)
      .sort((a, c) => Math.abs(c.d) - Math.abs(a.d)).slice(0, 2);
    const ratio = prev.cost ? d / prev.cost * 100 : null;
    const driverText = drivers.length ? `主要来自 ${drivers.map(x => `${b(keyShort(x.id))}（${x.d > 0 ? '+' : '−'}${esc(money(Math.abs(x.d)))}）`).join('、')}。` : '';
    out.push({
      level: d > 0 && (ratio == null || ratio > 20) ? 'warn' : d > 0 ? 'info' : 'good', icon: d >= 0 ? 'up' : 'down', rank: 1,
      title: prev.cost ? `费用${state.compareLabel}${d >= 0 ? '上升' : '下降'} ${Math.abs(ratio).toFixed(1)}%` : '本期新增费用',
      html: `本期 ${b(money(cur.cost))}，上期 ${b(money(prev.cost))}，变动 ${b((d >= 0 ? '+' : '−') + money(Math.abs(d)))}。${driverText}`,
      go: drivers[0] && drivers[0].id !== NONE_KEY ? `#/key/${encodeURIComponent(drivers[0].id)}` : null, goLabel: '查看主要 Key',
    });
  }

  // 2. 预测与预算
  // 预算比较固定用应付金额（预算按应付金额设置）；其余情况与旁边的“预计本月费用”一致，按当前费用口径
  const budget = budgetOf();
  const useBudget = budget && !hasDimFilter();
  const fc = forecastOf(daily, useBudget ? l => l.pretax : metricVal);
  if (fc) {
    const prevFull = sum(filterLines(state.prevFull), useBudget ? l => l.pretax : metricVal);
    if (useBudget) {
      const r = fc.value / budget * 100;
      out.push({
        level: r >= 100 ? 'bad' : r >= (state.budgets.alertPct || 80) ? 'warn' : 'good', icon: 'wallet', rank: r >= 100 ? 0 : 2,
        title: r >= 100 ? `预计超出月度预算 ${money(fc.value - budget)}` : `预计使用月度预算的 ${r.toFixed(0)}%`,
        html: `按已完成 ${fc.fullDays} 天日均 ${b(money(fc.avg))} 推算，本月预计 ${b(money(fc.value))}，月度预算 ${b(money(budget))}，当前已用 ${b(pct(sum(lines, l => l.pretax), budget))}。`,
      });
    } else {
      out.push({
        level: 'info', icon: 'forecast', rank: 3, title: `本月预计 ${money(fc.value)}`,
        html: `按已完成 ${fc.fullDays} 天日均 ${b(money(fc.avg))} 推算${prevFull ? `，较上月全月 ${b(money(prevFull))} ${fc.value >= prevFull ? '增加' : '减少'} ${b(pct(Math.abs(fc.value - prevFull), prevFull))}` : ''}。${!budget && !hasDimFilter() ? '尚未设置月度预算。' : ''}`,
        go: !budget && state.me?.role === 'admin' && !hasDimFilter() ? '#/admin/budgets' : null, goLabel: '设置预算',
      });
    }
  }

  // 3. 超预算 Key（当月）
  if (p.mode === 'month') {
    // 预算是 Key 的整月总额：按该 Key 的全部应付金额判断，不受模型等筛选影响（与治理页一致）
    const full = new Map();
    for (const l of state.lines) { const id = l.apiKeyId || NONE_KEY; full.set(id, (full.get(id) || 0) + l.pretax); }
    const over = sortedAggs(byKey).filter(a => budgetOf(a.key) && (full.get(a.key) || 0) >= budgetOf(a.key));
    if (over.length) out.push({ level: 'bad', icon: 'wallet', rank: 0, title: `${over.length} 个 API Key 已超出预算`, html: over.slice(0, 3).map(a => `${b(keyShort(a.key))} ${esc(money(full.get(a.key) || 0))} / ${esc(money(budgetOf(a.key)))}`).join('；'), go: '#/governance', goLabel: '查看治理' });
  }

  // 4. 费用集中度
  const ranked = sortedAggs(byKey).filter(a => a.cost > 0);
  if (ranked.length >= 3 && cur.cost > 0) {
    const s1 = ranked[0].cost / cur.cost, s3 = sum(ranked.slice(0, 3), a => a.cost) / cur.cost;
    if (s1 >= 0.5) out.push({ level: 'warn', icon: 'layers', rank: 4, title: '费用高度集中', html: `${b(keyShort(ranked[0].key))} 占 ${b(pct(ranked[0].cost, cur.cost))}，前 3 个 Key 合计占 ${b((s3 * 100).toFixed(1) + '%')}。建议对该 Key 设置独立预算与告警。`, go: ranked[0].key !== NONE_KEY ? `#/key/${encodeURIComponent(ranked[0].key)}` : null, goLabel: '查看该 Key' });
  }

  // 5. 异常日（均值 + 2σ 且 ≥ 1.5 倍日均）
  const yesterday = addDays(state.today, -1);
  const from = p.from, to = p.to < yesterday ? p.to : yesterday;
  if (to >= from) {
    const n = daysBetween(from, to);
    if (n >= 5) {
      const dm = new Map();
      daily.forEach(l => { if (l.date >= from && l.date <= to) dm.set(l.date, (dm.get(l.date) || 0) + metricVal(l)); });
      const vals = []; for (let d = from; d <= to; d = addDays(d, 1)) vals.push([d, dm.get(d) || 0]);
      const mean = sum(vals, v => v[1]) / vals.length;
      const sd = Math.sqrt(sum(vals, v => (v[1] - mean) ** 2) / vals.length);
      const peaks = vals.filter(v => v[1] > mean + 2 * sd && v[1] > mean * 1.5).sort((a, c) => c[1] - a[1]);
      if (peaks.length && mean > 0) out.push({ level: 'warn', icon: 'warn', rank: 2, title: `发现 ${peaks.length} 个费用异常日`, html: peaks.slice(0, 2).map(v => `${b(v[0].slice(5))} 费用 ${b(money(v[1]))}，为日均的 ${b((v[1] / mean).toFixed(1) + ' 倍')}`).join('；') + '。', day: peaks[0][0], dayLabel: `查看 ${peaks[0][0].slice(5)} 明细` });
    }
  }

  // 6. 缓存效率
  if (cur.tIn > 0) {
    const hit = cur.tCache / cur.tIn, ph = prev.tIn ? prev.tCache / prev.tIn : null;
    const saved = cacheSavings(lines);
    out.push({ level: hit >= 0.5 ? 'good' : 'info', icon: 'cache', rank: 6, title: `缓存命中率 ${(hit * 100).toFixed(1)}%`,
      html: `${ph != null ? `较上期 ${b(((hit - ph) * 100 >= 0 ? '+' : '') + ((hit - ph) * 100).toFixed(1) + 'pp')}。` : ''}${saved > 0.01 ? `按同模型常规输入单价估算，缓存为本期节省约 ${b(money(saved))}。` : ''}${hit < 0.3 ? '可通过复用系统提示词、固定前缀提升命中率。' : ''}` });
  }

  // 7. 治理风险
  const noDesc = ranked.filter(a => a.key !== NONE_KEY && !keyObj(a.key)?.description);
  // 已删除的 Key 只统计删除日之后（账单时区）的费用，与 Key 治理一致：删除前的正常消费不是风险
  const delDay = ts => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: state.tz || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ts))); } catch { return ''; } };
  const deleted = ranked.filter(a => {
    const k = keyObj(a.key);
    if (a.key === NONE_KEY || !k) return false;
    if (k.source === 'bill') return true;
    if (k.source !== 'deleted' || !k.deletedAt) return false;
    const dd = delDay(k.deletedAt);
    return state.daily.some(l => l.apiKeyId === a.key && l.date > dd && l.pretax > 0.005);
  });
  if (noDesc.length || deleted.length) {
    out.push({ level: 'warn', icon: 'shield', rank: 3, title: '存在需治理的 API Key', html: [
      noDesc.length ? `${b(noDesc.length + ' 个')}有消费的 Key 未填写描述（${noDesc.slice(0, 2).map(a => esc(a.key)).join('、')}），费用难以归属` : '',
      deleted.length ? `${b(deleted.length + ' 个')}已删除/不在列表的 Key 仍产生费用` : '',
    ].filter(Boolean).join('；') + '。', go: '#/governance', goLabel: '前往 Key 治理' });
  }

  // 8. 峰时占比
  const peak = sum(lines.filter(l => l.ioi.time === 'peak'), metricVal), off = sum(lines.filter(l => l.ioi.time === 'offpeak'), metricVal);
  if (peak + off > 0 && peak / (peak + off) > 0.6) out.push({ level: 'info', icon: 'clock', rank: 7, title: `峰时调用占分时计费的 ${pct(peak, peak + off)}`, html: `峰时 ${b(money(peak))}，闲时 ${b(money(off))}。可将批量、离线类任务调度至闲时以降低单价。` });

  // 9. 新增模型
  // 是否“新增”与上一个完整周期比较（本月进行中时 prev 只是上月同期，月初会把常用模型误判为新增）
  const prevModels = new Set(filterLines(state.prevFull).map(l => l.model));
  const newModels = sortedAggs(aggregate(lines, l => l.model)).filter(a => a.cost > 0 && !prevModels.has(a.key));
  if (newModels.length && prevLines.length) out.push({ level: 'info', icon: 'model', rank: 8, title: `本期新增使用 ${newModels.length} 个模型`, html: newModels.slice(0, 4).map(a => `${b(a.key)} ${esc(money(a.cost))}`).join('、') + (newModels.length > 4 ? ' 等' : '') + '。', ...(newModels.length === 1 ? { model: newModels[0].key, modelLabel: '查看该模型' } : { go: '#/models', goLabel: '模型分析' }) });

  // 10. 腾讯云费用口径：目录价估算 / 未匹配到用量
  const est = sum(lines.filter(l => l.alloc === 2), metricVal);
  if (est > 0.005) out.push({ level: 'warn', icon: 'info', rank: 2, title: '部分腾讯云费用为目录价估算', html: `估算金额 ${b(money(est))}，未含折扣、代金券与阶梯价。为腾讯云 CAM 子用户授予“计费只读”权限后，下次同步将自动改用真实账单。`, go: state.me?.role === 'admin' ? '#/admin/tencent' : null, goLabel: '腾讯云接入' });
  const unTc = sum(lines.filter(l => l.provider === 'tencent' && !l.apiKeyId), metricVal);
  if (unTc > 0.01) out.push({ level: 'info', icon: 'info', rank: 7, title: `腾讯云有 ${money(unTc)} 未归属到 API Key`, html: '这部分账单在 TokenHub 用量中找不到对应模型（如控制台体验、非 API Key 调用或用量统计尚未覆盖），计入“无 API Key”。' });

  return out.sort((a, c) => a.rank - c.rank).slice(0, 6);
}
/** 有维度筛选时，整体预算不适用 */
const hasDimFilter = () => activeFilterCount() > 0;
