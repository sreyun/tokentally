/* 系统管理：云厂商接入（阿里云 / 腾讯云）、数据同步、预算、告警通知、用户、品牌与备份、安全审计、接口日志 */
import { $, esc, state, ui, app, http, toast, money, fmtTime, ago, p2, addMonths, opt, icon, help, keyShort, wsName, NONE_KEY, sum, PROVIDERS, provTag, modal } from '../core.js';
import { table } from '../table.js';

export const ADMIN_TABS = { aliyun: '阿里云接入', tencent: '腾讯云接入', sync: '数据同步', budgets: '预算管理', alerts: '告警通知', users: '用户管理', system: '品牌与备份', security: '安全与审计', calls: '接口日志' };
const POLICY = {
  Version: '1',
  Statement: [
    { Effect: 'Allow', Action: ['modelstudio:ListWorkspaces', 'modelstudio:ListApiKeys', 'modelstudio:GetApiKey', 'modelstudio:GetBillingOverview', 'modelstudio:GetBillingTrend'], Resource: '*' },
    { Effect: 'Allow', Action: ['bss:DescribeInstanceBill', 'bss:QueryBillOverview'], Resource: '*' },
  ],
};
const TC_POLICY = {
  version: '2.0',
  statement: [
    { effect: 'allow', action: ['tokenhub:DescribeApiKeyList', 'tokenhub:DescribeModelEndpointList', 'tokenhub:DescribeUsageRankList', 'tokenhub:DescribeModelList'], resource: ['*'] },
    { effect: 'allow', action: ['finance:DescribeBillDetail', 'finance:DescribeBillSummaryByProduct'], resource: ['*'] },
  ],
};

export async function render(v, tab) {
  if (!ADMIN_TABS[tab]) tab = 'aliyun';
  v.innerHTML = `<div class="row" style="margin-bottom:14px"><div class="seg scroll" role="tablist" aria-label="系统管理">${Object.entries(ADMIN_TABS).map(([k, l]) => `<button type="button" role="tab" data-go="#/admin/${k}" aria-pressed="${tab === k}" aria-selected="${tab === k}">${l}</button>`).join('')}</div></div><div id="adm"><div class="nodata">加载中…</div></div>`;
  const el = $('#adm', v);
  try { await ({ aliyun, tencent, sync, budgets, alerts, users, system, security, calls })[tab](el); }
  catch (e) { el.innerHTML = `<div class="notice err">${icon('warn')}<div><b>加载失败</b><span class="why">${esc(e.message)}</span></div></div>`; }
}

/* ---------------- 云厂商接入（通用表单逻辑） ---------------- */
const SECRET = { ok: ['已配置 · 加密保存', 'on'], none: ['未配置', 'off'], undecryptable: ['无法解密（主密钥已变化），请重新配置', 'off'] };
function bindCredForm(el, { form, idField, secretField, settingsKey, reload, testBody }) {
  const confirmBox = $('[data-confirm]', form), pw = form.elements.confirmPassword;
  const touched = () => !!(form.elements[idField].value.trim() || form.elements[secretField].value.trim());
  form.addEventListener('input', e => {
    app.dirty = true;
    if (e.target === pw) { pw.classList.remove('invalid'); return; }
    confirmBox.hidden = !touched();
    if (confirmBox.hidden) pw.value = '';
  });
  form.onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = Object.fromEntries(fd);
    for (const cb of form.querySelectorAll('input[type=checkbox]')) body[cb.name] = cb.checked;
    const changing = touched();
    if (!changing) delete body.confirmPassword;
    else if (!body.confirmPassword) { confirmBox.hidden = false; pw.classList.add('invalid'); pw.focus(); toast('更换访问密钥需输入当前登录密码', 'err'); return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await http('PUT', '/api/admin/settings', { [settingsKey]: body });
      app.dirty = false;
      toast(changing ? '已保存，密钥已加密存储，正在重新同步' : '配置已保存');
      await app.refreshStatus(); reload();
    } catch (ex) {
      if (ex.status === 403) { pw.value = ''; pw.classList.add('invalid'); pw.focus(); }
      toast('保存失败：' + ex.message, 'err', 4000);
    } finally { btn.disabled = false; }
  };
  const runTest = async body => {
    const out = $('[data-test-out]', el);
    out.innerHTML = '<div class="muted">正在测试 5 项接口，约需数秒…</div>';
    try {
      const { results } = await http('POST', '/api/admin/test', body);
      out.innerHTML = results.map(r => `<div>${r.ok ? `<span class="ok-text">${icon('check')}</span>` : `<span class="bad-text">${icon('x')}</span>`}<div><b style="font-weight:500">${esc(r.name)}</b>：${r.ok ? esc(r.detail) : `<span class="bad-text">${esc(r.error)}</span>${r.hint ? `<div class="hint">${esc(r.hint)}</div>` : ''}`}</div></div>`).join('');
    } catch (ex) { out.innerHTML = `<div class="bad-text">${esc(ex.message)}</div>`; }
  };
  $('[data-test-saved]', el).onclick = () => runTest(testBody(null));
  $('[data-test-form]', el).onclick = () => runTest(testBody(Object.fromEntries(new FormData(form))));
}

/* ---------------- 阿里云接入 ---------------- */
async function aliyun(el) {
  const s = await http('GET', '/api/admin/settings');
  const a = s.aliyun, ss = SECRET[a.secretState] || ['-', ''];
  el.innerHTML = `<div class="bi">
    <section class="panel c7"><div class="panel-h"><h3>阿里云 RAM 用户 AccessKey</h3>${help('使用 RAM 用户 AccessKey 调用百炼与费用中心只读接口；Secret 只写不回显，以 AES-256-GCM 加密后存入 SQLite，主密钥与数据分离保存。')}</div>
      <div class="kv" style="margin-bottom:16px">
        <div><span>当前 AccessKey ID</span><b class="mono">${esc(a.accessKeyId || '—')}</b></div>
        <div><span>状态</span><b><span class="state ${ss[1]}">${esc(ss[0])}</span></b></div>
        <div><span>主密钥来源</span><b>${s.security.masterKeySource === 'env' ? '环境变量 APP_MASTER_KEY' : '<span class="warn-text">数据目录文件（建议改用环境变量）</span>'}</b></div>
      </div>
      <form id="akForm" class="form-grid" autocomplete="off">
        <label class="field"><span>AccessKey ID</span><input class="inp mono" name="accessKeyId" placeholder="${a.accessKeyId ? '留空表示不修改' : 'LTAI…'}" spellcheck="false" autocomplete="off"></label>
        <label class="field"><span>AccessKey Secret</span><input class="inp mono" name="accessKeySecret" type="password" placeholder="${a.secretState === 'ok' ? '已加密保存，留空表示不修改' : ''}" autocomplete="new-password" spellcheck="false"></label>
        <label class="field"><span>百炼 OpenAPI 地域</span><select class="inp" name="msRegion">${s.options.msRegions.map(r => opt(r, r, a.msRegion)).join('')}</select></label>
        <label class="field"><span>费用中心站点</span><select class="inp" name="bssSite">${opt('cn', '中国站 business.aliyuncs.com', a.bssSite)}${opt('intl', '国际站 business.ap-southeast-1.aliyuncs.com', a.bssSite)}</select></label>
        <label class="field full"><span>百炼产品代码 ProductCode</span><input class="inp mono" name="productCode" value="${esc(a.productCode)}" placeholder="留空自动识别（通常为 sfm）"></label>
        <label class="field full" data-confirm hidden><span>当前登录密码</span><input class="inp" name="confirmPassword" type="password" autocomplete="current-password" maxlength="256"><small class="hint">更换 AccessKey 属于敏感操作，需要再次验证身份</small></label>
        <div class="row full"><button class="btn primary" type="submit">保存配置</button><button class="btn" type="button" data-test-saved>测试已保存配置</button><button class="btn" type="button" data-test-form>用表单中的 Key 测试</button></div>
      </form>
      <div class="test-list" data-test-out aria-live="polite"></div>
    </section>
    <section class="panel c5"><div class="panel-h"><h3>所需 RAM 权限（只读）</h3></div>
      <p class="hint" style="margin:0 0 10px">系统策略 <b>AliyunBailianReadOnlyAccess</b> + <b>AliyunBSSReadOnlyAccess</b>，或下方最小权限自定义策略：</p>
      <pre class="code">${esc(JSON.stringify(POLICY, null, 2))}</pre>
      <p class="hint" style="margin:10px 0 0">建议为本系统创建专用 RAM 用户，只授予只读权限并定期轮换 AccessKey。更换 Key 后系统会立即重新同步。</p>
    </section></div>`;
  bindCredForm(el, {
    form: $('#akForm', el), idField: 'accessKeyId', secretField: 'accessKeySecret', settingsKey: 'aliyun', reload: () => aliyun(el),
    testBody: fd => (fd ? { provider: 'aliyun', accessKeyId: fd.accessKeyId, accessKeySecret: fd.accessKeySecret } : { provider: 'aliyun' }),
  });
}

