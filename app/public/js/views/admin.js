/* 系统管理：云厂商接入（阿里云 / 腾讯云）、数据同步、预算、告警通知、用户、品牌与备份、安全审计、接口日志 */
import { $, esc, state, ui, app, http, toast, money, fmtTime, ago, p2, addMonths, opt, icon, help, keyShort, wsName, NONE_KEY, NO_WS, NO_CC, sum, PROVIDERS, provTag, modal } from '../core.js';
import { table } from '../table.js';
import { actLabel, actBad, auditHtml, auditText, ipHtml, ipText, API, apiParams, OP_CAT, OP_ACT, opPairs, uaText } from '../labels.js';

export const ADMIN_TABS = { aliyun: '阿里云接入', tencent: '腾讯云接入', sync: '数据同步', budgets: '预算管理', alerts: '告警通知', users: '用户管理', system: '品牌与备份', security: '安全与审计', oplog: '操作日志', logs: '系统日志', calls: '接口日志' };
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
  if (!Object.hasOwn(ADMIN_TABS, tab)) tab = 'aliyun';
  v.innerHTML = `<div class="row" style="margin-bottom:14px"><div class="seg scroll" role="tablist" aria-label="系统管理">${Object.entries(ADMIN_TABS).map(([k, l]) => `<button type="button" role="tab" data-go="#/admin/${k}" aria-pressed="${tab === k}" aria-selected="${tab === k}">${l}</button>`).join('')}</div></div><div id="adm"><div class="nodata">加载中…</div></div>`;
  const el = $('#adm', v);
  try { await ({ aliyun, tencent, sync, budgets, alerts, users, system, security, oplog, logs, calls })[tab](el); }
  catch (e) { el.innerHTML = `<div class="notice err">${icon('warn')}<div><b>加载失败</b><span class="why">${esc(e.message)}</span></div></div>`; }
}

/* ---------------- 云厂商接入（通用表单逻辑） ---------------- */
const SECRET = { ok: ['已配置 · 加密保存', 'on'], none: ['未配置', 'off'], undecryptable: ['无法解密（主密钥已变化），请重新配置', 'off'] };
/** 每个表单单独记录未保存状态：保存其中一个表单后，页面上其他表单的未保存修改仍受离开确认保护 */
const markDirty = form => { form.dataset.dirty = '1'; app.dirty = true; };
const markClean = form => { delete form.dataset.dirty; app.dirty = !!document.querySelector('#view form[data-dirty]'); };
/** 操作成功后的刷新：等待完成，失败时在页面上提示（不能成为未处理的 Promise 拒绝，也不能悄悄停留在旧内容） */
async function refresh(box, fn) {
  try { await fn(); }
  catch (e) { box.insertAdjacentHTML('afterbegin', `<div class="notice err">${icon('warn')}<div><b>刷新失败</b><span class="why">${esc(e.message)}（操作已完成，可稍后重新打开本页查看）</span></div></div>`); }
}
/** 敏感操作的当前登录密码确认；取消时返回 null */
const askPassword = (title, why) => modal({
  title, submit: '确认',
  body: `<p class="hint" style="margin:0 0 10px">${esc(why)}</p><label class="field"><span>当前登录密码</span><input class="inp" type="password" name="password" autocomplete="current-password" required maxlength="256"></label>`,
  onSubmit: form => { const p = form.elements.password.value; if (!p) throw new Error('请输入当前登录密码'); return { password: p }; },
}).then(r => r?.password || null);
function bindCredForm(el, { form, idField, secretField, settingsKey, reload, testBody }) {
  const confirmBox = $('[data-confirm]', form), pw = form.elements.confirmPassword;
  const touched = () => !!(form.elements[idField].value.trim() || form.elements[secretField].value.trim());
  form.addEventListener('input', e => {
    markDirty(form);
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
      markClean(form);
      toast(changing ? '已保存，密钥已加密存储，正在重新同步' : '配置已保存');
      await app.refreshStatus(); await reload();
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
  el.innerHTML = '<div id="akBox"></div><div class="bi" style="margin-top:16px" id="callsBox"></div>';
  const akBox = $('#akBox', el), callsBox = $('#callsBox', el);
  // 两个表单各自刷新：保存其中一个时不能重绘另一个（会丢失另一个表单中未保存的输入）
  const reloadAk = () => refresh(akBox, async () => akPanel(akBox, await http('GET', '/api/admin/settings'), reloadAk));
  const reloadCalls = () => refresh(callsBox, async () => callsPanel(callsBox, (await http('GET', '/api/admin/settings')).aliyunCalls, reloadCalls));
  akPanel(akBox, s, reloadAk);
  callsPanel(callsBox, s.aliyunCalls, reloadCalls);
}
function akPanel(el, s, reload) {
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
    form: $('#akForm', el), idField: 'accessKeyId', secretField: 'accessKeySecret', settingsKey: 'aliyun', reload,
    // 表单测试使用表单中选择的地域 / 站点（与保存后实际使用的一致）
    testBody: fd => (fd ? { provider: 'aliyun', accessKeyId: fd.accessKeyId, accessKeySecret: fd.accessKeySecret, msRegion: fd.msRegion, bssSite: fd.bssSite } : { provider: 'aliyun' }),
  });
}

