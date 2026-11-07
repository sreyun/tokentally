/* =========================================================================
 * 图表组件（SVG / HTML，无外部依赖）
 * 规范：柱宽 ≤24px、顶端 4px 圆角、2px 段间隙；折线 2px；网格线 1px 实线；
 *      ≥2 个系列必有图例；文字使用文本色，不使用系列色。
 * ========================================================================= */
import { esc, sum, money, compact, curSym, intFmt, pct, isWeekend, WEEK, weekday, tipRows, deltaPill, DIMS, sortedAggs } from './core.js';

export function niceStep(max, n = 4) {
  if (!(max > 0)) return 1;
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
export function axisMoney(v, top) {
  if (top >= 1e4) return curSym() + compact(v);
  return curSym() + v.toLocaleString('zh-CN', { maximumFractionDigits: top < 1 ? 3 : top < 10 ? 2 : 0 });
}
export const legendHtml = items => items.map(it => `<span title="${esc(it.label)}"><i class="${it.line ? 'line' : ''}" style="background:${it.color}"></i><em>${esc(it.label)}</em></span>`).join('');
const uid = () => 'g' + Math.random().toString(36).slice(2, 8);
const width = el => Math.max(300, Math.floor(el.clientWidth || el.parentElement?.clientWidth || 800));

export function sparkline(values, color = 'var(--s1)') {
  if (values.length < 2) return '';
  const W = 300, H = 60, pad = 4;
  const max = Math.max(...values, 0) || 1;
  const xs = i => pad + i * (W - pad * 2) / (values.length - 1);
  const ys = v => H - pad - v / max * (H - pad * 2);
  const pts = values.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`);
  const last = values.length - 1;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M${pts[0]} L${pts.join(' L')} L${xs(last)},${H - pad} L${xs(0)},${H - pad}Z" fill="${color}" fill-opacity=".1"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

/** 堆叠柱状图 */
export function columnChart(el, { xs, series, cell, avg = null, height = 260, xLabel = x => x, tipTitle = x => x, aria = '', empty = '暂无数据', weekend = true, onX, clickHint = '' }) {
  if (!xs.length) { el.innerHTML = `<div class="nodata">${esc(empty)}</div>`; return; }
  const W = width(el), H = height;
  const m = { l: 60, r: 10, t: 16, b: 26 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const totals = xs.map(x => series.reduce((s, sr) => s + Math.max(0, cell(x, sr.id)), 0));
  const maxT = Math.max(...totals, avg || 0, 0);
  const step = niceStep(maxT), top = Math.max(step, Math.ceil(maxT / step) * step);
  const band = pw / xs.length, cw = Math.max(2, Math.min(24, band * 0.62)), base = m.t + ph, id = uid();
  let defs = '', body = '';
  if (weekend) xs.forEach((x, i) => { if (x.length === 10 && isWeekend(x)) body += `<rect class="weekend" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>`; });
  for (let v = 0; v <= top + step / 2; v += step) {
    const y = base - v / top * ph;
    body += `<line class="${v === 0 ? 'baseline' : 'gridline'}" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/><text x="${m.l - 8}" y="${y + 4}" text-anchor="end">${esc(axisMoney(v, top))}</text>`;
  }
  xs.forEach((x, i) => {
    const th = totals[i] / top * ph;
    if (th <= 0) return;
    const bx = m.l + band * i + (band - cw) / 2, r = Math.min(4, cw / 2, th), yt = base - th;
    defs += `<clipPath id="${id}c${i}"><path d="M${bx},${base}V${yt + r}Q${bx},${yt} ${bx + r},${yt}H${bx + cw - r}Q${bx + cw},${yt} ${bx + cw},${yt + r}V${base}Z"/></clipPath>`;
    let y0 = base;
    const segs = series.map(sr => ({ sr, v: Math.max(0, cell(x, sr.id)) })).filter(z => z.v > 0);
    body += `<g clip-path="url(#${id}c${i})">`;
    segs.forEach((z, j) => {
      const h = z.v / top * ph, y = y0 - h, gap = j < segs.length - 1 ? 2 : 0;
      if (h - gap > 0.3) body += `<rect x="${bx}" y="${y + gap}" width="${cw}" height="${h - gap}" fill="${z.sr.color}"/>`;
      y0 = y;
    });
    body += '</g>';
  });
  if (avg > 0) {
    const y = base - avg / top * ph;
    body += `<line class="avgline" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/><text class="ann" x="${m.l + 6}" y="${y - 6}">日均 ${esc(money(avg))}</text>`;
  }
  const every = Math.max(1, Math.ceil(xs.length * 46 / pw));
  xs.forEach((x, i) => {
    if (i % every === 0) body += `<text x="${m.l + band * i + band / 2}" y="${H - 7}" text-anchor="middle">${esc(xLabel(x))}</text>`;
    const rows = series.map(sr => [sr.label, cell(x, sr.id), sr.color]).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
    const tip = tipRows(`${tipTitle(x)} · 合计 ${money(totals[i])}`, rows.slice(0, 10).map(r => [r[0], money(r[1]), r[2]]).concat(rows.length > 10 ? [[`其余 ${rows.length - 10} 项`, money(sum(rows.slice(10), r => r[1])), '']] : []))
      + (onX && clickHint && totals[i] > 0 ? `<div class="tip-hint">${esc(clickHint)}</div>` : '');
    body += `<rect class="hit" ${onX && totals[i] > 0 ? 'style="cursor:pointer" tabindex="0" role="button"' : ''} aria-label="${esc(`${tipTitle(x)} ${money(totals[i])}`)}" data-x="${esc(x)}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}" data-tip="${esc(tip)}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}"><defs>${defs}</defs>${body}</svg>`;
  const pick = e => { const r = e.target.closest('[data-x]'); return r && totals[xs.indexOf(r.dataset.x)] > 0 ? r.dataset.x : null; };
  el.onclick = onX ? e => { const x = pick(e); if (x) onX(x); } : null;
  el.onkeydown = onX ? e => { if (e.key === 'Enter' || e.key === ' ') { const x = pick(e); if (x) { e.preventDefault(); onX(x); } } } : null;
}

/** 多折线图（单一 Y 轴） */
export function lineChart(el, { xs, lines, height = 260, xLabel = x => x, tipTitle = x => x, aria = '', empty = '暂无数据' }) {
  const vals = lines.flatMap(l => l.values.filter(v => v != null));
  if (!xs.length || !vals.length) { el.innerHTML = `<div class="nodata">${esc(empty)}</div>`; return; }
  const W = width(el), H = height;
  const m = { l: 64, r: 70, t: 16, b: 26 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const maxV = Math.max(...vals, 0);
  const step = niceStep(maxV), top = Math.max(step, Math.ceil(maxV / step) * step), base = m.t + ph;
  const X = i => m.l + (xs.length === 1 ? pw / 2 : i * pw / (xs.length - 1));
  const Y = v => base - v / top * ph;
  let body = '';
  for (let v = 0; v <= top + step / 2; v += step) body += `<line class="${v === 0 ? 'baseline' : 'gridline'}" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${esc(axisMoney(v, top))}</text>`;
  const every = Math.max(1, Math.ceil(xs.length * 46 / pw));
  xs.forEach((x, i) => { if (i % every === 0 || i === xs.length - 1) body += `<text x="${X(i)}" y="${H - 7}" text-anchor="middle">${esc(xLabel(x))}</text>`; });
  const labels = [];
  for (const ln of lines) {
    let d = '', started = false, lastI = -1;
    ln.values.forEach((v, i) => { if (v == null) { started = false; return; } d += `${started ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; started = true; lastI = i; });
    if (!d) continue;
    body += `<path d="${d}" fill="none" stroke="${ln.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${ln.dashed ? 'stroke-dasharray="5 5" opacity=".75"' : ''}/>`;
    if (lastI >= 0 && !ln.noEnd) {
      body += `<circle cx="${X(lastI)}" cy="${Y(ln.values[lastI])}" r="4" fill="${ln.color}" stroke="var(--surface)" stroke-width="2"/>`;
      labels.push({ y: Y(ln.values[lastI]), x: X(lastI), text: ln.endLabel || money(ln.values[lastI]) });
    }
  }
  // 末端标签避免重叠：按 y 排序后保持最小间距
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  for (const lb of labels) body += `<text class="ann" x="${lb.x + 8}" y="${lb.y + 4}">${esc(lb.text)}</text>`;
  const band = pw / Math.max(1, xs.length - 1);
  xs.forEach((x, i) => {
    const rows = lines.filter(l => !l.noTip && l.values[i] != null).map(l => [l.label, money(l.values[i]), l.color]);
    if (!rows.length) return;
    const x0 = xs.length === 1 ? m.l : X(i) - band / 2;
    body += `<rect class="hit" x="${Math.max(m.l, x0)}" y="${m.t}" width="${xs.length === 1 ? pw : band}" height="${ph}" data-tip="${esc(tipRows(tipTitle(x), rows))}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">${body}</svg>`;
}

/** 两行式排行：名称/数值 + 条形/占比/环比 */
export function rankList(el, items, { fmt = v => money(v), limit = 10, onClick, total, showDelta = false, goodWhenUp = false, empty = '暂无数据', color } = {}) {
  items = items.filter(i => i.value > 0);
  if (!items.length) { el.innerHTML = `<div class="nodata">${esc(empty)}</div>`; return; }
  const max = Math.max(...items.map(i => i.value)) || 1;
  const tot = total ?? sum(items, i => i.value);
  const shown = items.slice(0, limit);
  el.innerHTML = `<ol class="rank">${shown.map((it, i) => `<li class="${onClick ? 'clickable' : ''}" data-idx="${i}" ${onClick ? 'tabindex="0" role="button"' : ''} ${it.tip ? `data-tip="${esc(it.tip)}"` : ''}>
      <span class="rank-no">${i + 1}</span>
      <div><div class="rank-top"><span class="rank-label" title="${esc(it.label + (it.sub ? " · " + it.sub : ""))}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span><span class="rank-val">${esc(fmt(it.value))}</span></div>
      <div class="rank-bot"><span class="rank-bar"><i style="width:${Math.max(1, it.value / max * 100).toFixed(1)}%;background:${it.color || color || 'var(--s1)'}"></i></span>
      <span class="rank-meta">${tot ? pct(it.value, tot) : ''}${showDelta ? ' ' + deltaPill(it.value, it.prev ?? 0, { goodWhenUp }) : ''}${it.extra ? ' ' + it.extra : ''}</span></div></div></li>`).join('')}</ol>
    ${items.length > limit ? `<div class="more">另有 ${items.length - limit} 项未显示</div>` : ''}`;
  bindActivate(el, 'li[data-idx]', li => onClick && onClick(shown[+li.dataset.idx]));
}

/** 发散排行：环比增减额 */
export function divergingList(el, items, { limit = 10, onClick } = {}) {
  items = items.filter(i => Math.abs(i.delta) >= 0.005).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, limit);
  if (!items.length) { el.innerHTML = '<div class="nodata">与上期相比无明显变化</div>'; return; }
  const max = Math.max(...items.map(i => Math.abs(i.delta))) || 1;
  el.innerHTML = `<div class="legend"><span><i style="background:var(--div-neg)"></i><em>费用减少</em></span><span><i style="background:var(--div-pos)"></i><em>费用增加</em></span></div>
  <ol class="rank">${items.map((it, i) => {
    const w = Math.max(1.5, Math.abs(it.delta) / max * 100).toFixed(1);
    const tip = tipRows(it.label, [['本期', money(it.cur)], ['上期', money(it.prev)], ['变动', (it.delta > 0 ? '+' : '') + money(it.delta)], ['变化率', it.prev ? pct(it.delta, it.prev) : '新增']]);
    return `<li class="${onClick ? 'clickable' : ''}" data-idx="${i}" ${onClick ? 'tabindex="0" role="button"' : ''} data-tip="${esc(tip)}"><span class="rank-no">${i + 1}</span>
      <div><div class="rank-top"><span class="rank-label" title="${esc(it.label + (it.sub ? " · " + it.sub : ""))}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span><span class="rank-val ${it.delta > 0 ? 'bad-text' : 'ok-text'}">${it.delta > 0 ? '+' : '−'}${esc(money(Math.abs(it.delta)))}</span></div>
      <div class="rank-bot"><span class="dv-bar"><span class="neg">${it.delta < 0 ? `<i style="width:${w}%"></i>` : ''}</span><span class="pos">${it.delta > 0 ? `<i style="width:${w}%"></i>` : ''}</span></span>
      <span class="rank-meta">${deltaPill(it.cur, it.prev)}</span></div></div></li>`;
  }).join('')}</ol>`;
  bindActivate(el, 'li[data-idx]', li => onClick && onClick(items[+li.dataset.idx]));
}

