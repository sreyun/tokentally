/**
 * 告警与报表推送：钉钉 / 飞书 / 企业微信群机器人、通用 Webhook 与邮件（SMTP）（最多 5 个渠道，按渠道订阅事件）
 * 邮件渠道：消息内容之后附上完整的成本概览（日报为昨日所在账期、周报为上周、月报为上月、告警为本月）
 *
 * 事件：
 *  - budget   预算告警：达到预警阈值 / 超出预算 / 预计月末超出总预算 / API Key 预算 / 成本中心预算（同一阈值每账期每渠道只通知一次）
 *  - anomaly  费用异常：昨日原价 ≥ 前 7 日原价日均 × 倍数 且 增量 ≥ 最小金额（整体与单个 Key；按原价判断，不受优惠集中抵扣影响）
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
import { dayStartSec } from './prom.mjs';
import { sendMail, parseRecipients, normalizeSmtp, SMTP_SECURITY } from './smtp.mjs';
import { renderOverviewHtml, renderEmail, scopePredicate } from './overview-mail.mjs';
import { feishuCard, feishuFormatError } from './feishu-card.mjs';
import { feishuAppLink } from './share.mjs';
import { NO_CC } from './db.mjs';

/** 推送范围：全部 / 指定 API Key / 指定业务空间（最多 200 个） */
export const SCOPE_TYPES = { all: '全部', key: '指定 API Key', ws: '指定业务空间' };
export function cleanScope(s) {
  if (!s || typeof s !== 'object') return { type: 'all', ids: [] };
  const type = Object.hasOwn(SCOPE_TYPES, s.type) ? s.type : 'all';
  const ids = type === 'all' ? [] : [...new Set((Array.isArray(s.ids) ? s.ids : []).map(String).filter(x => /^[\w:.@-]{1,128}$/.test(x)))].slice(0, 200);
  return { type: ids.length ? type : 'all', ids };
}

export const ALERT_TYPES = {
  dingtalk: { label: '钉钉群机器人', hosts: ['oapi.dingtalk.com'], sign: true, mention: 'mobile' },
  feishu: { label: '飞书群机器人', hosts: ['open.feishu.cn', 'open.larksuite.com'], sign: true, mention: 'all' },
  wecom: { label: '企业微信群机器人', hosts: ['qyapi.weixin.qq.com'], sign: false, mention: 'mobile' },
  generic: { label: '通用 Webhook（JSON）', hosts: null, sign: true, mention: 'mobile' },
  email: { label: '邮件（附成本概览）', hosts: null, sign: false, mention: null, email: true },
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
  const t = Object.hasOwn(ALERT_TYPES, type) ? ALERT_TYPES[type] : null;
  if (!t) throw new Error('不支持的通知类型');
  if (t.email) return parseRecipients(raw).join(', '); // 邮件渠道：“地址”为收件人列表（同样加密保存）
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
/** 收件人脱敏：ab***@example.com 等 N 个 */
export function maskEmails(raw) {
  const list = String(raw || '').split(/,\s*/).filter(Boolean);
  return list.slice(0, 3).map(e => e.replace(/^(.{1,2})[^@]*(@.*)$/, '$1***$2')).join(', ') + (list.length > 3 ? ` 等 ${list.length} 个` : '');
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
    // 总时限：timeout 只是空闲超时，持续缓慢回传数据的地址会让请求一直挂起，阻塞所有渠道的告警队列
    // req 先声明再启动计时器：此前计时器在 req 初始化之前创建，https.request 同步抛错（如地址协议不是 https）时，
    // 15 秒后计时器访问未初始化的 req 抛出 ReferenceError，成为未捕获异常导致整个服务退出
    let done = false, req = null;
    const timer = setTimeout(() => { if (req) req.destroy(new Error('请求超时（15 秒）')); else finish(reject, new Error('请求超时（15 秒）')); }, 15_000);
    timer.unref?.();
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    try {
      req = https.request(url, {
        method: 'POST', timeout: 8000, lookup: allowPrivate ? undefined : safeLookup,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'User-Agent': 'tokentally-alert/1.2', ...headers },
      }, res => {
        const chunks = []; let size = 0;
        res.on('data', c => { size += c.length; if (size > 65536) req.destroy(new Error('响应内容过大')); else chunks.push(c); });
        res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', e => finish(reject, e));
      });
      req.on('timeout', () => req.destroy(new Error('请求超时（8 秒）')));
      req.on('error', e => finish(reject, e));
      req.end(data);
    } catch (e) { finish(reject, e); }
  });
}