/* ---------------- 阿里云调用次数：百炼监控投递 → 云监控 Prometheus ---------------- */
const promQL = c => {
  if (!c.metric || !c.keyLabel) return '';
  const sel = c.filter ? `${c.metric}{${c.filter}}` : c.metric;
  const by = [c.keyLabel, c.modelLabel].filter(Boolean).join(', ');
  return c.aggregation === 'sum' ? `sum by (${by}) (sum_over_time(${sel}[1d]))` : `sum by (${by}) (increase(${sel}[1d]))`;
};
function callsPanel(box, c, reload) {
  const last = c.last;
  const lastHtml = !last ? '<div><span>最近同步</span><b>尚未同步</b></div>' : last.ok
    ? `<div><span>最近同步</span><b>${esc(fmtTime(last.at))}</b></div>
       <div><span>数据范围</span><b>${last.from ? `${esc(last.from)} ~ ${esc(last.to)}` : '无数据'}</b></div>
       <div><span>调用次数</span><b>${Number(last.requests || 0).toLocaleString()} 次</b>${last.unmatched ? `<span class="hint warn-text">${last.unmatched} 个 Key 标签值未匹配</span>` : ''}</div>`
    : `<div><span>最近同步</span><b class="bad-text">${esc(fmtTime(last.at))} 失败</b><span class="hint bad-text">${esc(last.error || '')}</span></div>`;
  box.innerHTML = `
    <section class="panel c7"><div class="panel-h"><h3>调用次数（云监控 Prometheus）</h3>${help('百炼公开 OpenAPI 与费用中心账单不含调用次数。百炼“监控告警”数据开启“监控数据投递”后写入云监控 Prometheus 实例，本系统通过其标准 HTTP API 只读查询，按 API Key × 模型 × 日 汇总。')}
        <span class="sp"></span><span class="state ${c.enabled ? 'on' : 'off'}">${c.enabled ? '已启用' : '未启用'}</span></div>
      <div class="kv" style="margin-bottom:14px">${lastHtml}</div>
      <form id="callsForm" class="form-grid" autocomplete="off">
        <label class="chk full"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}> 启用：随阿里云账单同步读取调用次数（单次平均 Token / 费用、成功率、每日调用图）</label>
        <label class="field full"><span>Prometheus HTTP API 地址</span><input class="inp mono" name="url" value="${esc(c.url)}" placeholder="云监控 Prometheus 实例“设置”页中的 HTTP API 地址（公网或 VPC 内网）" spellcheck="false"></label>
        <label class="field"><span>认证方式</span><select class="inp" name="authType">${Object.entries(c.authTypes || {}).map(([k, l]) => opt(k, l, c.authType)).join('')}</select></label>
        <label class="field" data-auth="bearer raw"><span>Token</span><input class="inp mono" name="token" type="password" placeholder="${c.secretSet ? '已加密保存，留空表示不修改' : '实例开启鉴权时填写'}" autocomplete="new-password" spellcheck="false"></label>
        <label class="field" data-auth="basic"><span>用户名</span><input class="inp mono" name="username" value="${esc(c.username)}" autocomplete="off" spellcheck="false"></label>
        <label class="field" data-auth="basic"><span>密码</span><input class="inp mono" name="password" type="password" placeholder="${c.secretSet ? '已加密保存，留空表示不修改' : ''}" autocomplete="new-password"></label>
        <div class="row full"><button class="btn" type="button" data-discover>${icon('search')}发现指标</button><span class="hint">读取实例中的指标名与标签，自动推荐下方映射</span></div>
        <div class="full" data-discover-out></div>
        <label class="field"><span>调用次数指标</span><input class="inp mono" name="metric" value="${esc(c.metric)}" list="promMetrics" spellcheck="false" placeholder="发现后自动填写"></label>
        <label class="field"><span>失败次数指标（可选）</span><input class="inp mono" name="failMetric" value="${esc(c.failMetric)}" list="promMetrics" spellcheck="false" placeholder="用于成功率"></label>
        <label class="field"><span>API Key 标签</span><input class="inp mono" name="keyLabel" value="${esc(c.keyLabel)}" list="promLabels" spellcheck="false"></label>
        <label class="field"><span>模型标签（可选）</span><input class="inp mono" name="modelLabel" value="${esc(c.modelLabel)}" list="promLabels" spellcheck="false"></label>
        <label class="field"><span>统计方式</span><select class="inp" name="aggregation">${opt('increase', '计数器：increase（累计值）', c.aggregation)}${opt('sum', '周期值：sum_over_time（每点为该周期次数）', c.aggregation)}</select></label>
        <label class="field"><span>回读天数</span><input class="inp" name="lookbackDays" type="number" min="1" max="400" value="${esc(c.lookbackDays)}"></label>
        <label class="field full"><span>过滤条件（可选）</span><input class="inp mono" name="filter" value="${esc(c.filter)}" placeholder='如 region="cn-beijing"，多个用逗号分隔' spellcheck="false"></label>
        <div class="field full"><span>查询语句（每个自然日）</span><pre class="code" data-ql>${esc(promQL(c) || '—')}</pre></div>
        <label class="chk full" ${c.secretSet ? '' : 'hidden'}><input type="checkbox" name="clearToken"> 清除已保存的 Token / 密码</label>
        <label class="field full" data-confirm hidden><span>当前登录密码</span><input class="inp" name="confirmPassword" type="password" autocomplete="current-password" maxlength="256"><small class="hint">修改 Prometheus 地址或认证信息属于敏感操作，需要再次验证身份</small></label>
        <div class="row full"><button class="btn primary" type="submit">保存配置</button><button class="btn" type="button" data-preview>预览近 7 天</button><button class="btn" type="button" data-calls-sync ${c.enabled ? '' : 'disabled'}>${icon('sync')}立即同步</button></div>
        <datalist id="promMetrics"></datalist><datalist id="promLabels"></datalist>
      </form>
    </section>
    <section class="panel c5"><div class="panel-h"><h3>接入步骤</h3></div>
      <ol class="hint" style="margin:0;padding-left:18px;line-height:1.9">
        <li>百炼控制台 → <b>监控告警</b> → 开启<b>监控数据投递</b>，选择（或新建）云监控 Prometheus 实例</li>
        <li>在云监控 / 可观测监控 Prometheus 版控制台打开该实例的<b>设置</b>页，复制 <b>HTTP API 地址</b>；实例开启鉴权时同时复制 Token</li>
        <li>填入左侧后点<b>发现指标</b>，系统自动识别调用次数 / 失败次数指标与 API Key、模型标签</li>
        <li>点<b>预览近 7 天</b>，与百炼控制台“模型用量”中的调用次数核对一致后，勾选启用并保存</li>
      </ol>
      <h4 class="sec-h">说明</h4>
      <ul class="hint" style="margin:0;padding-left:18px;line-height:1.8">
        <li>只读查询：仅调用 Prometheus 的查询接口，Token 以 AES-256-GCM 加密保存、不回显</li>
        <li>调用次数从开启投递之日起才有数据；系统每次同步回读最近 N 天，Prometheus 中已过期的日期保留本地已同步的记录</li>
        <li>单次平均 Token 取同日同 Key 同模型的<b>账单 Token</b>，与费用口径一致；修改指标映射会清空已同步的阿里云调用次数并重新读取</li>
        <li>VPC 内网地址需本系统部署在同一 VPC；云服务器元数据地址与本机回环地址禁止访问</li>
      </ul>
    </section>
    <section class="panel c12" data-preview-panel hidden><div class="panel-h"><h3>预览</h3><span class="sub" data-preview-sub></span></div><div data-preview-out></div></section>`;

  const form = $('#callsForm', box), pw = form.elements.confirmPassword, confirmBox = $('[data-confirm]', form);
  const val = n => form.elements[n].value.trim();
  const cfgNow = () => ({ url: val('url'), authType: form.elements.authType.value, username: val('username'), metric: val('metric'), failMetric: val('failMetric'), keyLabel: val('keyLabel'), modelLabel: val('modelLabel'), aggregation: form.elements.aggregation.value, filter: val('filter'), lookbackDays: val('lookbackDays') });
  const authBody = () => ({ ...cfgNow(), token: form.elements.token.value.trim(), password: form.elements.password.value });
  const needConfirm = () => !!(form.elements.token.value.trim() || form.elements.password.value || form.elements.clearToken.checked || (c.secretSet && c.url && val('url').replace(/\/+$/, '').replace(/\/api\/v1$/, '') !== c.url));
  const sync = () => {
    const t = form.elements.authType.value;
    form.querySelectorAll('[data-auth]').forEach(x => { x.hidden = !x.dataset.auth.split(' ').includes(t); });
    $('[data-ql]', form).textContent = promQL(cfgNow()) || '—';
    confirmBox.hidden = !needConfirm();
  };
  sync();
  form.addEventListener('input', e => { markDirty(form); if (e.target === pw) pw.classList.remove('invalid'); else sync(); });
  form.addEventListener('change', sync);

  const fill = (list, el) => { $(el, form).innerHTML = [...new Set(list)].map(x => `<option value="${esc(x)}"></option>`).join(''); };
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
  $('[data-discover]', form).onclick = e => busy(e.currentTarget, async () => {
    const out = $('[data-discover-out]', form);
    out.innerHTML = '<div class="muted">正在读取指标…</div>';
    try {
      const d = await http('POST', '/api/admin/aliyun-calls/discover', authBody());
      fill(d.candidates.map(x => x.name), '#promMetrics');
      fill(d.candidates.flatMap(x => x.labels), '#promLabels');
      if (!d.candidates.length) { out.innerHTML = `<div class="notice warn">${icon('warn')}<div><b>未找到疑似调用次数的指标</b><span class="why">实例共有 ${d.totalMetrics} 个指标。请确认百炼已开启监控数据投递到该实例（投递后约数分钟出现数据），或手动填写指标名。</span></div></div>`; return; }
      out.innerHTML = `<div class="hint" style="margin-bottom:6px">实例共 ${d.totalMetrics} 个指标，以下为疑似调用相关的候选（点“使用”填入映射）：</div>
        <div class="tbl-wrap" style="max-height:260px"><table class="dt compact"><thead><tr><th>指标名</th><th>标签</th><th>推荐 Key / 模型标签</th><th></th></tr></thead><tbody>
        ${d.candidates.slice(0, 15).map((x, i) => `<tr><td class="mono">${esc(x.name)}${x.fail ? ' <span class="pill warn">失败</span>' : ''}</td><td class="mono" style="white-space:normal">${esc(x.labels.join(', ') || '—')}</td><td class="mono">${esc(x.keyLabel || '—')} / ${esc(x.modelLabel || '—')}</td><td><button class="btn sm" type="button" data-use="${i}">使用</button></td></tr>`).join('')}
        </tbody></table></div>`;
      const use = x => {
        const f = form.elements;
        if (x.fail) f.failMetric.value = x.name;
        else { f.metric.value = x.name; f.keyLabel.value = x.keyLabel || f.keyLabel.value; f.modelLabel.value = x.modelLabel || f.modelLabel.value; f.aggregation.value = /_total$|_count$|counter/i.test(x.name) ? 'increase' : 'sum'; }
        markDirty(form); sync();
      };
      out.querySelectorAll('[data-use]').forEach(b => { b.onclick = () => use(d.candidates[Number(b.dataset.use)]); });
      if (d.guess && !val('metric')) {
        const f = form.elements;
        Object.assign(f.metric, { value: d.guess.metric }); f.failMetric.value = d.guess.failMetric || ''; f.keyLabel.value = d.guess.keyLabel || ''; f.modelLabel.value = d.guess.modelLabel || ''; f.aggregation.value = d.guess.aggregation;
        markDirty(form); sync();
        toast('已按推荐填写指标映射，请预览核对');
      }
    } catch (ex) { out.innerHTML = `<div class="bad-text">${esc(ex.message)}</div>`; }
  });

  const panel = $('[data-preview-panel]', box);
  $('[data-preview]', form).onclick = e => busy(e.currentTarget, async () => {
    panel.hidden = false;
    const out = $('[data-preview-out]', panel);
    out.innerHTML = '<div class="muted">正在查询…</div>';
    try {
      const p = await http('POST', '/api/admin/aliyun-calls/preview', { ...authBody(), days: 7 });
      $('[data-preview-sub]', panel).textContent = `${p.from} ~ ${p.to} · ${p.calls} 次查询`;
      const max = Math.max(1, ...p.days.map(x => x.requests));
      out.innerHTML = `
        <div class="kv" style="margin-bottom:12px">
          <div><span>调用次数（已匹配 Key）</span><b>${Number(p.total).toLocaleString()} 次</b></div>
          <div><span>失败次数</span><b>${val('failMetric') ? Number(p.fails).toLocaleString() + ' 次' : '未配置失败次数指标'}</b></div>
          <div><span>未匹配的 Key 标签值</span><b>${p.unmatched.length ? `<span class="warn-text">${p.unmatched.length} 个 · ${Number(p.unmatchedTotal).toLocaleString()} 次</span>` : '无'}</b></div>
        </div>
        ${p.days.length ? `<div class="hint" style="margin-bottom:4px">每日调用次数</div><div class="test-list" style="margin:0 0 12px">${p.days.map(x => `<div style="grid-template-columns:86px 1fr 90px"><span class="mono">${esc(x.day.slice(5))}</span><span class="progress" style="align-self:center"><i style="width:${(x.requests / max * 100).toFixed(1)}%"></i></span><span class="mono" style="text-align:right">${Number(x.requests).toLocaleString()}</span></div>`).join('')}</div>` : `<div class="notice warn">${icon('warn')}<div><b>近 7 天没有查询到调用次数</b><span class="why">请检查指标名、标签与统计方式；投递刚开启时需等待数分钟。</span></div></div>`}
        ${p.unmatched.length ? `<div class="notice warn" style="margin-bottom:12px">${icon('warn')}<div><b>以下 API Key 标签值未匹配到已同步的阿里云 Key（不会入库）</b><span class="why mono">${p.unmatched.map(u => `${esc(u.value || '（空）')} · ${u.requests} 次`).join('；')}</span><span class="why">请确认选择的是 API Key ID 标签，或先在“数据同步”中同步 Key。</span></div></div>` : ''}
        <div id="callsPrev"></div>`;
      table('callsPrev', $('#callsPrev', out), {
        sort: 'requests', pageSize: 20, stickyFirst: false, empty: '无数据',
        columns: [
          { key: 'apiKeyId', label: 'API Key', fmt: (x, r) => `<span class="mono">${esc(x || '（无 API Key）')}</span>${r.name ? ` <span class="muted">${esc(r.name)}</span>` : ''}` },
          { key: 'model', label: '模型', fmt: x => `<span class="mono">${esc(x || '—')}</span>` },
          { key: 'requests', label: '调用次数', align: 'r', fmt: x => Number(x).toLocaleString() },
          { key: 'fails', label: '失败', align: 'r', fmt: x => Number(x).toLocaleString() },
          { key: 'tokens', label: '账单 Token', align: 'r', fmt: x => Math.round(x).toLocaleString() },
          { key: 'tokPer', label: '单次平均 Token', align: 'r', fmt: x => (x == null ? '—' : Math.round(x).toLocaleString()) },
        ],
      }).setRows(p.rows.map(r => ({ ...r, tokPer: r.requests && r.tokens ? r.tokens / r.requests : null })));
    } catch (ex) { out.innerHTML = `<div class="bad-text">${esc(ex.message)}</div>`; }
  });

  $('[data-calls-sync]', form).onclick = e => busy(e.currentTarget, async () => {
    try {
      const r = await http('POST', '/api/admin/aliyun-calls/sync', {});
      toast(r.from ? `已同步 ${r.from} ~ ${r.to}：${Number(r.requests).toLocaleString()} 次调用` : '同步完成，但没有查询到调用次数', '', 4000);
      app.reload?.(); await reload();
    } catch (ex) { toast('同步失败：' + ex.message, 'err', 5000); }
  });

  form.onsubmit = async e => {
    e.preventDefault();
    const body = { ...cfgNow(), enabled: form.elements.enabled.checked, clearToken: form.elements.clearToken.checked };
    const tk = form.elements.token.value.trim(), pass = form.elements.password.value;
    if (tk) body.token = tk;
    if (pass) body.password = pass;
    if (needConfirm()) {
      if (!pw.value) { confirmBox.hidden = false; pw.classList.add('invalid'); pw.focus(); toast('修改地址或认证信息需输入当前登录密码', 'err'); return; }
      body.confirmPassword = pw.value;
    }
    // 只改地址（如公网地址换成 VPC 地址）不清空已同步的调用次数，与服务端一致
    const remap = c.metric && ['metric', 'failMetric', 'keyLabel', 'modelLabel', 'aggregation', 'filter'].some(k => String(body[k] || '') !== String(c[k] || ''));
    if (remap && !confirm('修改了指标映射，保存后将清空已同步的阿里云调用次数并按新配置重新读取。是否继续？')) return;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await http('PUT', '/api/admin/settings', { aliyunCalls: body });
      markClean(form);
      toast(body.enabled ? '已保存，将随下一次阿里云账单同步读取调用次数（也可点“立即同步”）' : '配置已保存');
      await app.refreshStatus(); await reload();
    } catch (ex) {
      if (ex.status === 403) { pw.value = ''; pw.classList.add('invalid'); pw.focus(); }
      toast('保存失败：' + ex.message, 'err', 4000);
    } finally { btn.disabled = false; }
  };
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
    form: $('#tcForm', el), idField: 'secretId', secretField: 'secretKey', settingsKey: 'tencent', reload: () => refresh(el, () => tencent(el)),
    testBody: fd => (fd ? { provider: 'tencent', secretId: fd.secretId, secretKey: fd.secretKey, region: fd.region, site: fd.site } : { provider: 'tencent' }),
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
      { key: 'trig', label: '触发', fmt: x => esc(trigLabel(x)) },
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
    try { const r = await http('POST', '/api/admin/sync', body); toast(r.queued ? '已有同类任务在运行，本次请求已排队，将在其结束后执行' : r.alreadyRunning ? '已有同类同步任务在运行' : '同步任务已启动', '', 3600); await app.refreshStatus(); }
    catch (ex) { toast('启动失败：' + ex.message, 'err', 4000); }
  });
  // 同步策略表单同样记录未保存状态：离开或刷新本页前提示
  $('#syncForm', el).addEventListener('input', () => markDirty($('#syncForm', el)));
  $('#syncForm', el).onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await http('PUT', '/api/admin/settings', { sync: { metaIntervalMin: fd.get('metaIntervalMin'), billIntervalMin: fd.get('billIntervalMin'), backfillMonths: fd.get('backfillMonths'), concurrency: fd.get('concurrency'), perWorkspaceKeys: fd.get('perWorkspaceKeys') === 'on' } });
      markClean(e.target); toast('同步策略已保存'); await refresh(el, () => sync(el));
    } catch (ex) { toast('保存失败：' + ex.message, 'err', 4000); }
  };
}
/** 同步触发来源 */
const trigLabel = t => { t = String(t || ''); return t.startsWith('manual:') ? `手动 · ${t.slice(7)}` : { schedule: '定时', 'key-changed': '更换密钥后', 'ak-changed': '更换密钥后', startup: '服务启动', retry: '失败重试' }[t] || t; };
function runSummary(r) {
  if (r.status === 'error') return r.error || '';
  try {
    const d = JSON.parse(r.detail || 'null');
    if (!d) return r.error || '';
    if (r.kind === 'meta') return `业务空间 ${d.workspaces} · API Key ${d.apiKeys} · 变更 ${d.changes}${r.error ? ' · ' + r.error : ''}`;
    return (d.cycles || []).map(c => (c.demo ? `${c.cycle} 演示数据` : c.skipped ? `${c.cycle} 跳过` : c.failed ? `${c.cycle} 失败` : c.lines != null ? `${c.cycle}：${c.lines} 行 · 分摊 ¥${Number(c.allocated || 0).toFixed(2)}${c.estimated ? ' · 估算' : ''}${c.final ? ' · 终版' : ''}` : `${c.cycle}：月 ${c.monthly} / 日 ${c.daily} 条${c.final ? ' · 终版' : ''}`)).join('；') + (d.calls ? (d.calls.error ? '；调用次数同步失败' : `；调用次数 ${Number(d.calls.requests || 0).toLocaleString()} 次`) : '') + (r.error ? ' · ' + r.error : '');
  } catch { return r.error || ''; }
}