/* ---------------- 腾讯云接入 ---------------- */
async function tencent(el) {
  const s = await http('GET', '/api/admin/settings');
  const t = s.tencent, ss = SECRET[t.secretState] || ['-', ''];
  const REG = { 'ap-guangzhou': '华南地区（广州）ap-guangzhou', 'ap-singapore': '亚太东南（新加坡）ap-singapore' };
  el.innerHTML = `<div class="bi">
    <section class="panel c7"><div class="panel-h"><h3>腾讯云 CAM API 密钥</h3>${help('使用 CAM 子用户 API 密钥（SecretId / SecretKey）调用大模型服务平台 TokenHub 与计费只读接口；SecretKey 只写不回显，以 AES-256-GCM 加密保存。')}</div>
      <div class="kv" style="margin-bottom:16px">
        <div><span>当前 SecretId</span><b class="mono">${esc(t.secretId || '—')}</b></div>
        <div><span>状态</span><b><span class="state ${ss[1]}">${esc(ss[0])}</span></b></div>
        <div><span>API 地址</span><b>${t.endpointOverride ? '<span class="warn-text">已被 TENCENT_ENDPOINT_OVERRIDE 覆盖（测试 / 私有网关）</span>' : '官方域名 tokenhub / billing.tencentcloudapi.com'}</b></div>
      </div>
      <form id="tcForm" class="form-grid" autocomplete="off">
        <label class="field"><span>SecretId</span><input class="inp mono" name="secretId" placeholder="${t.secretId ? '留空表示不修改' : 'AKID…'}" spellcheck="false" autocomplete="off"></label>
        <label class="field"><span>SecretKey</span><input class="inp mono" name="secretKey" type="password" placeholder="${t.secretState === 'ok' ? '已加密保存，留空表示不修改' : ''}" autocomplete="new-password" spellcheck="false"></label>
        <label class="field"><span>TokenHub 地域</span><select class="inp" name="region">${s.options.tcRegions.map(r => opt(r, REG[r] || r, t.region)).join('')}</select></label>
        <label class="field"><span>站点</span><select class="inp" name="site">${opt('cn', '中国站 tencentcloudapi.com', t.site)}${opt('intl', '国际站 intl.tencentcloudapi.com', t.site)}</select></label>
        <label class="field full"><span>账单产品代码 BusinessCode</span><input class="inp mono" name="businessCode" value="${esc(t.businessCode)}" placeholder="留空自动识别（按产品名称匹配 TokenHub / 大模型服务平台 / 混元）"></label>
        <label class="chk full"><input type="checkbox" name="estimate" ${t.estimate ? 'checked' : ''}> 缺少计费只读权限时，按 TokenHub 模型目录价 × 用量估算费用（标记为“估算”）</label>
        <label class="field full" data-confirm hidden><span>当前登录密码</span><input class="inp" name="confirmPassword" type="password" autocomplete="current-password" maxlength="256"><small class="hint">更换 API 密钥属于敏感操作，需要再次验证身份</small></label>
        <div class="row full"><button class="btn primary" type="submit">保存配置</button><button class="btn" type="button" data-test-saved>测试已保存配置</button><button class="btn" type="button" data-test-form>用表单中的密钥测试</button></div>
      </form>
      <div class="test-list" data-test-out aria-live="polite"></div>
    </section>
    <section class="panel c5"><div class="panel-h"><h3>费用归属方式</h3></div>
      <p class="hint" style="margin:0 0 8px">腾讯云账单按推理服务 / 模型出账，<b>不含 API Key 维度</b>。系统同时拉取：</p>
      <ul class="hint" style="margin:0 0 10px;padding-left:18px;line-height:1.8">
        <li>计费中心账单明细（真实金额，含折扣与代金券）</li>
        <li>TokenHub 用量统计：每个 API Key × 模型 × 日 的输入 / 缓存命中 / 输出 Token 与请求数</li>
      </ul>
      <p class="hint" style="margin:0 0 10px">Key 费用 = 当日该模型同一计费项的账单金额 × 该 Key 对应 Token 的占比（标记“分摊”），各 Key 合计与腾讯云账单完全一致；账单资源本身为 API Key 时直接归属。</p>
      <h4 class="sec-h">所需 CAM 权限（只读）</h4>
      <p class="hint" style="margin:0 0 8px">为本系统创建专用 CAM 子用户（仅编程访问），授予 TokenHub 只读与费用中心账单只读权限，或参考下方自定义策略（以 CAM 控制台策略语法为准）：</p>
      <pre class="code">${esc(JSON.stringify(TC_POLICY, null, 2))}</pre>
    </section></div>`;
  bindCredForm(el, {
    form: $('#tcForm', el), idField: 'secretId', secretField: 'secretKey', settingsKey: 'tencent', reload: () => tencent(el),
    testBody: fd => (fd ? { provider: 'tencent', secretId: fd.secretId, secretKey: fd.secretKey } : { provider: 'tencent' }),
  });
}

