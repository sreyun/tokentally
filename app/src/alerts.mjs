/**
 * 预算告警通知：钉钉 / 飞书 / 企业微信群机器人与通用 Webhook
 *
 * - 每次账单同步成功、预算或告警配置变更后评估当月（自然月账期）预算使用情况
 * - 同一阈值（含预算金额）每个账期只通知一次；账期切换后自动重置
 * - Webhook 地址与加签密钥使用 AES-256-GCM 加密保存
 * - 仅允许 HTTPS；钉钉/飞书/企业微信只允许官方域名；解析结果为内网/保留地址时拒绝连接（防 SSRF / DNS 重绑定）
 */
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import crypto from 'node:crypto';
import { todayIn, addDays } from './sync.mjs';

export const ALERT_TYPES = {
  dingtalk: { label: '钉钉群机器人', hosts: ['oapi.dingtalk.com'], sign: true },
  feishu: { label: '飞书群机器人', hosts: ['open.feishu.cn', 'open.larksuite.com'], sign: true },
  wecom: { label: '企业微信群机器人', hosts: ['qyapi.weixin.qq.com'], sign: false },
  generic: { label: '通用 Webhook（JSON）', hosts: null, sign: true },
};
export const DEFAULT_ALERTS = { enabled: false, type: 'dingtalk', rules: { pct: true, over: true, forecast: true, keys: true } };

/* ---------------- 内网地址拦截 ---------------- */
const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) PRIVATE.addSubnet(a, p, 'ipv6');
export function isPrivateIp(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) ip = m[1];
  const fam = net.isIP(ip);
  return !fam || PRIVATE.check(ip, fam === 6 ? 'ipv6' : 'ipv4');
}
/** 连接时校验解析结果，避免“校验时公网、连接时内网”的 DNS 重绑定 */
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find(a => isPrivateIp(a.address));
    if (!addrs.length || bad) return cb(Object.assign(new Error(`目标地址 ${bad?.address || hostname} 属于内网或保留地址，已拒绝`), { code: 'EPRIVATE' }));
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/** 校验 Webhook 地址；返回规范化后的 URL 字符串，不合法时抛出带中文说明的 Error */
export function validateWebhook(type, raw, { allowPrivate = false } = {}) {
  const t = ALERT_TYPES[type];
  if (!t) throw new Error('不支持的通知类型');
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Webhook 地址格式不正确'); }
  if (u.protocol !== 'https:') throw new Error('Webhook 地址必须使用 HTTPS');
  if (u.username || u.password) throw new Error('Webhook 地址不能包含用户名或密码');
  if (u.href.length > 1000) throw new Error('Webhook 地址过长');
  const host = u.hostname.toLowerCase();
  if (t.hosts && !t.hosts.includes(host)) throw new Error(`${t.label}的地址应以 https://${t.hosts[0]}/ 开头`);
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (net.isIP(host.replace(/^\[|\]$/g, '')) && isPrivateIp(host.replace(/^\[|\]$/g, ''))))) {
    throw new Error('不允许向内网或本机地址发送通知');
  }
  u.hash = '';
  return u.href;
}
/** 展示用：只显示协议、主机与路径前缀，隐藏 access_token / key 等凭据 */
export function maskWebhook(href) {
  try { const u = new URL(href); return `${u.protocol}//${u.host}${u.pathname.length > 18 ? u.pathname.slice(0, 18) + '…' : u.pathname}${u.search ? '?…' : ''}`; } catch { return ''; }
}

function postJson(url, body, headers, allowPrivate) {
  return new Promise((resolve, reject) => {
    // IP 字面量不会经过 lookup，需要单独校验
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) return reject(Object.assign(new Error(`目标地址 ${host} 属于内网或保留地址，已拒绝`), { code: 'EPRIVATE' }));
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'POST', timeout: 8000, lookup: allowPrivate ? undefined : safeLookup,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'User-Agent': 'bailian-cost-alert/1.1', ...headers },
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 65536) req.destroy(new Error('响应内容过大')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（8 秒）')));
    req.on('error', reject);
    req.end(data);
  });
}