/* ---------------- 预算管理 ---------------- */
async function budgets(el) {
  /*
   * 必须等账单与 Key 数据加载完成后再渲染：直接打开 / 刷新本页时，数据请求可能晚于本页返回，
   * 此时 Key 列表为空、预算为默认值，若直接保存会覆盖掉已保存的全部预算。预算本身从服务端重新读取（最新值）。
   */
  const [{ alerts: al }, bd] = await Promise.all([http('GET', '/api/admin/settings'), http('GET', '/api/admin/budgets'), app.whenData()]);
  if (!state.data) throw new Error('账单与 API Key 数据尚未加载成功。为避免覆盖已保存的预算，请刷新页面后再编辑。');
  const b = bd.budgets;
  state.budgets = { monthly: null, alertPct: 80, keys: {}, ...b };
  const lastCycle = bd.lastCycle;
  // 上月费用由服务端按账期账单汇总，与页面当前选择的统计周期无关
  const lastMonth = new Map(Object.entries(bd.lastMonth || {}));
  const keys = [...state.apiKeys.values()].filter(k => k.source !== 'deleted' || b.keys?.[k.apiKeyId] != null);
  const rows = keys.map(k => ({ id: k.apiKeyId, provider: k.provider || 'aliyun', desc: keyShort(k.apiKeyId), wsKey: k.wsKey || NO_WS, ws: wsName(k.wsKey), cc: k.costCenter || '', owner: k.owner || '', last: lastMonth.get(k.apiKeyId) || 0, c30: state.keyActivity.get(k.apiKeyId)?.c30 || 0, budget: b.keys?.[k.apiKeyId] ?? '' }));
  // 已设置预算、但当前数据中没有的 Key（如只在账单中出现过、本期无账单）：保留为一行，避免保存时被静默删除
  const shown = new Set(rows.map(r => r.id));
  for (const [id, v] of Object.entries(b.keys || {})) {
    if (shown.has(id)) continue;
    rows.push({ id, provider: state.apiKeys.get(id)?.provider || 'aliyun', desc: keyShort(id), wsKey: NO_WS, ws: id === NONE_KEY ? '—' : wsName(''), cc: '', owner: '', last: lastMonth.get(id) || 0, c30: state.keyActivity.get(id)?.c30 || 0, budget: v });
  }
  // 联动筛选：业务空间 / 成本中心 / 云厂商 / 关键字，选项随其余条件收窄；批量操作只作用于筛选出的 Key
  const bf = { ws: '', cc: '', provider: '', q: '' };
  const tagged = rows.some(r => r.cc || r.owner), multi = new Set(rows.map(r => r.provider)).size > 1;
  const match = (r, skip) => (skip === 'ws' || !bf.ws || r.wsKey === bf.ws) && (skip === 'cc' || !bf.cc || (bf.cc === NO_CC ? !r.cc : r.cc === bf.cc))
    && (skip === 'provider' || !bf.provider || r.provider === bf.provider) && (!bf.q || `${r.id} ${r.desc} ${r.ws} ${r.cc} ${r.owner}`.toLowerCase().includes(bf.q.toLowerCase()));
  const visible = () => rows.filter(r => match(r));
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
      <div class="actions"><button class="btn sm" id="fill" title="为当前列表中未设置预算的 Key 按上月费用 × 1.2 填入建议值（取整到元）">按上月 ×1.2 填充空白</button><button class="btn sm" id="clear" title="清空当前列表中 Key 的预算输入">清空</button><button class="btn sm primary" id="saveB">保存</button></div></div>
      <div class="row bud-tools" id="bTools"></div>
      <div id="bTbl"></div><div class="panel-foot" id="bDirty"></div></section></div>`;
  const bt = table('budgets', $('#bTbl', el), {
    sort: 'last', pageSize: 0, maxHeight: '60vh', caption: 'API Key 预算', empty: '没有符合条件的 API Key',
    columns: [
      { key: 'desc', label: 'API Key', fmt: (x, r) => `<b style="font-weight:600">${esc(x)}</b>${provTag(r.provider)}<span class="sub mono">${esc(r.id)}</span>` },
      { key: 'ws', label: '业务空间' },
      ...(tagged ? [{ key: 'cc', label: '成本中心', fmt: (x, r) => (x ? esc(x) : '<span class="muted">未分配</span>') + (r.owner ? `<span class="sub">负责人 ${esc(r.owner)}</span>` : '') }] : []),
      { key: 'last', label: `上月（${lastCycle}）`, align: 'r', fmt: x => money(x) },
      { key: 'c30', label: '近 30 天', align: 'r', fmt: x => money(x) },
      { key: 'budget', label: '月度预算（元）', sortable: false, fmt: (x, r) => `<input class="inp sm" type="number" min="0" step="0.01" data-bk="${esc(r.id)}" value="${esc(x)}" placeholder="不设置" style="width:130px" aria-label="${esc(r.desc)} 月度预算">` },
    ],
  });
  const tools = () => {
    const opts = (skip, valOf, labelOf, cur) => {
      const m = new Map();
      rows.filter(r => match(r, skip)).forEach(r => { const v = valOf(r); m.set(v, (m.get(v) || 0) + 1); });
      if (cur && !m.has(cur)) m.set(cur, 0);
      return [...m.entries()].map(([v, n]) => [v, `${labelOf(v)} · ${n} 个`]).sort((a, c) => a[1].localeCompare(c[1], 'zh-CN')).map(([v, l]) => opt(v, l, cur)).join('');
    };
    const vis = visible();
    $('#bTools', el).innerHTML = `
      <select class="inp sm ${bf.ws ? 'active' : ''}" data-bf="ws" aria-label="按业务空间筛选">${opt('', '全部业务空间', bf.ws)}${opts('ws', r => r.wsKey, v => (v === NO_WS ? '（未归属业务空间）' : wsName(v)), bf.ws)}</select>
      ${tagged ? `<select class="inp sm ${bf.cc ? 'active' : ''}" data-bf="cc" aria-label="按成本中心筛选">${opt('', '全部成本中心', bf.cc)}${opts('cc', r => r.cc || NO_CC, v => (v === NO_CC ? '（未分配成本中心）' : v), bf.cc)}</select>` : ''}
      ${multi ? `<select class="inp sm ${bf.provider ? 'active' : ''}" data-bf="provider" aria-label="按云厂商筛选">${opt('', '全部云厂商', bf.provider)}${opts('provider', r => r.provider, v => PROVIDERS[v] || v, bf.provider)}</select>` : ''}
      <input class="inp sm" type="search" data-bf="q" value="${esc(bf.q)}" placeholder="搜索 Key / 描述" aria-label="搜索 API Key" style="width:160px">
      <span class="sp"></span>
      <span class="muted" style="font-size:12px">显示 ${vis.length} / ${rows.length} 个</span>
      <input class="inp sm" type="number" min="0" step="0.01" id="bBulk" placeholder="统一预算（元）" aria-label="为当前列表的 Key 统一设置预算" style="width:130px">
      <button class="btn sm" id="bBulkApply" ${vis.length ? '' : 'disabled'} title="把输入的预算填入当前列表中的全部 Key（保存后生效）">应用到这 ${vis.length} 个 Key</button>`;
    bt.setRows(vis);
  };
  tools();
  $('#bTools', el).addEventListener('change', e => { const s = e.target.closest('select[data-bf]'); if (!s) return; bf[s.dataset.bf] = s.value; tools(); el.querySelector(`[data-bf="${s.dataset.bf}"]`)?.focus(); });
  let bq;
  $('#bTools', el).addEventListener('input', e => { const i = e.target.closest('input[data-bf="q"]'); if (!i) return; clearTimeout(bq); bq = setTimeout(() => { bf.q = i.value.trim(); const pos = i.selectionStart; tools(); const n = el.querySelector('[data-bf="q"]'); n?.focus(); n?.setSelectionRange(pos, pos); }, 250); });
  $('#bTools', el).addEventListener('click', e => {
    if (!e.target.closest('#bBulkApply')) return;
    const val = $('#bBulk', el).value.trim();
    if (val !== '' && !(Number(val) >= 0)) { toast('请输入有效的预算金额', 'err'); return; }
    const vis = visible();
    if (!vis.length) return;
    if (val === '' && !confirm(`清空当前列表中 ${vis.length} 个 Key 的预算输入？保存后生效。`)) return;
    vis.forEach(r => { r.budget = val === '' ? '' : Number(val); });
    syncInputs(); markDirty();
    toast(val === '' ? `已清空 ${vis.length} 个 Key 的预算输入，确认后请保存` : `已为 ${vis.length} 个 Key 填入预算 ${money(Number(val))}，确认后请保存`);
  });
  // 输入值实时写回行数据：排序重绘表格时不会丢失尚未保存的输入
  const markDirty = () => { app.dirty = true; $('#bDirty', el).innerHTML = '<span class="warn-text">有未保存的修改</span> · 按 Enter 或点击“保存”生效'; };
  const syncInputs = () => el.querySelectorAll('[data-bk]').forEach(i => { const r = rows.find(x => x.id === i.dataset.bk); if (r) i.value = r.budget; });
  $('#bTbl', el).addEventListener('input', e => { const i = e.target.closest('[data-bk]'); if (!i) return; const r = rows.find(x => x.id === i.dataset.bk); if (r) r.budget = i.value; markDirty(); });
  $('#bForm', el).addEventListener('input', markDirty);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-bk]')) { e.preventDefault(); $('#bForm', el).requestSubmit(); } });
  $('#fill', el).onclick = () => { let n = 0; visible().forEach(r => { if (r.budget === '' && r.last > 0) { r.budget = Math.ceil(r.last * 1.2); n++; } }); syncInputs(); if (n) { markDirty(); toast(`已为 ${n} 个 Key 填入建议预算，确认后请保存`); } else toast('没有可填充的空白项（上月无费用或已设置）'); };
  $('#clear', el).onclick = () => { const vis = visible(); if (!vis.some(r => r.budget !== '')) return; if (!confirm(`清空${vis.length < rows.length ? `当前列表中 ${vis.length} 个` : '所有'} API Key 的预算输入？保存后生效。`)) return; vis.forEach(r => { r.budget = ''; }); syncInputs(); markDirty(); };
  $('#saveB', el).onclick = () => $('#bForm', el).requestSubmit();
  $('#bForm', el).onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const keysB = {};
    rows.forEach(r => { if (r.budget !== '' && r.budget != null) keysB[r.id] = r.budget; });
    if (Object.keys(keysB).length > 2000) return toast(`最多为 2000 个 Key 设置预算（当前 ${Object.keys(keysB).length} 个），请缩小批量设置的范围`, 'err', 5000);
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
  email: '邮件会在消息内容之后附上完整的成本概览（日报为昨日所在账期、周报为上周、月报为上月、告警为本月）。需先在下方“邮件服务器（SMTP）”中配置发信服务器。',
  wecom: '企业微信群 → 添加群机器人，复制 Webhook 地址。企业微信机器人不支持加签，地址即凭据，请妥善保管；@ 提醒会额外发送一条文本消息。',
  generic: '以 POST JSON 发送 {event, title, level, items, text, link, mentions, sentAt}。填写密钥后附带 X-Alert-Timestamp 与 X-Alert-Signature 请求头（HMAC-SHA256，签名内容为 timestamp + "." + body）。',
};
const RULE_LABEL = { pct: '达到预警阈值', over: '超出预算', forecast: '预计月末超出总预算', keys: '包含 API Key 预算' };
const EVENT_ICON = { budget: 'wallet', anomaly: 'warn', sync: 'sync', keyChange: 'key', daily: 'calendar', weekly: 'calendar', monthly: 'calendar' };
/** 飞书实际使用的卡片样式（机器人不接受图表 / 卡片组件时自动降级） */
const STYLE_NOTE = { chart: '（飞书完整卡片：指标 + 趋势图 + 排行）', card: '（飞书卡片：该机器人不支持趋势图，已自动省略）', plain: '（飞书简洁卡片：该机器人不支持新版卡片组件）' };
/** 报表预览：按飞书卡片的布局展示（指标面板 / 趋势柱状图 / 排行表 / 异常条目） */
function cardPreview(r) {
  const d = r.doc, TONE = { bad: 'bad', warn: 'warn', good: 'good', up: 'bad', down: 'good' }, TXT = { bad: 'bad-text', warn: 'warn-text', good: 'ok-text', up: 'bad-text', down: 'ok-text' };
  const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // 用量（neutral）的涨跌不代表好坏：用主题色显示
  const delta = x => (x ? `<span class="muted">${esc(x.label)}</span> <span class="${x.neutral ? (x.dir ? 'acc-text' : 'muted') : TXT[x.dir] || 'muted'}">${x.dir === 'up' ? '↑ ' : x.dir === 'down' ? '↓ ' : ''}${esc(x.dir ? String(x.text).replace(/^[+−-]/, '') : x.text)}</span>` : '');
  const tags = (d.tags || []).filter(Boolean).map(t => `<span class="pill ${TONE[t.level] || 'info'}">${esc(t.text)}</span>`).join('');
  const panel = list => (list?.length ? `<div class="fc-kpis">${list.map(k => `<div><span>${esc(k.label)}</span><b class="${TXT[k.tone] || ''}">${esc(k.value)}</b><small>${k.delta ? delta(k.delta) : esc(k.sub || '')}</small></div>`).join('')}</div>` : '');
  const chart = c => {
    if (!c?.values?.length) return '';
    const max = Math.max(1e-9, ...c.values.map(v => v.v)), unit = /Token/.test(c.title) ? ' 万 Token' : ' 元';
    return `<div class="fc-sec">${esc(c.title)}</div><div class="fc-chart" role="img" aria-label="${esc(c.title)}">${c.values.map(v => `<i style="height:${Math.max(2, v.v / max * 100).toFixed(1)}%;background:${esc(c.colors?.[v.k] || '#3370FF')}" title="${esc(v.d)} · ${esc(v.v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }))}${unit}"></i>`).join('')}</div>`;
  };
  const secs = (d.sections || []).filter(s => s.rows?.length || s.items?.length).map(s => `<div class="fc-sec">${esc(s.title)}</div>${s.rows?.length ? `<div class="fc-rows">${s.rows.map((x, i) => `<div><em>${i + 1}</em><span>${esc(x.name)}</span><b>${esc(x.value)}</b><small>${esc(x.share || '')}</small></div>`).join('')}</div>` : s.items.map(i => `<div class="fc-item"><span class="pill ${TONE[i.level] || 'info'}">${esc(i.tag || '提示')}</span> ${md(i.text)}</div>`).join('')}`).join('');
  return `<div class="fc"><div class="fc-h"><div><b>${esc(r.title)}</b>${tags}</div>${r.empty ? '<span class="pill neutral">无费用，定时发送时将跳过</span>' : ''}</div>
    <div class="fc-b">${panel(d.kpis)}${panel(d.usage)}${(d.notes || []).map(n => `<div class="fc-note">${esc(n)}</div>`).join('')}${chart(d.chart)}${chart(d.tokenChart)}${secs}</div>
    <div class="fc-f muted">飞书卡片预览 · 钉钉 / 企业微信 / 邮件为文本消息，内容相同</div></div>`;
}

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
          <div class="ch-top"><span class="ch-ico">${icon(c.type === 'email' ? 'mail' : 'bell')}</span><div class="ch-t"><b>${esc(c.name)}</b><span class="muted">${esc(al.types[c.type]?.label || c.type)} · <span class="mono">${esc(c.webhookMasked || '未配置地址')}</span>${c.secretSet ? ' · 已加签' : ''}</span></div>
            <span class="state ${c.enabled ? 'on' : 'off'}">${c.enabled ? '已启用' : '已停用'}</span></div>
          <div class="ch-evs">${c.scopeLabel ? `<span class="tag info">${icon('filter')}范围：${esc(c.scopeLabel)}</span>` : ''}${Object.keys(evs).filter(k => c.events[k]).map(k => `<span class="tag">${icon(EVENT_ICON[k] || 'bell')}${esc(evs[k].label)}</span>`).join('') || '<span class="muted">未订阅任何事件</span>'}${c.share ? `<span class="tag info">${icon('link')}附交互报表链接</span>` : ''}${c.atAll || c.atMobiles.length ? `<span class="tag warn">@ ${c.atAll ? '所有人' : ''}${c.atAll && c.atMobiles.length ? ' + ' : ''}${c.atMobiles.length ? c.atMobiles.length + ' 人' : ''}</span>` : ''}</div>
          ${Object.keys(c.nextRuns || {}).length ? `<div class="ch-next">${icon('clock')}<span>下次报表：${Object.entries(c.nextRuns).map(([k, v]) => `${esc(evs[k]?.label.replace(/（.*）/, '') || k)} <b>${esc(v)}</b>`).join('<i>·</i>')}</span></div>` : ''}
          <div class="ch-foot"><span class="${c.lastError && (!c.lastSentAt || c.lastErrorAt > c.lastSentAt) ? 'bad-text' : 'muted'}">${c.lastError && (!c.lastSentAt || c.lastErrorAt > c.lastSentAt) ? `${esc(fmtTime(c.lastErrorAt))} 发送失败：${esc(c.lastError)}` : c.lastSentAt ? `最近发送 ${esc(fmtTime(c.lastSentAt))}` : '尚未发送'}</span>
            <span class="sp"></span><button class="btn sm" data-ch-test="${esc(c.id)}">${icon('send')}测试</button><button class="btn sm" data-ch-edit="${esc(c.id)}">${icon('edit')}编辑</button><button class="btn sm danger" data-ch-del="${esc(c.id)}">${icon('trash')}删除</button></div>
        </div>`).join('')}</div>` : `<div class="empty-mini">${icon('bell')}<div><b>尚未配置通知渠道</b><span class="muted">添加钉钉、飞书、企业微信群机器人、通用 Webhook 或邮件，接收预算告警、费用异常、同步故障与日报 / 周报 / 月报；邮件会附上完整的成本概览。</span></div></div>`}
    </section>
    <section class="panel c4"><div class="panel-h"><h3>告警规则</h3>${help('预算告警：同一阈值（含预算金额）每个账期每个渠道只通知一次。费用异常：每天报表时间之后检查“昨日费用 ≥ 前 7 日日均 × 倍数，且增量 ≥ 最小金额”。同步故障：同一云厂商同类同步连续失败 3 次时告警，恢复后通知。')}</div>
      <form id="rForm" class="form-grid" style="grid-template-columns:1fr 1fr">
        <div class="field full"><span>预算告警条件</span><div class="row" style="gap:6px 16px">${Object.entries(RULE_LABEL).map(([k, l]) => `<label class="chk"><input type="checkbox" name="rule_${k}" ${al.rules[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
        <label class="field" title="按原价（目录价）判断，不受优惠券 / 折扣集中抵扣的影响"><span>异常倍数（×前 7 日原价日均）</span><input class="inp" type="number" name="ratio" min="1.2" max="20" step="0.1" value="${al.anomaly.ratio}"></label>
        <label class="field" title="昨日原价比前 7 日原价日均至少多出的金额"><span>异常最小增量（元，按原价）</span><input class="inp" type="number" name="minAmount" min="0" step="1" value="${al.anomaly.minAmount}"></label>
        <label class="chk full"><input type="checkbox" name="anomalyKeys" ${al.anomaly.keys ? 'checked' : ''}> 同时检测单个 API Key 的费用异常（最多列出 5 个）</label>
        <label class="field" title="渠道开启“附带交互报表链接”时，每条消息生成的只读链接的有效期"><span>交互报表链接有效期（天）</span><input class="inp" type="number" name="shareDays" min="1" max="90" step="1" value="${al.shareDays}"></label>
        <div class="field"><span>&nbsp;</span><small class="hint" style="margin-top:8px">${al.shareAvailable ? '到期后链接自动失效，可在下方“只读分享链接”中提前撤销' : '需设置 PUBLIC_URL 后才能附带链接'}</small></div>
        <label class="field full"><span>报表与异常检查时间</span><select class="inp" name="reportHour">${Array.from({ length: 24 }, (_, h) => opt(h, `每天 ${p2(h)}:00 之后`, al.reportHour)).join('')}</select><small class="hint">账单通常延迟数小时入账，建议 9:00 之后发送，数据更完整</small></label>
        <div class="row full"><button class="btn primary" type="submit">保存规则</button></div>
      </form></section>
    <section class="panel c12" id="smtpBox"><div class="panel-h"><h3>邮件服务器（SMTP）</h3>${help('邮件通知渠道使用此服务器发信。密码（或邮箱授权码）使用 AES-256-GCM 加密保存、不回显；修改密码或服务器地址需要当前登录密码确认。连接前会拒绝解析到内网的服务器地址（内网邮件中继请设置 ALERT_ALLOW_PRIVATE=true）。')}
      <span class="sub">${al.smtp.host ? `${esc(al.smtp.host)}:${al.smtp.port} · ${esc(al.smtp.securities[al.smtp.security] || al.smtp.security)}${al.smtp.passwordSet ? ' · 密码已加密保存' : ''}` : '尚未配置：配置后可添加“邮件”通知渠道'}</span></div>
      <form id="smtpForm" class="form-grid" autocomplete="off">
        <label class="field"><span>SMTP 服务器</span><input class="inp mono" name="host" maxlength="253" value="${esc(al.smtp.host)}" placeholder="smtp.qq.com / smtp.exmail.qq.com / smtpdm.aliyun.com"></label>
        <label class="field"><span>加密方式</span><select class="inp" name="security">${Object.entries(al.smtp.securities).map(([k, l]) => opt(k, l, al.smtp.security)).join('')}</select></label>
        <label class="field"><span>端口</span><input class="inp" type="number" name="port" min="1" max="65535" value="${esc(al.smtp.port)}"></label>
        <label class="field"><span>用户名（通常为邮箱地址）</span><input class="inp mono" name="username" maxlength="254" value="${esc(al.smtp.username)}" autocomplete="off"></label>
        <label class="field"><span>密码 / 授权码</span><input class="inp mono" type="password" name="password" maxlength="512" autocomplete="new-password" placeholder="${al.smtp.passwordSet ? '已加密保存，留空表示不修改' : 'QQ / 163 等邮箱请使用授权码'}"></label>
        <label class="field"><span>发件人邮箱</span><input class="inp mono" name="fromAddr" maxlength="254" value="${esc(al.smtp.fromAddr)}" placeholder="留空则使用用户名"></label>
        <label class="field"><span>发件人名称</span><input class="inp" name="fromName" maxlength="40" value="${esc(al.smtp.fromName)}" placeholder="如：大模型费用分析"></label>
        <label class="field"><span>当前登录密码</span><input class="inp" type="password" name="confirmPassword" autocomplete="current-password" maxlength="256"><small class="hint">修改密码或服务器地址时需要</small></label>
        ${al.smtp.passwordSet ? '<label class="chk"><input type="checkbox" name="clearPassword"> 清除已保存的密码</label>' : ''}
        <div class="row full"><button class="btn primary" type="submit">保存邮件服务器</button><span class="sp"></span><input class="inp" name="testTo" type="email" placeholder="测试收件人邮箱" style="width:240px" aria-label="测试收件人邮箱"><button class="btn" type="button" data-smtp-test>${icon('mail')}发送测试邮件（含成本概览）</button></div>
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
    </section>
    <section class="panel c12" id="shareBox"><div class="panel-h"><h3>只读分享链接</h3>${help('收件人无需账号即可在浏览器（飞书中在飞书内）查看限定周期与范围的交互式成本概览：可悬停查看明细、切换页面、按 Key / 模型筛选与下钻，但不能修改任何配置。链接只出现在消息中，系统只保存其摘要；到期自动失效，撤销后已打开的页面也立即失效。访问记录在“操作日志”中（用户为“分享链接”）。')}<span class="sub" data-share-sub></span>
      <div class="actions"><button class="btn sm danger" data-share-revoke-all>${icon('trash')}撤销全部有效链接</button></div></div>
      <div data-share-body><div class="nodata">加载中…</div></div></section></div>`;

  const payload = (channels, extra = {}) => ({
    channels: channels.map(c => ({ id: c.id, name: c.name, type: c.type, enabled: c.enabled, events: c.events, atAll: c.atAll, atMobiles: c.atMobiles, scope: c.scope, share: !!c.share, ...(c.webhook ? { webhook: c.webhook } : {}), ...(c.secret ? { secret: c.secret } : {}), ...(c.clearSecret ? { clearSecret: true } : {}) })),
    rules: al.rules, anomaly: al.anomaly, reportHour: al.reportHour, shareDays: al.shareDays, ...extra,
  });
  const save = async (channels, extra, okMsg) => {
    // 保存渠道会重绘本页：告警规则表单有未保存的修改时先确认，避免被静默丢弃
    const rf = $('#rForm', el);
    if (!extra.rules && rf?.dataset.dirty && !confirm('告警规则有未保存的修改，继续将丢弃这些修改。是否继续？')) return;
    const out = await http('PUT', '/api/admin/alerts', payload(channels, extra));
    if (rf) markClean(rf);
    // 保存只保存、不推送：新订阅当前已到点的报表与已满足的告警条件不补发，之后按时间 / 条件推送
    toast(out.armed ? `${okMsg}。不会立即推送：报表从下一次发送时间开始，告警在出现新的条件时发送` : okMsg, '', 5000);
    await refresh(el, () => alerts(el));
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
    try { const r = await http('POST', '/api/admin/alerts/test', { channelId: c.id, type: c.type, atAll: c.atAll, atMobiles: c.atMobiles }); toast(`测试消息已发送到「${c.name}」${STYLE_NOTE[r.style] || ''}，请在群中查看`, '', 5000); }
    catch (ex) { toast(ex.message, 'err', 5000); } finally { b.disabled = false; }
  });
  $('#rForm', el).addEventListener('input', () => markDirty($('#rForm', el)));
  $('#rForm', el).onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const extra = {
      rules: Object.fromEntries(Object.keys(RULE_LABEL).map(k => [k, fd.get('rule_' + k) === 'on'])),
      anomaly: { ratio: Number(fd.get('ratio')), minAmount: Number(fd.get('minAmount')), keys: fd.get('anomalyKeys') === 'on' },
      reportHour: Number(fd.get('reportHour')),
      shareDays: Number(fd.get('shareDays')),
    };
    try { markClean(e.target); await save(al.channels, extra, '告警规则已保存'); } catch (ex) { markDirty(e.target); toast('保存失败：' + ex.message, 'err', 4000); }
  };
  // 报表预览
  let kind = 'daily', seq = 0;
  // 请求序号：先点“月报”再点“日报”时，较慢返回的月报不能覆盖当前选中的日报预览
  const preview = async (send = false) => {
    const box = $('#rPrev', el), my = ++seq, k = kind;
    if (!send) box.innerHTML = '<div class="nodata">加载中…</div>';
    try {
      const r = await http('POST', '/api/admin/alerts/report', { kind: k, send, channelId: send ? $('#rCh', el).value : undefined });
      if (my !== seq || k !== kind) { if (send) toast('报表已发送'); return; }
      box.innerHTML = r.doc ? cardPreview(r) : `<div class="rp-t">${esc(r.title)}${r.empty ? ' <span class="pill neutral">无费用，定时发送时将跳过</span>' : ''}</div>${r.lines.map(l => (l === '' ? '<div class="rp-gap"></div>' : l.startsWith('#') ? `<div class="rp-h">${esc(l.replace(/^#+\s*/, ''))}</div>` : `<div class="rp-l">${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</div>`)).join('')}`;
      if (send) toast(`报表已发送${STYLE_NOTE[r.style] || ''}`, '', 4500);
    } catch (ex) { if (send) toast(ex.message, 'err', 5000); else if (my === seq) box.innerHTML = `<div class="bad-text">${esc(ex.message)}</div>`; }
  };
  el.querySelectorAll('[data-rk]').forEach(b => b.onclick = () => { kind = b.dataset.rk; el.querySelectorAll('[data-rk]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); preview(); });
  // 事件分发结束后 e.currentTarget 会变为 null：按钮必须在 await 之前取得
  $('#rSend', el).onclick = async e => { const btn = e.currentTarget; btn.disabled = true; try { await preview(true); } finally { btn.disabled = false; } };
  preview();
  bindSmtp(el, al, () => refresh(el, () => alerts(el)));
  bindShares(el);
}

/** 只读分享链接：生成（全部范围）、列表、撤销 */
async function bindShares(el) {
  const box = $('#shareBox', el);
  if (!box) return;
  const body = $('[data-share-body]', box), sub = $('[data-share-sub]', box);
  const ST = { active: ['有效', 'good'], expired: ['已过期', 'neutral'], revoked: ['已撤销', 'bad'] };
  const load = async () => {
    let r;
    try { r = await http('GET', '/api/admin/shares'); } catch (ex) { body.innerHTML = `<div class="bad-text">${esc(ex.message)}</div>`; return; }
    if (!box.isConnected) return;
    sub.textContent = `有效 ${r.stats.active || 0} 个 · 累计 ${r.stats.total || 0} 个 · 访问 ${r.stats.views || 0} 次`;
    const cur = (state.today || '').slice(0, 7), months = Array.from({ length: 12 }, (_, i) => addMonths(cur, -i));
    body.innerHTML = `${r.available ? `<form class="row share-new" data-share-new style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <select class="inp sm" name="cycle" aria-label="账期">${months.map((m, i) => opt(m, i === 0 ? `本月（${m}）` : i === 1 ? `上月（${m}）` : m, cur)).join('')}</select>
        <input class="inp sm" name="title" maxlength="60" placeholder="标题（可选，如：10 月费用汇报）" style="width:240px">
        <label class="row" style="gap:6px"><span class="muted">有效期</span><input class="inp sm" type="number" name="days" min="${r.limits.min}" max="${r.limits.max}" value="${r.days}" style="width:70px"><span class="muted">天</span></label>
        <button class="btn sm primary" type="submit">${icon('link')}生成分享链接（全部范围）</button><span class="hint">按渠道范围的链接会随报表 / 告警消息自动生成</span></form><div data-share-out></div>`
      : '<div class="notice warn" style="margin-bottom:12px">' + icon('warn') + '<div><b>尚未设置 PUBLIC_URL</b><span class="why">请在环境变量中设置系统对外访问地址（如 https://cost.example.com），才能生成分享链接与消息中的“查看交互报表”。</span></div></div>'}
      ${r.links.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>标题</th><th>周期</th><th>范围</th><th>来源</th><th>创建</th><th>有效期至</th><th>访问</th><th>最近访问</th><th>状态</th><th></th></tr></thead><tbody>${r.links.map(l => `<tr>
        <td class="wide-cell">${esc(l.title)}</td><td class="nowrap">${esc(l.periodLabel)}</td><td>${esc(l.scopeLabel)}</td><td>${esc(l.channel || (l.createdBy === 'system' ? '系统' : l.createdBy))}</td>
        <td class="nowrap">${esc(fmtTime(l.createdAt))}</td><td class="nowrap">${esc(fmtTime(l.expiresAt))}</td><td class="num">${l.views}</td>
        <td class="nowrap">${l.lastViewAt ? `${esc(fmtTime(l.lastViewAt))}<div class="muted">${esc(l.lastViewIp)}${l.lastViewLoc ? ' · ' + esc(l.lastViewLoc) : ''}</div>` : '<span class="muted">—</span>'}</td>
        <td><span class="pill ${ST[l.status][1]}">${ST[l.status][0]}</span>${l.revokedBy ? `<div class="muted">${esc(l.revokedBy)}</div>` : ''}</td>
        <td>${l.status === 'active' ? `<button class="btn sm" data-share-revoke="${esc(l.id)}">撤销</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint" style="margin:0">暂无分享链接</p>'}`;
    const form = $('[data-share-new]', body);
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(form), btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const x = await http('POST', '/api/admin/shares', { mode: 'month', cycle: fd.get('cycle'), title: fd.get('title'), days: Number(fd.get('days')) });
        await load();
        const out = $('[data-share-out]', body);
        if (out) out.innerHTML = `<div class="notice info" style="margin-bottom:12px">${icon('check')}<div><b>已生成：${esc(x.title)}</b><span class="why">链接只显示这一次，请复制后发送；有效期至 ${esc(fmtTime(x.expiresAt))}。</span><div class="row" style="gap:8px;margin-top:6px"><input class="inp sm mono" readonly value="${esc(x.url)}" style="flex:1;min-width:260px" data-share-url><button type="button" class="btn sm" data-share-copy>${icon('copy')}复制</button></div></div></div>`;
        const inp = $('[data-share-url]', body);
        $('[data-share-copy]', body).onclick = async () => { try { await navigator.clipboard.writeText(inp.value); toast('已复制分享链接'); } catch { inp.select(); toast('请按 Ctrl+C 复制', '', 3000); } };
      } catch (ex) { toast(ex.message, 'err', 5000); } finally { btn.disabled = false; }
    };
    body.querySelectorAll('[data-share-revoke]').forEach(b => b.onclick = async () => {
      if (!confirm('撤销该分享链接？撤销后已打开的页面也将无法继续查看，且不能恢复。')) return;
      try { await http('POST', '/api/admin/shares/revoke', { id: b.dataset.shareRevoke }); toast('已撤销'); await load(); } catch (ex) { toast(ex.message, 'err', 5000); }
    });
  };
  $('[data-share-revoke-all]', box).onclick = async () => {
    if (!confirm('撤销全部有效的分享链接？已发送的消息中的“查看交互报表”将全部失效，且不能恢复。')) return;
    try { const x = await http('POST', '/api/admin/shares/revoke', { all: true }); toast(`已撤销 ${x.revoked} 个链接`); await load(); } catch (ex) { toast(ex.message, 'err', 5000); }
  };
  await load();
}

/** 邮件服务器（SMTP）表单：保存（敏感修改需当前登录密码）与发送测试邮件 */
function bindSmtp(el, al, reload) {
  const form = $('#smtpForm', el);
  if (!form) return;
  const sec = form.elements.security, port = form.elements.port;
  sec.addEventListener('change', () => { if (!port.dataset.touched) port.value = sec.value === 'ssl' ? 465 : sec.value === 'starttls' ? 587 : 25; });
  port.addEventListener('input', () => { port.dataset.touched = '1'; });
  form.addEventListener('input', e => { if (e.target.name !== 'testTo') markDirty(form); });
  form.onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      await http('PUT', '/api/admin/smtp', { host: fd.host, port: fd.port, security: fd.security, username: fd.username, password: fd.password || '', clearPassword: fd.clearPassword === 'on', fromAddr: fd.fromAddr, fromName: fd.fromName, confirmPassword: fd.confirmPassword || '' });
      markClean(form); toast('邮件服务器已保存'); await reload();
    } catch (ex) { form.elements.confirmPassword.value = ''; toast('保存失败：' + ex.message, 'err', 5000); } finally { btn.disabled = false; }
  };
  $('[data-smtp-test]', form).onclick = async e => {
    const btn = e.currentTarget, to = form.elements.testTo.value.trim();
    if (!to) { form.elements.testTo.focus(); return toast('请填写测试收件人邮箱', 'err'); }
    if (form.dataset.dirty) return toast('请先保存邮件服务器配置，再发送测试邮件', 'err', 4000);
    btn.disabled = true;
    try { await http('POST', '/api/admin/smtp/test', { to }); toast(`测试邮件已发送至 ${to}`, '', 4000); }
    catch (ex) { toast(ex.message, 'err', 6000); } finally { btn.disabled = false; }
  };
}

