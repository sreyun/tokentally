/* =========================================================================
 * Token 消耗与调用统计：单个 API Key / 单个模型共用
 *  - Token：总量与结构（输入非缓存 / 缓存命中 / 输出 / 向量）、输出/输入比、日均、峰值日、消耗天数、按次计费用量
 *  - 调用（腾讯云 TokenHub 用量统计；阿里云百炼监控投递的云监控 Prometheus）：请求次数、成功率、单次平均 Token（输入 / 输出 / 缓存命中）、单次平均费用、每千次费用
 * ========================================================================= */
import { esc, state, ui, money, compact, intFmt, uniq, sum, WEEK, weekday, daysBetween, totalTokens, deltaPill, unitsText, icon, help, perCallCovered, perCall, coveredCost, REQ_SRC } from './core.js';
import { columnChart, legendHtml } from './charts.js';

export const periodDays = p => Math.max(1, daysBetween(p.from, p.to < state.today ? p.to : state.today));

/**
 * a / pa：本期与上期聚合（aggAll）；daily：本期按日账单行；us：用量汇总（usageAgg 的一项，可为空）
 * scope：'key' | 'model'；provider：用于无用量时的说明
 */
export function tokenStatsHtml({ a, pa, daily, us, period, scope = 'key', provider = 'aliyun', compact: dense = false, unavailable = false }) {
  const tokens = totalTokens(a), ptokens = totalTokens(pa);
  const calDays = periodDays(period);
  const dayTok = new Map();
  daily.forEach(l => { if (l.tokens) dayTok.set(l.date, (dayTok.get(l.date) || 0) + l.tokens); });
  const peak = [...dayTok.entries()].sort((x, y) => y[1] - x[1])[0];
  const active = [...dayTok.values()].filter(x => x > 0).length;
  // 单次平均费用只用有调用数据的日期的费用；日均请求按有调用数据的天数计算
  const pc = perCallCovered(us, daily);
  const usDays = us?.days?.size || 0;
  const units = unitsText(a);
  const cell = (label, value, sub = '', cls = '') => `<div class="tok-cell ${cls}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
  const share = x => (tokens ? `占 ${(x / tokens * 100).toFixed(1)}%` : '');
  const nIn = a.tIn - a.tCache;
  const why = unavailable ? '当前按 Token 类型 / 计费项 / 渠道筛选，请求次数无法按这些维度拆分；清除这些筛选后显示。'
    : provider === 'tencent' ? `该周期 TokenHub 用量统计中没有该${scope === 'key' ? ' Key' : '模型'}的调用记录。`
      : state.status?.calls?.aliyun ? `该周期云监控 Prometheus 中没有该${scope === 'key' ? ' Key' : '模型'}的调用记录（调用次数从开启百炼“监控数据投递”之日起才有数据）。`
        : `阿里云百炼 OpenAPI 与费用中心账单不含调用次数。管理员可在“系统管理 → 阿里云接入 → 调用次数”中接入百炼监控投递的云监控 Prometheus，接入后显示${scope === 'key' ? '该 Key' : '该模型'}的请求次数、成功率与单次平均；也可在百炼控制台“监控告警”中查看。`;
  return `<div class="tok-grid ${dense ? 'dense' : ''}">
      <div class="tok-group"><h4>Token 消耗</h4><div class="tok-cells">
        ${cell('总 Token', compact(tokens), `${deltaPill(tokens, ptokens, { neutral: true })} <span class="muted">${esc(state.compareLabel)}</span>`, 'big')}
        ${cell('输入（非缓存）', compact(nIn), share(nIn))}
        ${cell('缓存命中', compact(a.tCache), a.tIn ? `命中率 ${(a.tCache / a.tIn * 100).toFixed(1)}%` : '')}
        ${cell('输出', compact(a.tOut), share(a.tOut))}
        ${a.tEmb ? cell('向量', compact(a.tEmb), share(a.tEmb)) : ''}
        ${cell('输出 / 输入', a.tIn ? (a.tOut / a.tIn * 100).toFixed(1) + '%' : '—', '输出 Token ÷ 输入 Token')}
        ${cell('日均 Token', compact(tokens / calDays), `按 ${calDays} 个自然日`)}
        ${cell('峰值日', peak ? compact(peak[1]) : '—', peak ? `${peak[0].slice(5)}（周${WEEK[weekday(peak[0])]}）` : '')}
        ${cell('消耗天数', `${active}<small>/ ${calDays}</small>`, active ? `活跃日均 ${compact(tokens / active)}` : '')}
        ${units ? cell('按次 / 其他计费用量', esc(units), '非 Token 计费项') : ''}
      </div></div>
      <div class="tok-group"><h4>调用</h4>${pc ? `<div class="tok-cells">
        ${cell('请求次数', intFmt(pc.requests), `日均 ${intFmt(pc.requests / Math.max(1, usDays))} 次${usDays < calDays ? `（按 ${usDays} 天调用数据）` : ''}${scope === 'model' && us.keys ? ` · ${us.keys.size} 个 Key` : ''}`, 'big')}
        ${pc.success == null ? cell('成功率', '—', '阿里云未配置失败次数指标') : cell('成功率', (pc.success * 100).toFixed(2) + '%', `失败 ${intFmt(pc.fails)} 次`, pc.success < 0.95 ? 'bad' : pc.success < 0.99 ? 'warn' : '')}
        ${cell('单次平均 Token', intFmt(pc.tokPer), `输入 ${intFmt(pc.inPer)} · 输出 ${intFmt(pc.outPer)}`)}
        ${cell('单次平均费用', money(pc.costPer, pc.costPer < 0.01 ? 4 : 3), `每千次 ${money(pc.costPerK)}${usDays < calDays ? ` · 仅计有调用数据的 ${usDays} 天费用` : ''}`)}
        ${cell('单次平均缓存命中', intFmt(us.cache / pc.requests), us.input ? `占输入 ${(us.cache / us.input * 100).toFixed(1)}%` : '')}
      </div>` : `<div class="tok-empty">${icon('info')}<div><b>暂无调用次数数据</b><span>${esc(why)}</span></div></div>`}</div>
    </div>`;
}

const TOKS = [['in', '输入（非缓存）', 'var(--s1)'], ['hit', '缓存命中', 'var(--s3)'], ['out', '输出', 'var(--s2)'], ['emb', '向量', 'var(--s7)'], ['other', '其他', 'var(--other)']];
const tType = l => (l.ioi.dir === 'in' ? (l.ioi.cache === 'hit' ? 'hit' : 'in') : ['out', 'emb'].includes(l.ioi.dir) ? l.ioi.dir : 'other');

/** 每日 Token（按类型堆叠） */
export function drawDailyTokens(el, legendEl, daily, period, { onX, height = 240 } = {}) {
  const tcell = new Map();
  daily.forEach(l => { if (l.tokens == null) return; const kk = l.date + '|' + tType(l); tcell.set(kk, (tcell.get(kk) || 0) + l.tokens); });
  const series = TOKS.filter(([t]) => [...tcell.keys()].some(k => k.endsWith('|' + t))).map(([t, label, color]) => ({ id: t, label, color }));
  const days = uniq(daily.filter(l => l.tokens).map(l => l.date)).sort();
  const total = sum(daily, l => l.tokens || 0);
  if (legendEl) legendEl.innerHTML = series.length > 1 ? legendHtml(series) : '';
  columnChart(el, {
    xs: days, series, cell: (x, s) => tcell.get(x + '|' + s) || 0, avg: days.length ? total / periodDays(period) : null, height, fmt: compact,
    xLabel: x => x.slice(5), tipTitle: x => `${x}（周${WEEK[weekday(x)]}）`, empty: '本期无 Token 用量（可能为按次计费的模型）', onX, clickHint: onX ? '点击查看当日明细' : '',
  });
}

/** 每日调用次数（成功 / 失败），悬停显示单次平均 Token */
export function drawDailyRequests(el, legendEl, us, period, { height = 240 } = {}) {
  const days = [...us.days.keys()].sort();
  if (legendEl) legendEl.innerHTML = legendHtml([{ label: '成功', color: 'var(--s3)' }, { label: '失败', color: 'var(--s8)' }]);
  columnChart(el, {
    xs: days, series: [{ id: 'ok', label: '成功', color: 'var(--s3)' }, { id: 'fail', label: '失败', color: 'var(--s8)' }], height, fmt: x => intFmt(x),
    cell: (x, s) => { const d = us.days.get(x); return d ? (s === 'ok' ? d.requests - d.fails : d.fails) : 0; },
    avg: days.length ? us.requests / days.length : null, xLabel: x => x.slice(5), // 均值按有调用数据的天数

    tipTitle: x => { const d = us.days.get(x); return `${x}（周${WEEK[weekday(x)]}）${d && d.requests ? ` · 单次平均 ${intFmt(d.tokens / d.requests)} Token` : ''}`; },
    empty: '本期无调用记录',
  });
}

export const reqHelp = () => help(`${REQ_SRC}，按 API Key × 模型 × 日。悬停查看当日请求数、失败数与单次平均 Token。`);