/* ---------------- 消息格式 ---------------- */
const yuan = n => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (Number.isFinite(n) ? n.toFixed(1) + '%' : '-');
/** 描述来自阿里云 Key 备注，去掉可构成 Markdown 链接/格式的字符 */
const clean = s => String(s || '').replace(/[[\]()<>*_`#|\\~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

function buildMessage(type, { title, level, lines, footer, link }) {
  if (type === 'dingtalk') {
    const text = [`### ${title}`, '', ...lines.map(l => `- ${l}`), '', `> ${footer}`, ...(link ? ['', `[打开费用分析](${link})`] : [])].join('\n');
    return { msgtype: 'markdown', markdown: { title, text } };
  }
  if (type === 'feishu') {
    const content = [...lines.map(l => `• ${l}`), '', `<font color='grey'>${footer}</font>`, ...(link ? [`[打开费用分析](${link})`] : [])].join('\n');
    return { msg_type: 'interactive', card: { config: { wide_screen_mode: true }, header: { template: level === 'bad' ? 'red' : level === 'warn' ? 'orange' : 'blue', title: { tag: 'plain_text', content: title } }, elements: [{ tag: 'markdown', content }] } };
  }
  if (type === 'wecom') {
    const color = level === 'bad' ? 'warning' : level === 'warn' ? 'comment' : 'info';
    const content = [`### <font color="${color}">${title}</font>`, ...lines.map(l => `> ${l}`), `<font color="comment">${footer}</font>`, ...(link ? [`[打开费用分析](${link})`] : [])].join('\n');
    return { msgtype: 'markdown', markdown: { content: content.slice(0, 3800) } };
  }
  return null;
}
const strip = s => s.replace(/\*\*/g, '');