/* ---------------- 数据同步 ---------------- */
const RUN = { success: ['成功', 'good'], partial: ['部分成功', 'warn'], error: ['失败', 'bad'], running: ['运行中', 'info'] };
async function sync(el) {
  const [s, { runs }] = await Promise.all([http('GET', '/api/admin/settings'), http('GET', '/api/admin/runs')]);
  await app.refreshStatus();
  const st = state.status, sy = s.sync, cur = state.today.slice(0, 7);
  const conf = st.sync.configured || [];
  const info = (name, x) => `<div><span>${name}</span><b>${x.running ? `<span class="state warn">同步中：${esc(x.progress?.text || '')}</span>` : x.last?.status === 'error' ? `<span class="state off" title="${esc(x.last.error || '')}">失败</span> ${x.lastSuccessAt ? '· 最近成功 ' + esc(fmtTime(x.lastSuccessAt)) : ''}` : `${x.lastSuccessAt ? '最近成功 ' + esc(fmtTime(x.lastSuccessAt)) : '尚未成功同步'}`}</b>${!x.running && x.nextAt ? `<span class="hint">下次约 ${esc(fmtTime(x.nextAt))}</span>` : ''}${!x.running && x.last?.status === 'error' ? `<span class="hint bad-text">${esc(x.last.error || '')}</span>` : ''}</div>`;
  const provBlock = p => `<div class="sync-card"><div class="sync-card-h">${provTag(p, true)}<b>${PROVIDERS[p]}</b>${conf.includes(p) ? '' : '<span class="state off">未配置</span>'}
      ${conf.includes(p) ? `<span class="sp"></span><button class="btn sm" data-sync="meta" data-p="${p}">${icon('sync')}同步 Key</button><button class="btn sm" data-sync="bills" data-p="${p}" data-cycles="${cur}">同步本月账单</button>` : `<span class="sp"></span><button class="btn sm" data-go="#/admin/${p}">前往配置</button>`}</div>
      ${conf.includes(p) ? `<div class="kv">${info('API Key / 业务空间', st.sync.providers[p].meta)}${info('账单', st.sync.providers[p].bills)}</div>` : ''}</div>`;
  el.innerHTML = `<div class="bi">
    <section class="panel c7"><div class="panel-h"><h3>同步状态</h3>${help('各云厂商独立调度、互不影响。元数据（API Key、描述、业务空间、权限）按间隔比对同步；账单按账期与日两种粒度拉取替换（腾讯云同时拉取 TokenHub 用量用于分摊），口径与费用中心一致。')}</div>
      ${Object.keys(PROVIDERS).map(provBlock).join('')}
      <div class="kv" style="margin-top:12px"><div><span>本地日账单</span><b>${Number(st.data.dailyLines || 0).toLocaleString()} 条</b>${st.data.minDay ? `<span class="hint">${esc(st.data.minDay)} ~ ${esc(st.data.maxDay)}</span>` : ''}</div></div>
      <div class="row" style="margin-top:12px">
        <select class="inp" id="syncProv" aria-label="选择云厂商">${opt('', '全部已配置云厂商', '')}${conf.map(p => opt(p, PROVIDERS[p], '')).join('')}</select>
        <select class="inp" id="syncCycle" aria-label="选择账期">${Array.from({ length: 18 }, (_, i) => addMonths(cur, -i)).map(c => opt(c, c, cur)).join('')}</select>
        <label class="chk"><input type="checkbox" id="syncForce"> 强制重新拉取</label>
        <button class="btn" data-sync="bills" data-pick="1" ${conf.length ? '' : 'disabled'}>同步所选账期</button>
        <button class="btn" data-sync="bills" data-all="1" ${conf.length ? '' : 'disabled'} title="按回溯月数重新拉取全部账期（包括已出账账期）">全量回溯</button>
      </div>
    </section>
    <section class="panel c5"><div class="panel-h"><h3>同步策略</h3><span class="sub">对所有云厂商生效</span></div>
      <form id="syncForm" class="form-grid">
        <label class="field"><span>元数据同步间隔（分钟）</span><input class="inp" type="number" name="metaIntervalMin" min="1" max="1440" value="${sy.metaIntervalMin}"></label>
        <label class="field"><span>账单同步间隔（分钟）</span><input class="inp" type="number" name="billIntervalMin" min="10" max="1440" value="${sy.billIntervalMin}"></label>
        <label class="field"><span>回溯账期数（月，1–18）</span><input class="inp" type="number" name="backfillMonths" min="1" max="18" value="${sy.backfillMonths}"></label>
        <label class="field"><span>并发请求数（1–6）</span><input class="inp" type="number" name="concurrency" min="1" max="6" value="${sy.concurrency}"></label>
        <label class="chk full"><input type="checkbox" name="perWorkspaceKeys" ${sy.perWorkspaceKeys ? 'checked' : ''}> 阿里云：逐个业务空间补全 API Key</label>
        <div class="row full"><button class="btn primary" type="submit">保存策略</button></div>
      </form>
      <p class="hint" style="margin:12px 0 0">已出账账期（次月 4 日起）同步一次后定稿；未出账账期最近 3 天每次刷新，其余日每 12 小时校正。腾讯云用量统计最长保留约 90 天，更早账期的费用可能无法分摊到 Key。月度趋势需回溯 12 个月。</p>
    </section>
    <section class="panel c5"><div class="panel-h"><h3>账期数据</h3><span class="sub">本地已同步的账期（多云合计）</span></div><div id="cyc"></div></section>
    <section class="panel c7"><div class="panel-h"><h3>同步任务记录</h3></div><div id="runs"></div></section></div>`;
  table('cyc', $('#cyc', el), {
    sort: 'cycle', pageSize: 0, stickyFirst: false, empty: '尚无账期数据',
    columns: [
      { key: 'cycle', label: '账期' },
      { key: 'providers', label: '云厂商', fmt: x => String(x || 'aliyun').split(',').map(p => provTag(p, true)).join('') },
      { key: 'final', label: '状态', fmt: x => (x ? '<span class="pill good">已出账</span>' : '<span class="pill warn">未出账</span>') },
      { key: 'pretax', label: '应付金额', align: 'r', fmt: x => money(x || 0) },
      { key: 'gross', label: '原价', align: 'r', fmt: x => money(x || 0) },
      { key: 'synced_at', label: '同步时间', fmt: x => ago(x) },
    ],
  }).setRows(st.data.cycles || []);
  table('runs', $('#runs', el), {
    sort: 'id', pageSize: 20, stickyFirst: false, empty: '暂无同步记录',
    columns: [
      { key: 'id', label: '#', align: 'r' },
      { key: 'provider', label: '云厂商', fmt: x => provTag(x || 'aliyun', true) },
      { key: 'kind', label: '类型', fmt: x => (x === 'meta' ? 'Key / 空间' : '账单') },
      { key: 'trig', label: '触发', fmt: x => esc(String(x || '').replace('manual:', '手动 · ').replace('schedule', '定时').replace('ak-changed', 'Key 变更').replace('key-changed', '密钥变更')) },
      { key: 'started_at', label: '开始', fmt: x => fmtTime(x) },
      { key: 'dur', label: '耗时', align: 'r', fmt: (x, r) => (r.finished_at ? ((r.finished_at - r.started_at) / 1000).toFixed(1) + 's' : '-'), sortVal: r => (r.finished_at || 0) - r.started_at },
      { key: 'status', label: '结果', fmt: x => `<span class="pill ${RUN[x]?.[1] || 'neutral'}">${RUN[x]?.[0] || esc(x)}</span>` },
      { key: 'api_calls', label: '调用', align: 'r' },
      { key: 'detail', label: '详情', cls: 'wrap-cell', sortable: false, fmt: (x, r) => esc(runSummary(r)) },
    ],
  }).setRows(runs);
  el.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => {
    const body = { kind: b.dataset.sync };
    if (b.dataset.p) body.provider = b.dataset.p;
    if (b.dataset.cycles) body.cycles = [b.dataset.cycles];
    if (b.dataset.pick || b.dataset.all) { const p = $('#syncProv', el).value; if (p) body.provider = p; }
    if (b.dataset.pick) { body.cycles = [$('#syncCycle', el).value]; body.force = $('#syncForce', el).checked; }
    if (b.dataset.all) { body.force = true; if (!confirm('将按回溯月数重新拉取全部账期账单，可能需要数分钟。继续？')) return; }
    try { const r = await http('POST', '/api/admin/sync', body); toast(r.alreadyRunning ? '已有同类同步任务在运行' : '同步任务已启动'); await app.refreshStatus(); }
    catch (ex) { toast('启动失败：' + ex.message, 'err', 4000); }
  });
  $('#syncForm', el).onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await http('PUT', '/api/admin/settings', { sync: { metaIntervalMin: fd.get('metaIntervalMin'), billIntervalMin: fd.get('billIntervalMin'), backfillMonths: fd.get('backfillMonths'), concurrency: fd.get('concurrency'), perWorkspaceKeys: fd.get('perWorkspaceKeys') === 'on' } });
      toast('同步策略已保存'); sync(el);
    } catch (ex) { toast('保存失败：' + ex.message, 'err', 4000); }
  };
}
function runSummary(r) {
  if (r.status === 'error') return r.error || '';
  try {
    const d = JSON.parse(r.detail || 'null');
    if (!d) return r.error || '';
    if (r.kind === 'meta') return `业务空间 ${d.workspaces} · API Key ${d.apiKeys} · 变更 ${d.changes}${r.error ? ' · ' + r.error : ''}`;
    return (d.cycles || []).map(c => (c.demo ? `${c.cycle} 演示数据` : c.skipped ? `${c.cycle} 跳过` : c.failed ? `${c.cycle} 失败` : c.lines != null ? `${c.cycle}：${c.lines} 行 · 分摊 ¥${Number(c.allocated || 0).toFixed(2)}${c.estimated ? ' · 估算' : ''}${c.final ? ' · 终版' : ''}` : `${c.cycle}：月 ${c.monthly} / 日 ${c.daily} 条${c.final ? ' · 终版' : ''}`)).join('；') + (r.error ? ' · ' + r.error : '');
  } catch { return r.error || ''; }
}

