/* 系统管理：阿里云接入、数据同步、预算、用户、安全审计、接口日志 */
import { $, esc, state, ui, app, http, toast, money, fmtTime, ago, p2, addMonths, opt, icon, help, keyShort, wsName, NONE_KEY, sum } from '../core.js';
import { table } from '../table.js';

export const ADMIN_TABS = { aliyun: '阿里云接入', sync: '数据同步', budgets: '预算管理', users: '用户管理', security: '安全与审计', calls: '接口日志' };
const POLICY = {
  Version: '1',
  Statement: [
    { Effect: 'Allow', Action: ['modelstudio:ListWorkspaces', 'modelstudio:ListApiKeys', 'modelstudio:GetApiKey', 'modelstudio:GetBillingOverview', 'modelstudio:GetBillingTrend'], Resource: '*' },
    { Effect: 'Allow', Action: ['bss:DescribeInstanceBill', 'bss:QueryBillOverview'], Resource: '*' },
  ],
};

export async function render(v, tab) {
  if (!ADMIN_TABS[tab]) tab = 'aliyun';
  v.innerHTML = `<div class="row" style="margin-bottom:14px"><div class="seg scroll" role="tablist" aria-label="系统管理">${Object.entries(ADMIN_TABS).map(([k, l]) => `<button type="button" role="tab" data-go="#/admin/${k}" aria-pressed="${tab === k}" aria-selected="${tab === k}">${l}</button>`).join('')}</div></div><div id="adm"><div class="nodata">加载中…</div></div>`;
  const el = $('#adm', v);
  try { await ({ aliyun, sync, budgets, users, security, calls })[tab](el); }
  catch (e) { el.innerHTML = `<div class="notice err">${icon('warn')}<div><b>加载失败</b><span class="why">${esc(e.message)}</span></div></div>`; }
}