/** 多段两行式排行（如 Token 构成） */
export function stackRank(el, rows, parts, { fmt = compact, limit = 10, onClick, meta } = {}) {
  rows = rows.filter(r => r.parts.some(v => v > 0));
  if (!rows.length) { el.innerHTML = '<div class="nodata">暂无用量数据</div>'; return; }
  const max = Math.max(...rows.map(r => sum(r.parts, v => v))) || 1;
  const shown = rows.slice(0, limit);
  el.innerHTML = `<div class="legend">${legendHtml(parts)}</div><ol class="rank">${shown.map((r, i) => {
    const tot = sum(r.parts, v => v);
    const tip = tipRows(r.label, parts.map((p, j) => [p.label, `${intFmt(r.parts[j])}（${pct(r.parts[j], tot)}）`, p.color]).concat([['合计', intFmt(tot), '']]));
    return `<li class="${onClick ? 'clickable' : ''}" data-idx="${i}" ${onClick ? 'tabindex="0" role="button"' : ''} data-tip="${esc(tip)}"><span class="rank-no">${i + 1}</span>
      <div><div class="rank-top"><span class="rank-label" title="${esc(r.label)}">${esc(r.label)}</span><span class="rank-val">${esc(fmt(tot))}</span></div>
      <div class="rank-bot"><span class="rank-bar"><span class="stack" style="width:${Math.max(1, tot / max * 100).toFixed(1)}%">${r.parts.map((v, j) => (v > 0 ? `<i style="flex:${v} 1 0;background:${parts[j].color}"></i>` : '')).join('')}</span></span>
      <span class="rank-meta">${meta ? meta(r) : ''}</span></div></div></li>`;
  }).join('')}</ol>${rows.length > limit ? `<div class="more">另有 ${rows.length - limit} 项未显示</div>` : ''}`;
  bindActivate(el, 'li[data-idx]', li => onClick && onClick(shown[+li.dataset.idx]));
}

