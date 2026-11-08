/**
 * 告警与报表推送：钉钉 / 飞书 / 企业微信群机器人与通用 Webhook（最多 5 个渠道，按渠道订阅事件）
 *
 * 事件：
 *  - budget   预算告警：达到预警阈值 / 超出预算 / 预计月末超出总预算 / API Key 预算（同一阈值每账期每渠道只通知一次）
 *  - anomaly  费用异常：昨日费用 ≥ 前 7 日日均 × 倍数 且 增量 ≥ 最小金额（整体与单个 Key）
 *  - sync     同步故障：某云厂商同一类同步连续失败 3 次；恢复后发送恢复通知
 *  - keyChange API Key 新增 / 删除 / 恢复
 *  - daily / weekly / monthly  日报（昨日）/ 周报（上周）/ 月报（上月出账后）
 *
 * 安全：仅 HTTPS；钉钉/飞书/企业微信只允许官方域名；连接阶段拒绝解析到内网/保留地址（防 SSRF / DNS 重绑定）；
 *       Webhook 地址与加签密钥使用 AES-256-GCM 加密保存，接口不回显。
 */
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import crypto from 'node:crypto';
import { todayIn, hourIn, addDays, addMonths, isCycleFinal, PROVIDER_NAMES } from './sync.mjs';

export const ALERT_TYPES = {
  dingtalk: { label: '钉钉群机器人', hosts: ['oapi.dingtalk.com'], sign: true, mention: 'mobile' },
  feishu: { label: '飞书群机器人', hosts: ['open.feishu.cn', 'open.larksuite.com'], sign: true, mention: 'all' },
  wecom: { label: '企业微信群机器人', hosts: ['qyapi.weixin.qq.com'], sign: false, mention: 'mobile' },
  generic: { label: '通用 Webhook（JSON）', hosts: null, sign: true, mention: 'mobile' },
};
export const EVENT_TYPES = {
  budget: { label: '预算告警', group: '告警', mention: true },
  anomaly: { label: '费用异常', group: '告警', mention: true },
  sync: { label: '同步故障与恢复', group: '告警', mention: true },
  keyChange: { label: 'API Key 新增 / 删除', group: '告警', mention: false },
  daily: { label: '日报（每天）', group: '报表', mention: false },
  weekly: { label: '周报（每周一）', group: '报表', mention: false },
  monthly: { label: '月报（次月出账后）', group: '报表', mention: false },
};
export const MAX_CHANNELS = 5;
export const DEFAULT_RULES = { pct: true, over: true, forecast: true, keys: true };
export const DEFAULT_ANOMALY = { ratio: 2, minAmount: 50, keys: true };
const DEFAULT_EVENTS = { budget: true, anomaly: true, sync: true, keyChange: false, daily: false, weekly: false, monthly: true };

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
/** @ 手机号：仅数字（可带 +），最多 10 个 */
export function cleanMobiles(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,，\s]+/);
  return [...new Set(arr.map(x => String(x).trim()).filter(x => /^\+?\d{6,15}$/.test(x)))].slice(0, 10);
}