/* ---------------- 阿里云接入 ---------------- */
const SECRET = { ok: ['已配置 · 加密保存', 'on'], none: ['未配置', 'off'], undecryptable: ['无法解密（主密钥已变化），请重新配置', 'off'] };
async function aliyun(el) {
  const s = await http('GET', '/api/admin/settings');
  const a = s.aliyun, ss = SECRET[a.secretState] || ['-', ''];
  el.innerHTML = `<div class="bi">
    <section class="panel c7"><div class="panel-h"><h3>RAM 用户 AccessKey</h3>${help('使用 RAM 用户 AccessKey 调用百炼与费用中心只读接口；Secret 只写不回显，以 AES-256-GCM 加密后存入 SQLite，主密钥与数据分离保存。')}</div>
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
        <label class="field full" id="akConfirm" hidden><span>当前登录密码</span><input class="inp" name="confirmPassword" type="password" autocomplete="current-password" maxlength="256"><small class="hint">更换 AccessKey 属于敏感操作，需要再次验证身份</small></label>
        <div class="row full"><button class="btn primary" type="submit">保存配置</button><button class="btn" type="button" id="testSaved">测试已保存配置</button><button class="btn" type="button" id="testForm">用表单中的 Key 测试</button></div>
      </form>
      <div class="test-list" id="testOut" aria-live="polite"></div>
    </section>
    <section class="panel c5"><div class="panel-h"><h3>所需 RAM 权限（只读）</h3></div>
      <p class="hint" style="margin:0 0 10px">系统策略 <b>AliyunBailianReadOnlyAccess</b> + <b>AliyunBSSReadOnlyAccess</b>，或下方最小权限自定义策略：</p>
      <pre class="code">${esc(JSON.stringify(POLICY, null, 2))}</pre>
      <p class="hint" style="margin:10px 0 0">建议为本系统创建专用 RAM 用户，只授予只读权限并定期轮换 AccessKey。更换 Key 后系统会立即重新同步。</p>
    </section></div>`;
  const form = $('#akForm', el), confirmBox = $('#akConfirm', el), pw = form.elements.confirmPassword;
  const akTouched = () => !!(form.elements.accessKeyId.value.trim() || form.elements.accessKeySecret.value.trim());
  form.addEventListener('input', e => {
    if (e.target === pw) { pw.classList.remove('invalid'); return; }
    confirmBox.hidden = !akTouched();
    if (confirmBox.hidden) pw.value = '';
  });
  form.onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const changingAk = akTouched();
    if (!changingAk) delete body.confirmPassword;
    else if (!body.confirmPassword) { confirmBox.hidden = false; pw.classList.add('invalid'); pw.focus(); toast('更换 AccessKey 需输入当前登录密码', 'err'); return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await http('PUT', '/api/admin/settings', { aliyun: body });
      toast(changingAk ? '已保存，AccessKey 已加密存储，正在重新同步' : '配置已保存');
      await app.refreshStatus(); aliyun(el);
    } catch (ex) {
      if (ex.status === 403) { pw.value = ''; pw.classList.add('invalid'); pw.focus(); }
      toast('保存失败：' + ex.message, 'err', 4000);
    } finally { btn.disabled = false; }
  };
  const runTest = async body => {
    const out = $('#testOut', el);
    out.innerHTML = '<div class="muted">正在测试 5 项接口，约需数秒…</div>';
    try {
      const { results } = await http('POST', '/api/admin/test', body);
      out.innerHTML = results.map(r => `<div>${r.ok ? `<span class="ok-text">${icon('check')}</span>` : `<span class="bad-text">${icon('x')}</span>`}<div><b style="font-weight:500">${esc(r.name)}</b>：${r.ok ? esc(r.detail) : `<span class="bad-text">${esc(r.error)}</span>${r.hint ? `<div class="hint">${esc(r.hint)}</div>` : ''}`}</div></div>`).join('');
    } catch (ex) { out.innerHTML = `<div class="bad-text">${esc(ex.message)}</div>`; }
  };
  $('#testSaved', el).onclick = () => runTest({});
  $('#testForm', el).onclick = () => { const fd = Object.fromEntries(new FormData($('#akForm', el))); runTest({ accessKeyId: fd.accessKeyId, accessKeySecret: fd.accessKeySecret }); };
}