function editChannel(al, c, onSave) {
  const evs = al.eventTypes, isNew = !c;
  const cur = c || { name: '', type: 'dingtalk', enabled: true, events: { budget: true, anomaly: true, sync: true, keyChange: false, daily: false, weekly: false, monthly: true }, atAll: false, atMobiles: [] };
  const sel = { type: cur.scope?.type || 'all', ids: { key: new Set(cur.scope?.type === 'key' ? cur.scope.ids : []), ws: new Set(cur.scope?.type === 'ws' ? cur.scope.ids : []) } };
  const segScope = `<div class="seg sm" role="group" aria-label="推送范围">${[['all', '全部'], ['ws', '按业务空间'], ['key', '按 API Key']].map(([k, l]) => `<button type="button" data-scope-type="${k}" aria-pressed="${sel.type === k}">${l}</button>`).join('')}</div>`;
  const group = g => Object.entries(evs).filter(([, e]) => e.group === g).map(([k, e]) => `<label class="chk"><input type="checkbox" name="ev_${k}" ${cur.events[k] ? 'checked' : ''}> ${esc(e.label)}</label>`).join('');
  return modal({
    title: isNew ? '添加通知渠道' : `编辑通知渠道 · ${cur.name}`, submit: '保存', wide: true,
    body: `<div class="form-grid">
      <label class="field"><span>名称</span><input class="inp" name="name" maxlength="30" value="${esc(cur.name)}" placeholder="如：财务群、运维群"></label>
      <label class="field"><span>类型</span><select class="inp" name="type">${Object.entries(al.types).map(([k, t]) => opt(k, t.label, cur.type)).join('')}</select></label>
      <label class="field full"><span data-addr-label>Webhook 地址</span><input class="inp mono" name="webhook" spellcheck="false" maxlength="1000" autocomplete="off"></label>
      <label class="field full" data-secret><span>加签密钥（可选）</span><input class="inp mono" name="secret" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" placeholder="${c?.secretSet ? '已加密保存，留空表示不修改' : '未设置'}">${c?.secretSet ? '<label class="chk" style="margin-top:4px"><input type="checkbox" name="clearSecret"> 清除已保存的密钥</label>' : ''}</label>
      <p class="hint full" data-hint style="margin:0"></p>
      <div class="field full"><span>推送范围</span><div class="row" style="gap:8px">${segScope}<input class="inp sm" data-scope-q placeholder="搜索" style="width:180px" aria-label="搜索推送范围"><span class="hint" data-scope-n></span></div>
        <div class="scope-list" data-scope-list></div>
        <small class="hint">限定范围后：成本概览与报表只统计范围内的数据；预算告警只推送范围内 API Key 的预算；费用异常检查范围合计与范围内的 Key；Key 变更只推送范围内的 Key。同步故障为系统事件，不受范围限制。</small></div>
      <div class="field full"><span>订阅告警</span><div class="row" style="gap:6px 16px">${group('告警')}</div></div>
      <div class="field full"><span>订阅报表</span><div class="row" style="gap:6px 16px">${group('报表')}</div></div>
      <div class="field full" data-mention><span>@ 提醒（仅告警消息）</span><div class="row" style="gap:8px 16px;align-items:center"><label class="chk"><input type="checkbox" name="atAll" ${cur.atAll ? 'checked' : ''}> @所有人</label>
        <input class="inp" name="atMobiles" data-mobiles value="${esc(cur.atMobiles.join(','))}" placeholder="@ 手机号，多个用逗号分隔（最多 10 个）" style="flex:1;min-width:220px"></div></div>
      <label class="chk full" title="${al.shareAvailable ? '' : '需先设置 PUBLIC_URL'}"><input type="checkbox" name="share" ${(isNew ? al.shareAvailable : cur.share) ? 'checked' : ''} ${al.shareAvailable ? '' : 'disabled'}> 附带只读交互报表链接（收件人无需登录即可查看该渠道范围内的成本概览，${al.shareDays} 天内有效${al.shareAvailable ? '' : '；需先设置 PUBLIC_URL'}）</label>
      <label class="chk full"><input type="checkbox" name="enabled" ${cur.enabled ? 'checked' : ''}> 启用该渠道</label>
      <div class="row full"><button type="button" class="btn" data-test>${icon('send')}用当前填写内容发送测试</button></div>
    </div>`,
    onOpen: form => {
      const syncUi = () => {
        const t = form.elements.type.value, ty = al.types[t];
        $('[data-hint]', form).textContent = ALERT_HINT[t] || '';
        $('[data-secret]', form).hidden = !ty?.sign;
        $('[data-mobiles]', form).hidden = ty?.mention !== 'mobile';
        $('[data-mention]', form).hidden = !ty?.mention;
        $('[data-addr-label]', form).textContent = ty?.email ? '收件人邮箱（多个用逗号分隔，最多 20 个）' : 'Webhook 地址';
        form.elements.webhook.classList.toggle('mono', !ty?.email);
        form.elements.webhook.placeholder = c?.webhookSet && t === c.type ? c.webhookMasked + '（已加密保存，留空表示不修改）' : ty?.email ? 'ops@example.com, finance@example.com' : ty?.host ? `https://${ty.host}/…` : 'https://…';
      };
      syncUi();
      form.elements.type.addEventListener('change', syncUi);
      // 推送范围：按业务空间 / API Key 勾选（列表来自当前数据，已选但已不存在的项仍保留）
      const list = $('[data-scope-list]', form), q = $('[data-scope-q]', form), cnt = $('[data-scope-n]', form);
      const options = t => (t === 'ws'
        ? [...state.workspaces.values()].map(w => [w.workspaceId, w.workspaceName || w.workspaceId, w.workspaceId])
        : [...state.apiKeys.values()].filter(k => !k.deletedAt || sel.ids.key.has(k.apiKeyId)).map(k => [k.apiKeyId, keyShort(k.apiKeyId), k.apiKeyId]));
      const drawScope = () => {
        form.querySelectorAll('[data-scope-type]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scopeType === sel.type)));
        const on = sel.type !== 'all';
        list.hidden = q.hidden = !on; cnt.textContent = on ? `已选 ${sel.ids[sel.type].size} 个` : '';
        if (!on) return;
        const kw = q.value.trim().toLowerCase(), chosen = sel.ids[sel.type];
        const opts = options(sel.type);
        if (!opts.length && !state.data) { list.innerHTML = '<div class="hint">数据加载中，请稍后重新打开本窗口</div>'; return; }
        for (const id of chosen) if (!opts.some(o => o[0] === id)) opts.push([id, id + '（已不存在）', id]);
        const shown = opts.filter(o => !kw || (o[1] + ' ' + o[2]).toLowerCase().includes(kw)).sort((a, b) => (chosen.has(b[0]) - chosen.has(a[0])) || a[1].localeCompare(b[1], 'zh-CN'));
        list.innerHTML = shown.length ? shown.map(([id, label, sub]) => `<label class="chk"><input type="checkbox" data-scope-id="${esc(id)}" ${chosen.has(id) ? 'checked' : ''}> <span>${esc(label)}${sub !== label ? ` <span class="muted mono">${esc(sub)}</span>` : ''}</span></label>`).join('') : '<div class="hint">没有匹配的项</div>';
      };
      form.querySelectorAll('[data-scope-type]').forEach(b => b.onclick = () => { sel.type = b.dataset.scopeType; drawScope(); });
      q.oninput = drawScope;
      list.addEventListener('change', e => { const id = e.target.dataset.scopeId; if (id == null) return; if (e.target.checked) sel.ids[sel.type].add(id); else sel.ids[sel.type].delete(id); cnt.textContent = `已选 ${sel.ids[sel.type].size} 个`; });
      drawScope();
      form._scope = () => ({ type: sel.type, ids: sel.type === 'all' ? [] : [...sel.ids[sel.type]] });
      $('[data-test]', form).onclick = async e => {
        const fd = new FormData(form), btn = e.currentTarget;
        btn.disabled = true;
        try { await http('POST', '/api/admin/alerts/test', { channelId: c?.id, type: fd.get('type'), webhook: fd.get('webhook') || '', secret: fd.get('secret') || '', atAll: fd.get('atAll') === 'on', atMobiles: fd.get('atMobiles') || '', scope: form._scope(), share: fd.get('share') === 'on' }); toast('测试消息已发送，请在群中查看'); }
        catch (ex) { toast(ex.message, 'err', 5000); } finally { btn.disabled = false; }
      };
    },
    onSubmit: async form => {
      const fd = new FormData(form);
      const type = fd.get('type'), webhook = String(fd.get('webhook') || '').trim();
      const addr = al.types[type]?.email ? '收件人邮箱' : 'Webhook 地址';
      if (isNew && !webhook) throw new Error(`请填写${addr}`);
      if (!isNew && type !== c.type && !webhook) throw new Error(`更换通知类型时请同时填写对应的${addr}`);
      const ch = {
        id: c?.id, name: String(fd.get('name') || '').trim() || al.types[type].label, type, enabled: fd.get('enabled') === 'on',
        events: Object.fromEntries(Object.keys(evs).map(k => [k, fd.get('ev_' + k) === 'on'])), atAll: fd.get('atAll') === 'on',
        atMobiles: String(fd.get('atMobiles') || '').split(/[,，\s]+/).filter(Boolean), webhook, secret: String(fd.get('secret') || '').trim(), clearSecret: fd.get('clearSecret') === 'on',
        scope: form._scope(), share: fd.get('share') === 'on',
      };
      if (ch.scope.type !== 'all' && !ch.scope.ids.length) throw new Error(`请至少选择一个${ch.scope.type === 'key' ? ' API Key' : '业务空间'}，或将推送范围改为“全部”`);
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
      { key: 'lastActiveAt', label: '最近活动', fmt: x => (x ? `${esc(ago(x))}<span class="sub">${esc(fmtTime(x))}</span>` : '<span class="muted">—</span>'), csv: r => (r.lastActiveAt ? fmtTime(r.lastActiveAt) : '') },
      { key: 'lastLoginAt', label: '最近登录', fmt: (x, r) => (x ? `${fmtTime(x)}<span class="sub">${r.lastLoginIp ? `<span class="mono">${esc(r.lastLoginIp)}</span>${r.lastLoginLoc ? ` · ${esc(r.lastLoginLoc)}` : ''}` : ''}</span>` : '<span class="muted">从未登录</span>'), csv: r => (r.lastLoginAt ? `${fmtTime(r.lastLoginAt)} ${ipText(r.lastLoginIp, r.lastLoginLoc)}` : '') },
      { key: 'sessions', label: '会话', align: 'r' },
      { key: 'ops', label: '操作', sortable: false, fmt: (x, r) => `<div class="row" style="gap:4px;flex-wrap:nowrap">
        <button class="btn sm" data-u="role" data-id="${r.id}" data-v="${r.role === 'admin' ? 'viewer' : 'admin'}">设为${r.role === 'admin' ? '只读' : '管理员'}</button>
        ${r.id === state.me.id ? '' : `<button class="btn sm" data-u="pw" data-id="${r.id}">重置密码</button>`}
        <button class="btn sm" data-u="dis" data-id="${r.id}" data-v="${r.disabled ? 0 : 1}">${r.disabled ? '启用' : '禁用'}</button>
        ${r.locked ? `<button class="btn sm" data-u="unlock" data-id="${r.id}">解锁</button>` : ''}
        <button class="btn sm danger" data-u="del" data-id="${r.id}" data-name="${esc(r.username)}">删除</button></div>` },
    ],
  }).setRows(list);
  $('#uTbl', el).addEventListener('click', async e => {
    const b = e.target.closest('[data-u]'); if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.u === 'role') {
        // 设为管理员属于提权操作，需要再次验证当前登录密码
        let confirmPassword;
        if (b.dataset.v === 'admin') { confirmPassword = await askPassword('设为管理员', '将该用户设为管理员后，其可以修改云厂商密钥、用户与全部系统配置。请输入当前登录密码确认。'); if (!confirmPassword) return; }
        await http('PUT', `/api/admin/users/${id}`, { role: b.dataset.v, confirmPassword });
      }
      else if (b.dataset.u === 'dis') await http('PUT', `/api/admin/users/${id}`, { disabled: b.dataset.v === '1' });
      else if (b.dataset.u === 'unlock') await http('PUT', `/api/admin/users/${id}`, { unlock: true });
      else if (b.dataset.u === 'pw') {
        const pw = genPassword();
        if (!confirm(`将该用户密码重置为：\n\n${pw}\n\n请复制后安全告知用户（首次登录须修改）。确认重置？`)) return;
        const confirmPassword = await askPassword('重置密码', '重置他人密码属于敏感操作，请输入当前登录密码确认。');
        if (!confirmPassword) return;
        await http('PUT', `/api/admin/users/${id}`, { password: pw, confirmPassword });
      } else if (b.dataset.u === 'del') {
        if (!confirm(`确认删除用户「${b.dataset.name}」？此操作不可撤销。`)) return;
        await http('DELETE', `/api/admin/users/${id}`);
      }
      toast('已更新'); await refresh(el, () => users(el));
    } catch (ex) { toast('操作失败：' + ex.message, 'err', 4000); }
  });
  $('#genPw', el).onclick = () => { $('#uForm', el).password.value = genPassword(); };
  $('#uForm', el).onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (fd.role === 'admin') { fd.confirmPassword = await askPassword('创建管理员', '创建管理员账号属于敏感操作，请输入当前登录密码确认。'); if (!fd.confirmPassword) return; }
    try { await http('POST', '/api/admin/users', fd); toast(`已创建用户 ${fd.username}`); await refresh(el, () => users(el)); }
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
const ACCENT_OPTS = [['blue', '蓝', '#2563eb'], ['indigo', '靛蓝', '#4f46e5'], ['violet', '紫', '#7c3aed'], ['teal', '青', '#0f766e'], ['graphite', '石墨', '#334155']];
const fmtSize = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
async function system(el) {
  const s = await http('GET', '/api/admin/settings');
  const b = s.branding, bk = s.backup;
  el.innerHTML = `<div class="bi">
    <section class="panel c5"><div class="panel-h"><h3>品牌设置</h3>${help('用于侧栏、浏览器标题、登录页与告警消息中的产品名称，便于交付给不同团队或客户使用。')}</div>
      <form id="brForm" class="form-grid" style="grid-template-columns:1fr">
        <label class="field"><span>产品名称（≤ 24 字）</span><input class="inp" name="name" maxlength="24" value="${esc(b.name)}" required></label>
        <label class="field"><span>副标题（≤ 48 字，可留空）</span><input class="inp" name="subtitle" maxlength="48" value="${esc(b.subtitle)}"></label>
        <div class="field"><span>界面主题色</span><div class="accent-pick" role="radiogroup" aria-label="界面主题色">${ACCENT_OPTS.map(([k, l, c]) => `<label title="${esc(l)}"><input type="radio" name="accent" value="${k}" ${(b.accent || 'blue') === k ? 'checked' : ''}><i style="background:${c}"></i>${esc(l)}</label>`).join('')}</div>
          <small class="hint">用于按钮、导航、链接与登录页等界面元素，所有用户生效；图表的数据颜色保持不变，各页面颜色含义一致</small></div>
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
  form.addEventListener('input', e => { const k = e.target.name; if (k === 'accent') app.applyAccent(e.target.value); const t = el.querySelector(`[data-bp="${k}"]`); if (t) t.textContent = e.target.value; markDirty(form); });
  form.onsubmit = async e => {
    e.preventDefault();
    try { await http('PUT', '/api/admin/settings', { branding: Object.fromEntries(new FormData(form)) }); markClean(form); toast('品牌设置已保存'); await app.refreshStatus(); app.render(); }
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
  const [s, { audit }, ipd] = await Promise.all([http('GET', '/api/admin/settings'), http('GET', '/api/admin/audit'), http('GET', '/api/admin/ip-check')]);
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
        <div><span>客户端 IP 来源</span><b>${sec.ipSource === 'xff' ? `X-Forwarded-For 右起第 ${sec.proxyHops || 1} 个地址（${sec.proxyHops || 1} 层可信代理）` : sec.ipSource === 'realip' ? 'X-Real-IP' : '直连（使用连接地址）'}${sec.ipSourceFrom === 'ui' ? ' · 页面设置' : ' · 环境变量 TRUST_PROXY'}</b></div>
        <div><span>IP 白名单</span><b class="mono">${esc(sec.allowCidrs.join(', ') || '未启用')}</b></div>
        <div><span>IP 归属地库</span><b>${ipDbText(sec.ipDb)}</b></div>
        <div><span>其他</span><b>CSP · CSRF 令牌 · 防点击劫持 · 请求限流 · 敏感操作二次验证 · 审计日志</b></div>
      </div></section>
    <div id="ipBox"></div>
    <section class="panel"><div class="panel-h"><h3>审计日志</h3><span class="sub">登录、配置变更、预算、标签、告警、备份、用户管理、同步触发等（最近 1000 条）</span><div class="actions"><button class="btn sm" id="csv">${icon('download')}导出</button></div></div><div id="aTbl"></div></section>`;
  ipPanel($('#ipBox', el), ipd, () => refresh(el, () => security(el)));
  const t = table('audit', $('#aTbl', el), {
    sort: 'id', pageSize: 50, stickyFirst: false, caption: '审计日志',
    columns: [
      { key: 'id', label: '时间', fmt: (x, r) => fmtTime(r.ts) + ':' + p2(new Date(r.ts).getSeconds()), csv: r => fmtTime(r.ts) },
      { key: 'username', label: '用户', fmt: x => (x === 'system' ? '<span class="pill neutral">系统</span>' : x.startsWith('?') ? `<span class="muted" title="${esc(`输入的用户名不存在（摘要 ${x.slice(1)}）`)}">不存在的用户</span>` : esc(x)), csv: r => (r.username === 'system' ? '系统' : r.username) },
      { key: 'ip', label: 'IP / 归属地', fmt: (x, r) => (r.username === 'system' && !x ? '<span class="muted">—</span>' : ipHtml(x, r.loc)), csv: r => r.ip },
      { key: 'action', label: '操作', sortVal: r => actLabel(r.action), fmt: x => `<span class="${actBad(x) ? 'bad-text' : ''}" title="${esc(x)}">${esc(actLabel(x))}</span>`, csv: r => actLabel(r.action) },
      { key: 'detail', label: '详情', cls: 'wrap-cell wide-cell', sortable: false, fmt: (x, r) => auditHtml(r.action, x), csv: r => auditText(r.action, r.detail) },
    ],
    csvExtra: [{ label: '归属地', val: r => r.loc || '' }, { label: '操作代码', val: r => r.action }, { label: '原始详情', val: r => r.detail || '' }],
  }).setRows(audit);
  $('#csv', el).onclick = () => t.csv('审计日志.csv');
}