/* ---------------- 预算管理 ---------------- */
async function budgets(el) {
  const b = state.budgets;
  const { alerts: al } = await http('GET', '/api/admin/settings');
  const lastCycle = addMonths(state.today.slice(0, 7), -1);
  const lastMonth = new Map();
  state.history.filter(l => l.date === lastCycle).forEach(l => lastMonth.set(l.apiKeyId || NONE_KEY, (lastMonth.get(l.apiKeyId || NONE_KEY) || 0) + l.pretax));
  const keys = [...state.apiKeys.values()].filter(k => k.source !== 'deleted' || b.keys?.[k.apiKeyId] != null);
  const rows = keys.map(k => ({ id: k.apiKeyId, provider: k.provider, desc: keyShort(k.apiKeyId), ws: k.costCenter || wsName(k.wsKey), last: lastMonth.get(k.apiKeyId) || 0, c30: state.keyActivity.get(k.apiKeyId)?.c30 || 0, budget: b.keys?.[k.apiKeyId] ?? '' }));
  const totalLast = sum([...lastMonth.values()], x => x);
  const subs = al.channels.filter(c => c.enabled && c.events.budget);
  el.innerHTML = `<div class="bi">
    <section class="panel c4"><div class="panel-h"><h3>月度总预算</h3>${help('预算按自然月的应付金额（税前，多云合计）计算。设置后在成本概览显示使用率与月末预测，并在超出或预计超出时给出提醒。')}</div>
      <form id="bForm" class="form-grid" style="grid-template-columns:1fr">
        <label class="field"><span>月度总预算（元）</span><input class="inp" type="number" min="0" step="0.01" name="monthly" value="${b.monthly ?? ''}" placeholder="不设置"></label>
        <label class="field"><span>预警阈值（%）</span><input class="inp" type="number" min="1" max="100" name="alertPct" value="${b.alertPct ?? 80}"></label>
        <div class="hint">参考：上月（${esc(lastCycle)}）应付合计 ${money(totalLast)}。达到预警阈值显示黄色，超出预算显示红色。</div>
        <div class="row"><button class="btn primary" type="submit">保存全部预算</button></div>
      </form>
      <div class="notice ${subs.length ? 'info' : 'warn'}" style="margin:14px 0 0">${icon('bell')}<div><b>${subs.length ? `预算告警将推送到 ${subs.length} 个渠道` : '尚未配置预算告警推送'}</b><span class="why">${subs.length ? esc(subs.map(c => c.name).join('、')) : '可推送到钉钉、飞书、企业微信群机器人或通用 Webhook。'}</span><button class="link" data-go="#/admin/alerts">前往告警通知 →</button></div></div>
    </section>
    <section class="panel c8"><div class="panel-h"><h3>API Key 月度预算</h3><span class="sub">留空表示不设预算</span>
      <div class="actions"><button class="btn sm" id="fill" title="为未设置预算的 Key 按上月费用 × 1.2 填入建议值（取整到元）">按上月 ×1.2 填充空白</button><button class="btn sm" id="clear">清空</button><button class="btn sm primary" id="saveB">保存</button></div></div>
      <div id="bTbl"></div><div class="panel-foot" id="bDirty"></div></section></div>`;
  table('budgets', $('#bTbl', el), {
    sort: 'last', pageSize: 0, maxHeight: '60vh', caption: 'API Key 预算',
    columns: [
      { key: 'desc', label: 'API Key', fmt: (x, r) => `<b style="font-weight:600">${esc(x)}</b>${provTag(r.provider)}<span class="sub mono">${esc(r.id)}</span>` },
      { key: 'ws', label: '成本中心 / 业务空间' },
      { key: 'last', label: `上月（${lastCycle}）`, align: 'r', fmt: x => money(x) },
      { key: 'c30', label: '近 30 天', align: 'r', fmt: x => money(x) },
      { key: 'budget', label: '月度预算（元）', sortable: false, fmt: (x, r) => `<input class="inp sm" type="number" min="0" step="0.01" data-bk="${esc(r.id)}" value="${esc(x)}" placeholder="不设置" style="width:130px" aria-label="${esc(r.desc)} 月度预算">` },
    ],
  }).setRows(rows);
  // 输入值实时写回行数据：排序重绘表格时不会丢失尚未保存的输入
  const markDirty = () => { app.dirty = true; $('#bDirty', el).innerHTML = '<span class="warn-text">有未保存的修改</span> · 按 Enter 或点击“保存”生效'; };
  const syncInputs = () => el.querySelectorAll('[data-bk]').forEach(i => { const r = rows.find(x => x.id === i.dataset.bk); if (r) i.value = r.budget; });
  $('#bTbl', el).addEventListener('input', e => { const i = e.target.closest('[data-bk]'); if (!i) return; const r = rows.find(x => x.id === i.dataset.bk); if (r) r.budget = i.value; markDirty(); });
  $('#bForm', el).addEventListener('input', markDirty);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-bk]')) { e.preventDefault(); $('#bForm', el).requestSubmit(); } });
  $('#fill', el).onclick = () => { let n = 0; rows.forEach(r => { if (r.budget === '' && r.last > 0) { r.budget = Math.ceil(r.last * 1.2); n++; } }); syncInputs(); if (n) { markDirty(); toast(`已为 ${n} 个 Key 填入建议预算，确认后请保存`); } else toast('没有可填充的空白项（上月无费用或已设置）'); };
  $('#clear', el).onclick = () => { if (!rows.some(r => r.budget !== '')) return; if (!confirm('清空所有 API Key 的预算输入？保存后生效。')) return; rows.forEach(r => { r.budget = ''; }); syncInputs(); markDirty(); };
  $('#saveB', el).onclick = () => $('#bForm', el).requestSubmit();
  $('#bForm', el).onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const keysB = {};
    rows.forEach(r => { if (r.budget !== '' && r.budget != null) keysB[r.id] = r.budget; });
    try {
      state.budgets = await http('PUT', '/api/admin/budgets', { monthly: fd.get('monthly'), alertPct: fd.get('alertPct'), keys: keysB });
      app.dirty = false;
      $('#bDirty', el).textContent = '';
      toast(`预算已保存（总预算${state.budgets.monthly != null ? ' ' + money(state.budgets.monthly) : '未设置'}，${Object.keys(state.budgets.keys).length} 个 Key）`);
      app.reload();
    } catch (ex) { toast('保存失败：' + ex.message, 'err', 4000); }
  };
}

/* ---------------- 告警通知（多渠道） ---------------- */
const ALERT_HINT = {
  dingtalk: '钉钉群 → 群设置 → 机器人 → 添加“自定义”机器人，复制 Webhook。安全设置建议选择“加签”并填写密钥；如使用“自定义关键词”，请包含“费用”。可 @ 指定手机号或所有人。',
  feishu: '飞书群 → 设置 → 群机器人 → 添加“自定义机器人”，复制 Webhook。建议开启“签名校验”并填写密钥。自定义机器人仅支持 @所有人。',
  wecom: '企业微信群 → 添加群机器人，复制 Webhook 地址。企业微信机器人不支持加签，地址即凭据，请妥善保管；@ 提醒会额外发送一条文本消息。',
  generic: '以 POST JSON 发送 {event, title, level, items, text, link, mentions, sentAt}。填写密钥后附带 X-Alert-Timestamp 与 X-Alert-Signature 请求头（HMAC-SHA256，签名内容为 timestamp + "." + body）。',
};
const RULE_LABEL = { pct: '达到预警阈值', over: '超出预算', forecast: '预计月末超出总预算', keys: '包含 API Key 预算' };
const EVENT_ICON = { budget: 'wallet', anomaly: 'warn', sync: 'sync', keyChange: 'key', daily: 'calendar', weekly: 'calendar', monthly: 'calendar' };