/* ---------------- 数据同步 ---------------- */
const RUN = { success: ['成功', 'good'], partial: ['部分成功', 'warn'], error: ['失败', 'bad'], running: ['运行中', 'info'] };
async function sync(el) {
  const [s, { runs }] = await Promise.all([http('GET', '/api/admin/settings'), http('GET', '/api/admin/runs')]);
  await app.refreshStatus();
  const st = state.status, sy = s.sync, cur = state.today.slice(0, 7);
  const info = (name, x) => `<div><span>${name}</span><b>${x.running ? `<span class="state warn">同步中：${esc(x.progress?.text || '')}</span>` : `${x.lastSuccessAt ? '最近成功 ' + esc(fmtTime(x.lastSuccessAt)) : '尚未成功同步'}`}</b>${!x.running && x.nextAt ? `<span class="hint">下次约 ${esc(fmtTime(x.nextAt))}</span>` : ''}</div>`;
  el.innerHTML = `<div class="bi">
    <section class="panel c7"><div class="panel-h"><h3>同步状态</h3>${help('元数据（API Key、描述、业务空间、权限）按间隔与阿里云比对同步；账单按“账期（月）”与“日”两种粒度整体拉取替换，口径与费用中心一致。')}</div>
      <div class="kv">${info('API Key / 业务空间', st.sync.meta)}${info('账单', st.sync.bills)}<div><span>本地日账单</span><b>${Number(st.data.dailyLines || 0).toLocaleString()} 条</b>${st.data.minDay ? `<span class="hint">${esc(st.data.minDay)} ~ ${esc(st.data.maxDay)}</span>` : ''}</div></div>
      <div class="row" style="margin-top:16px">
        <button class="btn primary" data-sync="meta">${icon('sync')}同步 API Key / 业务空间</button>
        <button class="btn" data-sync="bills" data-cycles="${cur}">同步本月账单</button>
      </div>
      <div class="row" style="margin-top:10px">
        <select class="inp" id="syncCycle" aria-label="选择账期">${Array.from({ length: 18 }, (_, i) => addMonths(cur, -i)).map(c => opt(c, c, cur)).join('')}</select>
        <label class="chk"><input type="checkbox" id="syncForce"> 强制重新拉取</label>
        <button class="btn" data-sync="bills" data-pick="1">同步所选账期</button>
        <button class="btn" data-sync="bills" data-all="1" title="按回溯月数重新拉取全部账期（包括已出账账期）">全量回溯</button>
      </div>
    </section>
    <section class="panel c5"><div class="panel-h"><h3>同步策略</h3></div>
      <form id="syncForm" class="form-grid">
        <label class="field"><span>元数据同步间隔（分钟）</span><input class="inp" type="number" name="metaIntervalMin" min="1" max="1440" value="${sy.metaIntervalMin}"></label>
        <label class="field"><span>账单同步间隔（分钟）</span><input class="inp" type="number" name="billIntervalMin" min="10" max="1440" value="${sy.billIntervalMin}"></label>
        <label class="field"><span>回溯账期数（月，1–18）</span><input class="inp" type="number" name="backfillMonths" min="1" max="18" value="${sy.backfillMonths}"></label>
        <label class="field"><span>并发请求数（1–6）</span><input class="inp" type="number" name="concurrency" min="1" max="6" value="${sy.concurrency}"></label>
        <label class="chk full"><input type="checkbox" name="perWorkspaceKeys" ${sy.perWorkspaceKeys ? 'checked' : ''}> 逐个业务空间补全 API Key</label>
        <div class="row full"><button class="btn primary" type="submit">保存策略</button></div>
      </form>
      <p class="hint" style="margin:12px 0 0">已出账账期（次月 4 日起）同步一次后定稿；未出账账期最近 3 天每次刷新，其余日每 12 小时校正。月度趋势需回溯 12 个月。</p>
    </section>
    <section class="panel c5"><div class="panel-h"><h3>账期数据</h3><span class="sub">本地已同步的账期</span></div><div id="cyc"></div></section>
    <section class="panel c7"><div class="panel-h"><h3>同步任务记录</h3></div><div id="runs"></div></section></div>`;
  table('cyc', $('#cyc', el), {
    sort: 'cycle', pageSize: 0, stickyFirst: false, empty: '尚无账期数据',
    columns: [
      { key: 'cycle', label: '账期' },
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
      { key: 'kind', label: '类型', fmt: x => (x === 'meta' ? 'Key / 空间' : '账单') },
      { key: 'trig', label: '触发', fmt: x => esc(String(x || '').replace('manual:', '手动 · ').replace('schedule', '定时').replace('ak-changed', 'Key 变更')) },
      { key: 'started_at', label: '开始', fmt: x => fmtTime(x) },
      { key: 'dur', label: '耗时', align: 'r', fmt: (x, r) => (r.finished_at ? ((r.finished_at - r.started_at) / 1000).toFixed(1) + 's' : '-'), sortVal: r => (r.finished_at || 0) - r.started_at },
      { key: 'status', label: '结果', fmt: x => `<span class="pill ${RUN[x]?.[1] || 'neutral'}">${RUN[x]?.[0] || esc(x)}</span>` },
      { key: 'api_calls', label: '调用', align: 'r' },
      { key: 'detail', label: '详情', cls: 'wrap-cell', sortable: false, fmt: (x, r) => esc(runSummary(r)) },
    ],
  }).setRows(runs);
  el.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => {
    const body = { kind: b.dataset.sync };
    if (b.dataset.cycles) body.cycles = [b.dataset.cycles];
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
    return (d.cycles || []).map(c => (c.skipped ? `${c.cycle} 跳过` : `${c.cycle}：月 ${c.monthly} / 日 ${c.daily} 条${c.final ? ' · 终版' : ''}`)).join('；') + (r.error ? ' · ' + r.error : '');
  } catch { return r.error || ''; }
}