/** IP 归属地离线库状态 */
function ipDbText(db) {
  if (!db) return '-';
  if (!db.v4 && !db.v6) return `<span class="warn-text">未安装</span>，只区分内网 / 公网${db.errors?.length ? `（${esc(db.errors.join('；'))}）` : ''}`;
  const one = (x, v) => (x ? `IPv${v} ${x.builtin ? '内置' : esc(x.file)}（数据 ${fmtTime(x.createdAt, false)}）` : `IPv${v} 未安装`);
  return `ip2region 离线库 · ${one(db.v4, 4)} · ${one(db.v6, 6)}`;
}

/* ---------------- 客户端 IP 识别 ----------------
 * 显示服务端实际收到的连接地址与转发头、当前解析结果与推荐设置；IP 来源可在页面上修改（需要当前登录密码）
 */
function ipPanel(box, d, reload) {
  const label = d.mode.source === 'xff' ? `X-Forwarded-For，可信代理 ${d.mode.hops} 层` : d.mode.source === 'realip' ? 'X-Real-IP' : '直连（使用连接地址）';
  const priv = ip => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd])/i.test(ip || '');
  const bad = priv(d.resolved) && d.suggest?.ip && !priv(d.suggest.ip) && d.suggest.ip !== d.resolved;
  box.innerHTML = `<section class="panel"><div class="panel-h"><h3>客户端 IP 识别</h3>${help('登录记录、审计日志、IP 白名单与登录限流使用的客户端地址。经反向代理（Nginx / OpenResty / SLB）访问时，需要按代理链设置 IP 来源，否则记录的是代理的内网地址。设置保存后立即生效，无需重启。')}
      <span class="sub">当前请求解析为 <b class="mono ${bad ? 'warn-text' : ''}">${esc(d.resolved)}</b></span></div>
    <div class="kv" style="margin-bottom:12px">
      <div><span>解析结果（记录到日志的 IP）</span><b>${ipHtml(d.resolved, d.resolvedLoc)}</b></div>
      <div><span>连接来源地址</span><b>${ipHtml(d.peer, d.peerLoc)}</b><span class="hint ${d.trusted ? '' : 'warn-text'}">${d.trusted ? '在可信代理范围内' : '不在可信代理范围内（不采用转发头）'}</span></div>
      <div><span>X-Forwarded-For</span><b class="mono">${esc(d.xff.join(', ') || '（无）')}</b></div>
      <div><span>X-Real-IP</span><b>${d.xRealIp ? ipHtml(d.xRealIp, d.xRealIpLoc) : '（无）'}</b></div>
      <div><span>当前 IP 来源</span><b>${esc(label)}</b><span class="hint">${d.mode.from === 'ui' ? '页面设置' : `环境变量 TRUST_PROXY=${d.envTrustProxy ? (d.envHops > 1 ? d.envHops : 'true') : 'false'}`}</span></div>
    </div>
    ${d.candidates.length ? `<div class="tbl-wrap" style="margin-bottom:12px"><table class="dt compact"><thead><tr><th>X-Forwarded-For（从右往左）</th><th>地址</th><th>归属地</th><th>类型</th></tr></thead><tbody>${d.candidates.map(c => `<tr><td>可信代理 ${c.hops} 层时取此地址</td><td class="mono">${esc(c.ip)}</td><td>${esc(c.loc || '未知')}</td><td>${c.public ? '<span class="pill good">公网</span>' : '<span class="pill neutral">内网</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="notice ${bad ? 'warn' : 'info'}" style="margin-bottom:12px">${icon(bad ? 'warn' : 'info')}<div><b>${bad ? '当前设置识别到的是代理的内网地址' : '检测结果'}</b><span class="why">${esc(d.suggest?.text || '')}</span>${d.suggest && ['xff', 'realip', 'direct'].includes(d.suggest.source) && (d.suggest.source !== d.mode.source || (d.suggest.hops || 1) !== (d.mode.hops || 1)) ? '<button class="link" type="button" data-ip-apply>按建议填写 →</button>' : ''}</div></div>
    <form id="ipForm" class="form-grid" autocomplete="off">
      <label class="field"><span>客户端 IP 来源</span><select class="inp" name="ipSource">${Object.entries(d.sources).map(([k, l]) => opt(k, l, d.saved.ipSource || 'env')).join('')}</select></label>
      <label class="field" data-hops><span>可信代理层数</span><input class="inp" type="number" name="hops" min="1" max="10" value="${esc(d.saved.hops || d.mode.hops || 1)}"></label>
      <label class="field"><span>当前登录密码</span><input class="inp" type="password" name="confirmPassword" autocomplete="current-password" maxlength="256"><small class="hint">安全设置，需要再次验证身份</small></label>
      <div class="row full"><button class="btn primary" type="submit">保存</button><button class="btn" type="button" data-ip-recheck>${icon('sync')}重新检测</button></div>
    </form>
    <p class="hint" style="margin:10px 0 0">只有连接来自可信代理（${esc(d.trustedProxies.join('、'))}，可用环境变量 TRUSTED_PROXIES 修改）时才采用转发头。可信代理层数 = 请求经过的代理数量，例如 SLB → OpenResty → 本服务为 2。</p>
  </section>`;
  const form = $('#ipForm', box);
  const syncUi = () => { $('[data-hops]', form).hidden = form.elements.ipSource.value !== 'xff'; };
  syncUi();
  form.elements.ipSource.addEventListener('change', syncUi);
  form.addEventListener('input', () => markDirty(form));
  $('[data-ip-apply]', box)?.addEventListener('click', () => {
    form.elements.ipSource.value = d.suggest.source; if (d.suggest.hops) form.elements.hops.value = d.suggest.hops;
    syncUi(); markDirty(form); form.elements.confirmPassword.focus();
  });
  $('[data-ip-recheck]', box).onclick = async () => { try { ipPanel(box, await http('GET', '/api/admin/ip-check'), reload); } catch (ex) { toast(ex.message, 'err', 4000); } };
  form.onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.confirmPassword) { form.elements.confirmPassword.focus(); return toast('请输入当前登录密码', 'err'); }
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const r = await http('PUT', '/api/admin/network', { ipSource: fd.ipSource, hops: Number(fd.hops) || 1, confirmPassword: fd.confirmPassword });
      markClean(form);
      toast(`已保存，当前请求解析为 ${r.resolved}`, '', 4000);
      await reload();
    } catch (ex) { form.elements.confirmPassword.value = ''; toast('保存失败：' + ex.message, 'err', 4000); } finally { btn.disabled = false; }
  };
}

