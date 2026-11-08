/* 成本分摊 / 多维透视：任选行、列维度与指标，交叉汇总并导出 */
import { $, esc, state, ui, app, LS, money, compact, intFmt, pct, sum, uniq, metricVal, METRICS, NONE_KEY, keyShort, wsName, channelLabel, ioInfo,
  filterLines, icon, help, opt, periodTag, toast, PROVIDERS, multiCloud, hasTags, ccName, WEEK, weekday, addDays, NO_WS, NO_CC, NO_OWNER, groupHash } from '../core.js';
import { table } from '../table.js';

const TT = { in: '输入（非缓存）', hit: '缓存命中', create: '缓存创建', out: '输出', emb: '向量', other: '其他 / 订阅' };
const TIME = { peak: '峰时', offpeak: '闲时', std: '不分时段' };
/** ISO 周（周一开始）：返回“2026-W45（11-02~11-08）”的排序键 */
const isoWeek = d => {
  const wd = (weekday(d) + 6) % 7, from = addDays(d, -wd), thu = addDays(from, 3), y = thu.slice(0, 4), jan4 = `${y}-01-04`;
  const w1 = addDays(jan4, -((weekday(jan4) + 6) % 7));
  return `${y}-W${String(Math.round((Date.parse(from) - Date.parse(w1)) / 6048e5) + 1).padStart(2, '0')}|${from}`;
};
const ownerOf = l => l.owner || '';
const DIM = {
  provider: { label: '云厂商', of: l => l.provider, name: x => PROVIDERS[x] || x, when: multiCloud },
  cc: { label: '成本中心', of: l => l.cc, name: ccName, when: hasTags },
  owner: { label: '负责人', of: ownerOf, name: x => x || '（未指定负责人）', when: hasTags },
  ws: { label: '业务空间', of: l => l.wsKey, name: wsName },
  key: { label: 'API Key', of: l => l.apiKeyId || NONE_KEY, name: keyShort },
  model: { label: '模型', of: l => l.model, name: x => x },
  week: { label: '自然周', of: l => isoWeek(l.date), name: x => { const [w, f] = x.split('|'); return `${w}（${f.slice(5)}~${addDays(f, 6).slice(5)}）`; }, src: 'daily' },
  weekday: { label: '星期', of: l => String((weekday(l.date) + 6) % 7), name: x => '周' + WEEK[(Number(x) + 1) % 7], src: 'daily' },
  dir: { label: 'Token 类型', of: l => (l.ioi.dir === 'in' ? (l.ioi.cache === 'hit' ? 'hit' : l.ioi.cache === 'create' ? 'create' : 'in') : l.ioi.dir), name: x => TT[x] || x },
  item: { label: '计费项', of: l => l.io, name: x => (x ? ioInfo(x).label : '（无）') },
  time: { label: '计费时段', of: l => l.ioi.time || 'std', name: x => TIME[x] },
  channel: { label: '调用渠道', of: l => l.channel, name: channelLabel },
  date: { label: '日期', of: l => l.date, name: x => x, src: 'daily' },
  month: { label: '账期（近 12 月）', of: l => l.date, name: x => x, src: 'history' },
  none: { label: '（不分列）', of: () => '__all', name: () => '合计' },
};
const MEASURE = {
  cost: { label: () => `费用（${METRICS[ui.f.metric]}）`, val: metricVal, fmt: money },
  gross: { label: () => '原价', val: l => l.gross, fmt: money },
  tokens: { label: () => '总 Token', val: l => l.tokens || 0, fmt: intFmt },
  tIn: { label: () => '输入 Token', val: l => (l.ioi.dir === 'in' ? l.tokens || 0 : 0), fmt: intFmt },
  tOut: { label: () => '输出 Token', val: l => (l.ioi.dir === 'out' ? l.tokens || 0 : 0), fmt: intFmt },
};
const SHOW = { value: '数值', row: '行占比', col: '列占比', all: '总占比' };
const PRESETS = [
  { name: '成本中心 × 模型', rows: 'cc', cols: 'model', when: hasTags },
  { name: '云厂商 × 模型', rows: 'provider', cols: 'model', when: multiCloud },
  { name: '成本中心 × 近 12 月', rows: 'cc', cols: 'month', when: hasTags },
  { name: '业务空间 × API Key', rows: 'ws', cols: 'key' },
  { name: 'API Key × 模型', rows: 'key', cols: 'model' },
  { name: '模型 × Token 类型', rows: 'model', cols: 'dir' },
  { name: 'API Key × 日期', rows: 'key', cols: 'date' },
  { name: 'API Key × 近 12 月', rows: 'key', cols: 'month' },
  { name: 'API Key × 星期', rows: 'key', cols: 'weekday' },
  { name: '业务空间 × 计费时段', rows: 'ws', cols: 'time' },
];
const avail = k => !DIM[k]?.when || DIM[k].when();