/* ---------------- 预算管理 ---------------- */
const ALERT_HINT = {
  dingtalk: '钉钉群 → 群设置 → 机器人 → 添加“自定义”机器人，复制 Webhook。安全设置建议选择“加签”并把密钥填到右侧；如使用“自定义关键词”，请包含“预算”。',
  feishu: '飞书群 → 设置 → 群机器人 → 添加“自定义机器人”，复制 Webhook。建议开启“签名校验”并把密钥填到右侧。',
  wecom: '企业微信群 → 添加群机器人，复制 Webhook 地址。企业微信机器人不支持加签，地址即凭据，请妥善保管。',
  generic: '以 POST JSON 发送 {event, title, level, items, text, link, sentAt}。填写密钥后附带 X-Alert-Timestamp 与 X-Alert-Signature 请求头（HMAC-SHA256，签名内容为 timestamp + "." + body）。',
};
const ALERT_RULES = { pct: '达到预警阈值', over: '超出预算', forecast: '预计月末超出总预算', keys: '包含 API Key 预算' };

async function budgets(el) {
  const b = state.budgets;
  const { alerts: al } = await http('GET', '/api/admin/settings');
  const lastCycle = addMonths(state.today.slice(0, 7), -1);
  const lastMonth = new Map();
  state.history.filter(l => l.date === lastCycle).forEach(l => lastMonth.set(l.apiKeyId || NONE_KEY, (lastMonth.get(l.apiKeyId || NONE_KEY) || 0) + l.pretax));
  const keys = [...state.apiKeys.values()].filter(k => k.source !== 'deleted' || b.keys?.[k.apiKeyId] != null);
  const rows = keys.map(k => ({ id: k.apiKeyId, desc: keyShort(k.apiKeyId), ws: wsName(k.wsKey), last: lastMonth.get(k.apiKeyId) || 0, c30: state.keyActivity.get(k.apiKeyId)?.c30 || 0, budget: b.keys?.[k.apiKeyId] ?? '' }));
  const totalLast = sum([...lastMonth.values()], x => x);
  el.innerHTML = `<div class="bi">
    <section class="panel c4"><div class="panel-h"><h3>月度总预算</h3>${help('预算按自然月的应付金额（税前）计算。设置后在成本概览显示使用率与月末预测，并在超出或预计超出时给出提醒。')}</div>
      <form id="bForm" class="form-grid" style="grid-template-columns:1fr">
        <label class="field"><span>月度总预算（元）</span><input class="inp" type="number" min="0" step="0.01" name="monthly" value="${b.monthly ?? ''}" placeholder="不设置"></label>
        <label class="field"><span>预警阈值（%）</span><input class="inp" type="number" min="1" max="100" name="alertPct" value="${b.alertPct ?? 80}"></label>
        <div class="hint">参考：上月（${esc(lastCycle)}）应付合计 ${money(totalLast)}。达到预警阈值显示黄色，超出预算显示红色。</div>
        <div class="row"><button class="btn primary" type="submit">保存全部预算</button></div>
      </form></section>
    <section class="panel c8"><div class="panel-h"><h3>API Key 月度预算</h3><span class="sub">留空表示不设预算</span>
      <div class="actions"><button class="btn sm" id="fill" title="为未设置预算的 Key 按上月费用 × 1.2 填入建议值（取整到元）">按上月 ×1.2 填充空白</button><button class="btn sm" id="clear">清空</button><button class="btn sm primary" id="saveB">保存</button></div></div>
      <div id="bTbl"></div><div class="panel-foot" id="bDirty"></div></section>
    <section class="panel c7"><div class="panel-h"><h3>预算告警通知</h3>${help('每次账单同步完成、预算或通知设置变更后自动检查本月预算；同一阈值（含预算金额）每个账期只通知一次，次月自动重置。Webhook 地址与加签密钥加密保存。')}
      <div class="actions"><span class="state ${al.enabled ? 'on' : 'off'}">${al.enabled ? '已启用' : '未启用'}</span></div></div>
      <form id="aForm" class="form-grid" autocomplete="off">
        <label class="chk full"><input type="checkbox" name="enabled" ${al.enabled ? 'checked' : ''}> 启用预算告警通知</label>
        <label class="field"><span>通知渠道</span><select class="inp" name="type">${Object.entries(al.types).map(([k, t]) => opt(k, t.label, al.type)).join('')}</select></label>
        <label class="field" id="aSecretBox"><span>加签密钥（可选）</span><input class="inp mono" name="secret" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" placeholder="${al.secretSet ? '已加密保存，留空表示不修改' : '未设置'}"></label>
        <label class="field full"><span>Webhook 地址</span><input class="inp mono" name="webhook" spellcheck="false" maxlength="1000" placeholder="${al.webhookSet ? esc(al.webhookMasked) + '（已加密保存，留空表示不修改）' : ''}"></label>
        <div class="field full"><span>通知条件</span><div class="row" style="gap:6px 18px">${Object.entries(ALERT_RULES).map(([k, l]) => `<label class="chk"><input type="checkbox" name="rule_${k}" ${al.rules[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
        <p class="hint full" id="aHint" style="margin:0"></p>
        <div class="row full"><button class="btn primary" type="submit">保存通知设置</button><button class="btn" type="button" id="aTest">${icon('send')}发送测试消息</button>${al.secretSet ? '<label class="chk"><input type="checkbox" name="clearSecret"> 清除已保存的密钥</label>' : ''}${al.webhookSet ? '<label class="chk"><input type="checkbox" name="clearWebhook"> 移除通知渠道</label>' : ''}</div>
      </form></section>
    <section class="panel c5"><div class="panel-h"><h3>告警状态</h3><span class="sub">账期 ${esc(al.state.cycle)}</span></div>
      <div class="kv">
        <div><span>最近发送</span><b>${al.state.lastSentAt ? esc(fmtTime(al.state.lastSentAt)) : '尚未发送'}</b></div>
        <div><span>最近一次失败</span><b class="${al.state.lastError ? 'bad-text' : ''}">${al.state.lastError ? esc(fmtTime(al.state.lastErrorAt)) + ' · ' + esc(al.state.lastError) : '无'}</b></div>
      </div>
      <h4 class="sec-h">当前满足条件、尚未通知</h4>
      ${al.pending.length ? `<ul class="alert-list">${al.pending.map(t => `<li class="warn">${esc(t)}</li>`).join('')}</ul>` : `<p class="hint" style="margin:0">${b.monthly || Object.keys(b.keys || {}).length ? '暂无（未达到任何阈值，或已通知过）' : '尚未设置预算'}</p>`}
      <h4 class="sec-h">最近通知记录</h4>
      ${al.state.history.length ? `<ul class="alert-list">${al.state.history.map(h => `<li class="${h.level === 'bad' ? 'bad' : 'warn'}"><b>${esc(fmtTime(h.at))}</b> · ${h.items.map(esc).join('；')}</li>`).join('')}</ul>` : '<p class="hint" style="margin:0">暂无</p>'}
    </section></div>`;
  bindAlerts(el, al);
  table('budgets', $('#bTbl', el), {
    sort: 'last', pageSize: 0, maxHeight: '60vh', caption: 'API Key 预算',
    columns: [
      { key: 'desc', label: 'API Key', fmt: (x, r) => `<b style="font-weight:600">${esc(x)}</b><span class="sub mono">${esc(r.id)}</span>` },
      { key: 'ws', label: '业务空间' },
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

function bindAlerts(el, al) {
  const form = $('#aForm', el);
  const sync = () => {
    const t = form.elements.type.value;
    $('#aHint', el).textContent = ALERT_HINT[t] || '';
    $('#aSecretBox', el).hidden = !al.types[t]?.sign;
    form.elements.webhook.placeholder = al.webhookSet && t === al.type ? al.webhookMasked + '（已加密保存，留空表示不修改）' : al.types[t]?.host ? `https://${al.types[t].host}/…` : 'https://…';
  };
  sync();
  form.elements.type.addEventListener('change', sync);
  form.addEventListener('input', () => { app.dirty = true; });
  const body = () => {
    const fd = new FormData(form);
    return {
      enabled: fd.get('enabled') === 'on', type: fd.get('type'), webhook: fd.get('webhook') || '', secret: fd.get('secret') || '', clearSecret: fd.get('clearSecret') === 'on', clearWebhook: fd.get('clearWebhook') === 'on',
      rules: Object.fromEntries(Object.keys(ALERT_RULES).map(k => [k, fd.get('rule_' + k) === 'on'])),
    };
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const data = body();
    if (data.clearWebhook && !confirm('移除通知渠道后将停止发送预算告警（Webhook 地址与密钥会被删除），确定？')) return;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const out = await http('PUT', '/api/admin/alerts', data);
      app.dirty = false;
      const r = out.check || {};
      toast(data.clearWebhook ? '已移除通知渠道' : !out.enabled ? '通知设置已保存（未启用）' : r.error ? '已保存，但告警发送失败：' + r.error : r.sent ? `已保存，并已发送 ${r.sent} 条当前满足条件的告警` : '通知设置已保存并已启用', r.error ? 'err' : '', 4500);
      budgets(el);
    } catch (ex) { toast('保存失败：' + ex.message, 'err', 4000); }
    finally { btn.disabled = false; }
  };
  $('#aTest', el).onclick = async e => {
    const btn = e.currentTarget, { type, webhook, secret } = body();
    btn.disabled = true;
    try { await http('POST', '/api/admin/alerts/test', { type, webhook, secret }); toast('测试消息已发送，请在群中查看'); }
    catch (ex) { toast(ex.message, 'err', 5000); }
    finally { btn.disabled = false; }
  };
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

/* ---------------- 安全与审计 ---------------- */
async function security(el) {
  const [s, { audit }] = await Promise.all([http('GET', '/api/admin/settings'), http('GET', '/api/admin/audit')]);
  const sec = s.security;
  el.innerHTML = `
    <section class="panel"><div class="panel-h"><h3>安全策略</h3><span class="sub">部分策略通过环境变量配置（见 .env），修改后重启容器生效</span></div>
      <div class="kv">
        <div><span>AccessKey 存储</span><b>${esc(sec.encryption)} 加密，Secret 不回显</b></div>
        <div><span>主密钥来源</span><b>${sec.masterKeySource === 'env' ? '环境变量 APP_MASTER_KEY' : '<span class="warn-text">数据目录文件</span>'}</b></div>
        <div><span>密码哈希</span><b>${esc(sec.passwordHash)}</b></div>
        <div><span>登录失败锁定</span><b>连续 ${sec.loginMaxFailures} 次锁定 ${sec.lockMinutes} 分钟</b></div>
        <div><span>会话</span><b>空闲 ${sec.sessionIdleMinutes} 分钟 / 最长 ${sec.sessionMaxHours} 小时</b></div>
        <div><span>Cookie</span><b>HttpOnly · SameSite=Strict · Secure=${esc(sec.cookieSecure)}</b></div>
        <div><span>反向代理</span><b>${sec.trustProxy ? '信任 X-Forwarded-*' : '不信任（直连）'}</b></div>
        <div><span>IP 白名单</span><b class="mono">${esc(sec.allowCidrs.join(', ') || '未启用')}</b></div>
        <div><span>其他</span><b>CSP · CSRF 令牌 · 防点击劫持 · 请求限流 · 审计日志</b></div>
      </div></section>
    <section class="panel"><div class="panel-h"><h3>审计日志</h3><span class="sub">登录、配置变更、预算、用户管理、同步触发等（最近 1000 条）</span><div class="actions"><button class="btn sm" id="csv">${icon('download')}导出</button></div></div><div id="aTbl"></div></section>`;
  const ACT = { 'login.success': '登录成功', 'login.fail': '登录失败', logout: '退出登录', 'password.change': '修改密码', 'password.change.fail': '修改密码失败', 'user.create': '创建用户', 'user.update': '修改用户', 'user.delete': '删除用户', 'user.bootstrap': '初始化管理员', 'settings.update': '修改设置', 'aliyun.ak.update': '更新 AccessKey', 'aliyun.ak.bootstrap': '导入 AccessKey', 'aliyun.test': '测试连接', 'sync.trigger': '触发同步', 'budgets.update': '修改预算' };
  const t = table('audit', $('#aTbl', el), {
    sort: 'id', pageSize: 50, stickyFirst: false, caption: '审计日志',
    columns: [
      { key: 'id', label: '时间', fmt: (x, r) => fmtTime(r.ts) + ':' + p2(new Date(r.ts).getSeconds()), csv: r => fmtTime(r.ts) },
      { key: 'username', label: '用户' },
      { key: 'ip', label: 'IP', cls: 'mono' },
      { key: 'action', label: '操作', fmt: x => `<span class="${/fail/.test(x) ? 'bad-text' : ''}">${esc(ACT[x] || x)}</span><span class="sub mono">${esc(x)}</span>` },
      { key: 'detail', label: '详情', cls: 'wrap-cell' },
    ],
  }).setRows(audit);
  $('#csv', el).onclick = () => t.csv('审计日志.csv');
}

/* ---------------- 接口日志 ---------------- */
async function calls(el) {
  const { calls: list } = await http('GET', '/api/admin/calls');
  const fail = list.filter(c => !c.ok).length;
  el.innerHTML = `<div class="stat-strip"><div><span>最近调用</span><b>${list.length}</b></div><div><span>失败</span><b class="${fail ? 'bad-text' : ''}">${fail}</b></div><div><span>平均耗时</span><b>${list.length ? Math.round(sum(list, c => c.ms) / list.length) + ' ms' : '-'}</b></div></div>
    <section class="panel"><div class="panel-h"><h3>阿里云 OpenAPI 调用日志</h3><span class="sub">最近 300 次，仅内存保存，不含任何密钥</span></div><div id="cTbl"></div></section>`;
  table('calls', $('#cTbl', el), {
    sort: 'ts', pageSize: 50, stickyFirst: false, empty: '暂无调用',
    columns: [
      { key: 'ts', label: '时间', fmt: x => fmtTime(x) + ':' + p2(new Date(x).getSeconds()) },
      { key: 'action', label: '接口', fmt: (x, r) => `<span class="mono">${esc(x)}</span><span class="sub">${r.product === 'bss' ? 'BssOpenApi' : 'ModelStudio'}</span>` },
      { key: 'query', label: '参数', cls: 'mono wrap-cell', sortable: false },
      { key: 'ok', label: '结果', fmt: (x, r) => (x ? '<span class="pill good">成功</span>' : `<span class="pill bad">${esc(r.code || '失败')}</span>`) },
      { key: 'message', label: '错误信息', cls: 'wrap-cell' },
      { key: 'ms', label: '耗时', align: 'r', fmt: x => x + ' ms' },
      { key: 'requestId', label: 'RequestId', cls: 'mono' },
    ],
  }).setRows(list);
}