/* ---------------- 系统日志 ---------------- */
const LOG_CAT = { service: '服务', sync: '同步', alert: '告警', backup: '备份', config: '配置', runtime: '运行异常', demo: '演示', system: '系统' };
const LOG_LV = { error: ['错误', 'bad'], warn: ['警告', 'warn'], info: ['信息', 'neutral'] };
async function logs(el) {
  const st = { level: '', category: '', q: '' };
  el.innerHTML = `<section class="panel"><div class="panel-h"><h3>系统日志</h3><span class="sub" id="lgSub"></span>
      <div class="actions"><div class="seg sm" role="group" aria-label="级别">${[['', '全部'], ['warn', '警告及错误'], ['error', '仅错误']].map(([k, l]) => `<button type="button" data-lv="${k}" aria-pressed="${k === ''}">${l}</button>`).join('')}</div>
        <select class="inp sm" id="lgCat" aria-label="分类">${opt('', '全部分类', '')}${Object.entries(LOG_CAT).map(([k, l]) => opt(k, l, '')).join('')}</select>
        <input class="inp sm" id="lgQ" type="search" placeholder="搜索日志内容" aria-label="搜索日志内容" style="width:180px">
        <label class="chk"><input type="checkbox" id="lgAuto"> 自动刷新</label>
        <button class="btn sm" id="lgRefresh">${icon('sync')}刷新</button><button class="btn sm" id="lgCsv">${icon('download')}导出</button></div></div>
    <div id="lgTbl"></div>
    <div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" id="lgMore" hidden>加载更早的日志</button></div></section>`;
  let rows = [], t = null, seq = 0;
  const load = async (more = false) => {
    const my = ++seq;
    const p = new URLSearchParams({ limit: '500' });
    if (st.level) p.set('level', st.level);
    if (st.category) p.set('category', st.category);
    if (st.q) p.set('q', st.q);
    if (more && rows.length) p.set('before', String(rows[rows.length - 1].id));
    const r = await http('GET', '/api/admin/logs?' + p);
    if (my !== seq || !el.isConnected) return;
    rows = more ? rows.concat(r.logs) : r.logs;
    const c = Object.fromEntries((r.stats24h || []).map(x => [x.level, x.n]));
    $('#lgSub', el).innerHTML = `近 24 小时：<span class="${c.error ? 'bad-text' : ''}">错误 ${c.error || 0}</span> · <span class="${c.warn ? 'warn-text' : ''}">警告 ${c.warn || 0}</span> · 信息 ${c.info || 0} · 保留 ${r.retentionDays} 天`;
    t = table('syslog', $('#lgTbl', el), {
      sort: 'id', pageSize: 100, stickyFirst: false, empty: '暂无日志', caption: '系统日志',
      columns: [
        { key: 'id', label: '时间', fmt: (x, r2) => `${fmtTime(r2.ts)}:${p2(new Date(r2.ts).getSeconds())}`, csv: r2 => new Date(r2.ts).toISOString() },
        { key: 'level', label: '级别', fmt: x => `<span class="pill ${LOG_LV[x]?.[1] || 'neutral'}">${LOG_LV[x]?.[0] || esc(x)}</span>`, csv: r2 => LOG_LV[r2.level]?.[0] || r2.level },
        { key: 'category', label: '分类', fmt: x => esc(LOG_CAT[x] || x), csv: r2 => LOG_CAT[r2.category] || r2.category },
        { key: 'message', label: '内容', cls: 'wrap-cell mono', sortable: false },
      ],
    }).setRows(rows);
    $('#lgMore', el).hidden = r.logs.length < 500;
  };
  const reload = () => load().catch(ex => toast('日志加载失败：' + ex.message, 'err', 4000));
  el.querySelectorAll('[data-lv]').forEach(b => b.onclick = () => { st.level = b.dataset.lv; el.querySelectorAll('[data-lv]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); reload(); });
  $('#lgCat', el).onchange = e => { st.category = e.target.value; reload(); };
  let qt;
  $('#lgQ', el).oninput = e => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value.trim(); reload(); }, 300); };
  $('#lgRefresh', el).onclick = reload;
  $('#lgMore', el).onclick = () => load(true).catch(ex => toast(ex.message, 'err', 4000));
  $('#lgCsv', el).onclick = () => t?.csv(`系统日志_${new Date().toISOString().slice(0, 10)}.csv`);
  // 自动刷新：每 10 秒，离开本页后停止
  const timer = setInterval(() => { if (!el.isConnected) { clearInterval(timer); return; } if ($('#lgAuto', el).checked && !document.hidden) reload(); }, 10_000);
  await load();
}

