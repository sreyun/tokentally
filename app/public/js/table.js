/* =========================================================================
 * 数据表格：排序、分页、合计行、首列冻结、键盘操作、CSV 导出
 * ========================================================================= */
import { esc, money, ui, LS, toast } from './core.js';
/** 文本排序：共用一个排序器（localeCompare 带参数时每次比较都会新建排序器，大表格排序会卡顿十几秒） */
const COLL = new Intl.Collator('zh-CN', { numeric: true });

const registry = {};

export class DataTable {
  constructor(el, o) {
    this.el = el; this.o = o; this.sort = o.sort || null; this.dir = o.dir || 'desc'; this.page = 0; this.pageSize = o.pageSize ?? 50; this.rows = [];
    el.addEventListener('click', e => {
      const th = e.target.closest('th[data-k]');
      if (th) return this.toggleSort(th.dataset.k);
      const pg = e.target.closest('[data-pg]');
      if (pg) { this.page += +pg.dataset.pg; this.render(); return; }
      if (e.target.closest('button, a, select, input, label')) return;
      const tr = e.target.closest('tr[data-i]');
      if (tr && this.o.onRowClick) this.o.onRowClick(this.view[+tr.dataset.i], e);
    });
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const th = e.target.closest('th[data-k]');
      if (th) { e.preventDefault(); return this.toggleSort(th.dataset.k); }
      const tr = e.target.closest('tr[data-i]');
      if (tr && this.o.onRowClick && e.target === tr) { e.preventDefault(); this.o.onRowClick(this.view[+tr.dataset.i], e); }
    });
    el.addEventListener('change', e => { if (e.target.matches('[data-ps]')) { this.pageSize = +e.target.value; this.page = 0; this.render(); } });
  }
  toggleSort(k) {
    if (this.sort === k) this.dir = this.dir === 'desc' ? 'asc' : 'desc'; else { this.sort = k; this.dir = 'desc'; }
    this.page = 0;
    if (this.id) LS.set('bc.sort.' + this.id, { sort: this.sort, dir: this.dir });
    this.render();
    this.el.querySelector(`th[data-k="${CSS.escape(k)}"]`)?.focus();
  }
  setRows(rows) { this.rows = rows; this.render(); return this; }
  /** 排序结果按 行 / 排序列 / 方向 缓存：翻页、改变每页条数时不重新排序 */
  sorted() {
    if (this._sorted && this._sorted.rows === this.rows && this._sorted.sort === this.sort && this._sorted.dir === this.dir) return this._sorted.out;
    const rows = this.rows.slice();
    const c = this.sort && this.o.columns.find(c => c.key === this.sort);
    if (c) {
      const sv = c.sortVal || (r => r[c.key]);
      const k = this.dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const x = sv(a), y = sv(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : COLL.compare(String(x), String(y))) * k;
      });
    }
    this._sorted = { rows: this.rows, sort: this.sort, dir: this.dir, out: rows };
    return rows;
  }
  render() {
    const cols = this.o.columns, rows = this.sorted(), total = rows.length;
    const ps = this.pageSize || total || 1, pages = Math.max(1, Math.ceil(total / ps));
    this.page = Math.min(Math.max(0, this.page), pages - 1);
    this.view = this.pageSize ? rows.slice(this.page * ps, (this.page + 1) * ps) : rows;
    const stickyIdx = this.o.stickyFirst === false ? -1 : 0;
    const cls = (c, i) => `${c.align === 'r' ? 'r ' : ''}${i === stickyIdx ? 'sticky ' : ''}${c.cls || ''}`;
    const th = cols.map((c, i) => {
      const sortable = c.sortable !== false;
      const ariaSort = this.sort === c.key ? (this.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<th scope="col" class="${cls(c, i)} ${sortable ? 'sortable' : ''}" ${sortable ? `data-k="${esc(c.key)}" tabindex="0" aria-sort="${ariaSort}"` : ''} ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(c.label)}${this.sort === c.key ? `<span class="arr" aria-hidden="true">${this.dir === 'desc' ? '↓' : '↑'}</span>` : ''}</th>`;
    }).join('');
    const clickable = !!this.o.onRowClick;
    const body = this.view.length
      ? this.view.map((r, i) => `<tr data-i="${i}" class="${clickable ? 'clickable' : ''} ${this.o.rowClass ? this.o.rowClass(r) : ''}" ${clickable ? 'tabindex="0"' : ''}>${cols.map((c, j) => `<td class="${cls(c, j)}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="nodata">${esc(this.o.empty || '暂无数据')}</td></tr>`;
    const foot = this.o.footer && rows.length ? `<tfoot><tr>${this.o.footer(rows).map((v, i) => `<td class="${cols[i] ? cls(cols[i], i) : ''}">${v ?? ''}</td>`).join('')}</tr></tfoot>` : '';
    const from = total ? this.page * ps + 1 : 0, to = Math.min(total, (this.page + 1) * ps);
    const pager = this.pageSize && total > Math.min(...[20, this.pageSize]) ? `<div class="pager"><span>第 ${from.toLocaleString()}–${to.toLocaleString()} 条，共 ${total.toLocaleString()} 条</span>
      <select class="inp sm" data-ps aria-label="每页条数">${[20, 50, 100, 200, 500].map(n => `<option value="${n}" ${n === this.pageSize ? 'selected' : ''}>${n} 条/页</option>`).join('')}</select>
      <button class="btn sm" data-pg="-1" ${this.page === 0 ? 'disabled' : ''}>上一页</button><span>${this.page + 1} / ${pages}</span>
      <button class="btn sm" data-pg="1" ${this.page >= pages - 1 ? 'disabled' : ''}>下一页</button></div>` : (this.pageSize ? `<div class="pager"><span>共 ${total.toLocaleString()} 条</span></div>` : '');
    const scrollTop = this.el.querySelector('.tbl-wrap')?.scrollLeft;
    this.el.innerHTML = `<div class="tbl-wrap" ${this.o.maxHeight ? `style="max-height:${this.o.maxHeight}"` : ''}><table class="dt ${ui.density === 'compact' ? 'compact' : ''}"${this.o.caption ? ` aria-label="${esc(this.o.caption)}"` : ''}><thead><tr>${th}</tr></thead><tbody>${body}</tbody>${foot}</table></div>${pager}`;
    if (scrollTop) this.el.querySelector('.tbl-wrap').scrollLeft = scrollTop;
  }
  csv(name) {
    const cols = this.o.columns.filter(c => c.csv !== false);
    const extra = this.o.csvExtra || [];
    const head = cols.map(c => c.csvLabel || c.label).concat(extra.map(x => x.label));
    const lines = [head].concat(this.sorted().map(r => cols.map(c => (typeof c.csv === 'function' ? c.csv(r) : r[c.key])).concat(extra.map(x => x.val(r)))));
    downloadCsv(name, lines);
    toast(`已导出 ${(lines.length - 1).toLocaleString()} 行：${name}`, '', 2600);
  }
}

export function downloadCsv(name, lines) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // 防 CSV 公式注入
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/** 复用排序与分页偏好 */
export function table(id, el, opts) {
  const prev = registry[id];
  const t = new DataTable(el, opts);
  t.id = id;
  const saved = LS.get('bc.sort.' + id, null);
  // 沿用上次的排序（仅当该列仍存在，如透视表的列随数据变化）、每页条数与页码（后台刷新 / 窗口变化重绘时不回到第一页）
  if (prev) { if (opts.columns.some(c => c.key === prev.sort)) { t.sort = prev.sort; t.dir = prev.dir; } t.pageSize = prev.pageSize; t.page = prev.page; }
  else if (saved && opts.columns.some(c => c.key === saved.sort)) { t.sort = saved.sort; t.dir = saved.dir; }
  registry[id] = t;
  return t;
}
export const dataBar = (v, max, fmt = money) => `<span class="databar">${esc(fmt(v))}<i style="--w:${max ? Math.min(100, Math.max(0, v / max * 100)).toFixed(1) : 0}%"></i></span>`;