function postJson(url, body, headers, allowPrivate) {
  return new Promise((resolve, reject) => {
    // IP 字面量不会经过 lookup，需要单独校验
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) return reject(Object.assign(new Error(`目标地址 ${host} 属于内网或保留地址，已拒绝`), { code: 'EPRIVATE' }));
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'POST', timeout: 8000, lookup: allowPrivate ? undefined : safeLookup,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'User-Agent': 'tokentally-alert/1.2', ...headers },
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
const yuan = n => (n < 0 ? '-' : '') + '¥' + Math.abs(Number(n || 0)).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (Number.isFinite(n) ? n.toFixed(1) + '%' : '-');
const chg = (a, b) => (b > 0 ? `${a >= b ? '+' : '−'}${Math.abs((a - b) / b * 100).toFixed(1)}%` : a > 0 ? '新增' : '持平');
/** 描述来自云厂商 Key 备注，去掉可构成 Markdown 链接/格式的字符 */
export const clean = s => String(s || '').replace(/[[\]()<>*_`#|\\~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const strip = s => String(s).replace(/\*\*/g, '');

function buildMessage(type, { title, level, lines, footer, link, mentions }) {
  const atText = mentions?.mobiles?.length ? '\n\n' + mentions.mobiles.map(m => '@' + m).join(' ') : '';
  if (type === 'dingtalk') {
    const text = [`### ${title}`, '', ...lines.map(l => (l.startsWith('#') || l === '' ? l : `- ${l}`)), '', `> ${footer}`, ...(link ? ['', `[打开费用分析](${link})`] : [])].join('\n') + atText;
    return { msgtype: 'markdown', markdown: { title, text }, ...(mentions ? { at: { atMobiles: mentions.mobiles || [], isAtAll: !!mentions.all } } : {}) };
  }
  if (type === 'feishu') {
    const content = [...lines.map(l => (l.startsWith('#') ? `**${l.replace(/^#+\s*/, '')}**` : l === '' ? '' : `• ${l}`)), '', `<font color='grey'>${footer}</font>`, ...(mentions?.all ? ['<at id=all></at>'] : [])].join('\n');
    const elements = [{ tag: 'markdown', content }];
    if (link) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开费用分析' }, type: 'primary', url: link }] });
    return { msg_type: 'interactive', card: { config: { wide_screen_mode: true }, header: { template: level === 'bad' ? 'red' : level === 'warn' ? 'orange' : level === 'good' ? 'green' : 'blue', title: { tag: 'plain_text', content: title } }, elements } };
  }
  if (type === 'wecom') {
    const color = level === 'bad' ? 'warning' : level === 'warn' ? 'comment' : 'info';
    const content = [`### <font color="${color}">${title}</font>`, ...lines.map(l => (l.startsWith('#') ? `**${l.replace(/^#+\s*/, '')}**` : l === '' ? '' : `> ${l}`)), `<font color="comment">${footer}</font>`, ...(link ? [`[打开费用分析](${link})`] : [])].join('\n');
    return { msgtype: 'markdown', markdown: { content: content.slice(0, 3800) } };
  }
  return null;
}

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

/* ---------------- 日期工具 ---------------- */
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;
const daysInMonth = cycle => { const [y, m] = cycle.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const weekday = d => new Date(d + 'T00:00:00Z').getUTCDay();
/** ISO 周：返回 { key: '2026-W45', from: 周一, to: 周日 } */
export function isoWeek(day) {
  const wd = (weekday(day) + 6) % 7; // 周一 = 0
  const from = addDays(day, -wd), thu = addDays(from, 3);
  const y = thu.slice(0, 4), jan4 = `${y}-01-04`;
  const w1 = addDays(jan4, -((weekday(jan4) + 6) % 7));
  const n = Math.round((Date.parse(from) - Date.parse(w1)) / (7 * 864e5)) + 1;
  return { key: `${y}-W${String(n).padStart(2, '0')}`, from, to: addDays(from, 6) };
}

/* ---------------- 服务 ---------------- */
export class AlertService {
  constructor({ store, tz, log, publicUrl = '', allowPrivate = false, providers = () => ['aliyun'] }) {
    Object.assign(this, { store, tz, log, publicUrl, allowPrivate, providers });
    this.busy = null;
    this.migrate();
  }

  /** v1.1 单渠道配置 → v1.2 多渠道（只执行一次） */
  migrate() {
    const s = this.store.getSetting('alerts', null);
    if (!s || Array.isArray(s.channels)) return;
    let webhook = '', secret = '';
    try { webhook = this.store.getSecret('alerts.webhook') || ''; secret = this.store.getSecret('alerts.secret') || ''; } catch { /* 主密钥变化：无法迁移地址 */ }
    const channels = [];
    if (webhook || s.type) {
      const type = ALERT_TYPES[s.type] ? s.type : 'dingtalk';
      channels.push({ id: 'c1', name: ALERT_TYPES[type].label, type, enabled: !!s.enabled && !!webhook, events: { ...DEFAULT_EVENTS, anomaly: false, sync: false, monthly: false }, atAll: false, atMobiles: [] });
      if (webhook) this.store.setSecret('alerts.ch.c1.webhook', webhook);
      if (secret) this.store.setSecret('alerts.ch.c1.secret', secret);
    }
    this.store.setSecret('alerts.webhook', ''); this.store.setSecret('alerts.secret', '');
    this.store.setSetting('alerts', { channels, rules: { ...DEFAULT_RULES, ...(s.rules || {}) }, anomaly: DEFAULT_ANOMALY, reportHour: 9 });
    const st = this.store.getSetting('alerts.state', null);
    if (st && st.sent && !Object.values(st.sent).some(v => v && typeof v === 'object')) {
      this.store.setSetting('alerts.state', { ...st, sent: channels.length ? { c1: st.sent } : {} });
    }
    this.log?.('告警配置已升级为多渠道格式');
  }

  settings() {
    const s = this.store.getSetting('alerts', {}) || {};
    return {
      channels: (Array.isArray(s.channels) ? s.channels : []).map(c => ({ ...c, events: { ...DEFAULT_EVENTS, ...(c.events || {}) }, atMobiles: cleanMobiles(c.atMobiles), atAll: !!c.atAll })),
      rules: { ...DEFAULT_RULES, ...(s.rules || {}) },
      anomaly: { ...DEFAULT_ANOMALY, ...(s.anomaly || {}) },
      reportHour: Number.isInteger(s.reportHour) ? s.reportHour : 9,
    };
  }
  secretsOf(id) {
    try { return { webhook: this.store.getSecret(`alerts.ch.${id}.webhook`) || '', secret: this.store.getSecret(`alerts.ch.${id}.secret`) || '' }; }
    catch { return { webhook: '', secret: '', undecryptable: true }; }
  }
  stateFor(cycle) {
    const st = this.store.getSetting('alerts.state', null) || {};
    const base = { cycle, sent: {}, reports: st.reports || {}, lastChangeId: st.lastChangeId || {}, channels: st.channels || {}, history: st.history || [] };
    return st.cycle === cycle ? { ...base, sent: st.sent || {} } : base;
  }
  saveState(st) { this.store.setSetting('alerts.state', st); }

  out() {
    const s = this.settings(), cycle = todayIn(this.tz).slice(0, 7), st = this.stateFor(cycle);
    const budgetItems = this.evaluateBudget().filter(i => !i.hidden);
    const subs = s.channels.filter(c => c.enabled && c.events.budget);
    return {
      ...s,
      channels: s.channels.map(c => {
        const sec = this.secretsOf(c.id), cs = st.channels[c.id] || {};
        return { ...c, webhookSet: !!sec.webhook, webhookMasked: maskWebhook(sec.webhook), secretSet: !!sec.secret, undecryptable: !!sec.undecryptable, lastSentAt: cs.lastSentAt || null, lastError: cs.lastError || null, lastErrorAt: cs.lastErrorAt || null };
      }),
      enabled: s.channels.some(c => c.enabled),
      types: Object.fromEntries(Object.entries(ALERT_TYPES).map(([k, v]) => [k, { label: v.label, sign: v.sign, host: v.hosts?.[0] || '', mention: v.mention }])),
      eventTypes: EVENT_TYPES, maxChannels: MAX_CHANNELS,
      state: { cycle, history: (st.history || []).slice(0, 30) },
      pending: budgetItems.filter(i => subs.some(c => !st.sent[c.id]?.[i.code])).map(i => strip(i.text)),
    };
  }

  /* ---------- 名称 ---------- */
  keyMap() {
    const tags = new Map(this.store.listKeyTags().map(t => [t.api_key_id, t]));
    return new Map(this.store.listApiKeys().map(k => [k.api_key_id, { ...k, tag: tags.get(k.api_key_id) }]));
  }
  keyName(id, keys) {
    if (!id || id === '__none__') return '无 API Key';
    const k = keys.get(id);
    return `${clean(k?.description) || id}${k?.provider === 'tencent' ? '（腾讯云）' : ''}`;
  }

  /* ---------- 预算 ---------- */
  evaluateBudget(today = todayIn(this.tz)) {
    const b = this.store.budgets(), s = this.settings(), cycle = today.slice(0, 7), r = s.rules;
    const hasKeys = r.keys && Object.keys(b.keys || {}).length;
    if (!b.monthly && !hasKeys) return [];
    const { month, daily } = this.store.budgetUsage(cycle);
    const cost = new Map(month.map(x => [x.id || '', x.cost || 0]));
    const total = month.reduce((x, y) => x + (y.cost || 0), 0);
    const alertPct = b.alertPct || 80;
    const items = [];
    if (b.monthly) {
      const used = total / b.monthly * 100;
      if (r.over && total >= b.monthly) items.push({ code: `total:over:${b.monthly}`, level: 'bad', text: `**总预算已超出**：本月应付 ${yuan(total)}，预算 ${yuan(b.monthly)}（${pct(used)}）` });
      if (r.pct && used >= alertPct) items.push({ code: `total:pct:${alertPct}:${b.monthly}`, level: 'warn', hidden: r.over && total >= b.monthly, text: `**总预算已用 ${pct(used)}**（预警阈值 ${alertPct}%）：${yuan(total)} / ${yuan(b.monthly)}` });
      if (r.forecast && total < b.monthly) {
        const fc = this.forecast(daily, cycle, today);
        if (fc != null && fc >= b.monthly) items.push({ code: `total:forecast:${b.monthly}`, level: 'warn', text: `**预计月末超出总预算**：按日均推算 ${yuan(fc)}，预算 ${yuan(b.monthly)}（超出 ${yuan(fc - b.monthly)}）` });
      }
    }
    if (hasKeys) {
      const keys = this.keyMap();
      for (const [id, budget] of Object.entries(b.keys)) {
        if (!budget) continue;
        const c = cost.get(id === '__none__' ? '' : id) || 0, used = c / budget * 100;
        const name = id === '__none__' ? '未关联 API Key 的费用' : `API Key「${this.keyName(id, keys)}」(${id})`;
        if (r.over && c >= budget) items.push({ code: `key:${id}:over:${budget}`, level: 'bad', text: `**${name} 已超出预算**：${yuan(c)} / ${yuan(budget)}（${pct(used)}）` });
        if (r.pct && used >= alertPct) items.push({ code: `key:${id}:pct:${alertPct}:${budget}`, level: 'warn', hidden: r.over && c >= budget, text: `**${name} 预算已用 ${pct(used)}**：${yuan(c)} / ${yuan(budget)}` });
      }
    }
    return items;
  }
  /** 兼容旧接口 */
  evaluate(today) { return this.evaluateBudget(today); }
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

  /* ---------- 费用异常（昨日 vs 前 7 日日均） ---------- */
  evaluateAnomaly(today = todayIn(this.tz)) {
    const a = this.settings().anomaly;
    const day = addDays(today, -1), from = addDays(day, -7);
    const rows = this.store.dailyByKey(from, day);
    const items = [];
    const check = (scope, vals, name) => {
      const y = vals.get(day) || 0;
      let base = 0; for (let i = 1; i <= 7; i++) base += vals.get(addDays(day, -i)) || 0;
      base /= 7;
      if (y - base < a.minAmount) return;
      if (base > 0 && y < base * a.ratio) return;
      items.push({ code: `anomaly:${scope}:${day}`, level: 'warn', delta: y - base, text: `**${name}** ${day.slice(5)} 费用 ${yuan(y)}，为前 7 日日均 ${yuan(base)} 的 ${base > 0 ? (y / base).toFixed(1) + ' 倍' : '—（此前无消费）'}（+${yuan(y - base)}）` });
    };
    const total = new Map(), byKey = new Map();
    for (const r of rows) {
      total.set(r.day, (total.get(r.day) || 0) + (r.cost || 0));
      if (!byKey.has(r.id)) byKey.set(r.id, new Map());
      byKey.get(r.id).set(r.day, (byKey.get(r.id).get(r.day) || 0) + (r.cost || 0));
    }
    check('total', total, '整体');
    if (a.keys) {
      const keys = this.keyMap(), list = [];
      for (const [id, vals] of byKey) { const before = items.length; check('key:' + (id || '__none__'), vals, `API Key「${this.keyName(id, keys)}」`); if (items.length > before) list.push(items.pop()); }
      items.push(...list.sort((x, y) => y.delta - x.delta).slice(0, 5));
    }
    return items;
  }

  /* ---------- 同步故障（连续失败 3 次）与恢复 ---------- */
  evaluateSync() {
    const items = [];
    for (const p of this.providers()) {
      for (const kind of ['meta', 'bills']) {
        const runs = this.store.recentRuns(kind, p, 12);
        if (!runs.length) continue;
        const name = `${PROVIDER_NAMES[p]}${kind === 'meta' ? ' API Key 同步' : '账单同步'}`;
        if (runs[0].status === 'error') {
          let n = 0; while (n < runs.length && runs[n].status === 'error') n++;
          if (n >= 3) items.push({ code: `sync:${p}:${kind}:${runs[n - 1].id}`, level: 'bad', text: `**${name}连续失败 ${n} 次**：${clean(runs[0].error).slice(0, 80) || '未知错误'}` });
        } else {
          let n = 1; while (n < runs.length && runs[n].status === 'error') n++;
          if (n - 1 >= 3) items.push({ code: `syncok:${p}:${kind}:${runs[n - 1].id}`, level: 'good', text: `**${name}已恢复**：此前连续失败 ${n - 1} 次` });
        }
      }
    }
    return items;
  }

  /* ---------- API Key 变更 ---------- */
  evaluateChanges(sinceId) {
    const CH = { create: '新增', delete: '删除', restore: '恢复' };
    return this.store.changesSince(sinceId).filter(c => c.entity === 'api_key' && CH[c.change]).map(c => ({
      code: `chg:${c.id}`, id: c.id, level: c.change === 'delete' ? 'warn' : 'info', text: `${CH[c.change]} API Key「${clean(c.name) || '无描述'}」(${c.entity_id})`,
    }));
  }

  /* ---------- 报表 ---------- */
  report(kind, today = todayIn(this.tz)) {
    const keys = this.keyMap(), b = this.store.budgets();
    const top = (rows, n, nameOf, total) => rows.filter(r => r.cost > 0.005).sort((x, y) => y.cost - x.cost).slice(0, n).map((r, i) => `${i + 1}. ${nameOf(r)} ${yuan(r.cost)}（${pct(total ? r.cost / total * 100 : 0)}）`);
    const sumBy = (rows, f) => { const m = new Map(); for (const r of rows) { const k = f(r); m.set(k, (m.get(k) || 0) + (r.cost || 0)); } return [...m.entries()].map(([k, cost]) => ({ k, cost })); };
    const provSplit = rows => {
      const ps = sumBy(rows, r => r.provider || 'aliyun');
      return ps.length > 1 ? '按云厂商：' + ps.sort((x, y) => y.cost - x.cost).map(x => `${PROVIDER_NAMES[x.k] || x.k} ${yuan(x.cost)}`).join('，') : null;
    };
    if (kind === 'daily') {
      const day = addDays(today, -1), cycle = today.slice(0, 7);
      const rows = this.store.dailyByKey(addDays(day, -1), day);
      const y = rows.filter(r => r.day === day), p = rows.filter(r => r.day !== day);
      const yc = y.reduce((s, r) => s + r.cost, 0), pc = p.reduce((s, r) => s + r.cost, 0);
      const { daily } = this.store.budgetUsage(cycle);
      const mtd = daily.filter(r => r.day <= today).reduce((s, r) => s + (r.cost || 0), 0);
      const fc = this.forecast(daily, cycle, today);
      const lines = [`**昨日（${day.slice(5)}）费用 ${yuan(yc)}**，较前一日 ${chg(yc, pc)}`];
      lines.push(`本月累计 ${yuan(mtd)}${fc != null ? `，预计月末 ${yuan(fc)}` : ''}${b.monthly ? `，月度预算 ${yuan(b.monthly)}（已用 ${pct(mtd / b.monthly * 100)}）` : ''}`);
      const ps = provSplit(y); if (ps) lines.push(ps);
      const tk = top(sumBy(y, r => r.id).map(x => ({ id: x.k, cost: x.cost })), 5, r => this.keyName(r.id, keys), yc);
      if (tk.length) lines.push('', '#### 昨日 API Key Top 5', ...tk);
      const tm = top(this.store.dailyByModel(day, day), 3, r => clean(r.model), yc);
      if (tm.length) lines.push('', '#### 昨日模型 Top 3', ...tm);
      const an = this.evaluateAnomaly(today);
      if (an.length) lines.push('', '#### 异常提示', ...an.map(i => i.text));
      return { title: `费用日报 · ${day}`, level: 'info', lines, empty: yc < 0.005 && mtd < 0.005, period: today };
    }
    if (kind === 'weekly') {
      const last = isoWeek(addDays(isoWeek(today).from, -1)), prev = isoWeek(addDays(last.from, -1));
      const rows = this.store.dailyByKey(prev.from, last.to);
      const cur = rows.filter(r => r.day >= last.from), old = rows.filter(r => r.day < last.from);
      const c = cur.reduce((s, r) => s + r.cost, 0), o = old.reduce((s, r) => s + r.cost, 0);
      const lines = [`**上周（${last.from.slice(5)} ~ ${last.to.slice(5)}）费用 ${yuan(c)}**，较前一周 ${chg(c, o)}，日均 ${yuan(c / 7)}`];
      const ps = provSplit(cur); if (ps) lines.push(ps);
      const kc = sumBy(cur, r => r.id), ko = new Map(sumBy(old, r => r.id).map(x => [x.k, x.cost]));
      const tk = top(kc.map(x => ({ id: x.k, cost: x.cost })), 5, r => this.keyName(r.id, keys), c);
      if (tk.length) lines.push('', '#### API Key Top 5', ...tk);
      const up = kc.map(x => ({ id: x.k, d: x.cost - (ko.get(x.k) || 0) })).filter(x => x.d >= 1).sort((x, y) => y.d - x.d).slice(0, 3);
      if (up.length) lines.push('', '#### 增长最快', ...up.map(x => `${this.keyName(x.id, keys)} +${yuan(x.d)}`));
      const tm = top(this.store.dailyByModel(last.from, last.to), 3, r => clean(r.model), c);
      if (tm.length) lines.push('', '#### 模型 Top 3', ...tm);
      return { title: `费用周报 · ${last.key}`, level: 'info', lines, empty: c < 0.005 && o < 0.005, period: last.key };
    }
    // monthly
    const cycle = addMonths(today.slice(0, 7), -1), pcyc = addMonths(cycle, -1);
    const rows = this.store.monthByKey(cycle), prows = this.store.monthByKey(pcyc);
    const c = rows.reduce((s, r) => s + r.cost, 0), g = rows.reduce((s, r) => s + (r.gross || 0), 0), o = prows.reduce((s, r) => s + r.cost, 0);
    const lines = [`**${cycle} 账期应付 ${yuan(c)}**，较上月 ${chg(c, o)}${g > c ? `，原价 ${yuan(g)}，优惠 ${yuan(g - c)}` : ''}`];
    if (b.monthly) lines.push(`月度预算 ${yuan(b.monthly)}，${c > b.monthly ? `超出 ${yuan(c - b.monthly)}` : `使用 ${pct(c / b.monthly * 100)}`}`);
    const ps = provSplit(rows); if (ps) lines.push(ps);
    const tk = top(sumBy(rows, r => r.id).map(x => ({ id: x.k, cost: x.cost })), 5, r => this.keyName(r.id, keys), c);
    if (tk.length) lines.push('', '#### API Key Top 5', ...tk);
    const cc = sumBy(rows, r => clean(keys.get(r.id)?.tag?.cost_center) || '未分配成本中心');
    if (cc.length > 1 || (cc[0] && cc[0].k !== '未分配成本中心')) lines.push('', '#### 按成本中心', ...top(cc.map(x => ({ k: x.k, cost: x.cost })), 6, r => r.k, c));
    const tm = top(this.store.monthByModel(cycle), 3, r => clean(r.model), c);
    if (tm.length) lines.push('', '#### 模型 Top 3', ...tm);
    return { title: `费用月报 · ${cycle}`, level: 'info', lines, empty: c < 0.005 && o < 0.005, period: cycle, ready: isCycleFinal(cycle, today) };
  }

  /* ---------- 评估并发送 ---------- */
  /** 串行执行；某渠道失败时该渠道的条目保持未发送，下次检查时重试 */
  check(trigger = 'sync') {
    const run = async () => {
      const s = this.settings();
      const chans = s.channels.filter(c => c.enabled);
      if (!chans.length) return { skipped: 'disabled' };
      const today = todayIn(this.tz), cycle = today.slice(0, 7), hour = hourIn(this.tz), st = this.stateFor(cycle);
      const afterHour = hour >= s.reportHour;
      const lazy = {};
      const get = (k, f) => (lazy[k] ??= f());
      let sent = 0, errors = [];
      for (const ch of chans) {
        const sec = this.secretsOf(ch.id);
        if (!sec.webhook) continue;
        st.sent[ch.id] ||= {};
        st.reports[ch.id] ||= {};
        const msgs = [];
        const alertMsg = (event, title, items) => {
          const fresh = items.filter(i => !st.sent[ch.id][i.code]);
          if (!fresh.length) return;
          const show = fresh.filter(i => !i.hidden);
          if (!show.length) { for (const i of fresh) st.sent[ch.id][i.code] = Date.now(); return; }
          const level = show.some(i => i.level === 'bad') ? 'bad' : show.every(i => i.level === 'good') ? 'good' : show.some(i => i.level === 'warn') ? 'warn' : 'info';
          msgs.push({ event, title, level, lines: show.map(i => i.text), codes: fresh.map(i => i.code), mention: EVENT_TYPES[event].mention && level !== 'good' });
        };
        if (ch.events.budget) alertMsg('budget', `预算告警 · ${cycle}`, get('budget', () => this.evaluateBudget(today)));
        if (ch.events.anomaly && afterHour) alertMsg('anomaly', `费用异常提醒 · ${addDays(today, -1)}`, get('anomaly', () => this.evaluateAnomaly(today)));
        if (ch.events.sync) alertMsg('sync', '数据同步告警', get('sync', () => this.evaluateSync()));
        if (ch.events.keyChange) {
          if (st.lastChangeId[ch.id] == null) st.lastChangeId[ch.id] = this.store.maxChangeId(); // 首次启用不补发历史变更
          const items = this.evaluateChanges(st.lastChangeId[ch.id]);
          if (items.length) { msgs.push({ event: 'keyChange', title: `API Key 变更通知（${items.length} 项）`, level: items.some(i => i.level === 'warn') ? 'warn' : 'info', lines: items.map(i => i.text), changeTo: Math.max(...items.map(i => i.id)) }); }
        } else delete st.lastChangeId[ch.id];
        if (afterHour) {
          for (const kind of ['daily', 'weekly', 'monthly']) {
            if (!ch.events[kind]) continue;
            const r = get('report:' + kind, () => this.report(kind, today));
            if (kind === 'monthly' && !r.ready) continue;
            if (st.reports[ch.id][kind] === r.period) continue;
            if (r.empty) { st.reports[ch.id][kind] = r.period; continue; }
            msgs.push({ event: kind, title: r.title, level: r.level, lines: r.lines, report: { kind, period: r.period } });
          }
        }
        for (const m of msgs) {
          try {
            await this.send(ch, sec, { ...m, today });
            const now = Date.now();
            for (const c of m.codes || []) st.sent[ch.id][c] = now;
            if (m.report) st.reports[ch.id][m.report.kind] = m.report.period;
            if (m.changeTo) st.lastChangeId[ch.id] = m.changeTo;
            st.channels[ch.id] = { ...(st.channels[ch.id] || {}), lastSentAt: now, lastError: null, lastErrorAt: null };
            st.history = [{ at: now, ch: ch.id, chName: ch.name, event: m.event, level: m.level, title: m.title, items: m.lines.filter(l => l && !l.startsWith('#')).slice(0, 8).map(strip) }, ...(st.history || [])].slice(0, 30);
            this.store.audit('system', '', 'alert.sent', { trigger, channel: ch.name, event: m.event, items: m.codes?.length ?? m.lines.length });
            sent++;
          } catch (e) {
            const msg = String(e.message || e).slice(0, 300);
            st.channels[ch.id] = { ...(st.channels[ch.id] || {}), lastError: msg, lastErrorAt: Date.now() };
            errors.push(`${ch.name}：${msg}`);
            this.log(`告警发送失败（${ch.name} · ${EVENT_TYPES[m.event]?.label}）：${msg}`);
            break; // 该渠道后续消息下次再试
          }
        }
      }
      // 清理已删除渠道的状态
      const ids = new Set(s.channels.map(c => c.id));
      for (const k of ['sent', 'reports', 'lastChangeId', 'channels']) for (const id of Object.keys(st[k] || {})) if (!ids.has(id)) delete st[k][id];
      this.saveState(st);
      if (sent) this.log(`告警/报表已发送 ${sent} 条（${trigger}）`);
      return errors.length ? { sent, error: errors.join('；') } : { sent };
    };
    this.busy = (this.busy || Promise.resolve()).then(run, run).catch(e => { this.log('告警评估失败：' + e.message); return { error: e.message }; });
    return this.busy;
  }

  async send(ch, { webhook, secret }, { title, level, lines, today = todayIn(this.tz), mention = false }) {
    const brand = clean(this.store.branding().name) || '大模型费用分析';
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: this.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const src = this.providers().map(p => PROVIDER_NAMES[p]).join(' / ') || '云厂商';
    const footer = `${brand} · 统计至 ${today} ${time} · 口径：应付金额（税前）· 数据来源：${src}费用中心`;
    const link = this.publicUrl ? this.publicUrl.replace(/\/+$/, '') + '/#/overview' : '';
    const type = ch.type;
    const mentions = mention && (ch.atAll || ch.atMobiles?.length) ? { all: !!ch.atAll, mobiles: ALERT_TYPES[type]?.mention === 'mobile' ? ch.atMobiles || [] : [] } : null;
    const fullTitle = `【${brand}】${title}`;
    const payload = buildMessage(type, { title: fullTitle, level, lines, footer, link, mentions });
    const generic = { event: 'alert', title: fullTitle, level, items: lines.filter(l => l && !l.startsWith('#')).map(strip), text: [fullTitle, ...lines.map(l => (l.startsWith('#') ? l.replace(/^#+\s*/, '') : l ? '- ' + strip(l) : '')), footer].join('\n'), link: link || null, mentions, sentAt: new Date().toISOString() };
    const req = signRequest(type, webhook, secret, payload, generic);
    checkResponse(type, await postJson(req.url, req.body, req.headers, this.allowPrivate));
    // 企业微信 markdown 不支持按手机号 @，追加一条 text 消息提醒；主消息已送达，提醒失败只记录日志，避免重试时重复发送主消息
    if (type === 'wecom' && mentions && (mentions.all || mentions.mobiles.length)) {
      const t = { msgtype: 'text', text: { content: `${fullTitle}，请及时关注。`, mentioned_mobile_list: [...mentions.mobiles, ...(mentions.all ? ['@all'] : [])] } };
      try { checkResponse(type, await postJson(webhook, t, {}, this.allowPrivate)); }
      catch (e) { this.log?.(`企业微信 @ 提醒发送失败（主消息已发送）：${e.message}`); }
    }
  }
  async test(ch, creds) {
    await this.send(ch, creds, { title: '测试消息', level: 'info', mention: true, lines: ['这是一条测试消息，收到即表示通知渠道配置正确。', '告警（预算、费用异常、同步故障）满足条件时发送，同一条件每账期只通知一次；报表在每天设定的时间之后发送。'] });
  }
}
