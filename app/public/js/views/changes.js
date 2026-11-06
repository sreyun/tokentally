/* 变更记录：同步时检测到的 API Key / 业务空间变化 */
import { $, esc, state, ui, app, http, fmtTime, icon, help } from '../core.js';
import { table } from '../table.js';

const FIELD = { description: '描述', workspace_id: '业务空间ID', workspace_name: '业务空间', disabled: '禁用', auth_type: '授权类型', allow_all_models: '全部模型', accessible_models: '可访问模型', access_ips: 'IP 白名单', api_key_masked: 'API Key', name: '名称', region: '地域', service_site: '服务站点', api_host: 'API Host', tenant_id: '租户ID', gmt_create: '创建时间' };
const CHG = { create: ['新增', 'good'], update: ['修改', 'warn'], delete: ['删除', 'bad'], restore: ['恢复', 'good'] };
const fmtJson = s => { try { const o = JSON.parse(s || 'null'); return o ? Object.entries(o).map(([k, x]) => `${FIELD[k] || k}：${x == null || x === '' ? '（空）' : x}`).join('；') : ''; } catch { return ''; } };

export async function render(v) {
  v.innerHTML = '<div class="nodata">加载中…</div>';
  try {
    state.changes = (await http('GET', '/api/changes')).changes;
  } catch (e) { v.innerHTML = `<div class="notice err">${icon('warn')}<div><b>加载失败</b><span class="why">${esc(e.message)}</span></div></div>`; return; }
  const all = state.changes;
  const f = ui.chgEntity || '';
  const list = f ? all.filter(c => c.entity === f) : all;
  const n = k => all.filter(c => c.change === k).length;
  v.innerHTML = `
    <div class="stat-strip">
      <div><span>变更总数</span><b>${all.length}</b></div>
      <div><span>新增</span><b>${n('create')}</b></div>
      <div><span>修改</span><b>${n('update')}</b></div>
      <div><span>删除</span><b>${n('delete')}</b></div>
      <div><span>恢复</span><b>${n('restore')}</b></div>
    </div>
    <section class="panel"><div class="panel-h"><h3>变更明细</h3>${help('每次与阿里云同步时比对得到的新增、修改（描述、归属、状态、权限、IP 白名单等）、删除与恢复。首次同步时的记录为初始化。')}
      <div class="actions"><div class="seg sm" role="group">${[['', '全部'], ['api_key', 'API Key'], ['workspace', '业务空间']].map(([k, l]) => `<button type="button" data-ent="${k}" aria-pressed="${f === k}">${l}</button>`).join('')}</div>
      <button class="btn sm" id="csv">${icon('download')}导出</button></div></div><div id="tbl"></div></section>`;
  v.querySelectorAll('[data-ent]').forEach(b => b.onclick = () => { ui.chgEntity = b.dataset.ent; render(v); });
  const t = table('changes', $('#tbl', v), {
    sort: 'ts', pageSize: 100, caption: '变更明细', empty: '暂无变更记录',
    onRowClick: r => (r.entity === 'api_key' ? app.go(`#/key/${r.entity_id}`) : null),
    columns: [
      { key: 'ts', label: '时间', fmt: x => fmtTime(x), csv: r => fmtTime(r.ts) },
      { key: 'entity', label: '对象', fmt: x => (x === 'api_key' ? 'API Key' : '业务空间') },
      { key: 'name', label: '名称 / 描述', fmt: (x, r) => `${esc(x || '（无描述）')}<span class="sub mono">${esc(r.entity_id)}</span>` },
      { key: 'change', label: '变更', fmt: x => `<span class="pill ${CHG[x]?.[1] || 'neutral'}">${CHG[x]?.[0] || esc(x)}</span>` },
      { key: 'before', label: '变更前', cls: 'wrap-cell', sortable: false, fmt: (x, r) => esc(fmtJson(r.before_json)) || '<span class="muted">—</span>', csv: r => fmtJson(r.before_json) },
      { key: 'after', label: '变更后', cls: 'wrap-cell', sortable: false, fmt: (x, r) => esc(fmtJson(r.after_json)) || '<span class="muted">—</span>', csv: r => fmtJson(r.after_json) },
    ],
  }).setRows(list);
  $('#csv', v).onclick = () => t.csv('API_Key变更记录.csv');
}