/** 分段条（整体构成） */
export function segbar(parts, { thin = false } = {}) {
  const total = sum(parts, p => p.value);
  if (!(total > 0)) return '<div class="nodata">暂无数据</div>';
  const darkText = c => /--s4\b/.test(c);
  return `<div class="segbar ${thin ? 'thin' : ''}" role="img" aria-label="${esc(parts.filter(p => p.value > 0).map(p => `${p.label} ${pct(p.value, total)}`).join('，'))}">${parts.filter(p => p.value > 0).map(p => {
    const share = p.value / total * 100;
    return `<div style="flex:${p.value} 1 0;background:${p.color}" class="${darkText(p.color) ? 'dk' : ''}" data-tip="${esc(tipRows(p.label, [['金额', money(p.value)], ['占比', share.toFixed(1) + '%']]))}">${!thin && share >= 10 ? `<span>${share.toFixed(0)}%</span>` : ''}</div>`;
  }).join('')}</div>`;
}
export const legendList = (parts, total, clickable = false) => `<div class="lgl">${parts.filter(p => p.value > 0).map((p, i) => `<div class="li ${clickable && p.id != null && p.id !== '__other' ? 'clickable' : ''}" data-pid="${esc(p.id ?? '')}" ${clickable ? 'tabindex="0"' : ''}><i style="background:${p.color}"></i><span title="${esc(p.label)}">${esc(p.label)}</span><b>${esc(money(p.value))}</b><em>${pct(p.value, total)}</em></div>`).join('')}</div>`;
export function topParts(aggMap, dim, n = 7) {
  const arr = sortedAggs(aggMap).filter(a => a.cost > 0);
  const head = arr.slice(0, n), rest = arr.slice(n);
  const parts = head.map(a => ({ id: a.key, label: DIMS[dim].short(a.key), value: a.cost, color: DIMS[dim].color(a.key) }));
  if (rest.length) parts.push({ id: '__other', label: `其他 ${rest.length} 项`, value: sum(rest, a => a.cost), color: 'var(--other)' });
  return parts;
}