/** 组装请求（含加签），返回 { url, body, headers } */
function signRequest(type, webhook, secret, payload, generic) {
  const headers = {};
  let url = webhook, body = payload;
  if (type === 'dingtalk' && secret) {
    const ts = Date.now();
    const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
    const u = new URL(webhook); u.searchParams.set('timestamp', String(ts)); u.searchParams.set('sign', sign); url = u.href;
  } else if (type === 'feishu' && secret) {
    const ts = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
    body = { timestamp: String(ts), sign, ...payload };
  } else if (type === 'generic') {
    body = generic;
    if (secret) {
      const ts = String(Math.floor(Date.now() / 1000));
      headers['X-Alert-Timestamp'] = ts;
      headers['X-Alert-Signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${JSON.stringify(body)}`).digest('hex');
    }
  }
  return { url, body, headers };
}

function checkResponse(type, { status, text }) {
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}${text ? '：' + text.slice(0, 160) : ''}`);
  if (type === 'generic') return;
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!j) return;
  const code = j.errcode ?? j.code ?? j.StatusCode;
  if (code != null && Number(code) !== 0) throw new Error(`${j.errmsg || j.msg || j.StatusMessage || '机器人返回错误'}（错误码 ${code}）`);
}

/* ---------------- 服务 ---------------- */
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;
const daysInMonth = cycle => { const [y, m] = cycle.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

export class AlertService {
  constructor({ store, tz, log, publicUrl = '', allowPrivate = false }) {
    Object.assign(this, { store, tz, log, publicUrl, allowPrivate });
    this.busy = null;
  }
  settings() {
    const s = this.store.getSetting('alerts', {}) || {};
    return { ...DEFAULT_ALERTS, ...s, rules: { ...DEFAULT_ALERTS.rules, ...(s.rules || {}) } };
  }
  secrets() {
    try { return { webhook: this.store.getSecret('alerts.webhook') || '', secret: this.store.getSecret('alerts.secret') || '' }; }
    catch { return { webhook: '', secret: '', undecryptable: true }; }
  }
  stateFor(cycle) {
    const st = this.store.getSetting('alerts.state', null);
    return st && st.cycle === cycle ? { sent: {}, ...st } : { cycle, sent: {}, lastSentAt: st?.lastSentAt || null, lastError: null, lastErrorAt: null, history: st?.history || [] };
  }
  out() {
    const s = this.settings(), sec = this.secrets(), cycle = todayIn(this.tz).slice(0, 7), st = this.stateFor(cycle);
    return {
      ...s, types: Object.fromEntries(Object.entries(ALERT_TYPES).map(([k, v]) => [k, { label: v.label, sign: v.sign, host: v.hosts?.[0] || '' }])),
      webhookSet: !!sec.webhook, webhookMasked: maskWebhook(sec.webhook), secretSet: !!sec.secret, undecryptable: !!sec.undecryptable,
      state: { cycle, lastSentAt: st.lastSentAt, lastError: st.lastError, lastErrorAt: st.lastErrorAt, history: (st.history || []).slice(0, 20) },
      pending: this.evaluate().filter(i => !i.hidden && !st.sent[i.code]).map(i => strip(i.text)),
    };
  }

  /** 当月预算使用情况 → 当前已触发的全部告警项 */
  evaluate(today = todayIn(this.tz)) {
    const b = this.store.budgets(), s = this.settings(), cycle = today.slice(0, 7);
    const hasKeys = s.rules.keys && Object.keys(b.keys || {}).length;
    if (!b.monthly && !hasKeys) return [];
    const { month, daily } = this.store.budgetUsage(cycle);
    const cost = new Map(month.map(r => [r.id || '', r.cost || 0]));
    const total = month.reduce((x, r) => x + (r.cost || 0), 0);
    const alertPct = b.alertPct || 80;
    const items = [];
    if (b.monthly) {
      const used = total / b.monthly * 100;
      if (s.rules.over && total >= b.monthly) items.push({ code: `total:over:${b.monthly}`, entity: 'total', level: 'bad', text: `**总预算已超出**：本月应付 ${yuan(total)}，预算 ${yuan(b.monthly)}（${pct(used)}）` });
      if (s.rules.pct && used >= alertPct) items.push({ code: `total:pct:${alertPct}:${b.monthly}`, entity: 'total', level: 'warn', hidden: s.rules.over && total >= b.monthly, text: `**总预算已用 ${pct(used)}**（预警阈值 ${alertPct}%）：${yuan(total)} / ${yuan(b.monthly)}` });
      if (s.rules.forecast && total < b.monthly) {
        const fc = this.forecast(daily, cycle, today);
        if (fc != null && fc >= b.monthly) items.push({ code: `total:forecast:${b.monthly}`, entity: 'total', level: 'warn', text: `**预计月末超出总预算**：按日均推算 ${yuan(fc)}，预算 ${yuan(b.monthly)}（超出 ${yuan(fc - b.monthly)}）` });
      }
    }
    if (hasKeys) {
      const keys = new Map(this.store.listApiKeys().map(k => [k.api_key_id, k]));
      for (const [id, budget] of Object.entries(b.keys)) {
        if (!budget) continue;
        const c = cost.get(id === '__none__' ? '' : id) || 0, used = c / budget * 100;
        const k = keys.get(id), name = id === '__none__' ? '未关联 API Key 的费用' : `API Key「${clean(k?.description) || '无描述'}」(${id})`;
        if (s.rules.over && c >= budget) items.push({ code: `key:${id}:over:${budget}`, entity: 'key:' + id, level: 'bad', text: `**${name} 已超出预算**：${yuan(c)} / ${yuan(budget)}（${pct(used)}）` });
        if (s.rules.pct && used >= alertPct) items.push({ code: `key:${id}:pct:${alertPct}:${budget}`, entity: 'key:' + id, level: 'warn', hidden: s.rules.over && c >= budget, text: `**${name} 预算已用 ${pct(used)}**：${yuan(c)} / ${yuan(budget)}` });
      }
    }
    return items;
  }
  /** 与前端口径一致：已完整的日 + 今日实际 + 完整日日均 × 剩余天数 */
  forecast(daily, cycle, today) {
    if (today.slice(0, 7) !== cycle) return null;
    const from = cycle + '-01', yesterday = addDays(today, -1);
    if (yesterday < from) return null;
    const fullDays = daysBetween(from, yesterday);
    let full = 0, td = 0;
    for (const r of daily) { if (r.day <= yesterday) full += r.cost || 0; else if (r.day === today) td += r.cost || 0; }
    return full + td + (full / fullDays) * Math.max(0, daysInMonth(cycle) - fullDays - 1);
  }

  /** 评估并发送尚未通知过的告警；串行执行，失败时保留未发送状态等待下次重试 */
  check(trigger = 'sync') {
    const run = async () => {
      const s = this.settings();
      if (!s.enabled) return { skipped: 'disabled' };
      const sec = this.secrets();
      if (!sec.webhook) return { skipped: 'no-webhook' };
      const today = todayIn(this.tz), cycle = today.slice(0, 7), st = this.stateFor(cycle);
      const fresh = this.evaluate(today).filter(i => !st.sent[i.code]);
      if (!fresh.length) return { sent: 0 };
      // 已超出预算时“达到预警阈值”被隐含（hidden），只发更严重的一条，但两者都记为已通知
      const show = fresh.filter(i => !i.hidden);
      if (!show.length) { const now = Date.now(); for (const i of fresh) st.sent[i.code] = now; this.store.setSetting('alerts.state', st); return { sent: 0 }; }
      const level = show.some(i => i.level === 'bad') ? 'bad' : 'warn';
      try {
        await this.send(s.type, sec, { title: `百炼费用预算告警 · ${cycle}`, level, lines: show.map(i => i.text), today });
        const now = Date.now();
        for (const i of fresh) st.sent[i.code] = now;
        st.lastSentAt = now; st.lastError = null; st.lastErrorAt = null;
        st.history = [{ at: now, n: show.length, level, items: show.map(i => strip(i.text)) }, ...(st.history || [])].slice(0, 20);
        this.store.audit('system', '', 'alert.sent', { trigger, type: s.type, items: show.map(i => i.code) });
        this.log(`预算告警已发送（${show.length} 项，${ALERT_TYPES[s.type]?.label}）`);
        return { sent: show.length };
      } catch (e) {
        st.lastError = String(e.message || e).slice(0, 300); st.lastErrorAt = Date.now();
        this.log(`预算告警发送失败：${st.lastError}`);
        return { error: st.lastError };
      } finally {
        this.store.setSetting('alerts.state', st);
      }
    };
    this.busy = (this.busy || Promise.resolve()).then(run, run).catch(e => { this.log('预算告警评估失败：' + e.message); return { error: e.message }; });
    return this.busy;
  }

  async send(type, { webhook, secret }, { title, level, lines, today = todayIn(this.tz) }) {
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: this.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const footer = `统计至 ${today} ${time} · 口径：应付金额（税前）· 数据来源：阿里云费用中心`;
    const link = this.publicUrl ? this.publicUrl.replace(/\/+$/, '') + '/#/overview' : '';
    const payload = buildMessage(type, { title, level, lines, footer, link });
    const generic = { event: 'budget_alert', title, level, items: lines.map(strip), text: [title, ...lines.map(l => '- ' + strip(l)), footer].join('\n'), link: link || null, sentAt: new Date().toISOString() };
    const req = signRequest(type, webhook, secret, payload, generic);
    const res = await postJson(req.url, req.body, req.headers, this.allowPrivate);
    checkResponse(type, res);
  }
  async test(type, creds) {
    await this.send(type, creds, { title: '百炼费用预算告警 · 测试消息', level: 'info', lines: ['这是一条测试消息，收到即表示通知渠道配置正确。', '真实告警将在预算达到预警阈值、超出预算或预计月末超出时发送，每个阈值每月只通知一次。'] });
  }
}