/* ---------------- 消息格式 ---------------- */
const yuan = n => (n < 0 ? '-' : '') + '¥' + Math.abs(Number(n || 0)).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (Number.isFinite(n) ? n.toFixed(1) + '%' : '—');
const chg = (a, b) => (b > 0 ? `${a >= b ? '+' : '−'}${Math.abs((a - b) / b * 100).toFixed(1)}%` : a > 0 ? '新增' : '持平');
/** 按长度截断且不切开表情等代理对：切开后 JSON 中为孤立的 \ud83d，机器人与邮件中显示为乱码 */
export const cut = (s, n) => String(s ?? '').slice(0, n).replace(/[\uD800-\uDBFF]$/, '');
/** 来自云厂商的文本（Key 备注、错误信息等）：去掉可构成 Markdown 链接/格式的字符，合并空白，按长度截断 */
export const cleanText = (s, n) => cut(String(s || '').replace(/[[\]()<>*_`#|\\~]/g, '').replace(/\s+/g, ' ').trim(), n);
/** 名称（Key 描述、模型、业务空间、成本中心等）：最多 40 个字符 */
export const clean = s => cleanText(s, 40);
const strip = s => String(s).replace(/\*\*/g, '');
/**
 * 邮件发送结果中被服务器拒绝的收件人（sendMail 返回 { accepted, rejected }，如“typo@example.com（550）”）→ 提示文字；没有时为 null。
 * 地址与渠道卡片一致做脱敏（ty***@example.com）：收件人列表只写不回显，提示中不能露出完整地址
 */
export const rejectedNote = res => (Array.isArray(res?.rejected) && res.rejected.length
  ? `部分收件人被邮件服务器拒绝：${res.rejected.slice(0, 5).map(r => String(r).replace(/^(.{1,2})[^@]*(@.*)$/, '$1***$2')).join('、')}${res.rejected.length > 5 ? ` 等 ${res.rejected.length} 个` : ''}`
  : null);
/** 涨跌（飞书卡片着色用）：{ label, text: '+2.0%', dir: up / down / null } */
const delta = (label, a, b) => ({ label, text: chg(a, b), dir: b > 0 && Math.abs(a - b) >= 0.005 ? (a > b ? 'up' : 'down') : null });
/**
 * 排行：[{ name, value, share, sub? }]；与文本消息中的“1. 名称 ¥金额（占比）”一一对应。
 * extra(r) 可附加 sub: { text, level }（如成本中心的预算使用情况），飞书卡片显示在名称下方，文本消息接在行尾
 */
const topRows = (rows, n, nameOf, total, extra = null) => rows.filter(r => r.cost > 0.005).sort((x, y) => y.cost - x.cost).slice(0, n).map(r => ({ name: nameOf(r), value: yuan(r.cost), share: pct(total ? r.cost / total * 100 : 0), ...(extra ? extra(r) : {}) }));
/**
 * 排行区块的表头与说明：kind = cost（费用，单位元）/ token（Token 用量）/ delta（增加金额）；basis 为占比的分母（如“昨日总费用”）。
 * 飞书卡片显示表头行与灰色说明，文本消息在小标题后注明，避免把占比误读为涨跌幅
 */
const head = (kind, name, basis) => ({
  kind, head: kind === 'token' ? [name, 'Token 用量', '占比'] : kind === 'delta' ? [name, '增加金额（元）'] : [name, '费用（元）', '占比'],
  note: kind === 'delta' ? '按增加金额排序' : `按${kind === 'token' ? ' Token 用量' : '费用'}排序 · 占比 = 占${basis}`,
});
const rowLines = (rows, kind) => rows.map((r, i) => `${i + 1}. ${r.name} ${r.value}${kind === 'token' ? ' Token' : ''}${r.share ? `（占 ${r.share}）` : ''}${r.sub?.text ? `，${r.sub.text}` : ''}`);
/** 结构化分节 → 文本行（钉钉 / 企业微信 / 邮件 / 通用 Webhook / 通知记录使用） */
const sectionLines = sections => sections.flatMap(s => (s.rows?.length ? ['', `#### ${s.title}${s.note ? `（${s.note}）` : ''}`, ...rowLines(s.rows, s.kind)] : s.items?.length ? ['', `#### ${s.title}`, ...s.items.map(i => i.text)] : []));
/**
 * Token 单位：默认用“亿”（最大值不少于 0.1 亿时整组统一用亿，如 0.29 亿，避免同一组里亿与万混用、趋势图标签过长），
 * 量很小的账号依次用“万”与“个”
 */
const tokUnit = max => (max >= 1e7 ? { div: 1e8, unit: '亿', dec: 2 } : max >= 1e4 ? { div: 1e4, unit: '万', dec: 1 } : { div: 1, unit: '', dec: 0 });
const tokIn = (n, u) => (Number(n || 0) / u.div).toLocaleString('zh-CN', { minimumFractionDigits: u.dec, maximumFractionDigits: u.dec }) + (u.unit ? ' ' + u.unit : '');
/** Token 数量（指标面板等单个数值）：与排行、趋势图同一规则——不少于 0.1 亿用“亿”，否则用“万”，很小时用整数 */
const tok = n => tokIn(n, tokUnit(Number(n) || 0));
/** 单位成本：每百万 Token 的应付金额 */
const perM = (cost, tokens) => (tokens > 0 ? `¥${(cost / tokens * 1e6).toFixed(2)} / 百万 Token` : '—');
const perMv = (cost, tokens) => (tokens > 0 ? `¥${(cost / tokens * 1e6).toFixed(2)}` : '—');
/** Token 排行：[{ name, value: 'x.xx 亿', share }]，同一区块统一单位 */
const tokRows = (rows, n, nameOf, total) => {
  const list = rows.filter(r => (r.tokens || 0) > 0).sort((x, y) => y.tokens - x.tokens).slice(0, n), u = tokUnit(list[0]?.tokens || 0);
  return list.map(r => ({ name: nameOf(r), value: tokIn(r.tokens, u), share: pct(total ? r.tokens / total * 100 : 0) }));
};
/** 用量涨跌：Token 增加不一定是坏事，卡片中用中性颜色显示 */
const udelta = (label, a, b) => ({ ...delta(label, a, b), neutral: true });
/** 每日柱状图数据：from..to 每天一根柱子，k 用于分组着色；val 取值（默认应付金额），scale 换算单位；有数据的天数不足 3 天时不画图 */
function dailyChart(title, rows, from, to, kOf, colors, val = r => r.cost || 0, scale = 1) {
  const by = new Map();
  for (const r of rows) by.set(r.day, (by.get(r.day) || 0) + val(r));
  const first = [...by.keys()].sort()[0];
  if (!first) return null;
  const values = [];
  for (let d = first > from ? first : from; d <= to; d = addDays(d, 1)) values.push({ d: d.slice(5), v: Math.round((by.get(d) || 0) * scale * 100) / 100, k: kOf(d) });
  return values.length >= 3 ? { title, values, colors, unit: '元' } : null;
}
/** 每日 Token 柱状图：按区间内单日最大值选择单位（默认亿），标题注明单位 */
function tokenChart(title, rows, from, to, kOf, colors) {
  const by = new Map();
  for (const r of rows) if (r.day >= from && r.day <= to) by.set(r.day, (by.get(r.day) || 0) + (r.tokens || 0));
  const u = tokUnit(Math.max(0, ...by.values()));
  const c = dailyChart(`${title}（${u.unit || '个'}）`, rows, from, to, kOf, colors, r => r.tokens || 0, 1 / u.div);
  return c && { ...c, unit: u.unit || '个' };
}
const pause = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const BLUE = '#3370FF', BLUE_L = '#B7CBF9', TEAL = '#14A38B', TEAL_L = '#A7DED4';

/**
 * 机器人消息长度上限按 UTF-8 字节计算（企业微信 markdown 4096 字节、钉钉 20000 字节、飞书卡片约 30KB；中文每字 3 字节）。
 * 超出时从正文末尾按整行删减并注明，页眉、页脚与链接保留；按字符数截断会让中文消息仍然超限而被拒绝，并在每次检查时重复失败
 */
export const MSG_BYTES = { wecom: 4000, dingtalk: 18000, feishu: 25000 };
export function fitLines(head, body, tail, maxBytes) {
  const size = arr => Buffer.byteLength(arr.join('\n'), 'utf8');
  if (size([...head, ...body, ...tail]) <= maxBytes) return [...head, ...body, ...tail];
  // 线性计算：逐行累计字节数（上千行的预算告警不能反复拼接整条消息）
  const fixed = size([...head, ...tail]) + 1, lens = body.map(l => Buffer.byteLength(l, 'utf8') + 1);
  let kept = 0, used = fixed;
  const note = n => Buffer.byteLength(`…另有 ${n} 行内容未显示`, 'utf8') + 1;
  while (kept < body.length && used + lens[kept] + note(body.length - kept - 1) <= maxBytes) used += lens[kept++];
  const dropped = body.length - kept;
  const out = [...head, ...body.slice(0, kept), `…另有 ${dropped} 行内容未显示`, ...tail];
  return size(out) <= maxBytes ? out : [Buffer.from(out.join('\n'), 'utf8').subarray(0, maxBytes - 3).toString('utf8').replace(/�+$/, '')];
}
function buildMessage(type, { title, level, lines, footer, link, mentions, share = null }) {
  // 只读分享链接（无需登录的交互报表）放在“打开费用分析”（需登录）之前
  const shareMd = share ? [`[查看交互报表（${share.days} 天内有效，无需登录）](${share.url})`] : [];
  const atText = mentions?.mobiles?.length ? '\n\n' + mentions.mobiles.map(m => '@' + m).join(' ') : '';
  if (type === 'dingtalk') {
    const text = fitLines([`### ${title}`, ''], lines.map(l => (l.startsWith('#') || l === '' ? l : `- ${l}`)), ['', `> ${footer}`, ...(share ? ['', ...shareMd] : []), ...(link ? ['', `[打开费用分析](${link})`] : [])], MSG_BYTES.dingtalk - Buffer.byteLength(atText)).join('\n') + atText;
    return { msgtype: 'markdown', markdown: { title, text }, ...(mentions ? { at: { atMobiles: mentions.mobiles || [], isAtAll: !!mentions.all } } : {}) };
  }
  if (type === 'feishu') {
    const content = fitLines([], lines.map(l => (l.startsWith('#') ? `**${l.replace(/^#+\s*/, '')}**` : l === '' ? '' : `• ${l}`)), ['', `<font color='grey'>${footer}</font>`, ...(mentions?.all ? ['<at id=all></at>'] : [])], MSG_BYTES.feishu).join('\n');
    const elements = [{ tag: 'markdown', content }];
    const btns = [share && { text: '查看交互报表', url: share.feishu || share.url, type: 'primary' }, link && { text: '打开费用分析', url: link, type: share ? 'default' : 'primary' }].filter(Boolean);
    if (btns.length) elements.push({ tag: 'action', actions: btns.map(b => ({ tag: 'button', text: { tag: 'plain_text', content: b.text }, type: b.type, url: b.url })) });
    return { msg_type: 'interactive', card: { config: { wide_screen_mode: true }, header: { template: level === 'bad' ? 'red' : level === 'warn' ? 'orange' : level === 'good' ? 'green' : 'blue', title: { tag: 'plain_text', content: title } }, elements } };
  }
  if (type === 'wecom') {
    const color = level === 'bad' ? 'warning' : level === 'warn' ? 'comment' : 'info';
    const content = fitLines([`### <font color="${color}">${title}</font>`], lines.map(l => (l.startsWith('#') ? `**${l.replace(/^#+\s*/, '')}**` : l === '' ? '' : `> ${l}`)), [`<font color="comment">${footer}</font>`, ...shareMd, ...(link ? [`[打开费用分析](${link})`] : [])], MSG_BYTES.wecom).join('\n');
    return { msgtype: 'markdown', markdown: { content } };
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
  // 机器人拒绝了消息内容（而非网络 / 鉴权问题）：标记 content，发送循环会继续尝试该渠道的后续消息
  if (code != null && Number(code) !== 0) throw Object.assign(new Error(`${j.errmsg || j.msg || j.StatusMessage || '机器人返回错误'}（错误码 ${code}）`), { content: /length|exceed|content|长度|过长|invalid.*(markdown|msg)/i.test(String(j.errmsg || j.msg || '')) });
}

/**
 * 限定范围的渠道是否接收某条预算告警：API Key 预算看该 Key 是否在范围内；成本中心预算要求该成本中心的 Key 全部在范围内
 * （成本中心的费用含范围外的 Key 或无 API Key 的费用时不推送，与总预算只推送给“全部”范围的渠道同理）；总预算不推送给限定范围的渠道
 */
export function budgetInScope(item, scope) {
  if (!scope) return true;
  const k = /^key:([^:]*):/.exec(item.code);
  if (k) return scope.keys.has(k[1]);
  if (item.members) return item.members.length > 0 && item.members.every(id => scope.keys.has(id));
  return false;
}
/** 成本中心预算告警的去重编码片段：名称可能含冒号，编码后放入 cc:<名称>:over|pct:...（孤立的代理字符先替换，避免 encodeURIComponent 抛错） */
const ccCode = cc => encodeURIComponent(String(cc).toWellFormed());
/** 成本中心的显示名称 */
export const ccLabel = cc => (cc === NO_CC ? '未分配成本中心' : clean(cc) || '（空）');

/** 告警卡片标题栏的状态标签 */
function alertTag(event, level, n) {
  if (event === 'budget') return level === 'bad' ? { text: '已超支', level: 'bad' } : { text: '预算预警', level: 'warn' };
  if (event === 'anomaly') return { text: `${n} 项异常`, level: 'warn' };
  if (event === 'sync') return level === 'good' ? { text: '已恢复', level: 'good' } : { text: '同步故障', level: 'bad' };
  if (event === 'keyChange') return { text: `${n} 项变更`, level: 'info' };
  return null;
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
      const type = Object.hasOwn(ALERT_TYPES, s.type) ? s.type : 'dingtalk';
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
      channels: (Array.isArray(s.channels) ? s.channels : []).map(c => ({ ...c, events: { ...DEFAULT_EVENTS, ...(c.events || {}) }, atMobiles: cleanMobiles(c.atMobiles), atAll: !!c.atAll, scope: cleanScope(c.scope), share: !!c.share })),
      rules: { ...DEFAULT_RULES, ...(s.rules || {}) },
      anomaly: { ...DEFAULT_ANOMALY, ...(s.anomaly || {}) },
      reportHour: Number.isInteger(s.reportHour) ? s.reportHour : 9,
      // 只读分享链接有效期（天）：渠道开启“附带交互报表链接”时使用
      shareDays: Number.isInteger(s.shareDays) && s.shareDays >= 1 && s.shareDays <= 90 ? s.shareDays : 7,
    };
  }
  secretsOf(id) {
    try { return { webhook: this.store.getSecret(`alerts.ch.${id}.webhook`) || '', secret: this.store.getSecret(`alerts.ch.${id}.secret`) || '' }; }
    catch { return { webhook: '', secret: '', undecryptable: true }; }
  }
  /**
   * 告警状态。sent（预算 / 异常）按账期重置：新账期重新评估；
   * syncSent（同步故障 / 恢复）不随账期重置：一轮持续跨月的故障不能在月初再通知一次（保留 90 天）
   */
  stateFor(cycle) {
    const st = this.store.getSetting('alerts.state', null) || {};
    const base = { cycle, sent: {}, syncSent: st.syncSent || {}, reports: st.reports || {}, lastChangeId: st.lastChangeId || {}, channels: st.channels || {}, history: st.history || [] };
    return st.cycle === cycle ? { ...base, sent: st.sent || {} } : base;
  }
  saveState(st) { this.store.setSetting('alerts.state', st); }

  /* ---------- 保存配置：只保存，不补发 ---------- */
  /**
   * 保存告警配置时调用（不发送任何消息）。以下情况视为“新订阅”，当前已到点 / 已满足条件的内容记为已处理、不补发，
   * 之后只在下一次到点或出现新的条件时推送：
   *  - 新增渠道、重新启用渠道、新勾选某个事件；
   *  - 修改推送范围（预算告警与费用异常按新范围重新计算，当前已满足的条件不补发）；
   *  - 报表时间改到今天已经过去的时刻（今天的日报 / 本周的周报 / 异常检查不在保存后立即补发）。
   * 到点规则：日报为每天报表时间；周报为每周一报表时间；月报为上月出账后（保存时已出账的上月月报不补发）；
   *          费用异常在每天报表时间检查昨日；预算告警与同步故障在条件出现时发送。
   * 基线在保存时立即计算（以保存时刻的数据为准），并持久化到 alerts.arm：有检查正在进行时（其结束时会整体写回状态）
   * 由下一次检查在开始时合并，避免并发写入互相覆盖；服务重启也不会丢失。返回登记的渠道数。
   */
  arm(prev, next) {
    const today = todayIn(this.tz), cycle = today.slice(0, 7), hour = hourIn(this.tz);
    const afterNew = hour >= next.reportHour, hourPast = afterNew && hour < prev.reportHour;
    const prevById = new Map((prev.channels || []).map(c => [c.id, c]));
    const scopeKey = sc => { const c = cleanScope(sc); return c.type + ':' + [...c.ids].sort().join(','); };
    const lazy = {}, get = (k, f) => (lazy[k] ??= f());
    const marks = [];
    for (const ch of next.channels) {
      if (!ch.enabled) continue;
      const o = prevById.get(ch.id), wasOn = e => !!(o && o.enabled && o.events?.[e]);
      const scopeChanged = !!o && scopeKey(o.scope) !== scopeKey(ch.scope);
      // 报表时间提前到已过的时刻：只影响“今天”到点的内容（今天的日报与异常检查、周一的周报）；
      // 此前已到点但尚未发出的报表（如周一账单未入账、周二仍在等待的周报，或等待出账的月报）照常发送，不能因改时间被跳过
      const hourHit = e => hourPast && (e === 'anomaly' || e === 'daily' || (e === 'weekly' && weekday(today) === 1));
      const armed = Object.keys(EVENT_TYPES).filter(e => ch.events[e] && (!wasOn(e) || (scopeChanged && (e === 'budget' || e === 'anomaly')) || hourHit(e)));
      if (!armed.length) continue;
      const scope = this.scopeOf(ch);
      const m = { ch: ch.id, cycle, at: Date.now(), events: armed, sent: [], syncSent: [], reports: {}, lastChangeId: null };
      for (const e of armed) {
        if (e === 'budget') m.sent.push(...get('budget', () => this.evaluateBudget(today)).filter(i => budgetInScope(i, scope)).map(i => i.code));
        else if (e === 'anomaly' && afterNew) m.sent.push(...get('anomaly:' + (scope?.sig || ''), () => this.evaluateAnomaly(today, scope)).map(i => i.code));
        else if (e === 'sync') m.syncSent.push(...get('sync', () => this.evaluateSync()).map(i => i.code));
        else if (e === 'keyChange') m.lastChangeId = get('maxChange', () => this.store.maxChangeId());
        else if (e === 'daily' && afterNew) m.reports.daily = today;
        else if (e === 'weekly' && (weekday(today) !== 1 || afterNew)) m.reports.weekly = isoWeek(addDays(isoWeek(today).from, -1)).key;
        else if (e === 'monthly' && get('monthlyReady', () => this.monthlyReady(today))) m.reports.monthly = addMonths(cycle, -1);
      }
      marks.push(m);
    }
    if (!marks.length) return 0;
    const q = this.store.getSetting('alerts.arm', null);
    this.store.setSetting('alerts.arm', [...(Array.isArray(q) ? q : []), ...marks].slice(-50));
    if (!this.running) this.applyArm(); // 没有检查在进行：立即合并（JS 单线程，此刻不会有检查读写状态）
    return marks.length;
  }
  /** 把基线合并进状态（纯函数，不保存）；预算 / 异常的标记只在同一账期内有效（预算条目编码不含账期，跨账期合并会压制新账期的告警） */
  mergeArm(st, q) {
    for (const m of q || []) {
      if (!m || !m.ch) continue;
      if (m.cycle === st.cycle) { const s = (st.sent[m.ch] ||= {}); for (const c of m.sent || []) s[c] ??= m.at; }
      const y = (st.syncSent[m.ch] ||= {}); for (const c of m.syncSent || []) y[c] ??= m.at;
      const r = (st.reports[m.ch] ||= {}); for (const [k, p] of Object.entries(m.reports || {})) if (r[k] == null || String(r[k]) < String(p)) r[k] = p;
      if (m.lastChangeId != null) st.lastChangeId[m.ch] = Math.max(Number(st.lastChangeId[m.ch]) || 0, m.lastChangeId);
    }
    return st;
  }
  applyArm() {
    const q = this.store.getSetting('alerts.arm', null);
    if (!Array.isArray(q) || !q.length) return;
    this.saveState(this.mergeArm(this.stateFor(todayIn(this.tz).slice(0, 7)), q));
    this.store.setSetting('alerts.arm', []);
  }
  /** 渠道下一次报表的发送时间（展示用）：{ daily, weekly, monthly } 文本 */
  nextRuns(ch, st, today = todayIn(this.tz), hour = hourIn(this.tz), reportHour = this.settings().reportHour) {
    const r = st.reports[ch.id] || {}, hh = `${String(reportHour).padStart(2, '0')}:00`, at = d => `${d.slice(5)} ${hh}`, after = hour >= reportHour;
    const cycle = today.slice(0, 7), prevCycle = addMonths(cycle, -1), nextCycle = addMonths(cycle, 1);
    const out = {};
    // “待发送”：已到点但尚未发出（账单尚未入账、上次发送失败等），下一次检查（每 5 分钟 / 同步完成后）发送
    if (ch.events.daily) out.daily = r.daily === today ? at(addDays(today, 1)) : after ? '待发送' : at(today);
    if (ch.events.weekly) {
      const last = isoWeek(addDays(isoWeek(today).from, -1)).key, mon = isoWeek(today).from;
      out.weekly = r.weekly === last ? at(addDays(mon, 7)) + '（周一）' : weekday(today) === 1 && !after ? at(mon) + '（周一）' : '待发送';
    }
    if (ch.events.monthly) {
      out.monthly = r.monthly === prevCycle ? `${nextCycle.slice(5)} 月初出账后（约 ${nextCycle.slice(5)}-04，最晚 ${nextCycle.slice(5)}-10）`
        : this.monthlyReady(today) ? (after ? '待发送' : `今天 ${hh}`) : `${prevCycle.slice(5)} 月账单出账后（约 ${cycle.slice(5)}-04，最晚 ${cycle.slice(5)}-10）`;
    }
    return out;
  }

  out() {
    const s = this.settings(), today = todayIn(this.tz), cycle = today.slice(0, 7), hour = hourIn(this.tz);
    // 展示时包含尚未合并的基线（检查进行中保存的配置），避免“当前满足条件、尚未通知”误列出不会补发的条目
    const st = this.mergeArm(this.stateFor(cycle), this.store.getSetting('alerts.arm', null));
    const budgetItems = this.evaluateBudget().filter(i => !i.hidden);
    // “待通知”只列出会推送给某个渠道的条目：限定范围的渠道不接收范围外的 Key / 成本中心预算，也不接收总预算
    const subs = s.channels.filter(c => c.enabled && c.events.budget).map(c => ({ c, scope: this.scopeOf(c) }));
    return {
      ...s,
      channels: s.channels.map(c => {
        const sec = this.secretsOf(c.id), cs = st.channels[c.id] || {};
        return { ...c, scopeLabel: this.scopeOf(c)?.label || '', webhookSet: !!sec.webhook, webhookMasked: c.type === 'email' ? maskEmails(sec.webhook) : maskWebhook(sec.webhook), secretSet: !!sec.secret, undecryptable: !!sec.undecryptable, lastSentAt: cs.lastSentAt || null, lastError: cs.lastError || null, lastErrorAt: cs.lastErrorAt || null, lastWarning: cs.lastWarning || null, lastWarningAt: cs.lastWarningAt || null, nextRuns: c.enabled ? this.nextRuns(c, st, today, hour, s.reportHour) : {} };
      }),
      enabled: s.channels.some(c => c.enabled),
      shareAvailable: !!this.shares?.available,
      types: Object.fromEntries(Object.entries(ALERT_TYPES).map(([k, v]) => [k, { label: v.label, sign: v.sign, host: v.hosts?.[0] || '', mention: v.mention, email: !!v.email }])),
      eventTypes: EVENT_TYPES, maxChannels: MAX_CHANNELS,
      smtp: { ...this.smtpSettings(), passwordSet: this.smtpPasswordSet(), securities: SMTP_SECURITY },
      state: { cycle, history: (st.history || []).slice(0, 30) },
      pending: budgetItems.filter(i => subs.some(({ c, scope }) => budgetInScope(i, scope) && !st.sent[c.id]?.[i.code])).map(i => strip(i.text)),
    };
  }

  /* ---------- 推送范围 ---------- */
  /** 渠道的推送范围：null 表示全部；否则 { type, ids, keys（范围内的 API Key）, label, sig（用于去重编码）} */
  scopeOf(ch) {
    const sc = cleanScope(ch.scope);
    if (sc.type === 'all') return null;
    const keys = this.keyMap(), ids = new Set(sc.ids);
    const keySet = sc.type === 'key' ? ids : new Set([...keys.values()].filter(k => ids.has(k.workspace_id)).map(k => k.api_key_id));
    let names;
    if (sc.type === 'key') names = sc.ids.map(id => this.keyName(id, keys));
    else { const ws = new Map(this.store.listWorkspaces().map(w => [w.workspace_id, w.name])); for (const k of keys.values()) if (k.workspace_id && k.workspace_name && !ws.get(k.workspace_id)) ws.set(k.workspace_id, k.workspace_name); names = sc.ids.map(id => clean(ws.get(id)) || id); }
    const label = `${sc.type === 'key' ? 'API Key' : '业务空间'} ${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 个` : ''}`;
    return { type: sc.type, ids: sc.ids, keys: keySet, label, sig: crypto.createHash('sha1').update(sc.type + ':' + [...sc.ids].sort().join(',')).digest('hex').slice(0, 10) };
  }
  /**
   * 按推送范围过滤按日账单（dailyByKey(from, to, true) 的结果）：与成本概览、邮件、分享链接使用同一规则——
   * 业务空间范围同时匹配账单行的业务空间与 Key 当前所属的业务空间。此前只按“范围内的 Key”过滤，
   * 业务空间下不属于任何 Key 的费用被漏掉，同一条报表中的“昨日费用”与“本月合计”口径不一致
   */
  scopeRows(rows, scope, keys = this.keyMap()) {
    const pred = scope && scopePredicate(scope, keys);
    return pred ? rows.filter(r => pred({ api_key_id: r.id, workspace_id: r.ws || '' })) : rows;
  }
  /** 限定范围的报表：摘要按范围重新计算（邮件中另附范围内的成本概览） */
  scopedReport(kind, today, scope, globalReady = true) {
    const keys = this.keyMap();
    const o = renderOverviewHtml(this.overviewSpec(kind, today), { store: this.store, today, scope, tz: this.tz });
    const st = o.stats, tag = `（${scope.label}）`;
    const rowsOf = list => list.filter(x => x.cost > 0.005).map(x => ({ name: clean(x.name), value: yuan(x.cost), share: st.cost ? pct(x.cost / st.cost * 100) : '' }));
    const scopeNote = `推送范围：${scope.label}`;
    const budgetKpi = st.budget ? [{ label: '范围内 Key 预算使用率', value: pct(st.cost / st.budget * 100), tone: st.cost >= st.budget ? 'bad' : null, sub: `预算 ${yuan(st.budget)}` }] : [];
    if (kind === 'daily') {
      const day = addDays(today, -1);
      const rows14 = this.scopeRows(this.store.dailyByKey(addDays(day, -13), day, true), scope, keys);
      const y = rows14.filter(r => r.day === day), pd = rows14.filter(r => r.day === addDays(day, -1));
      const yc = y.reduce((s, r) => s + r.cost, 0), pc = pd.reduce((s, r) => s + r.cost, 0), yt = y.reduce((s, r) => s + (r.tokens || 0), 0), pt = pd.reduce((s, r) => s + (r.tokens || 0), 0);
      const byKey = new Map(); for (const r of y) { const a = byKey.get(r.id) || byKey.set(r.id, { id: r.id, cost: 0, tokens: 0 }).get(r.id); a.cost += r.cost; a.tokens += r.tokens || 0; }
      const sections = [{ title: '昨日 API Key Top 5', rows: topRows([...byKey.values()], 5, r => this.keyName(r.id, keys), yc), ...head('cost', 'API Key', '范围内昨日总费用') }, { title: '昨日 Token 用量 · API Key Top 5', rows: tokRows([...byKey.values()], 5, r => this.keyName(r.id, keys), yt), ...head('token', 'API Key', '范围内昨日总 Token') }];
      const hasTok = (st.tokens || 0) > 0 || rows14.some(r => (r.tokens || 0) > 0);
      const lines = [`**昨日（${day.slice(5)}）费用 ${yuan(yc)}**，较前一日 ${chg(yc, pc)}`, `${st.label} 合计 ${yuan(st.cost)}${st.forecast != null ? `，预计月末 ${yuan(st.forecast)}` : ''}${st.budget ? `，范围内 Key 预算 ${yuan(st.budget)}（已用 ${pct(st.cost / st.budget * 100)}）` : ''}`, ...(hasTok ? [`昨日 Token ${tok(yt)}，较前一日 ${chg(yt, pt)}${yt > 0 ? `，单位成本 ${perM(yc, yt)}` : ''}`] : []), scopeNote, ...sectionLines(sections)];
      const d = delta('较前一日', yc, pc);
      const doc = {
        tags: [{ text: '指定范围', level: 'info' }],
        kpis: [{ label: '昨日费用（元）', value: yuan(yc), delta: d }, { label: `${st.label} 合计（元）`, value: yuan(st.cost), sub: st.forecast != null ? `预计月末 ${yuan(st.forecast)}` : '' }, ...budgetKpi],
        usage: hasTok ? [{ label: '昨日 Token', value: tok(yt), delta: udelta('较前一日', yt, pt) }, { label: `${st.label} Token`, value: tok(st.tokens) }, { label: '昨日单位成本（元）', value: perMv(yc, yt), sub: '每百万 Token' }] : null,
        notes: [scopeNote], sections,
        chart: dailyChart('近 14 日每日费用（元）', rows14, addDays(day, -13), day, x => (x === day ? '昨日' : '此前'), { 此前: BLUE_L, 昨日: BLUE }),
        tokenChart: hasTok ? tokenChart('近 14 日每日 Token', rows14, addDays(day, -13), day, x => (x === day ? '昨日' : '此前'), { 此前: TEAL_L, 昨日: TEAL }) : null,
      };
      return { title: `费用日报 · ${day}${tag}`, level: 'info', lines, doc, empty: yc < 0.005 && st.cost < 0.005, period: today, ready: true, path: '#/overview' };
    }
    const period = kind === 'weekly' ? isoWeek(addDays(isoWeek(today).from, -1)).key : addMonths(today.slice(0, 7), -1);
    const tRows = list => { const u = tokUnit(Math.max(0, ...(list || []).map(x => x.tokens || 0))); return (list || []).map(x => ({ name: clean(x.name), value: tokIn(x.tokens, u), share: st.tokens ? pct(x.tokens / st.tokens * 100) : '' })); };
    const pb = kind === 'weekly' ? '范围内上周总' : `范围内 ${period} 总`;
    const sections = [{ title: 'API Key Top 5', rows: rowsOf(st.topKeys), ...head('cost', 'API Key', pb + '费用') }, { title: '模型 Top 3', rows: rowsOf(st.topModels), ...head('cost', '模型', pb + '费用') }, { title: 'Token 用量 · API Key Top 5', rows: tRows(st.tokenKeys), ...head('token', 'API Key', pb + ' Token') }, { title: 'Token 用量 · 模型 Top 3', rows: tRows(st.tokenModels), ...head('token', '模型', pb + ' Token') }];
    const hasTok = (st.tokens || 0) > 0 || (st.prevTokens || 0) > 0;
    const lines = [`**${kind === 'weekly' ? '上周' : period + ' 账期'}费用 ${yuan(st.cost)}**，较${st.prevLabel} ${chg(st.cost, st.prevCost)}`, ...(hasTok ? [`Token ${tok(st.tokens)}，较${st.prevLabel} ${chg(st.tokens || 0, st.prevTokens || 0)}${st.tokens > 0 ? `，单位成本 ${perM(st.cost, st.tokens)}` : ''}`] : []), scopeNote, ...sectionLines(sections)];
    const d = delta('较' + st.prevLabel, st.cost, st.prevCost);
    const doc = { tags: [{ text: '指定范围', level: 'info' }], kpis: [{ label: kind === 'weekly' ? '上周费用（元）' : `${period} 应付（元）`, value: yuan(st.cost), delta: d }, { label: `${st.prevLabel}（元）`, value: yuan(st.prevCost) }, ...(kind === 'monthly' ? budgetKpi : [])],
      usage: hasTok ? [{ label: kind === 'weekly' ? '上周 Token' : `${period} Token`, value: tok(st.tokens), delta: udelta('较' + st.prevLabel, st.tokens || 0, st.prevTokens || 0) }, { label: '单位成本（元）', value: perMv(st.cost, st.tokens), sub: '每百万 Token' }] : null, notes: [scopeNote], sections };
    return { title: `${kind === 'weekly' ? '费用周报' : '费用月报'} · ${period}${tag}`, level: 'info', lines, doc, empty: st.cost < 0.005 && st.prevCost < 0.005, period, ready: kind === 'monthly' ? globalReady : true, path: '#/overview' };
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
    // 成本中心预算：与 API Key 预算一样受“达到预警阈值 / 超出预算”开关控制（不受“包含 API Key 预算”影响）
    const ccBudgets = (r.over || r.pct) ? Object.entries(b.costCenters || {}).map(([k, v]) => [k, Number(v)]).filter(([, v]) => v > 0) : [];
    if (!b.monthly && !hasKeys && !ccBudgets.length) return [];
    const { month, daily } = this.store.budgetUsage(cycle);
    const cost = new Map(month.map(x => [x.id || '', x.cost || 0]));
    const total = month.reduce((x, y) => x + (y.cost || 0), 0);
    const alertPct = b.alertPct || 80;
    const items = [];
    if (b.monthly) {
      const used = total / b.monthly * 100;
      if (r.over && total >= b.monthly) items.push({ code: `total:over:${b.monthly}`, level: 'bad', tag: '超支', text: `**总预算已超出**：本月应付 ${yuan(total)}，预算 ${yuan(b.monthly)}（${pct(used)}）` });
      if (r.pct && used >= alertPct) items.push({ code: `total:pct:${alertPct}:${b.monthly}`, level: 'warn', tag: '预警', hidden: r.over && total >= b.monthly, text: `**总预算已用 ${pct(used)}**（预警阈值 ${alertPct}%）：${yuan(total)} / ${yuan(b.monthly)}` });
      if (r.forecast && total < b.monthly) {
        const fc = this.forecast(daily, cycle, today);
        if (fc != null && fc >= b.monthly) items.push({ code: `total:forecast:${b.monthly}`, level: 'warn', tag: '预测超支', text: `**预计月末超出总预算**：按日均推算 ${yuan(fc)}，预算 ${yuan(b.monthly)}（超出 ${yuan(fc - b.monthly)}）` });
      }
    }
    // 成本中心预算排在 API Key 预算之前：Key 预算条目可能很多，消息超长时从末尾删减，不能挤掉部门级的告警。
    // 费用 = 本月月账单按 Key 当前的成本中心标签汇总；members 用于限定范围渠道的过滤（budgetInScope），不出现在消息中
    if (ccBudgets.length) {
      const usage = this.store.costCenterUsage(cycle, month);
      for (const [cc, budget] of ccBudgets) {
        const u = usage.get(cc), c = u?.cost || 0, used = c / budget * 100, members = [...(u?.members || [])];
        const name = cc === NO_CC ? '未分配成本中心的费用' : `成本中心「${ccLabel(cc)}」`, code = ccCode(cc);
        if (r.over && c >= budget) items.push({ code: `cc:${code}:over:${budget}`, level: 'bad', tag: '超支', members, text: `**${name}已超出预算**：${yuan(c)} / ${yuan(budget)}（${pct(used)}）` });
        if (r.pct && used >= alertPct) items.push({ code: `cc:${code}:pct:${alertPct}:${budget}`, level: 'warn', tag: '预警', hidden: r.over && c >= budget, members, text: `**${name}预算已用 ${pct(used)}**：${yuan(c)} / ${yuan(budget)}` });
      }
    }
    if (hasKeys) {
      const keys = this.keyMap();
      for (const [id, budget] of Object.entries(b.keys)) {
        if (!budget) continue;
        const c = cost.get(id === '__none__' ? '' : id) || 0, used = c / budget * 100;
        const name = id === '__none__' ? '未关联 API Key 的费用' : `API Key「${this.keyName(id, keys)}」(${id})`;
        if (r.over && c >= budget) items.push({ code: `key:${id}:over:${budget}`, level: 'bad', tag: '超支', text: `**${name} 已超出预算**：${yuan(c)} / ${yuan(budget)}（${pct(used)}）` });
        if (r.pct && used >= alertPct) items.push({ code: `key:${id}:pct:${alertPct}:${budget}`, level: 'warn', tag: '预警', hidden: r.over && c >= budget, text: `**${name} 预算已用 ${pct(used)}**：${yuan(c)} / ${yuan(budget)}` });
      }
    }
    return items;
  }
  /** 预算告警卡片的指标面板（设置了月度总预算时）：本月应付 / 月度预算 / 已用 */
  budgetKpis(today = todayIn(this.tz)) {
    const b = this.store.budgets();
    if (!b.monthly) return null;
    const cycle = today.slice(0, 7), { month, daily } = this.store.budgetUsage(cycle);
    const total = month.reduce((x, y) => x + (y.cost || 0), 0), used = total / b.monthly * 100, fc = this.forecast(daily, cycle, today);
    return [
      { label: '本月应付（元）', value: yuan(total), sub: fc != null ? `预计月末 ${yuan(fc)}` : '' },
      { label: '月度预算（元）', value: yuan(b.monthly), sub: `预警阈值 ${b.alertPct || 80}%` },
      { label: '预算使用率', value: pct(used), tone: used >= 100 ? 'bad' : used >= (b.alertPct || 80) ? 'warn' : null, sub: total > b.monthly ? `超出 ${yuan(total - b.monthly)}` : `剩余 ${yuan(b.monthly - total)}` },
    ];
  }
  /** 兼容旧接口 */
  evaluate(today) { return this.evaluateBudget(today); }
  /** 与前端口径一致：已完整的日 + max(今日实际, 日均) + 完整日日均 × 剩余天数 */
  forecast(daily, cycle, today) {
    if (today.slice(0, 7) !== cycle) return null;
    const from = cycle + '-01', yesterday = addDays(today, -1);
    if (yesterday < from) return null;
    const fullDays = daysBetween(from, yesterday);
    let full = 0, td = 0;
    for (const r of daily) { if (r.day <= yesterday) full += r.cost || 0; else if (r.day === today) td += r.cost || 0; }
    // 今天按“已出账与日均的较大值”计：今天未结束且账单延迟入账，直接用已出账金额会让预测偏低、预算预警偏晚
    const avg = full / fullDays;
    return full + Math.max(td, avg) + avg * Math.max(0, daysInMonth(cycle) - fullDays - 1);
  }

  /* ---------- 费用异常（昨日 vs 前 7 日日均） ---------- */
  /**
   * 按原价（目录价，反映真实用量）判断：优惠券与折扣按云厂商实际抵扣的日期计入，常集中在某几天（当天应付为 0），
   * 若按应付判断，优惠用完后的第一个正常日会被误判为“费用异常”（如生产 10-19：原价只比前 7 日高约 30%，按应付却是 5 倍）
   */
  evaluateAnomaly(today = todayIn(this.tz), scope = null) {
    const a = this.settings().anomaly;
    const day = addDays(today, -1), from = addDays(day, -7);
    const rows = scope ? this.scopeRows(this.store.dailyByKey(from, day, true), scope) : this.store.dailyByKey(from, day);
    const items = [];
    const check = (scope, vals, name) => {
      const yv = vals.get(day), y = yv?.g || 0;
      // 日均只按有记录的日期计算：新 Key / 新账号的前几天不能被未存在的日子（记为 0）拉低基数而连续误报
      const first = [...vals.keys()].sort()[0];
      let base = 0, n = 0; for (let i = 1; i <= 7; i++) { const d = addDays(day, -i); if (first && d >= first) { base += vals.get(d)?.g || 0; n++; } }
      if (n < 3) return; // 历史不足 3 天，无法判断是否异常
      base /= n;
      if (y <= 0 || y <= base || y - base < Math.max(a.minAmount, 0.01)) return;
      if (base > 0 && y < base * a.ratio) return;
      const paid = yv?.p || 0;
      items.push({ code: `anomaly:${scope}:${day}`, level: 'warn', tag: '异常', delta: y - base, text: `**${name}** ${day.slice(5)} 原价 ${yuan(y)}${Math.abs(paid - y) >= 0.005 ? `（应付 ${yuan(paid)}）` : ''}，为前 7 日原价日均 ${yuan(base)} 的 ${base > 0 ? (y / base).toFixed(1) + ' 倍' : '—（此前无消费）'}（+${yuan(y - base)}）` });
    };
    const add = (m, d, r) => { const o = m.get(d) || m.set(d, { g: 0, p: 0 }).get(d); o.g += r.gross ?? r.cost ?? 0; o.p += r.cost || 0; };
    const total = new Map(), byKey = new Map();
    for (const r of rows) {
      add(total, r.day, r);
      if (!byKey.has(r.id)) byKey.set(r.id, new Map());
      add(byKey.get(r.id), r.day, r);
    }
    check(scope ? `scope:${scope.sig}` : 'total', total, scope ? `范围合计（${scope.label}）` : '整体');
    if (a.keys) {
      const keys = this.keyMap(), list = [];
      for (const [id, vals] of byKey) { const before = items.length; check('key:' + (id || '__none__'), vals, `API Key「${this.keyName(id, keys)}」`); if (items.length > before) list.push(items.pop()); }
      items.push(...list.sort((x, y) => y.delta - x.delta).slice(0, 5));
    }
    return items;
  }

  /* ---------- 同步故障（连续失败 3 次）与恢复 ---------- */
  /**
   * 去重标识以“本轮连续失败之前最后一次非失败任务的 ID”为锚点：同一轮故障无论再失败多少次标识都不变（只通知一次），
   * 次数按真实的连续失败次数统计（不受查询窗口限制）
   */
  evaluateSync() {
    const items = [];
    for (const p of this.providers()) {
      for (const kind of ['meta', 'bills']) {
        const runs = this.store.recentRuns(kind, p, 1);
        if (!runs.length) continue;
        const name = `${PROVIDER_NAMES[p]}${kind === 'meta' ? ' API Key 同步' : '账单同步'}`;
        if (runs[0].status === 'error') {
          const { n, anchor } = this.store.errorStreak(kind, p);
          // 错误信息最多 120 字（此前经 clean() 截断为 40 字，阿里云 / 腾讯云的错误码与说明常被截掉一半，无法据此排查）
          if (n >= 3) items.push({ code: `sync:${p}:${kind}:${anchor}`, level: 'bad', tag: '故障', text: `**${name}连续失败 ${n} 次**：${cleanText(runs[0].error, 120) || '未知错误'}` });
        } else {
          const { n, anchor } = this.store.errorStreak(kind, p, runs[0].id);
          if (n >= 3) items.push({ code: `syncok:${p}:${kind}:${anchor}`, level: 'good', tag: '已恢复', text: `**${name}已恢复**：此前连续失败 ${n} 次` });
        }
      }
    }
    return items;
  }

  /* ---------- API Key 变更 ---------- */
  /**
   * 返回 { items, scannedTo }：scannedTo 为本次扫描到的最大变更 ID。
   * 游标必须推进到 scannedTo（而不是最后一条匹配项）：changesSince 每次最多返回 200 条，
   * 若这 200 条全是修改 / 业务空间变更，游标停在原地会让之后的新增 / 删除永远不再通知
   */
  evaluateChanges(sinceId) {
    const CH = { create: '新增', delete: '删除', restore: '恢复' };
    const rows = this.store.changesSince(sinceId);
    const items = rows.filter(c => c.entity === 'api_key' && CH[c.change]).map(c => ({
      code: `chg:${c.id}`, id: c.id, entity: c.entity_id, level: c.change === 'delete' ? 'warn' : c.change === 'restore' ? 'good' : 'info', tag: CH[c.change],
      text: `${CH[c.change]} API Key「${clean(c.name) || '无描述'}」(${c.entity_id})`, body: `API Key「${clean(c.name) || '无描述'}」${c.entity_id}`,
    }));
    return { items, scannedTo: rows.length ? Math.max(...rows.map(c => c.id)) : null };
  }

  /* ---------- 报表 ---------- */
  /**
   * 返回 { title, level, lines, doc, empty, period, ready, path }：
   * lines 为文本消息（钉钉 / 企业微信 / 邮件 / 通用 Webhook）；doc 为结构化内容（飞书卡片：指标面板、趋势图、排行表、异常条目）
   */
  report(kind, today = todayIn(this.tz)) {
    const keys = this.keyMap(), b = this.store.budgets(), alertPct = b.alertPct || 80;
    const sumBy = (rows, f) => { const m = new Map(); for (const r of rows) { const k = f(r); const a = m.get(k) || m.set(k, { k, cost: 0, tokens: 0 }).get(k); a.cost += r.cost || 0; a.tokens += r.tokens || 0; } return [...m.values()]; };
    const provSplit = rows => {
      const ps = sumBy(rows, r => r.provider || 'aliyun');
      return ps.length > 1 ? '按云厂商：' + ps.sort((x, y) => y.cost - x.cost).map(x => `${PROVIDER_NAMES[x.k] || x.k} ${yuan(x.cost)}`).join('，') : null;
    };
    const budgetKpi = (cost, label = '月度预算使用率') => {
      if (!b.monthly) return [];
      const used = cost / b.monthly * 100;
      return [{ label, value: pct(used), tone: used >= 100 ? 'bad' : used >= alertPct ? 'warn' : null, sub: cost > b.monthly ? `超出 ${yuan(cost - b.monthly)}` : `预算 ${yuan(b.monthly)}` }];
    };
    const dirTag = d => (d.dir ? { text: `${d.label} ${d.dir === 'up' ? '↑' : '↓'} ${d.text.replace(/^[+−]/, '')}`, level: d.dir === 'up' ? 'bad' : 'good' } : null);
    if (kind === 'daily') {
      // 月累计按“昨日”所在的月份统计：每月 1 日的日报描述的是上月最后一天，应给出上月合计，而不是本月刚开始的累计
      const day = addDays(today, -1), cycle = day.slice(0, 7), isCur = cycle === today.slice(0, 7);
      const rows14 = this.store.dailyByKey(addDays(day, -13), day);
      const y = rows14.filter(r => r.day === day), p = rows14.filter(r => r.day === addDays(day, -1));
      const yc = y.reduce((s, r) => s + r.cost, 0), pc = p.reduce((s, r) => s + r.cost, 0);
      const yt = y.reduce((s, r) => s + (r.tokens || 0), 0), pt = p.reduce((s, r) => s + (r.tokens || 0), 0);
      const { daily, month } = this.store.budgetUsage(cycle);
      // 月累计与预算使用率按账期（月）账单计算，与预算告警、概览预算条、/metrics 一致；日账单只用于预测
      const mtd = month.reduce((s, r) => s + (r.cost || 0), 0);
      const fc = isCur ? this.forecast(daily, cycle, today) : null;
      const lines = [`**昨日（${day.slice(5)}）费用 ${yuan(yc)}**，较前一日 ${chg(yc, pc)}`];
      lines.push(`${isCur ? '本月累计' : `${cycle} 合计`} ${yuan(mtd)}${fc != null ? `，预计月末 ${yuan(fc)}` : ''}${b.monthly ? `，月度预算 ${yuan(b.monthly)}（已用 ${pct(mtd / b.monthly * 100)}）` : ''}`);
      const ps = provSplit(y); if (ps) lines.push(ps);
      const mt = this.store.monthByKey(cycle).reduce((s, r) => s + (r.tokens || 0), 0);
      // 没有任何 Token 数据（账单不含用量，如只有按次 / 按张计费的模型）时不显示用量：否则只是一组“0 / 持平 / —”和全为 0 的趋势图
      const hasTok = mt > 0 || rows14.some(r => (r.tokens || 0) > 0);
      if (hasTok) lines.push(`昨日 Token ${tok(yt)}，较前一日 ${chg(yt, pt)}${yt > 0 ? `，单位成本 ${perM(yc, yt)}` : ''}；${isCur ? '本月' : cycle} 累计 ${tok(mt)}`);
      const an = this.evaluateAnomaly(today);
      const byKeyY = sumBy(y, r => r.id).map(x => ({ id: x.k, cost: x.cost, tokens: x.tokens })), byModelY = this.store.dailyByModel(day, day);
      const sections = [
        { title: '昨日 API Key Top 5', rows: topRows(byKeyY, 5, r => this.keyName(r.id, keys), yc), ...head('cost', 'API Key', '昨日总费用') },
        { title: '昨日模型 Top 3', rows: topRows(byModelY, 3, r => clean(r.model), yc), ...head('cost', '模型', '昨日总费用') },
        { title: '异常提示', items: an.map(i => ({ text: i.text, tag: i.tag, level: i.level })) },
        { title: '昨日 Token 用量 · API Key Top 5', rows: tokRows(byKeyY, 5, r => this.keyName(r.id, keys), yt), ...head('token', 'API Key', '昨日总 Token') },
        { title: '昨日 Token 用量 · 模型 Top 3', rows: tokRows(byModelY, 3, r => clean(r.model), yt), ...head('token', '模型', '昨日总 Token') },
      ];
      lines.push(...sectionLines(sections));
      const d = delta('较前一日', yc, pc);
      const doc = {
        tags: [dirTag(d), an.length ? { text: `${an.length} 项异常`, level: 'warn' } : null],
        kpis: [{ label: '昨日费用（元）', value: yuan(yc), delta: d }, { label: isCur ? '本月累计（元）' : `${cycle} 合计（元）`, value: yuan(mtd), sub: fc != null ? `预计月末 ${yuan(fc)}` : '' }, ...budgetKpi(mtd)],
        usage: hasTok ? [{ label: '昨日 Token', value: tok(yt), delta: udelta('较前一日', yt, pt) }, { label: isCur ? '本月累计 Token' : `${cycle} Token`, value: tok(mt) }, { label: '昨日单位成本（元）', value: perMv(yc, yt), sub: '每百万 Token' }] : null,
        notes: ps ? [ps] : [], sections,
        chart: dailyChart('近 14 日每日费用（元）', rows14, addDays(day, -13), day, x => (x === day ? '昨日' : '此前'), { 此前: BLUE_L, 昨日: BLUE }),
        tokenChart: hasTok ? tokenChart('近 14 日每日 Token', rows14, addDays(day, -13), day, x => (x === day ? '昨日' : '此前'), { 此前: TEAL_L, 昨日: TEAL }) : null,
      };
      return { title: `费用日报 · ${day}`, level: 'info', lines, doc, empty: yc < 0.005 && mtd < 0.005, period: today, path: `#/overview?from=${day}&to=${day}` };
    }
    if (kind === 'weekly') {
      const last = isoWeek(addDays(isoWeek(today).from, -1)), prev = isoWeek(addDays(last.from, -1));
      const rows = this.store.dailyByKey(prev.from, last.to);
      const cur = rows.filter(r => r.day >= last.from), old = rows.filter(r => r.day < last.from);
      const c = cur.reduce((s, r) => s + r.cost, 0), o = old.reduce((s, r) => s + r.cost, 0);
      const ct = cur.reduce((s, r) => s + (r.tokens || 0), 0), ot = old.reduce((s, r) => s + (r.tokens || 0), 0);
      const lines = [`**上周（${last.from.slice(5)} ~ ${last.to.slice(5)}）费用 ${yuan(c)}**，较前一周 ${chg(c, o)}，日均 ${yuan(c / 7)}`];
      const ps = provSplit(cur); if (ps) lines.push(ps);
      const hasTok = ct > 0 || ot > 0;
      if (hasTok) lines.push(`上周 Token ${tok(ct)}，较前一周 ${chg(ct, ot)}，日均 ${tok(ct / 7)}${ct > 0 ? `，单位成本 ${perM(c, ct)}` : ''}`);
      const byModelW = this.store.dailyByModel(last.from, last.to);
      const kc = sumBy(cur, r => r.id), ko = new Map(sumBy(old, r => r.id).map(x => [x.k, x.cost]));
      const up = kc.map(x => ({ id: x.k, d: x.cost - (ko.get(x.k) || 0) })).filter(x => x.d >= 1).sort((x, y) => y.d - x.d).slice(0, 3);
      const sections = [
        { title: 'API Key Top 5', rows: topRows(kc.map(x => ({ id: x.k, cost: x.cost })), 5, r => this.keyName(r.id, keys), c), ...head('cost', 'API Key', '上周总费用') },
        { title: '增长最快（较前一周）', rows: up.map(x => ({ name: this.keyName(x.id, keys), value: '+' + yuan(x.d) })), ...head('delta', 'API Key') },
        { title: '模型 Top 3', rows: topRows(byModelW, 3, r => clean(r.model), c), ...head('cost', '模型', '上周总费用') },
        { title: 'Token 用量 · API Key Top 5', rows: tokRows(kc.map(x => ({ id: x.k, tokens: x.tokens })), 5, r => this.keyName(r.id, keys), ct), ...head('token', 'API Key', '上周总 Token') },
        { title: 'Token 用量 · 模型 Top 3', rows: tokRows(byModelW, 3, r => clean(r.model), ct), ...head('token', '模型', '上周总 Token') },
      ];
      lines.push(...sectionLines(sections));
      const d = delta('较前一周', c, o);
      const doc = {
        tags: [dirTag(d)],
        kpis: [{ label: '上周费用（元）', value: yuan(c), delta: d }, { label: '日均费用（元）', value: yuan(c / 7), sub: `前一周日均 ${yuan(o / 7)}` }, { label: '有消费的 API Key', value: `${kc.filter(x => x.cost > 0.005).length} 个`, sub: `前一周 ${[...ko.values()].filter(v => v > 0.005).length} 个` }],
        usage: hasTok ? [{ label: '上周 Token', value: tok(ct), delta: udelta('较前一周', ct, ot) }, { label: '日均 Token', value: tok(ct / 7), sub: `前一周日均 ${tok(ot / 7)}` }, { label: '单位成本（元）', value: perMv(c, ct), sub: '每百万 Token' }] : null,
        notes: [`统计周期：${last.from} ~ ${last.to}（较前一周 ${prev.from.slice(5)} ~ ${prev.to.slice(5)}）`, ...(ps ? [ps] : [])], sections,
        chart: dailyChart('近两周每日费用（元）', rows, prev.from, last.to, x => (x >= last.from ? '上周' : '前一周'), { 前一周: BLUE_L, 上周: BLUE }),
        tokenChart: hasTok ? tokenChart('近两周每日 Token', rows, prev.from, last.to, x => (x >= last.from ? '上周' : '前一周'), { 前一周: TEAL_L, 上周: TEAL }) : null,
      };
      return { title: `费用周报 · ${last.key}`, level: 'info', lines, doc, empty: c < 0.005 && o < 0.005, period: last.key, path: `#/overview?from=${last.from}&to=${last.to}` };
    }
    // monthly
    const cycle = addMonths(today.slice(0, 7), -1), pcyc = addMonths(cycle, -1);
    const rows = this.store.monthByKey(cycle), prows = this.store.monthByKey(pcyc);
    const c = rows.reduce((s, r) => s + r.cost, 0), g = rows.reduce((s, r) => s + (r.gross || 0), 0), o = prows.reduce((s, r) => s + r.cost, 0);
    const lines = [`**${cycle} 账期应付 ${yuan(c)}**，较上月 ${chg(c, o)}${g > c ? `，原价 ${yuan(g)}，优惠 ${yuan(g - c)}` : ''}`];
    if (b.monthly) lines.push(`月度预算 ${yuan(b.monthly)}，${c > b.monthly ? `超出 ${yuan(c - b.monthly)}` : `使用 ${pct(c / b.monthly * 100)}`}`);
    const ps = provSplit(rows); if (ps) lines.push(ps);
    const ct = rows.reduce((s, r) => s + (r.tokens || 0), 0), ot = prows.reduce((s, r) => s + (r.tokens || 0), 0), mdays = daysInMonth(cycle);
    const hasTok = ct > 0 || ot > 0;
    if (hasTok) lines.push(`${cycle} Token ${tok(ct)}，较上月 ${chg(ct, ot)}，日均 ${tok(ct / mdays)}${ct > 0 ? `，单位成本 ${perM(c, ct)}` : ''}`);
    const byModelM = this.store.monthByModel(cycle);
    // 按成本中心：按 Key 当前的成本中心标签汇总（与成本中心预算告警、业务分析一致），设置了预算的成本中心附上预算使用情况
    const ccTags = this.store.costCenterTags();
    const cc = sumBy(rows, r => (r.id && ccTags.get(r.id)) || NO_CC);
    const ccB = b.costCenters || {}, ccBudget = k => (Object.hasOwn(ccB, k) && Number(ccB[k]) > 0 ? Number(ccB[k]) : null);
    const ccSub = r => {
      const bud = ccBudget(r.k);
      if (!bud) return {};
      const used = r.cost / bud * 100;
      return { sub: { text: `预算 ${yuan(bud)}，${r.cost > bud ? `超出 ${yuan(r.cost - bud)}` : `已用 ${pct(used)}`}`, level: used >= 100 ? 'bad' : used >= alertPct ? 'warn' : null } };
    };
    const ccCost = new Map(cc.map(x => [x.k, x.cost]));
    const ccSet = Object.keys(ccB).filter(k => ccBudget(k)), ccOver = ccSet.filter(k => (ccCost.get(k) || 0) > ccBudget(k)).sort((x, y) => ((ccCost.get(y) || 0) - ccBudget(y)) - ((ccCost.get(x) || 0) - ccBudget(x)));
    const ccNote = ccSet.length ? `成本中心预算 ${ccSet.length} 个，${ccOver.length ? `${ccOver.length} 个超出：${ccOver.slice(0, 3).map(k => `${ccLabel(k)} 超出 ${yuan((ccCost.get(k) || 0) - ccBudget(k))}`).join('、')}${ccOver.length > 3 ? ` 等 ${ccOver.length} 个` : ''}` : '均未超出'}` : null;
    if (ccNote) lines.push(ccNote);
    const sections = [
      { title: 'API Key Top 5', rows: topRows(sumBy(rows, r => r.id).map(x => ({ id: x.k, cost: x.cost })), 5, r => this.keyName(r.id, keys), c), ...head('cost', 'API Key', `${cycle} 总费用`) },
      { title: '按成本中心', rows: cc.length > 1 || (cc[0] && cc[0].k !== NO_CC) ? topRows(cc, 6, r => ccLabel(r.k), c, ccSub) : [], ...head('cost', '成本中心', `${cycle} 总费用`) },
      { title: '模型 Top 3', rows: topRows(byModelM, 3, r => clean(r.model), c), ...head('cost', '模型', `${cycle} 总费用`) },
      { title: 'Token 用量 · API Key Top 5', rows: tokRows(sumBy(rows, r => r.id).map(x => ({ id: x.k, tokens: x.tokens })), 5, r => this.keyName(r.id, keys), ct), ...head('token', 'API Key', `${cycle} 总 Token`) },
      { title: 'Token 用量 · 模型 Top 3', rows: tokRows(byModelM, 3, r => clean(r.model), ct), ...head('token', '模型', `${cycle} 总 Token`) },
    ];
    lines.push(...sectionLines(sections));
    const d = delta('较上月', c, o), last = addDays(addMonths(cycle, 1) + '-01', -1);
    const mdaily = this.store.dailyByKey(cycle + '-01', last);
    const doc = {
      tags: [dirTag(d), b.monthly && c > b.monthly ? { text: '超出预算', level: 'bad' } : null, ...(ccOver.length ? [{ text: `${ccOver.length} 个成本中心超支`, level: 'bad' }] : [])],
      kpis: [{ label: `${cycle} 应付（元）`, value: yuan(c), delta: d }, ...(g > 0.005 ? [{ label: '原价（元）', value: yuan(g), sub: g - c >= 0.005 ? `优惠 ${yuan(g - c)}` : '无优惠抵扣' }] : []), ...budgetKpi(c, '预算使用率')],
      usage: hasTok ? [{ label: `${cycle} Token`, value: tok(ct), delta: udelta('较上月', ct, ot) }, { label: '日均 Token', value: tok(ct / mdays) }, { label: '单位成本（元）', value: perMv(c, ct), sub: '每百万 Token' }] : null,
      notes: [ps, ccNote].filter(Boolean), sections,
      chart: dailyChart(`${cycle} 每日费用（元）`, mdaily, cycle + '-01', last, () => '每日应付', { 每日应付: BLUE }),
      tokenChart: hasTok ? tokenChart(`${cycle} 每日 Token`, mdaily, cycle + '-01', last, () => '每日 Token', { '每日 Token': TEAL }) : null,
    };
    return { title: `费用月报 · ${cycle}`, level: 'info', lines, doc, empty: c < 0.005 && o < 0.005, period: cycle, ready: this.monthlyReady(today), path: `#/overview?cycle=${cycle}` };
  }
  /**
   * 月报在上月出账后发送：每个已配置云厂商的上月账期都已定稿即发送；账单同步持续失败时最晚 10 日发送（避免永远不发）。
   * 此前按已有的账期记录取最小值，某个已配置的云厂商还没有该账期的记录（如新接入、首次回溯尚未完成）时被忽略，月报会缺少它的费用
   */
  monthlyReady(today = todayIn(this.tz)) {
    const cycle = addMonths(today.slice(0, 7), -1);
    if (!isCycleFinal(cycle, today)) return false;
    const provs = this.providers();
    const final = provs.length ? provs.every(p => !!this.store.getCycle(cycle, p)?.final) : !!this.store.getCycle(cycle)?.final;
    return final || today >= addDays(addMonths(cycle, 1) + '-01', 9);
  }
  /** 报表周期结束后，所有已配置云厂商是否都完成过一次（部分）成功的账单同步：用于判断“空报表”是否真的为空 */
  periodSynced(kind, today = todayIn(this.tz)) {
    const end = kind === 'daily' ? today : kind === 'weekly' ? isoWeek(today).from : today.slice(0, 7) + '-01';
    const ts = dayStartSec(end, this.tz) * 1000;
    return this.providers().every(p => Math.max(this.store.lastRun('bills', 'success', p)?.finished_at || 0, this.store.lastRun('bills', 'partial', p)?.finished_at || 0) >= ts);
  }

  /* ---------- 评估并发送 ---------- */
  /** 串行执行；某渠道失败时该渠道的条目保持未发送，下次检查时重试 */
  check(trigger = 'sync') {
    const run = async () => {
      this.running = true;
      try { return await body(); } finally { this.running = false; }
    };
    const body = async () => {
      if (this.stopping) return { skipped: 'stopping' };
      this.applyArm(); // 先合并保存配置时登记的“新订阅基线”，再读取状态
      const s = this.settings();
      const chans = s.channels.filter(c => c.enabled);
      if (!chans.length) {
        // 全部停用时也要清除变更游标：之后重新启用某个渠道时与首次启用一样，不补发停用期间的历史变更
        const st0 = this.stateFor(todayIn(this.tz).slice(0, 7));
        if (Object.keys(st0.lastChangeId || {}).length) { st0.lastChangeId = {}; this.saveState(st0); }
        return { skipped: 'disabled' };
      }
      const today = todayIn(this.tz), cycle = today.slice(0, 7), hour = hourIn(this.tz), st = this.stateFor(cycle);
      const afterHour = hour >= s.reportHour;
      const lazy = {};
      const get = (k, f) => (lazy[k] ??= f());
      let sent = 0, errors = [];
      const active = new Set();
      for (const ch of chans) {
        const sec = this.secretsOf(ch.id);
        if (!sec.webhook) continue;
        active.add(ch.id);
        st.sent[ch.id] ||= {};
        st.syncSent[ch.id] ||= {};
        st.reports[ch.id] ||= {};
        const sentMap = code => (/^sync(ok)?:/.test(code) ? st.syncSent[ch.id] : st.sent[ch.id]);
        // 推送范围：预算告警只保留范围内 Key 的预算与 Key 全部在范围内的成本中心预算（总预算属于全部范围）；
        // 费用异常按范围重新计算；Key 变更只推送范围内的 Key
        const scope = this.scopeOf(ch);
        const tag = scope ? `（${scope.label}）` : '';
        const msgs = [];
        const alertMsg = (event, title, items, path) => {
          const fresh = items.filter(i => !sentMap(i.code)[i.code]);
          if (!fresh.length) return;
          const show = fresh.filter(i => !i.hidden);
          if (!show.length) { for (const i of fresh) sentMap(i.code)[i.code] = Date.now(); return; }
          const level = show.some(i => i.level === 'bad') ? 'bad' : show.every(i => i.level === 'good') ? 'good' : show.some(i => i.level === 'warn') ? 'warn' : 'info';
          const doc = { tags: [alertTag(event, level, show.length)], items: show.map(i => ({ text: i.text, body: i.body, tag: i.tag, level: i.level })), kpis: event === 'budget' && !scope ? get('budgetKpis', () => this.budgetKpis(today)) : null };
          msgs.push({ event, title, level, lines: show.map(i => i.text), doc, codes: fresh.map(i => i.code), mention: EVENT_TYPES[event].mention && level !== 'good', path });
        };
        // 消息中的“查看详情”直达对应页面与统计周期（地址中带周期参数，打开即为下钻后的视图）
        if (ch.events.budget) alertMsg('budget', `预算告警 · ${cycle}${tag}`, get('budget', () => this.evaluateBudget(today)).filter(i => budgetInScope(i, scope)), `#/keys?cycle=${cycle}`);
        if (ch.events.anomaly && afterHour) alertMsg('anomaly', `费用异常提醒 · ${addDays(today, -1)}${tag}`, scope ? get('anomaly:' + scope.sig, () => this.evaluateAnomaly(today, scope)) : get('anomaly', () => this.evaluateAnomaly(today)), `#/keys?from=${addDays(today, -1)}&to=${addDays(today, -1)}`);
        if (ch.events.sync) alertMsg('sync', '数据同步告警', get('sync', () => this.evaluateSync()), '#/admin/sync');
        if (ch.events.keyChange) {
          if (st.lastChangeId[ch.id] == null) st.lastChangeId[ch.id] = this.store.maxChangeId(); // 首次启用不补发历史变更
          const ev = this.evaluateChanges(st.lastChangeId[ch.id]), scannedTo = ev.scannedTo;
          const items = scope ? ev.items.filter(i => scope.keys.has(String(i.entity))) : ev.items;
          const MAX_LINES = 30; // 一次同步新增上百个 Key 时消息不能无限长（企业微信 4096 字节、钉钉 20KB 上限）
          if (items.length) {
            const lines = items.slice(0, MAX_LINES).map(i => i.text);
            if (items.length > MAX_LINES) lines.push(`…另有 ${items.length - MAX_LINES} 项，请在“变更记录”中查看`);
            const level = items.some(i => i.level === 'warn') ? 'warn' : 'info';
            const shown = items.slice(0, MAX_LINES).map(i => ({ text: i.text, body: i.body, tag: i.tag, level: i.level }));
            if (items.length > MAX_LINES) shown.push({ text: `…另有 ${items.length - MAX_LINES} 项，请在“变更记录”中查看` });
            msgs.push({ event: 'keyChange', title: `API Key 变更通知（${items.length} 项）`, level, lines, doc: { tags: [alertTag('keyChange', level, items.length)], items: shown }, changeTo: scannedTo, path: '#/changes' });
          } else if (scannedTo != null) st.lastChangeId[ch.id] = scannedTo; // 没有需要通知的变更：直接推进游标
        } else delete st.lastChangeId[ch.id];
        if (afterHour) {
          for (const kind of ['daily', 'weekly', 'monthly']) {
            if (!ch.events[kind]) continue;
            const r = scope ? get(`report:${kind}:${scope.sig}`, () => this.scopedReport(kind, today, scope, kind === 'monthly' ? get('report:monthly', () => this.report('monthly', today)).ready : true)) : get('report:' + kind, () => this.report(kind, today));
            if (kind === 'monthly' && !r.ready) continue;
            if (st.reports[ch.id][kind] === r.period) continue;
            // 空报表只有在该周期的账单确认已同步后才算“已发送”；否则（如刚配置密钥、回填尚未完成）稍后有数据时再发送
            if (r.empty) { if (get('synced:' + kind, () => this.periodSynced(kind, today))) st.reports[ch.id][kind] = r.period; continue; }
            msgs.push({ event: kind, title: r.title, level: r.level, lines: r.lines, doc: r.doc, report: { kind, period: r.period }, path: r.path });
          }
        }
        let first = true;
        for (const m of msgs) {
          if (this.stopping) break; // 服务正在退出：不再开始新的推送，剩余消息在重启后发送
          // 同一渠道的相邻消息间隔 0.4 秒：预算 / 异常 / 日报 / 周报 / 月报可能同时到点，连续发送容易触发机器人限流（飞书每秒 5 条）
          if (!first) await pause(this.sendGapMs ?? 400);
          first = false;
          let res = null;
          try {
            res = await this.send(ch, sec, { ...m, today });
          } catch (e) {
            const msg = String(e.message || e).slice(0, 300);
            st.channels[ch.id] = { ...(st.channels[ch.id] || {}), lastError: msg, lastErrorAt: Date.now() };
            errors.push(`${ch.name}：${msg}`);
            this.log(`告警发送失败（${ch.name} · ${EVENT_TYPES[m.event]?.label}）：${msg}`);
            if (e.content) continue; // 内容被拒绝：不影响该渠道的其他消息
            break; // 网络 / 鉴权问题：该渠道后续消息下次再试
          }
          const now = Date.now();
          for (const c of m.codes || []) sentMap(c)[c] = now;
          if (m.report) st.reports[ch.id][m.report.kind] = m.report.period;
          if (m.changeTo) st.lastChangeId[ch.id] = m.changeTo;
          // 邮件：部分收件人被邮件服务器拒绝（如地址拼写错误、邮箱不存在）时，其余收件人照常收到，渠道卡片提示被拒绝的地址。
          // 此前被拒绝的地址被静默忽略，管理员无从得知某人一直收不到报表
          const warn = rejectedNote(res);
          if (warn) this.log(`邮件发送（${ch.name}）：${warn}`);
          st.channels[ch.id] = { ...(st.channels[ch.id] || {}), lastSentAt: now, lastError: null, lastErrorAt: null, lastWarning: warn, lastWarningAt: warn ? now : null };
          st.history = [{ at: now, ch: ch.id, chName: ch.name, event: m.event, level: m.level, title: m.title, items: m.lines.filter(l => l && !l.startsWith('#')).slice(0, 8).map(strip) }, ...(st.history || [])].slice(0, 30);
          // 每条送达后立即记录：此前整批发完才保存，进程在批量推送中途退出（升级重启）时，已送达的消息重启后会再推送一次
          this.saveState(st);
          this.store.audit('system', '', 'alert.sent', { trigger, channel: ch.name, event: m.event, items: m.codes?.length ?? m.lines.length });
          sent++;
        }
        if (this.stopping) break;
      }
      // 清理已删除渠道的状态；停用（或地址缺失）的渠道清除变更游标：重新启用时与首次启用一样不补发停用期间的历史变更
      const ids = new Set(s.channels.map(c => c.id));
      for (const k of ['sent', 'syncSent', 'reports', 'lastChangeId', 'channels']) for (const id of Object.keys(st[k] || {})) if (!ids.has(id)) delete st[k][id];
      // 服务退出时本轮提前结束，排在后面的渠道没有轮到（不在 active 中），不能当作“已停用”清除其游标，否则重启后会漏发这段时间的变更通知
      if (!this.stopping) for (const id of Object.keys(st.lastChangeId || {})) if (!active.has(id)) delete st.lastChangeId[id];
      const old = Date.now() - 90 * 864e5;
      for (const m of Object.values(st.syncSent || {})) for (const [c, t] of Object.entries(m)) if (t < old) delete m[c];
      this.saveState(st);
      if (sent) this.log(`告警/报表已发送 ${sent} 条（${trigger}）`);
      return errors.length ? { sent, error: errors.join('；') } : { sent };
    };
    // 已有排队（尚未开始）的检查时直接复用：检查开始时才读取配置、状态与数据，重复排队只会重复评估。
    // 机器人响应缓慢（单条最长 15 秒）时，定时检查、账单同步完成、元数据同步完成会不断追加检查，队列越排越长
    if (this._queued) return this._queued;
    const start = () => { this._queued = null; return run(); };
    const p = (this.busy || Promise.resolve()).then(start, start).catch(e => { this.log('告警评估失败：' + e.message); return { error: e.message }; });
    this._queued = p;
    this.busy = p;
    return p;
  }
  /** 服务退出：不再开始新的检查与推送（正在发送的那一条会完成并记录） */
  stop() { this.stopping = true; }
  /** 等待正在进行的检查 / 推送结束，最多 ms 毫秒；返回是否已结束 */
  drain(ms = 8000) {
    const cur = this.busy;
    if (!cur) return Promise.resolve(true);
    let t;
    return Promise.race([cur.then(() => true, () => true), new Promise(r => { t = setTimeout(() => r(false), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
  }

  /* ---------- 邮件（SMTP） ---------- */
  smtpSettings() { try { return normalizeSmtp(this.store.getSetting('smtp', {}) || {}); } catch { return normalizeSmtp({}); } }
  smtpPasswordSet() { try { return !!this.store.getSecret('smtp.password'); } catch { return false; } }
  smtpConfig() {
    let password = '';
    try { password = this.store.getSecret('smtp.password') || ''; } catch { throw new Error('SMTP 密码无法解密（主密钥已变化），请重新填写'); }
    return { ...this.smtpSettings(), password };
  }
  /** 邮件附带的成本概览周期：日报为昨日所在账期，周报为上周，月报为上月，其余为本月 */
  overviewSpec(event, today = todayIn(this.tz)) {
    if (event === 'daily') return { mode: 'month', cycle: addDays(today, -1).slice(0, 7) };
    if (event === 'weekly') { const w = isoWeek(addDays(isoWeek(today).from, -1)); return { mode: 'range', from: w.from, to: w.to }; }
    if (event === 'monthly') return { mode: 'month', cycle: addMonths(today.slice(0, 7), -1) };
    return { mode: 'month', cycle: today.slice(0, 7) };
  }
  async sendEmail(recipients, { brand, title, level, lines, footer, event, today = todayIn(this.tz), scope = null, share = null }) {
    const spec = this.overviewSpec(event, today);
    const base = this.publicUrl ? this.publicUrl.replace(/\/+$/, '') + '/' : '';
    const link = base ? base + (spec.mode === 'month' ? `#/overview?cycle=${spec.cycle}` : `#/overview?from=${spec.from}&to=${spec.to}`) : '';
    let overview = null;
    // 概览生成失败不能阻止告警送达：只发送消息内容并记录日志。同一轮检查中多个渠道 / 多条消息的相同周期与范围只生成一次（缓存 60 秒）
    const ck = `${JSON.stringify(spec)}|${scope?.sig || 'all'}|${link}|${today}`, now = Date.now();
    this._ov = (this._ov || new Map());
    for (const [k, v] of this._ov) if (now - v.t > 60_000) this._ov.delete(k);
    try { overview = this._ov.get(ck)?.o || renderOverviewHtml(spec, { store: this.store, today, link, scope, tz: this.tz }); this._ov.set(ck, { t: now, o: overview }); } catch (e) { this.log?.(`生成成本概览邮件内容失败：${e.message}`); }
    const { html, text } = renderEmail({ brand, title, level, lines, overview, footer, share });
    return sendMail(this.smtpConfig(), { to: parseRecipients(recipients), subject: title, html, text }, { allowPrivate: this.allowPrivate, isPrivateIp });
  }
  /**
   * 渠道开启“附带交互报表链接”且已设置 PUBLIC_URL 时，为本条消息生成只读分享链接：周期与邮件附带的成本概览一致
   * （日报为昨日所在账期、周报为上周、月报为上月、告警为本月），范围与渠道的推送范围一致。生成失败不影响消息发送
   */
  shareFor(ch, { title, event, today, webhook }) {
    if (!ch.share || !this.shares?.available) return null;
    try {
      const days = this.settings().shareDays, spec = this.overviewSpec(event, today), scope = cleanScope(ch.scope);
      const t = String(title).replace(/（手动发送）$/, '');
      let host = ''; try { host = new URL(webhook).hostname; } catch { /* 邮件渠道 */ }
      // 同一渠道的同一条消息复用同一个链接：发送失败后每 5 分钟重试一次，不能每次重试都新建链接（链接列表与数据库被重复记录填满）；
      // 已撤销或剩余不足 1 小时的链接不再复用
      const key = [ch.id, event || 'alert', t, JSON.stringify(spec), JSON.stringify(scope), days, host].join('|'), now = Date.now();
      this._shareCache ||= new Map();
      const c = this._shareCache.get(key);
      if (c && c.share.expiresAt - now > 3600_000 && !this.shares.check(c.id).reason) return c.share;
      const l = this.shares.create({ title: t, spec, scope, channelId: ch.id, channelName: ch.name, event: event || 'alert', days });
      const share = { url: l.url, feishu: feishuAppLink(l.url, host), days, expiresAt: l.expiresAt };
      this._shareCache.set(key, { id: l.id, share });
      if (this._shareCache.size > 500) for (const [k, v] of this._shareCache) if (v.share.expiresAt - now <= 3600_000 || this._shareCache.size > 400) this._shareCache.delete(k);
      return share;
    } catch (e) { this.log?.('生成分享链接失败（消息照常发送）：' + e.message); return null; }
  }
  /**
   * 飞书：依次尝试“完整卡片（含趋势图）→ 不含趋势图 → 简洁卡片”，只有飞书明确拒绝卡片内容时才降级（签名 / 关键词 / 限流等错误直接报错）；
   * 被拒绝的样式按机器人地址记住（进程内），之后直接使用可用的样式，避免每条消息都先失败一次。返回实际使用的样式
   */
  async postFeishu(webhook, secret, variants) {
    const fp = crypto.createHash('sha1').update(webhook).digest('hex').slice(0, 12);
    this._fsSkip ||= new Map();
    // 被拒绝的样式记住 24 小时：机器人 / 客户端之后支持了图表等组件时能恢复完整样式，不必等服务重启
    const now = Date.now(), skip = this._fsSkip.get(fp) || new Map();
    for (const [k, t] of skip) if (now - t > 24 * 3600_000) skip.delete(k);
    const list = variants.filter(v => v.card && !skip.has(v.style));
    if (!list.length) list.push(variants[variants.length - 1]);
    let lastErr = null;
    const failed = [];
    for (const v of list) {
      if (lastErr) await pause(this.sendGapMs ?? 300); // 降级重发间隔，避免触发限流
      const req = signRequest('feishu', webhook, secret, v.card, null);
      const resp = await postJson(req.url, req.body, req.headers, this.allowPrivate);
      try {
        checkResponse('feishu', resp);
        // 只有较简单的样式随后发送成功，才说明被拒绝的是样式本身：全部样式都失败时（如这条消息的内容有问题）不记住，
        // 否则一次与样式无关的失败会让之后 24 小时的所有消息都只用简洁卡片
        if (failed.length) { for (const s of failed) skip.set(s, Date.now()); this._fsSkip.set(fp, skip); this.log?.(`飞书卡片已改用“${v.label}”样式发送（${lastErr.message}）`); }
        return v.style;
      } catch (e) {
        if (!feishuFormatError(resp) || v === list[list.length - 1]) throw e;
        lastErr = e; failed.push(v.style);
      }
    }
    throw lastErr;
  }
  async send(ch, { webhook, secret }, { title, level, lines, doc = null, today = todayIn(this.tz), mention = false, path = '', event = '' }) {
    const brand = clean(this.store.branding().name) || '大模型费用分析';
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: this.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const src = this.providers().map(p => PROVIDER_NAMES[p]).join(' / ') || '云厂商';
    const footer = `${brand} · 统计至 ${today} ${time} · 口径：应付金额（税前）· 数据来源：${src}费用中心`;
    const base = this.publicUrl ? this.publicUrl.replace(/\/+$/, '') + '/' : '';
    const link = base ? base + (/^#\/[\w/?&=.~%-]*$/.test(path) ? path : '#/overview') : '';
    const type = ch.type;
    const share = this.shareFor(ch, { title, event, today, webhook });
    if (ALERT_TYPES[type]?.email) return this.sendEmail(webhook, { brand, title: `【${brand}】${title}`, level, lines, footer, event, today, scope: this.scopeOf(ch), share });
    const mentions = mention && (ch.atAll || ch.atMobiles?.length) ? { all: !!ch.atAll, mobiles: ALERT_TYPES[type]?.mention === 'mobile' ? ch.atMobiles || [] : [] } : null;
    const fullTitle = `【${brand}】${title}`;
    const payload = buildMessage(type, { title: fullTitle, level, lines, footer, link, mentions, share });
    if (type === 'feishu') {
      const opt = { title, subtitle: `${brand} · 统计至 ${today.slice(5)} ${time}`, level, doc: doc || { items: lines.filter(l => l && !l.startsWith('#')).map(text => ({ text })) }, footer: `${brand} · 口径：应付金额（税前） · 数据来源：${src}费用中心${share ? ` · 交互报表 ${share.days} 天内有效，无需登录` : ''}`, mentions,
        // 按钮：查看交互报表（只读分享链接，在飞书内打开）/ 查看详情（登录后的系统页面）/ 成本概览
        buttons: [share && { text: '查看交互报表', url: share.feishu, type: 'primary' }, link && { text: share ? '登录系统查看' : '查看详情', url: link, type: share ? 'default' : 'primary' }, !share && link && !/^#\/overview/.test(path) && { text: '成本概览', url: base + '#/overview' }].filter(Boolean) };
      const hasChart = !!(doc?.chart || doc?.tokenChart);
      return this.postFeishu(webhook, secret, [
        { style: 'chart', label: '完整卡片', card: hasChart ? feishuCard({ ...opt, chart: true }) : null },
        { style: 'card', label: '卡片（不含趋势图）', card: feishuCard({ ...opt, chart: false }) },
        { style: 'plain', label: '简洁卡片', card: payload },
      ]);
    }
    const generic = { event: 'alert', title: fullTitle, level, items: lines.filter(l => l && !l.startsWith('#')).map(strip), text: [fullTitle, ...lines.map(l => (l.startsWith('#') ? l.replace(/^#+\s*/, '') : l ? '- ' + strip(l) : '')), footer].join('\n'), link: link || null, shareUrl: share?.url || null, shareExpiresAt: share ? new Date(share.expiresAt).toISOString() : null, mentions, sentAt: new Date().toISOString() };
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
    if (ALERT_TYPES[ch.type]?.email) {
      return this.send(ch, creds, { title: '测试邮件', level: 'info', lines: ['这是一封测试邮件，收到即表示邮件服务器（SMTP）与收件人配置正确。', '邮件通知会在消息内容之后附上完整的成本概览：日报为昨日所在账期、周报为上周、月报为上月、告警为本月。以下为本月的成本概览。'] });
    }
    const lines = ['这是一条测试消息，收到即表示通知渠道配置正确。', '保存配置不会立即推送：告警（预算、费用异常、同步故障）在条件出现时发送，同一条件每账期只通知一次；日报每天、周报每周一在设定时间发送，月报在上月出账后发送。'];
    // 飞书：附上本月指标与近 14 日趋势，测试消息即可看到实际的卡片样式（并检验机器人是否接受图表组件）。
    // 限定推送范围的渠道只能看到范围内的数据：此前测试卡片总是附上全部范围的指标（全公司费用与预算），项目群点“测试”即可看到
    let doc = null;
    if (ch.type === 'feishu') {
      let r = null, scope = null;
      try { scope = this.scopeOf(ch); r = scope ? this.scopedReport('daily', todayIn(this.tz), scope) : this.report('daily'); } catch (e) { this.log?.('生成测试卡片指标失败：' + e.message); }
      doc = { tags: [{ text: '测试', level: 'info' }], kpis: r?.doc.kpis || null, usage: r?.doc.usage || null, notes: scope ? r?.doc.notes || null : null, chart: r?.doc.chart || null, tokenChart: r?.doc.tokenChart || null, items: lines.map(text => ({ text })) };
    }
    return this.send(ch, creds, { title: '测试消息', level: 'info', mention: true, lines, doc });
  }
}