/** 热力表：rows × cols */
export function heatmap(el, { rows, cols, cell, total, fmt = money, onRow, rowTip = r => r.label }) {
  if (!rows.length || !cols.length) { el.innerHTML = '<div class="nodata">暂无数据</div>'; return; }
  let max = 0;
  for (const r of rows) for (const c of cols) max = Math.max(max, cell(r.id, c.id));
  const step = v => (v > 0 && max ? Math.min(7, Math.max(1, Math.ceil(Math.sqrt(v / max) * 7))) : 0);
  el.innerHTML = `<div class="heat-wrap"><table class="heat"><thead><tr><th></th>${cols.map(c => `<th class="${c.we ? 'we' : ''}" title="${esc(c.title || c.label)}">${esc(c.label)}</th>`).join('')}<th style="text-align:right">合计</th></tr></thead><tbody>
    ${rows.map(r => `<tr><th class="${onRow ? 'clickable' : ''}" data-row="${esc(r.id)}" title="${esc(rowTip(r))}"><i class="sw" style="background:${r.color}"></i>${esc(r.label)}</th>${cols.map(c => {
      const v = cell(r.id, c.id);
      return `<td class="h${step(v)}" data-tip="${esc(tipRows(`${r.label} · ${c.title || c.label}`, [['费用', fmt(v)]]))}"></td>`;
    }).join('')}<td class="tot">${esc(fmt(total(r.id)))}</td></tr>`).join('')}
  </tbody></table></div>`;
  el.onclick = onRow ? e => { const th = e.target.closest('th[data-row]'); if (th) onRow(th.dataset.row); } : null;
}
export function dayCols(days) {
  return days.map(d => ({ id: d, label: d.slice(8), title: `${d}（周${WEEK[weekday(d)]}）`, we: isWeekend(d) }));
}

/** 列表项的点击与键盘（Enter/Space）激活 */
export function bindActivate(el, sel, fn) {
  el.onclick = e => { const t = e.target.closest(sel); if (t && el.contains(t)) fn(t, e); };
  el.onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest(sel);
    if (t && el.contains(t)) { e.preventDefault(); fn(t, e); }
  };
}