async function alerts(el) {
  const { alerts: al } = await http('GET', '/api/admin/settings');
  const evs = al.eventTypes;
  const last = al.channels.map(c => c.lastSentAt || 0).sort((a, b) => b - a)[0];
  const failing = al.channels.filter(c => c.lastError && (!c.lastSentAt || c.lastErrorAt > c.lastSentAt));
  el.innerHTML = `
    <div class="stat-strip">
      <div><span>通知渠道</span><b>${al.channels.length} / ${al.maxChannels}</b></div>
      <div><span>已启用</span><b>${al.channels.filter(c => c.enabled).length}</b></div>
      <div><span>最近发送</span><b>${last ? esc(ago(last)) : '尚未发送'}</b></div>
      <div><span>发送失败的渠道</span><b class="${failing.length ? 'bad-text' : ''}">${failing.length}</b></div>
      <div><span>报表发送时间</span><b>每天 ${p2(al.reportHour)}:00 后</b></div>
    </div>
    <div class="bi">
    <section class="panel c8"><div class="panel-h"><h3>通知渠道</h3>${help('每个渠道可单独订阅告警与报表。Webhook 地址与加签密钥使用 AES-256-GCM 加密保存、不回显；仅允许 HTTPS，钉钉 / 飞书 / 企业微信只允许官方域名，并拒绝内网地址。')}
      <div class="actions"><button class="btn sm primary" id="addCh" ${al.channels.length >= al.maxChannels ? 'disabled' : ''}>${icon('plus')}添加渠道</button></div></div>
      ${al.channels.length ? `<div class="ch-list">${al.channels.map(c => `
        <div class="ch-card ${c.enabled ? '' : 'off'}">
          <div class="ch-top"><span class="ch-ico">${icon('bell')}</span><div class="ch-t"><b>${esc(c.name)}</b><span class="muted">${esc(al.types[c.type]?.label || c.type)} · <span class="mono">${esc(c.webhookMasked || '未配置地址')}</span>${c.secretSet ? ' · 已加签' : ''}</span></div>
            <span class="state ${c.enabled ? 'on' : 'off'}">${c.enabled ? '已启用' : '已停用'}</span></div>
          <div class="ch-evs">${Object.keys(evs).filter(k => c.events[k]).map(k => `<span class="tag">${icon(EVENT_ICON[k] || 'bell')}${esc(evs[k].label)}</span>`).join('') || '<span class="muted">未订阅任何事件</span>'}${c.atAll || c.atMobiles.length ? `<span class="tag warn">@ ${c.atAll ? '所有人' : ''}${c.atAll && c.atMobiles.length ? ' + ' : ''}${c.atMobiles.length ? c.atMobiles.length + ' 人' : ''}</span>` : ''}</div>
          <div class="ch-foot"><span class="${c.lastError && (!c.lastSentAt || c.lastErrorAt > c.lastSentAt) ? 'bad-text' : 'muted'}">${c.lastError && (!c.lastSentAt || c.lastErrorAt > c.lastSentAt) ? `${esc(fmtTime(c.lastErrorAt))} 发送失败：${esc(c.lastError)}` : c.lastSentAt ? `最近发送 ${esc(fmtTime(c.lastSentAt))}` : '尚未发送'}</span>
            <span class="sp"></span><button class="btn sm" data-ch-test="${esc(c.id)}">${icon('send')}测试</button><button class="btn sm" data-ch-edit="${esc(c.id)}">${icon('edit')}编辑</button><button class="btn sm danger" data-ch-del="${esc(c.id)}">${icon('trash')}删除</button></div>
        </div>`).join('')}</div>` : `<div class="empty-mini">${icon('bell')}<div><b>尚未配置通知渠道</b><span class="muted">添加钉钉、飞书、企业微信群机器人或通用 Webhook，接收预算告警、费用异常、同步故障与日报 / 周报 / 月报。</span></div></div>`}
    </section>
    <section class="panel c4"><div class="panel-h"><h3>告警规则</h3>${help('预算告警：同一阈值（含预算金额）每个账期每个渠道只通知一次。费用异常：每天报表时间之后检查“昨日费用 ≥ 前 7 日日均 × 倍数，且增量 ≥ 最小金额”。同步故障：同一云厂商同类同步连续失败 3 次时告警，恢复后通知。')}</div>
      <form id="rForm" class="form-grid" style="grid-template-columns:1fr 1fr">
        <div class="field full"><span>预算告警条件</span><div class="row" style="gap:6px 16px">${Object.entries(RULE_LABEL).map(([k, l]) => `<label class="chk"><input type="checkbox" name="rule_${k}" ${al.rules[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
        <label class="field"><span>异常倍数（×前 7 日日均）</span><input class="inp" type="number" name="ratio" min="1.2" max="20" step="0.1" value="${al.anomaly.ratio}"></label>
        <label class="field"><span>异常最小增量（元）</span><input class="inp" type="number" name="minAmount" min="0" step="1" value="${al.anomaly.minAmount}"></label>
        <label class="chk full"><input type="checkbox" name="anomalyKeys" ${al.anomaly.keys ? 'checked' : ''}> 同时检测单个 API Key 的费用异常（最多列出 5 个）</label>
        <label class="field full"><span>报表与异常检查时间</span><select class="inp" name="reportHour">${Array.from({ length: 24 }, (_, h) => opt(h, `每天 ${p2(h)}:00 之后`, al.reportHour)).join('')}</select><small class="hint">账单通常延迟数小时入账，建议 9:00 之后发送，数据更完整</small></label>
        <div class="row full"><button class="btn primary" type="submit">保存规则</button></div>
      </form></section>
    <section class="panel c7"><div class="panel-h"><h3>报表预览</h3><span class="sub">预览日报 / 周报 / 月报内容，可立即发送到指定渠道（不影响定时发送）</span></div>
      <div class="row" style="margin-bottom:10px"><div class="seg sm" role="group" aria-label="报表类型">${[['daily', '日报'], ['weekly', '周报'], ['monthly', '月报']].map(([k, l], i) => `<button type="button" data-rk="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>
        <span class="sp"></span><select class="inp sm" id="rCh" aria-label="发送到渠道">${al.channels.map(c => opt(c.id, c.name, '')).join('') || opt('', '（请先添加渠道）', '')}</select><button class="btn sm" id="rSend" ${al.channels.length ? '' : 'disabled'}>${icon('send')}立即发送</button></div>
      <div id="rPrev" class="report-prev"><div class="nodata">加载中…</div></div></section>
    <section class="panel c5"><div class="panel-h"><h3>告警状态</h3><span class="sub">账期 ${esc(al.state.cycle)}</span></div>
      <h4 class="sec-h" style="margin-top:0">当前满足条件、尚未通知的预算告警</h4>
      ${al.pending.length ? `<ul class="alert-list">${al.pending.map(t => `<li class="warn">${esc(t)}</li>`).join('')}</ul>` : `<p class="hint" style="margin:0">${state.budgets.monthly || Object.keys(state.budgets.keys || {}).length ? '暂无（未达到任何阈值，或已通知过）' : '尚未设置预算'}</p>`}
      <h4 class="sec-h">最近通知记录</h4>
      ${al.state.history.length ? `<ul class="alert-list">${al.state.history.map(h => `<li class="${h.level === 'bad' ? 'bad' : h.level === 'good' ? 'good' : h.level === 'warn' ? 'warn' : 'info'}"><b>${esc(fmtTime(h.at))}</b> · ${esc(h.chName || '')} · ${esc(h.title || evs[h.event]?.label || '')}<div class="muted">${(h.items || []).slice(0, 3).map(esc).join('；')}</div></li>`).join('')}</ul>` : '<p class="hint" style="margin:0">暂无</p>'}
    </section></div>`;

  const payload = (channels, extra = {}) => ({
    channels: channels.map(c => ({ id: c.id, name: c.name, type: c.type, enabled: c.enabled, events: c.events, atAll: c.atAll, atMobiles: c.atMobiles, ...(c.webhook ? { webhook: c.webhook } : {}), ...(c.secret ? { secret: c.secret } : {}), ...(c.clearSecret ? { clearSecret: true } : {}) })),
    rules: al.rules, anomaly: al.anomaly, reportHour: al.reportHour, ...extra,
  });
  const save = async (channels, extra, okMsg) => {
    const out = await http('PUT', '/api/admin/alerts', payload(channels, extra));
    const r = out.check || {};
    toast(r.error ? `${okMsg}，但发送失败：${r.error}` : r.sent ? `${okMsg}，并已发送 ${r.sent} 条当前满足条件的通知` : okMsg, r.error ? 'err' : '', 4500);
    alerts(el);
  };
  $('#addCh', el).onclick = () => editChannel(al, null, async ch => save([...al.channels, ch], {}, '渠道已添加'));
  el.querySelectorAll('[data-ch-edit]').forEach(b => b.onclick = () => { const c = al.channels.find(x => x.id === b.dataset.chEdit); editChannel(al, c, async ch => save(al.channels.map(x => (x.id === c.id ? ch : x)), {}, '渠道已保存')); });
  el.querySelectorAll('[data-ch-del]').forEach(b => b.onclick = async () => {
    const c = al.channels.find(x => x.id === b.dataset.chDel);
    if (!confirm(`删除通知渠道「${c.name}」？Webhook 地址与密钥将被清除。`)) return;
    try { await save(al.channels.filter(x => x.id !== c.id), {}, '渠道已删除'); } catch (ex) { toast('删除失败：' + ex.message, 'err', 4000); }
  });
  el.querySelectorAll('[data-ch-test]').forEach(b => b.onclick = async () => {
    const c = al.channels.find(x => x.id === b.dataset.chTest);
    b.disabled = true;
    try { await http('POST', '/api/admin/alerts/test', { channelId: c.id, type: c.type, atAll: c.atAll, atMobiles: c.atMobiles }); toast(`测试消息已发送到「${c.name}」，请在群中查看`); }
    catch (ex) { toast(ex.message, 'err', 5000); } finally { b.disabled = false; }
  });
  $('#rForm', el).onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const extra = {
      rules: Object.fromEntries(Object.keys(RULE_LABEL).map(k => [k, fd.get('rule_' + k) === 'on'])),
      anomaly: { ratio: Number(fd.get('ratio')), minAmount: Number(fd.get('minAmount')), keys: fd.get('anomalyKeys') === 'on' },
      reportHour: Number(fd.get('reportHour')),
    };
    try { await save(al.channels, extra, '告警规则已保存'); } catch (ex) { toast('保存失败：' + ex.message, 'err', 4000); }
  };
  // 报表预览
  let kind = 'daily';
  const preview = async (send = false) => {
    const box = $('#rPrev', el);
    if (!send) box.innerHTML = '<div class="nodata">加载中…</div>';
    try {
      const r = await http('POST', '/api/admin/alerts/report', { kind, send, channelId: send ? $('#rCh', el).value : undefined });
      box.innerHTML = `<div class="rp-t">${esc(r.title)}${r.empty ? ' <span class="pill neutral">无费用，定时发送时将跳过</span>' : ''}</div>${r.lines.map(l => (l === '' ? '<div class="rp-gap"></div>' : l.startsWith('#') ? `<div class="rp-h">${esc(l.replace(/^#+\s*/, ''))}</div>` : `<div class="rp-l">${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</div>`)).join('')}`;
      if (send) toast('报表已发送');
    } catch (ex) { if (send) toast(ex.message, 'err', 5000); else box.innerHTML = `<div class="bad-text">${esc(ex.message)}</div>`; }
  };
  el.querySelectorAll('[data-rk]').forEach(b => b.onclick = () => { kind = b.dataset.rk; el.querySelectorAll('[data-rk]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); preview(); });
  $('#rSend', el).onclick = async e => { e.currentTarget.disabled = true; try { await preview(true); } finally { e.currentTarget.disabled = false; } };
  preview();
}

function editChannel(al, c, onSave) {
  const evs = al.eventTypes, isNew = !c;
  const cur = c || { name: '', type: 'dingtalk', enabled: true, events: { budget: true, anomaly: true, sync: true, keyChange: false, daily: false, weekly: false, monthly: true }, atAll: false, atMobiles: [] };
  const group = g => Object.entries(evs).filter(([, e]) => e.group === g).map(([k, e]) => `<label class="chk"><input type="checkbox" name="ev_${k}" ${cur.events[k] ? 'checked' : ''}> ${esc(e.label)}</label>`).join('');
  return modal({
    title: isNew ? '添加通知渠道' : `编辑通知渠道 · ${cur.name}`, submit: '保存', wide: true,
    body: `<div class="form-grid">
      <label class="field"><span>名称</span><input class="inp" name="name" maxlength="30" value="${esc(cur.name)}" placeholder="如：财务群、运维群"></label>
      <label class="field"><span>类型</span><select class="inp" name="type">${Object.entries(al.types).map(([k, t]) => opt(k, t.label, cur.type)).join('')}</select></label>
      <label class="field full"><span>Webhook 地址</span><input class="inp mono" name="webhook" spellcheck="false" maxlength="1000" autocomplete="off"></label>
      <label class="field full" data-secret><span>加签密钥（可选）</span><input class="inp mono" name="secret" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" placeholder="${c?.secretSet ? '已加密保存，留空表示不修改' : '未设置'}">${c?.secretSet ? '<label class="chk" style="margin-top:4px"><input type="checkbox" name="clearSecret"> 清除已保存的密钥</label>' : ''}</label>
      <p class="hint full" data-hint style="margin:0"></p>
      <div class="field full"><span>订阅告警</span><div class="row" style="gap:6px 16px">${group('告警')}</div></div>
      <div class="field full"><span>订阅报表</span><div class="row" style="gap:6px 16px">${group('报表')}</div></div>
      <div class="field full"><span>@ 提醒（仅告警消息）</span><div class="row" style="gap:8px 16px;align-items:center"><label class="chk"><input type="checkbox" name="atAll" ${cur.atAll ? 'checked' : ''}> @所有人</label>
        <input class="inp" name="atMobiles" data-mobiles value="${esc(cur.atMobiles.join(','))}" placeholder="@ 手机号，多个用逗号分隔（最多 10 个）" style="flex:1;min-width:220px"></div></div>
      <label class="chk full"><input type="checkbox" name="enabled" ${cur.enabled ? 'checked' : ''}> 启用该渠道</label>
      <div class="row full"><button type="button" class="btn" data-test>${icon('send')}用当前填写内容发送测试</button></div>
    </div>`,
    onOpen: form => {
      const syncUi = () => {
        const t = form.elements.type.value, ty = al.types[t];
        $('[data-hint]', form).textContent = ALERT_HINT[t] || '';
        $('[data-secret]', form).hidden = !ty?.sign;
        $('[data-mobiles]', form).hidden = ty?.mention !== 'mobile';
        form.elements.webhook.placeholder = c?.webhookSet && t === c.type ? c.webhookMasked + '（已加密保存，留空表示不修改）' : ty?.host ? `https://${ty.host}/…` : 'https://…';
      };
      syncUi();
      form.elements.type.addEventListener('change', syncUi);
      $('[data-test]', form).onclick = async e => {
        const fd = new FormData(form), btn = e.currentTarget;
        btn.disabled = true;
        try { await http('POST', '/api/admin/alerts/test', { channelId: c?.id, type: fd.get('type'), webhook: fd.get('webhook') || '', secret: fd.get('secret') || '', atAll: fd.get('atAll') === 'on', atMobiles: fd.get('atMobiles') || '' }); toast('测试消息已发送，请在群中查看'); }
        catch (ex) { toast(ex.message, 'err', 5000); } finally { btn.disabled = false; }
      };
    },
    onSubmit: async form => {
      const fd = new FormData(form);
      const type = fd.get('type'), webhook = String(fd.get('webhook') || '').trim();
      if (isNew && !webhook) throw new Error('请填写 Webhook 地址');
      if (!isNew && type !== c.type && !webhook) throw new Error('更换通知类型时请同时填写对应的 Webhook 地址');
      const ch = {
        id: c?.id, name: String(fd.get('name') || '').trim() || al.types[type].label, type, enabled: fd.get('enabled') === 'on',
        events: Object.fromEntries(Object.keys(evs).map(k => [k, fd.get('ev_' + k) === 'on'])), atAll: fd.get('atAll') === 'on',
        atMobiles: String(fd.get('atMobiles') || '').split(/[,，\s]+/).filter(Boolean), webhook, secret: String(fd.get('secret') || '').trim(), clearSecret: fd.get('clearSecret') === 'on',
      };
      await onSave(ch);
      return true;
    },
  });
}

/* ---------------- 用户管理 ---------------- */
async function users(el) {
  const { users: list } = await http('GET', '/api/admin/users');
  el.innerHTML = `<div class="bi">
    <section class="panel c8"><div class="panel-h"><h3>用户</h3><span class="sub">管理员可配置系统；只读用户仅能查看分析数据。新用户与重置密码后首次登录须修改密码。</span></div><div id="uTbl"></div></section>
    <section class="panel c4"><div class="panel-h"><h3>新增用户</h3></div>
      <form id="uForm" class="form-grid" style="grid-template-columns:1fr" autocomplete="off">
        <label class="field"><span>用户名</span><input class="inp" name="username" required pattern="[A-Za-z0-9_.@\\-]{3,32}" autocomplete="off"></label>
        <label class="field"><span>初始密码</span><input class="inp mono" name="password" required minlength="10" autocomplete="new-password"></label>
        <label class="field"><span>角色</span><select class="inp" name="role">${opt('viewer', '只读用户', 'viewer')}${opt('admin', '管理员', 'viewer')}</select></label>
        <div class="hint">至少 10 位，需包含字母和数字，且不能包含用户名。</div>
        <div class="row"><button class="btn primary" type="submit">创建</button><button class="btn" type="button" id="genPw">生成强密码</button></div>
      </form></section></div>`;
  table('users', $('#uTbl', el), {
    sort: 'id', dir: 'asc', pageSize: 0, caption: '用户',
    columns: [
      { key: 'username', label: '用户名', fmt: (x, r) => `<b style="font-weight:600">${esc(x)}</b>${r.id === state.me.id ? '<span class="tag">我</span>' : ''}` },
      { key: 'role', label: '角色', fmt: x => `<span class="role ${x}">${x === 'admin' ? '管理员' : '只读'}</span>` },
      { key: 'st', label: '状态', sortable: false, fmt: (x, r) => (r.disabled ? '<span class="state off">已禁用</span>' : r.locked ? '<span class="state warn">已锁定</span>' : r.mustChange ? '<span class="state warn">待改密</span>' : '<span class="state on">正常</span>') },
      { key: 'lastLoginAt', label: '最近登录', fmt: (x, r) => `${fmtTime(x)}<span class="sub mono">${esc(r.lastLoginIp || '')}</span>` },
      { key: 'sessions', label: '会话', align: 'r' },
      { key: 'ops', label: '操作', sortable: false, fmt: (x, r) => `<div class="row" style="gap:4px;flex-wrap:nowrap">
        <button class="btn sm" data-u="role" data-id="${r.id}" data-v="${r.role === 'admin' ? 'viewer' : 'admin'}">设为${r.role === 'admin' ? '只读' : '管理员'}</button>
        <button class="btn sm" data-u="pw" data-id="${r.id}">重置密码</button>
        <button class="btn sm" data-u="dis" data-id="${r.id}" data-v="${r.disabled ? 0 : 1}">${r.disabled ? '启用' : '禁用'}</button>
        ${r.locked ? `<button class="btn sm" data-u="unlock" data-id="${r.id}">解锁</button>` : ''}
        <button class="btn sm danger" data-u="del" data-id="${r.id}" data-name="${esc(r.username)}">删除</button></div>` },
    ],
  }).setRows(list);
  $('#uTbl', el).addEventListener('click', async e => {
    const b = e.target.closest('[data-u]'); if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.u === 'role') await http('PUT', `/api/admin/users/${id}`, { role: b.dataset.v });
      else if (b.dataset.u === 'dis') await http('PUT', `/api/admin/users/${id}`, { disabled: b.dataset.v === '1' });
      else if (b.dataset.u === 'unlock') await http('PUT', `/api/admin/users/${id}`, { unlock: true });
      else if (b.dataset.u === 'pw') {
        const pw = genPassword();
        if (!confirm(`将该用户密码重置为：\n\n${pw}\n\n请复制后安全告知用户（首次登录须修改）。确认重置？`)) return;
        await http('PUT', `/api/admin/users/${id}`, { password: pw });
      } else if (b.dataset.u === 'del') {
        if (!confirm(`确认删除用户「${b.dataset.name}」？此操作不可撤销。`)) return;
        await http('DELETE', `/api/admin/users/${id}`);
      }
      toast('已更新'); users(el);
    } catch (ex) { toast('操作失败：' + ex.message, 'err', 4000); }
  });
  $('#genPw', el).onclick = () => { $('#uForm', el).password.value = genPassword(); };
  $('#uForm', el).onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await http('POST', '/api/admin/users', fd); toast(`已创建用户 ${fd.username}`); users(el); }
    catch (ex) { toast('创建失败：' + ex.message, 'err', 4000); }
  };
}
export function genPassword() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%+=';
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    const pw = [...b].map(x => a[x % a.length]).join('');
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

/* ---------------- 品牌与备份 ---------------- */
const fmtSize = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
async function system(el) {
  const s = await http('GET', '/api/admin/settings');
  const b = s.branding, bk = s.backup;
  el.innerHTML = `<div class="bi">
    <section class="panel c5"><div class="panel-h"><h3>品牌设置</h3>${help('用于侧栏、浏览器标题、登录页与告警消息中的产品名称，便于交付给不同团队或客户使用。')}</div>
      <form id="brForm" class="form-grid" style="grid-template-columns:1fr">
        <label class="field"><span>产品名称（≤ 24 字）</span><input class="inp" name="name" maxlength="24" value="${esc(b.name)}" required></label>
        <label class="field"><span>副标题（≤ 48 字，可留空）</span><input class="inp" name="subtitle" maxlength="48" value="${esc(b.subtitle)}"></label>
        <div class="brand-prev"><div class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round"><path d="M4 19V11M10 19V5M16 19v-6M22 19H2"/></svg></div><div class="brand-text"><b data-bp="name">${esc(b.name)}</b><span data-bp="subtitle">${esc(b.subtitle)}</span></div></div>
        <div class="row"><button class="btn primary" type="submit">保存品牌设置</button></div>
      </form></section>
    <section class="panel c7"><div class="panel-h"><h3>数据备份</h3>${help('备份为完整的 SQLite 数据库副本（VACUUM INTO 在线一致性备份），包含账单、配置、用户（密码为 scrypt 哈希）与加密后的访问密钥；恢复时需使用相同的 APP_MASTER_KEY 才能解密密钥。')}
      <div class="actions"><button class="btn sm primary" id="bkNow">${icon('database')}立即备份</button></div></div>
      <div class="kv" style="margin-bottom:12px">
        <div><span>自动备份</span><b>${bk.keep ? `每天 ${p2(bk.hour)}:00 · 保留最近 ${bk.keep} 份` : '<span class="warn-text">已关闭（BACKUP_KEEP=0）</span>'}</b></div>
        <div><span>存放位置</span><b class="mono">数据目录 /data/backups</b></div>
        <div><span>主密钥来源</span><b>${s.security.masterKeySource === 'env' ? '环境变量 APP_MASTER_KEY（请与备份分开保管）' : '<span class="warn-text">数据目录文件 .master.key（不在备份中，请单独保管）</span>'}</b></div>
      </div>
      <div id="bkTbl"></div>
      <details class="note" style="margin-top:12px"><summary>如何恢复备份</summary><div>1. 停止服务：<span class="mono">docker compose stop app</span>；2. 将备份文件复制为数据卷中的 <span class="mono">bailian-cost.db</span>（并删除同目录的 -wal / -shm 文件）；3. 确认 .env 中的 APP_MASTER_KEY 与备份时一致；4. 启动服务：<span class="mono">docker compose start app</span>。详见 docs/DEPLOYMENT.md。</div></details>
    </section>
    <section class="panel c12"><div class="panel-h"><h3>监控与运维接口</h3></div>
      <div class="kv">
        <div><span>健康检查</span><b class="mono">GET /healthz（存活） · GET /readyz（数据库可用）</b></div>
        <div><span>Prometheus 指标</span><b>${s.metrics.enabled ? '<span class="state on">已启用</span> <span class="mono">GET /metrics</span>（Authorization: Bearer &lt;METRICS_TOKEN&gt;）' : '<span class="state off">未启用</span>（在 .env 设置 ≥16 位的 METRICS_TOKEN 后重启生效）'}</b></div>
        <div><span>指标内容</span><b>同步状态与最近成功时间、本月各云厂商应付金额、预算使用率、Key 数量、告警渠道状态、会话数</b></div>
      </div></section></div>`;
  const form = $('#brForm', el);
  form.addEventListener('input', e => { const k = e.target.name; const t = el.querySelector(`[data-bp="${k}"]`); if (t) t.textContent = e.target.value; app.dirty = true; });
  form.onsubmit = async e => {
    e.preventDefault();
    try { await http('PUT', '/api/admin/settings', { branding: Object.fromEntries(new FormData(form)) }); app.dirty = false; toast('品牌设置已保存'); await app.refreshStatus(); app.render(); }
    catch (ex) { toast('保存失败：' + ex.message, 'err', 4000); }
  };
  const drawBackups = list => table('backups', $('#bkTbl', el), {
    sort: 'mtime', pageSize: 0, stickyFirst: false, empty: '暂无备份',
    columns: [
      { key: 'name', label: '文件', cls: 'mono' },
      { key: 'manual', label: '类型', fmt: x => (x ? '<span class="pill info">手动</span>' : '<span class="pill neutral">自动</span>') },
      { key: 'size', label: '大小', align: 'r', fmt: x => fmtSize(x) },
      { key: 'mtime', label: '时间', fmt: x => fmtTime(x) },
      { key: 'op', label: '', sortable: false, fmt: (x, r) => `<button class="btn sm" data-dl="${esc(r.name)}">${icon('download')}下载</button>` },
    ],
  }).setRows(list);
  drawBackups(bk.list);
  $('#bkNow', el).onclick = async e => {
    const btn = e.currentTarget; btn.disabled = true;
    try { const r = await http('POST', '/api/admin/backups'); toast(`已生成备份 ${r.name}（${fmtSize(r.size)}）`); drawBackups(r.list); }
    catch (ex) { toast('备份失败：' + ex.message, 'err', 4000); } finally { btn.disabled = false; }
  };
  $('#bkTbl', el).addEventListener('click', async e => {
    const b = e.target.closest('[data-dl]'); if (!b) return;
    const name = b.dataset.dl;
    await modal({
      title: '下载备份', submit: '验证并下载',
      body: `<p class="hint" style="margin:0 0 10px">备份包含加密后的访问密钥与用户密码哈希，下载前需再次验证当前登录密码。请将备份文件与 APP_MASTER_KEY 分开安全保管。</p>
        <div class="kv" style="margin-bottom:12px"><div><span>文件</span><b class="mono">${esc(name)}</b></div></div>
        <input type="text" name="username" autocomplete="username" value="${esc(state.me.username)}" hidden>
        <label class="field"><span>当前登录密码</span><input class="inp" type="password" name="password" autocomplete="current-password" required maxlength="256"></label>`,
      onSubmit: async form => {
        const password = form.elements.password.value;
        if (!password) throw new Error('请输入当前登录密码');
        const res = await fetch('/api/admin/backups/download', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ name, password }) });
        if (res.status === 401) { const j = await res.json().catch(() => ({})); try { sessionStorage.setItem('bc.loginMsg', j.error || '会话已过期'); } catch { /* ignore */ } location.href = '/login'; return false; }
        if (!res.ok) { const j = await res.json().catch(() => ({})); form.elements.password.value = ''; throw new Error(j.error || res.statusText); }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        toast('备份已开始下载');
        return true;
      },
    });
  });
}

/* ---------------- 安全与审计 ---------------- */
async function security(el) {
  const [s, { audit }] = await Promise.all([http('GET', '/api/admin/settings'), http('GET', '/api/admin/audit')]);
  const sec = s.security;
  el.innerHTML = `
    <section class="panel"><div class="panel-h"><h3>安全策略</h3><span class="sub">部分策略通过环境变量配置（见 .env），修改后重启容器生效</span></div>
      <div class="kv">
        <div><span>访问密钥存储</span><b>${esc(sec.encryption)} 加密，Secret / SecretKey 不回显</b></div>
        <div><span>主密钥来源</span><b>${sec.masterKeySource === 'env' ? '环境变量 APP_MASTER_KEY' : '<span class="warn-text">数据目录文件</span>'}</b></div>
        <div><span>密码哈希</span><b>${esc(sec.passwordHash)}</b></div>
        <div><span>登录失败锁定</span><b>连续 ${sec.loginMaxFailures} 次锁定 ${sec.lockMinutes} 分钟</b></div>
        <div><span>会话</span><b>空闲 ${sec.sessionIdleMinutes} 分钟 / 最长 ${sec.sessionMaxHours} 小时</b></div>
        <div><span>Cookie</span><b>HttpOnly · SameSite=Strict · Secure=${esc(sec.cookieSecure)}</b></div>
        <div><span>反向代理</span><b>${sec.trustProxy ? '信任 X-Forwarded-*' : '不信任（直连）'}</b></div>
        <div><span>IP 白名单</span><b class="mono">${esc(sec.allowCidrs.join(', ') || '未启用')}</b></div>
        <div><span>其他</span><b>CSP · CSRF 令牌 · 防点击劫持 · 请求限流 · 敏感操作二次验证 · 审计日志</b></div>
      </div></section>
    <section class="panel"><div class="panel-h"><h3>审计日志</h3><span class="sub">登录、配置变更、预算、标签、告警、备份、用户管理、同步触发等（最近 1000 条）</span><div class="actions"><button class="btn sm" id="csv">${icon('download')}导出</button></div></div><div id="aTbl"></div></section>`;
  const ACT = {
    'login.success': '登录成功', 'login.fail': '登录失败', logout: '退出登录', 'password.change': '修改密码', 'password.change.fail': '修改密码失败', 'password.change.lock': '改密错误过多强制退出',
    'user.create': '创建用户', 'user.update': '修改用户', 'user.delete': '删除用户', 'user.bootstrap': '初始化管理员', 'settings.update': '修改设置',
    'aliyun.ak.update': '更新阿里云 AccessKey', 'aliyun.ak.update.fail': '更新 AccessKey 验证失败', 'aliyun.ak.bootstrap': '导入阿里云 AccessKey', 'aliyun.test': '测试阿里云连接',
    'tencent.key.update': '更新腾讯云密钥', 'tencent.key.update.fail': '更新腾讯云密钥验证失败', 'tencent.key.bootstrap': '导入腾讯云密钥', 'tencent.test': '测试腾讯云连接',
    'sync.trigger': '触发同步', 'budgets.update': '修改预算', 'keytags.update': '修改成本中心 / 负责人', 'alert.update': '修改告警设置', 'alert.test': '发送测试消息', 'alert.test.fail': '测试消息失败',
    'alert.sent': '告警 / 报表已发送', 'alert.report.send': '手动发送报表', 'backup.create': '创建备份', 'backup.download': '下载备份', 'backup.download.fail': '下载备份验证失败', 'demo.clear': '清除演示数据',
  };
  const t = table('audit', $('#aTbl', el), {
    sort: 'id', pageSize: 50, stickyFirst: false, caption: '审计日志',
    columns: [
      { key: 'id', label: '时间', fmt: (x, r) => fmtTime(r.ts) + ':' + p2(new Date(r.ts).getSeconds()), csv: r => fmtTime(r.ts) },
      { key: 'username', label: '用户' },
      { key: 'ip', label: 'IP', cls: 'mono' },
      { key: 'action', label: '操作', fmt: x => `<span class="${/fail|lock/.test(x) ? 'bad-text' : ''}">${esc(ACT[x] || x)}</span><span class="sub mono">${esc(x)}</span>` },
      { key: 'detail', label: '详情', cls: 'wrap-cell' },
    ],
  }).setRows(audit);
  $('#csv', el).onclick = () => t.csv('审计日志.csv');
}

/* ---------------- 接口日志 ---------------- */
const PRODUCT = { bss: '阿里云 BssOpenApi', modelstudio: '阿里云 ModelStudio', tokenhub: '腾讯云 TokenHub', billing: '腾讯云 计费' };
async function calls(el) {
  const { calls: list } = await http('GET', '/api/admin/calls');
  const fail = list.filter(c => !c.ok).length;
  el.innerHTML = `<div class="stat-strip"><div><span>最近调用</span><b>${list.length}</b></div><div><span>失败</span><b class="${fail ? 'bad-text' : ''}">${fail}</b></div><div><span>平均耗时</span><b>${list.length ? Math.round(sum(list, c => c.ms) / list.length) + ' ms' : '-'}</b></div></div>
    <section class="panel"><div class="panel-h"><h3>云 API 调用日志</h3><span class="sub">最近 300 次（阿里云 + 腾讯云），仅内存保存，不含任何密钥</span></div><div id="cTbl"></div></section>`;
  table('calls', $('#cTbl', el), {
    sort: 'ts', pageSize: 50, stickyFirst: false, empty: '暂无调用',
    columns: [
      { key: 'ts', label: '时间', fmt: x => fmtTime(x) + ':' + p2(new Date(x).getSeconds()) },
      { key: 'action', label: '接口', fmt: (x, r) => `<span class="mono">${esc(x)}</span><span class="sub">${esc(PRODUCT[r.product] || r.product)}</span>` },
      { key: 'query', label: '参数', cls: 'mono wrap-cell', sortable: false },
      { key: 'ok', label: '结果', fmt: (x, r) => (x ? '<span class="pill good">成功</span>' : `<span class="pill bad">${esc(r.code || '失败')}</span>`) },
      { key: 'message', label: '错误信息', cls: 'wrap-cell' },
      { key: 'ms', label: '耗时', align: 'r', fmt: x => x + ' ms' },
      { key: 'requestId', label: 'RequestId', cls: 'mono' },
    ],
  }).setRows(list);
}