/* ---------------- 用户操作日志 ----------------
 * 所有用户（含只读用户）的登录、页面访问、数据查询、导出 / 下载、配置变更与权限拒绝；按用户 / 分类 / 结果 / 日期 / 关键字筛选
 */
async function oplog(el) {
  const st = { user: '', category: '', result: '', from: '', to: '', q: '' };
  el.innerHTML = `<div class="stat-strip" id="opStats"></div>
    <section class="panel"><div class="panel-h"><h3>用户活跃</h3><span class="sub">近 7 天 · 点击用户查看其操作</span></div><div id="opUsers"><div class="nodata">加载中…</div></div></section>
    <section class="panel"><div class="panel-h"><h3>操作明细</h3><span class="sub" id="opSub"></span>
      <div class="actions"><button class="btn sm" id="opCsv">${icon('download')}导出</button><button class="btn sm ghost" id="opRefresh">${icon('sync')}刷新</button></div></div>
      <div class="row" style="margin-bottom:10px;gap:8px">
        <select class="inp sm" id="opUser" aria-label="用户">${opt('', '全部用户', '')}</select>
        <div class="seg sm scroll" role="group" aria-label="分类">${[['', '全部'], ...Object.entries(OP_CAT)].map(([k, l]) => `<button type="button" data-oc="${k}" aria-pressed="${k === ''}">${l}</button>`).join('')}</div>
        <select class="inp sm" id="opRes" aria-label="结果">${opt('', '全部结果', '')}${opt('ok', '成功', '')}${opt('fail', '失败 / 拒绝', '')}</select>
        <input class="inp sm" type="date" id="opFrom" aria-label="开始日期"><span class="muted">–</span><input class="inp sm" type="date" id="opTo" aria-label="结束日期">
        <input class="inp sm" id="opQ" type="search" placeholder="搜索操作、对象、IP" style="width:180px" aria-label="搜索操作日志">
      </div>
      <div id="opTbl"></div><div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" id="opMore" hidden>加载更早的记录</button></div>
      <p class="hint" style="margin:10px 0 0">记录内容不含任何密码、密钥或 Webhook；后台自动刷新不计入。安全相关的配置变更另见“安全与审计 → 审计日志”。</p></section>`;
  let rows = [], t = null, users = [], retention = 0;
  const params = before => new URLSearchParams(Object.entries({ ...st, user: st.user, limit: 200, ...(before ? { before } : {}) }).filter(([, v]) => v !== '' && v != null)).toString();
  const resText = r => (r.status == null ? '<span class="pill neutral">已记录</span>' : r.status >= 400 ? `<span class="pill bad" title="HTTP ${r.status}">${r.status === 403 ? '拒绝' : '失败'}</span>` : '<span class="pill good">成功</span>');
  const draw = () => {
    t = table('oplog', $('#opTbl', el), {
      sort: 'id', pageSize: 0, stickyFirst: false, empty: '暂无操作记录', caption: '操作明细',
      columns: [
        { key: 'id', label: '时间', fmt: (x, r) => fmtTime(r.ts) + ':' + p2(new Date(r.ts).getSeconds()), csv: r => fmtTime(r.ts) + ':' + p2(new Date(r.ts).getSeconds()) },
        { key: 'username', label: '用户', fmt: (x, r) => (x.startsWith('?') ? '<span class="muted">不存在的用户</span>' : `<button class="lnk" data-op-user="${esc(x)}">${esc(x)}</button>${r.role === 'admin' ? '<span class="sub">管理员</span>' : r.role ? '<span class="sub">只读</span>' : ''}`), csv: r => r.username },
        { key: 'ip', label: 'IP / 归属地', fmt: (x, r) => ipHtml(x, r.loc), csv: r => ipText(r.ip, r.loc) },
        { key: 'category', label: '分类', fmt: x => `<span class="tag" style="margin-left:0">${esc(OP_CAT[x] || x)}</span>`, csv: r => OP_CAT[r.category] || r.category },
        { key: 'action', label: '操作', fmt: (x, r) => `<span class="${r.status >= 400 ? 'bad-text' : ''}" title="${esc(x)}">${esc(OP_ACT[x] || x)}</span>`, csv: r => OP_ACT[r.action] || r.action },
        { key: 'target', label: '对象', cls: 'wrap-cell', fmt: x => (x ? esc(x) : '<span class="muted">—</span>') },
        { key: 'detail', label: '详情', cls: 'wrap-cell wide-cell', sortable: false, fmt: x => { const ps = opPairs(x); return ps.length ? `<div class="ad">${ps.map(([k, v]) => `<span class="ad-i">${k ? `<em>${esc(k)}</em>` : ''}${esc(v)}</span>`).join('')}</div>` : '<span class="muted">—</span>'; }, csv: r => opPairs(r.detail).map(([k, v]) => (k ? `${k}：${v}` : v)).join('；') },
        { key: 'status', label: '结果', fmt: (x, r) => resText(r), csv: r => (r.status == null ? '' : r.status >= 400 ? `失败（${r.status}）` : '成功') },
        { key: 'ms', label: '耗时', align: 'r', fmt: x => (x == null ? '' : x + ' ms') },
        { key: 'ua', label: '设备', fmt: x => `<span title="${esc(x || '')}">${esc(uaText(x))}</span>`, csv: r => uaText(r.ua) },
      ],
      csvExtra: [{ label: '请求', val: r => (r.method ? `${r.method} ${r.path}` : r.path || '') }, { label: '会话', val: r => r.sid || '' }, { label: 'User-Agent', val: r => r.ua || '' }],
    }).setRows(rows);
    $('#opSub', el).textContent = `已加载 ${rows.length.toLocaleString()} 条${retention ? ` · 保留 ${retention} 天` : ''}`;
  };
  const drawUsers = () => {
    const u = $('#opUsers', el);
    if (!users.length) { u.innerHTML = '<div class="nodata">近 7 天无操作记录</div>'; return; }
    table('opusers', u, {
      sort: 'last', pageSize: 0, stickyFirst: false, caption: '用户活跃',
      columns: [
        { key: 'username', label: '用户', fmt: (x, r) => (x.startsWith('?') ? '<span class="muted">不存在的用户（登录尝试）</span>' : `<button class="lnk" data-op-user="${esc(x)}"><b style="font-weight:600">${esc(x)}</b></button>${r.role ? `<span class="sub">${r.role === 'admin' ? '管理员' : '只读'}</span>` : ''}`) },
        { key: 'last', label: '最近活动', fmt: x => `${esc(ago(x))}<span class="sub">${esc(fmtTime(x))}</span>` },
        { key: 'ip', label: '最近 IP / 归属地', fmt: (x, r) => ipHtml(x, r.loc) },
        { key: 'ua', label: '最近设备', fmt: x => esc(uaText(x)) },
        { key: 'sessions', label: '会话', align: 'r' }, { key: 'views', label: '页面访问', align: 'r' }, { key: 'queries', label: '数据查询', align: 'r' },
        { key: 'exports', label: '导出 / 下载', align: 'r' }, { key: 'changes', label: '配置变更', align: 'r' },
        { key: 'fails', label: '失败 / 拒绝', align: 'r', fmt: x => (x ? `<span class="bad-text">${x}</span>` : '0') },
      ],
    }).setRows(users);
  };
  const load = async (more = false) => {
    const before = more && rows.length ? rows.at(-1).id : 0;
    const r = await http('GET', '/api/admin/oplog?' + params(before));
    rows = more ? rows.concat(r.ops) : r.ops;
    if (!more) {
      const s = r.stats24h, c = s.byCat || {};
      $('#opStats', el).innerHTML = `<div><span>近 24 小时操作</span><b>${s.n.toLocaleString()}</b></div><div><span>活跃用户（24 小时）</span><b>${s.users}</b></div>
        <div><span>页面访问</span><b>${(c.view || 0).toLocaleString()}</b></div><div><span>数据查询</span><b>${(c.query || 0).toLocaleString()}</b></div>
        <div><span>导出 / 下载</span><b>${c.export || 0}</b></div><div><span>配置变更</span><b>${(c.config || 0) + (c.user || 0) + (c.alert || 0) + (c.sync || 0)}</b></div>
        <div><span>失败 / 拒绝</span><b class="${s.fails ? 'bad-text' : ''}">${s.fails}</b></div>`;
      retention = r.retentionDays;
      users = r.users || [];
      const sel = $('#opUser', el), names = [...new Set(users.map(x => x.username).filter(x => !x.startsWith('?')).concat(st.user ? [st.user] : []))].sort();
      sel.innerHTML = opt('', '全部用户', st.user) + names.map(n => opt(n, n, st.user)).join('');
      drawUsers();
    }
    $('#opMore', el).hidden = r.ops.length < 200;
    draw();
  };
  const reload = () => load().catch(ex => toast(ex.message, 'err', 4000));
  el.querySelectorAll('[data-oc]').forEach(b => b.onclick = () => { st.category = b.dataset.oc; el.querySelectorAll('[data-oc]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); reload(); });
  $('#opUser', el).onchange = e => { st.user = e.target.value; reload(); };
  $('#opRes', el).onchange = e => { st.result = e.target.value; reload(); };
  $('#opFrom', el).onchange = e => { st.from = e.target.value; reload(); };
  $('#opTo', el).onchange = e => { st.to = e.target.value; reload(); };
  let qt; $('#opQ', el).oninput = e => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value.trim(); reload(); }, 300); };
  $('#opRefresh', el).onclick = reload;
  $('#opMore', el).onclick = () => load(true).catch(ex => toast(ex.message, 'err', 4000));
  $('#opCsv', el).onclick = () => t?.csv(`操作日志_${new Date().toISOString().slice(0, 10)}.csv`);
  el.addEventListener('click', e => { const b = e.target.closest('[data-op-user]'); if (!b) return; st.user = b.dataset.opUser; $('#opUser', el).value = st.user; reload(); $('#opTbl', el).scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  await load();
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
      { key: 'action', label: '接口', sortVal: r => API[r.action] || r.action, fmt: (x, r) => `<span title="${esc(x)}">${esc(API[x] || x)}</span><span class="sub">${esc(PRODUCT[r.product] || r.product)} · <span class="mono">${esc(x)}</span></span>` },
      { key: 'query', label: '参数', cls: 'wrap-cell wide-cell', sortable: false, fmt: x => { const ps = apiParams(x); return ps.length ? `<div class="ad" title="${esc(x)}">${ps.map(([k, v]) => `<span class="ad-i"><em>${esc(k)}</em>${esc(v)}</span>`).join('')}</div>` : '<span class="muted">—</span>'; }, csv: r => r.query },
      { key: 'ok', label: '结果', fmt: (x, r) => (x ? '<span class="pill good">成功</span>' : `<span class="pill bad">${esc(r.code || '失败')}</span>`) },
      { key: 'message', label: '错误信息', cls: 'wrap-cell' },
      { key: 'ms', label: '耗时', align: 'r', fmt: x => x + ' ms' },
      { key: 'requestId', label: 'RequestId', cls: 'mono' },
    ],
  }).setRows(list);
}