export function render(v) {
  const pv = ui.pv || (ui.pv = { rows: 'ws', cols: 'model', measure: 'cost', show: 'value', heat: true, ...LS.get('bc.pivot', {}) });
  if (!avail(pv.rows) || !DIM[pv.rows]) pv.rows = 'ws';
  if (!avail(pv.cols) || !DIM[pv.cols]) pv.cols = 'model';
  if (pv.rows === pv.cols && pv.rows !== 'none') pv.cols = 'none';
  if (pv.rows === 'none') pv.rows = 'ws';
  const rd = DIM[pv.rows], cd = DIM[pv.cols], ms = MEASURE[pv.measure] || MEASURE.cost;
  const src = rd.src === 'history' || cd.src === 'history' ? state.history : rd.src === 'daily' || cd.src === 'daily' ? state.daily : state.lines;
  const lines = filterLines(src);
  const cell = new Map(), rowT = new Map(), colT = new Map();
  let grand = 0;
  for (const l of lines) {
    const r = rd.of(l), c = cd.of(l), x = ms.val(l);
    if (!x) { if (!rowT.has(r)) rowT.set(r, 0); continue; }
    cell.set(r + '\u0001' + c, (cell.get(r + '\u0001' + c) || 0) + x);
    rowT.set(r, (rowT.get(r) || 0) + x); colT.set(c, (colT.get(c) || 0) + x); grand += x;
  }
  const isTime = ['date', 'month', 'week', 'weekday'].includes(pv.cols);
  let colIds = [...colT.keys()].sort(isTime ? undefined : (a, b) => colT.get(b) - colT.get(a));
  const LIMIT = isTime ? 62 : 20;
  const extra = colIds.slice(LIMIT); colIds = colIds.slice(0, LIMIT);
  const OTHER = '\u0002other';
  if (extra.length) { for (const r of rowT.keys()) cell.set(r + '\u0001' + OTHER, sum(extra, c => cell.get(r + '\u0001' + c) || 0)); colT.set(OTHER, sum(extra, c => colT.get(c))); colIds.push(OTHER); }
  const rowIds = [...rowT.keys()].filter(r => rowT.get(r) > 0);
  const maxCell = Math.max(0, ...[...cell.values()]);

  v.innerHTML = `
    <section class="panel">
      <div class="panel-h"><h3>多维透视</h3>${help('任选行维度与列维度交叉汇总，用于按业务空间/项目分摊成本、对比 Key 的模型使用结构等。日期维度使用按日账单，“近 12 月”使用账期账单，其余使用当前周期账单。全局筛选条件同样生效。点击单元格按行、列两个维度定位账单明细；点击行进入对应的 Key / 模型 / 业务空间 / 成本中心详情（日期行查看当日明细）。')}
        <div class="actions"><button class="btn sm" id="print" title="打印或另存为 PDF（隐藏导航与筛选栏）">${icon('print')}打印 / PDF</button><button class="btn sm" id="csv">${icon('download')}导出</button></div></div>
      <div class="row" style="margin-bottom:12px;gap:10px 16px">
        <label class="field" style="flex-direction:row;align-items:center;gap:6px"><span>行</span><select class="inp" data-pv="rows">${Object.entries(DIM).filter(([k]) => k !== 'none' && avail(k)).map(([k, d]) => opt(k, d.label, pv.rows)).join('')}</select></label>
        <button class="btn ghost icon sm" id="swap" title="行列互换" aria-label="行列互换"><svg class="ico" viewBox="0 0 24 24"><path d="M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4"/></svg></button>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px"><span>列</span><select class="inp" data-pv="cols">${Object.entries(DIM).filter(([k]) => k !== pv.rows && avail(k)).map(([k, d]) => opt(k, d.label, pv.cols)).join('')}</select></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px"><span>指标</span><select class="inp" data-pv="measure">${Object.entries(MEASURE).map(([k, m]) => opt(k, m.label(), pv.measure)).join('')}</select></label>
        <div class="seg sm" role="group" aria-label="显示方式">${Object.entries(SHOW).map(([k, l]) => `<button type="button" data-pvshow="${k}" aria-pressed="${pv.show === k}">${l}</button>`).join('')}</div>
        <label class="chk"><input type="checkbox" data-pv="heat" ${pv.heat ? 'checked' : ''}> 色阶</label>
      </div>
      <div class="row" style="margin-bottom:12px"><span class="muted" style="font-size:12px">常用：</span>${PRESETS.map((p, i) => (p.when && !p.when() ? '' : `<button class="btn sm ${p.rows === pv.rows && p.cols === pv.cols ? 'primary' : ''}" data-preset="${i}">${esc(p.name)}</button>`)).join('')}</div>
      <div id="tbl"></div>
      <div class="panel-foot">共 ${rowIds.length} 行 × ${colIds.length} 列${extra.length ? `（列按${ms.label()}取前 ${LIMIT}，其余 ${extra.length} 项合并为“其他”）` : ''} · 合计 ${esc(ms.fmt(grand))}</div>
    </section>`;

  const fmtCell = (x, r, c) => {
    if (!x) return '<span class="muted">·</span>';
    const base = pv.show === 'row' ? rowT.get(r) : pv.show === 'col' ? colT.get(c) : pv.show === 'all' ? grand : 0;
    const text = pv.show === 'value' ? ms.fmt(x) : pct(x, base);
    const s = Math.min(7, Math.max(1, Math.ceil(Math.sqrt(x / (maxCell || 1)) * 7)));
    const inner = pv.heat ? `<span class="pv" style="background:var(--q${s});color:${s >= 4 ? '#fff' : '#0b0b0b'}">${esc(text)}</span>` : esc(text);
    const tip = `${rd.name(r)} × ${c === OTHER ? '其他' : cd.name(c)}：${ms.fmt(x)}${c === OTHER ? '' : '，点击查看对应账单明细'}`;
    return c === OTHER ? `<span title="${esc(tip)}">${inner}</span>` : `<button type="button" class="pv-btn" data-pr="${esc(r)}" data-pc="${esc(c)}" title="${esc(tip)}">${inner}</button>`;
  };
  /** 单元格下钻：把行、列维度转换为全局筛选/统计周期后进入账单明细 */
  const toFilter = (dim, val) => ({
    ws: { ws: val || NO_WS }, key: { key: val }, model: { model: val }, item: val ? { item: val } : {}, channel: { channel: val },
    provider: { provider: val }, cc: { cc: val || NO_CC }, owner: { owner: val || NO_OWNER },
    dir: { dir: ['in', 'hit', 'create'].includes(val) ? 'in' : val },
  }[dim] || {});
  const drill = (r, c) => {
    const patch = { ...toFilter(pv.rows, r), ...toFilter(pv.cols, c) };
    for (const [dim, val] of [[pv.rows, r], [pv.cols, c]]) {
      if (dim === 'date') app.setPeriod({ mode: 'range', preset: 'custom', from: val, to: val }, { url: false });
      if (dim === 'month') app.setPeriod({ mode: 'month', cycle: val }, { url: false });
      if (dim === 'week') { const f = val.split('|')[1], t = addDays(f, 6); app.setPeriod({ mode: 'range', preset: 'custom', from: f, to: t > state.today ? state.today : t }, { url: false }); }
    }
    const nf = [pv.rows, pv.cols].filter(d => ['time', 'weekday'].includes(d)).map(d => DIM[d].label);
    if (nf.length) toast(`${nf.join('、')}不是筛选维度，已按其余维度定位账单`, '', 2600);
    app.setFilter(patch, '#/detail');
  };
  /** 行下钻：实体维度进入详情页，日期行打开当日明细，账期行切换账期 */
  const rowDrill = r => {
    const d = pv.rows, id = r.id;
    if (d === 'key') { if (id !== NONE_KEY) app.go(`#/key/${encodeURIComponent(id)}`); else app.setFilter({ key: NONE_KEY }, '#/detail'); }
    else if (d === 'model') app.openModel(id);
    else if (d === 'ws') app.go(groupHash('ws', id || NO_WS));
    else if (d === 'cc') app.go(groupHash('cc', id || NO_CC));
    else if (d === 'owner') app.go(groupHash('owner', id || NO_OWNER));
    else if (d === 'provider') app.go(groupHash('provider', id));
    else if (d === 'date') app.openDay(id);
    else if (d === 'month') app.setPeriod({ mode: 'month', cycle: id });
    else if (d === 'item' || d === 'channel' || d === 'dir') app.setFilter(toFilter(d, id));
  };
  const colName = c => (c === OTHER ? `其他 ${extra.length} 项` : cd.name(c));
  const columns = [{ key: 'name', label: rd.label, sortVal: ['date', 'month', 'week', 'weekday'].includes(pv.rows) ? (r => r.id) : undefined, fmt: (x, r) => `<b style="font-weight:600">${esc(x)}</b>${r.sub ? `<span class="sub mono">${esc(r.sub)}</span>` : ''}` }];
  if (pv.cols !== 'none') colIds.forEach((c, i) => columns.push({ key: 'c' + i, label: colName(c), align: 'r', fmt: (x, r) => fmtCell(x, r.id, c), csv: r => (r['c' + i] ? +r['c' + i].toFixed(6) : 0) }));
  columns.push({ key: 'total', label: '合计', align: 'r', fmt: x => `<b>${esc(ms.fmt(x))}</b>`, csv: r => +r.total.toFixed(6) });
  columns.push({ key: 'share', label: '占比', align: 'r', fmt: x => (x * 100).toFixed(1) + '%', csv: r => (r.share * 100).toFixed(2) + '%' });
  const rows = rowIds.map(r => {
    const o = { id: r, name: rd.name(r), sub: pv.rows === 'key' && r !== NONE_KEY ? r : pv.rows === 'ws' && r ? r : '', total: rowT.get(r), share: grand ? rowT.get(r) / grand : 0 };
    colIds.forEach((c, i) => { o['c' + i] = cell.get(r + '\u0001' + c) || 0; });
    return o;
  });
  const t = table('pivot:' + pv.rows + ':' + pv.cols, $('#tbl', v), {
    sort: ['date', 'month', 'week', 'weekday'].includes(pv.rows) ? 'name' : 'total', dir: ['date', 'month', 'week', 'weekday'].includes(pv.rows) ? 'asc' : 'desc', pageSize: 0, caption: '多维透视', maxHeight: '64vh',
    onRowClick: ['key', 'model', 'ws', 'provider', 'cc', 'owner', 'date', 'month', 'item', 'channel', 'dir'].includes(pv.rows) ? rowDrill : null,
    columns,
    footer: rs => columns.map(c => (c.key === 'name' ? '合计' : c.key === 'total' ? esc(ms.fmt(grand)) : c.key === 'share' ? '100%' : esc(ms.fmt(sum(rs, r => r[c.key] || 0))))),
  }).setRows(rows);
  const save = () => { LS.set('bc.pivot', pv); render(v); };
  v.querySelectorAll('[data-pv]').forEach(el => el.onchange = () => { pv[el.dataset.pv] = el.type === 'checkbox' ? el.checked : el.value; save(); });
  v.querySelectorAll('[data-pvshow]').forEach(el => el.onclick = () => { pv.show = el.dataset.pvshow; save(); });
  v.querySelectorAll('[data-preset]').forEach(el => el.onclick = () => { const p = PRESETS[+el.dataset.preset]; pv.rows = p.rows; pv.cols = p.cols; save(); });
  $('#swap', v).onclick = () => { if (pv.cols === 'none') return; [pv.rows, pv.cols] = [pv.cols, pv.rows]; save(); };
  $('#print', v).onclick = () => window.print();
  $('#csv', v).onclick = () => t.csv(`成本分摊_${rd.label}x${cd.label}_${periodTag()}.csv`);
  $('#tbl', v).addEventListener('click', e => { const b = e.target.closest('.pv-btn'); if (b) drill(b.dataset.pr, b.dataset.pc); });
}
