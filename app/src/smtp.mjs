/* =========================================================================
 * SMTP 发信（零依赖：node:net / node:tls）
 * - 加密：ssl（465，隐式 TLS）/ starttls（587 / 25，升级为 TLS）/ none（仅限不带认证的内网中继）
 * - 认证：AUTH PLAIN / LOGIN；未加密的连接拒绝发送密码
 * - 安全：连接前解析服务器地址，拒绝内网 / 保留地址（防 SSRF），可用 ALERT_ALLOW_PRIVATE 放开（内网邮件中继）；
 *         收件人、发件人、主题中的换行一律去除（防邮件头注入）；整体与单步均有超时
 * - 邮件：multipart/alternative（纯文本 + HTML），UTF-8，正文 base64，主题与发件人名称按 RFC 2047 编码
 * ========================================================================= */
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import crypto from 'node:crypto';
import os from 'node:os';

export const SMTP_SECURITY = { ssl: 'SSL / TLS（通常端口 465）', starttls: 'STARTTLS（通常端口 587 或 25）', none: '不加密（仅内网中继，不能使用密码）' };
export const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const MAX_RECIPIENTS = 20;

/** 收件人列表：逗号 / 分号 / 空白分隔，去重，最多 20 个；有非法地址时抛错 */
export function parseRecipients(raw) {
  const list = [...new Set(String(raw || '').split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean))];
  if (!list.length) throw new Error('请填写收件人邮箱');
  const bad = list.filter(x => !EMAIL_RE.test(x) || x.length > 254);
  if (bad.length) throw new Error(`收件人邮箱格式不正确：${bad.slice(0, 3).join('、')}`);
  if (list.length > MAX_RECIPIENTS) throw new Error(`收件人最多 ${MAX_RECIPIENTS} 个`);
  return list;
}

/** SMTP 配置校验与规范化（不含密码） */
export function normalizeSmtp(s = {}, cur = {}) {
  const host = typeof s.host === 'string' ? s.host.trim().toLowerCase() : cur.host || '';
  if (host && !HOST_RE.test(host) && !net.isIP(host)) throw new Error('SMTP 服务器地址格式不正确');
  const security = Object.hasOwn(SMTP_SECURITY, s.security) ? s.security : cur.security || 'ssl';
  const port = s.port == null || s.port === '' ? (cur.port || (security === 'ssl' ? 465 : 587)) : Number(s.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP 端口应为 1 ~ 65535');
  const username = typeof s.username === 'string' ? s.username.trim().slice(0, 254) : cur.username || '';
  if (/[\r\n]/.test(username)) throw new Error('用户名格式不正确');
  const fromAddr = typeof s.fromAddr === 'string' ? s.fromAddr.trim() : cur.fromAddr || '';
  if (fromAddr && !EMAIL_RE.test(fromAddr)) throw new Error('发件人邮箱格式不正确');
  const fromName = typeof s.fromName === 'string' ? s.fromName.replace(/[\r\n<>"]/g, '').trim().slice(0, 40) : cur.fromName || '';
  return { host, port, security, username, fromAddr, fromName };
}

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = s => s.replace(/.{1,76}/g, m => m + '\r\n');
/** RFC 2047：非 ASCII 文本编码为多个 ≤ 75 字符的编码词（按字符切分，不拆开多字节字符），以折行空白连接 */
const encWord = s => {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = []; let cur = '';
  for (const ch of s) { if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = ''; } cur += ch; }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${b64(w)}?=`).join('\r\n ');
};
const noCrlf = s => String(s || '').replace(/[\r\n]+/g, ' ');

/** 组装 MIME 邮件（CRLF 换行） */
export function buildMime({ from, fromName, to, subject, text, html, domain }) {
  const boundary = 'tt-' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${fromName ? `${encWord(noCrlf(fromName))} ` : ''}<${noCrlf(from)}>`,
    `To: ${to.map(noCrlf).join(',\r\n ')}`,
    `Subject: ${encWord(noCrlf(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain || 'tokentally.local'}>`,
    'MIME-Version: 1.0',
    'X-Mailer: TokenTally',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(body))}`;
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', text || '')}${part('text/html', html || '')}--${boundary}--\r\n`;
}

/** 解析服务器地址并拦截内网 / 保留地址 */
async function resolveHost(host, allowPrivate, isPrivateIp) {
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  if (!addrs.length) throw new Error(`无法解析 SMTP 服务器 ${host}`);
  if (!allowPrivate && addrs.some(a => isPrivateIp(a.address))) throw new Error(`SMTP 服务器 ${host} 解析到内网或保留地址，已拒绝（内网邮件中继请设置 ALERT_ALLOW_PRIVATE=true）`);
  return addrs[0].address;
}

/** 简单的 SMTP 会话：逐条读取多行响应 */
class Session {
  constructor(sock, timeoutMs) {
    this.timeoutMs = timeoutMs; this.buf = ''; this.waiters = []; this.queue = []; this.lines = []; this.err = null;
    this.attach(sock);
  }
  attach(sock) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.setTimeout(this.timeoutMs, () => sock.destroy(new Error(`SMTP 服务器无响应（${Math.round(this.timeoutMs / 1000)} 秒）`)));
    sock.on('data', d => { this.buf += d; this.drain(); });
    sock.on('error', e => { this.err = e; this.flushErr(); });
    sock.on('close', () => { if (!this.err) this.err = new Error('SMTP 连接已关闭'); this.flushErr(); });
  }
  // 移交给 TLS 之后，原始套接字仍保留一个空的 error 监听：否则之后的连接错误会成为未捕获异常，导致整个服务退出
  detach() { this.sock.removeAllListeners('data'); this.sock.removeAllListeners('error'); this.sock.removeAllListeners('close'); this.sock.setTimeout(0); this.sock.on('error', () => {}); }
  flushErr() { for (const w of this.waiters.splice(0)) w.reject(this.err); }
  drain() {
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
      if (this.buf.length > 65536) { this.sock.destroy(new Error('SMTP 响应过长')); return; }
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const lines = this.lines.splice(0);
        const resp = { code: Number(line.slice(0, 3)), lines, text: lines.map(l => l.slice(4)).join(' ') };
        // 尚未开始等待时先到达的响应（如 SSL 连接建立后立即发来的欢迎语）先排队，不能丢弃
        const w = this.waiters.shift();
        if (w) w.resolve(resp); else if (this.queue.length < 20) this.queue.push(resp);
      }
    }
  }
  read() {
    return new Promise((resolve, reject) => {
      if (this.queue.length) return resolve(this.queue.shift());
      if (this.err) return reject(this.err);
      this.waiters.push({ resolve, reject }); this.drain();
    });
  }
  async cmd(line, expect, label = line.split(' ')[0]) {
    if (line != null) this.sock.write(line + '\r\n');
    const r = await this.read();
    if (!expect.includes(r.code)) throw Object.assign(new Error(`SMTP ${label} 失败：${r.code} ${r.text.slice(0, 200)}`), { smtpCode: r.code });
    return r;
  }
}

/**
 * 发送邮件。cfg: { host, port, security, username, password, fromAddr, fromName }；msg: { to: [], subject, text, html }
 * opts: { allowPrivate, isPrivateIp, timeoutMs, totalMs, rejectUnauthorized }
 */
// 证书校验默认开启；与 Node.js 一致，仅当显式设置 NODE_TLS_REJECT_UNAUTHORIZED=0 时放开（如测试环境的自签名证书）
export async function sendMail(cfg, msg, { allowPrivate = false, isPrivateIp = () => false, timeoutMs = 20_000, totalMs = 60_000, rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' } = {}) {
  if (!cfg?.host) throw new Error('尚未配置 SMTP 服务器');
  const from = cfg.fromAddr || cfg.username;
  if (!from || !EMAIL_RE.test(from)) throw new Error('请填写发件人邮箱');
  if (cfg.security === 'none' && cfg.password) throw new Error('未加密的连接不能发送密码，请改用 SSL / TLS 或 STARTTLS');
  const to = parseRecipients(msg.to.join(','));
  const address = await resolveHost(cfg.host, allowPrivate, isPrivateIp);
  const helo = (os.hostname() || 'tokentally').replace(/[^A-Za-z0-9.-]/g, '') || 'tokentally';
  const tlsOpts = { servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized, minVersion: 'TLSv1.2' };
  let sock, session, total;
  const run = async () => {
    sock = cfg.security === 'ssl'
      ? tls.connect({ host: address, port: cfg.port, ...tlsOpts })
      : net.connect({ host: address, port: cfg.port });
    session = new Session(sock, timeoutMs);
    await new Promise((resolve, reject) => { sock.once(cfg.security === 'ssl' ? 'secureConnect' : 'connect', resolve); sock.once('error', reject); });
    await session.cmd(null, [220], '连接');
    let ehlo = await session.cmd(`EHLO ${helo}`, [250], 'EHLO');
    if (cfg.security === 'starttls') {
      if (!ehlo.lines.some(l => /STARTTLS/i.test(l))) throw new Error('SMTP 服务器不支持 STARTTLS，请改用 SSL / TLS');
      await session.cmd('STARTTLS', [220]);
      session.detach();
      const secure = tls.connect({ socket: sock, ...tlsOpts });
      secure.on('error', () => {}); // 握手失败可能多次触发 error：兜底监听，错误由下面的 Promise 返回
      await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
      sock = secure; session.attach(secure);
      ehlo = await session.cmd(`EHLO ${helo}`, [250], 'EHLO');
    }
    if (cfg.username && cfg.password) {
      const caps = ehlo.lines.join(' ').toUpperCase();
      if (/AUTH[ =][^\n]*PLAIN/.test(caps) || !/AUTH[ =][^\n]*LOGIN/.test(caps)) {
        await session.cmd(`AUTH PLAIN ${b64(`\0${cfg.username}\0${cfg.password}`)}`, [235], 'AUTH（用户名或密码 / 授权码不正确）');
      } else {
        await session.cmd('AUTH LOGIN', [334], 'AUTH');
        await session.cmd(b64(cfg.username), [334], 'AUTH（用户名）');
        await session.cmd(b64(cfg.password), [235], 'AUTH（密码 / 授权码不正确）');
      }
    }
    await session.cmd(`MAIL FROM:<${noCrlf(from)}>`, [250], 'MAIL FROM');
    const accepted = [], rejected = [];
    for (const r of to) {
      try { await session.cmd(`RCPT TO:<${noCrlf(r)}>`, [250, 251], 'RCPT TO'); accepted.push(r); }
      catch (e) { if (e.smtpCode) rejected.push(`${r}（${e.smtpCode}）`); else throw e; }
    }
    if (!accepted.length) throw new Error(`收件人均被服务器拒绝：${rejected.join('、')}`);
    await session.cmd('DATA', [354]);
    const mime = buildMime({ from, fromName: cfg.fromName, to: accepted, subject: msg.subject, text: msg.text, html: msg.html, domain: from.split('@')[1] });
    // 行首的 “.” 需要转义（dot-stuffing），以 <CRLF>.<CRLF> 结束
    sock.write(mime.replace(/^\./gm, '..') + '.\r\n');
    await session.cmd(null, [250], '发送正文');
    try { sock.write('QUIT\r\n'); } catch { /* ignore */ }
    return { accepted, rejected };
  };
  try {
    const job = run();
    job.catch(() => { /* 已由 Promise.race 返回整体超时，后台会话随后被关闭 */ });
    return await Promise.race([job, new Promise((_, reject) => { total = setTimeout(() => reject(new Error(`发送邮件超时（${Math.round(totalMs / 1000)} 秒）`)), totalMs); total.unref?.(); })]);
  } finally {
    clearTimeout(total);
    setTimeout(() => sock?.destroy(), 200).unref?.();
  }
}
