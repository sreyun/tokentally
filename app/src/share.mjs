/**
 * 只读分享链接：报表 / 告警消息中的“查看交互报表”，收件人无需账号即可在浏览器（或飞书内）查看限定周期与范围的交互式成本概览。
 *
 * 安全设计：
 *  - 令牌 32 字节随机数（base64url，43 位），数据库只保存其 SHA-256；令牌只出现在链接的 # 片段中（/share#<令牌>），
 *    浏览器不会把片段发给服务器，不进入反向代理访问日志，也不会出现在 Referer 中；
 *  - 页面加载后用 POST 提交一次令牌，换取 HttpOnly 的分享会话 Cookie（最长 12 小时，且不超过链接有效期），之后只凭 Cookie 读取数据；
 *  - 分享会话只能读取该链接限定的周期与推送范围内的数据（服务端过滤），不能访问任何其他接口；
 *  - 每次读取数据都重新校验链接是否过期 / 已撤销：撤销后已打开的页面也立即失效；
 *  - 无效令牌按 IP 限流（10 分钟 20 次），防止枚举；访问记入操作日志与链接的访问次数。
 */
import crypto from 'node:crypto';

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SHARE_DAYS = { min: 1, max: 90, def: 7 };
const SESSION_MS = 12 * 3600_000;
const hashOf = token => crypto.createHash('sha256').update(token).digest('hex');

/** 飞书内打开：AppLink 网页协议（PC 端在飞书独立窗口中打开，移动端在飞书内置浏览器中打开）；Lark 使用 larksuite 域名 */
export function feishuAppLink(url, webhookHost = '') {
  const host = /larksuite\.com$/i.test(webhookHost) ? 'applink.larksuite.com' : 'applink.feishu.cn';
  return `https://${host}/client/web_url/open?mode=window&url=${encodeURIComponent(url)}`;
}

export class ShareService {
  constructor({ store, publicUrl = '', log = () => {} }) {
    Object.assign(this, { store, log });
    this.publicUrl = String(publicUrl || '').replace(/\/+$/, '');
    this.sessions = new Map(); // sid -> { id, exp }
    this.fails = new Map();    // ip -> { t, n }
  }
  get available() { return !!this.publicUrl; }

  /**
   * 创建链接；返回 { token, url, id, expiresAt }。spec：{ mode: 'month', cycle } | { mode: 'range', from, to }；scope：cleanScope 结果或 null（全部）
   */
  create({ title, spec, scope = null, channelId = null, channelName = null, event = null, createdBy = 'system', days = SHARE_DAYS.def }) {
    if (!this.available) throw new Error('未设置 PUBLIC_URL，无法生成分享链接');
    const token = crypto.randomBytes(32).toString('base64url');
    const id = hashOf(token), now = Date.now();
    const d = Math.min(SHARE_DAYS.max, Math.max(SHARE_DAYS.min, Math.round(Number(days) || SHARE_DAYS.def)));
    const expiresAt = now + d * 864e5;
    this.store.addShare({ id, title: String(title).slice(0, 120).replace(/[\uD800-\uDBFF]$/, ''), spec, scope: scope && scope.type !== 'all' ? scope : null, channelId, channelName, event, createdBy, createdAt: now, expiresAt });
    return { token, id, expiresAt, url: `${this.publicUrl}/share#${token}` };
  }

  /**
   * 链接状态：有效时为 { link }；无效时带 reason（not_found / expired / revoked），过期 / 撤销时同时附带 link 记录（仅用于提示原因）。
   * 判断是否有效必须看 reason，不能看 link 是否存在
   */
  check(id) {
    const link = id ? this.store.getShare(id) : null;
    if (!link) return { reason: 'not_found' };
    if (link.revoked_at) return { reason: 'revoked', link };
    if (link.expires_at <= Date.now()) return { reason: 'expired', link };
    return { link };
  }

  /** 无效令牌限流：10 分钟内同一 IP 最多 20 次 */
  limited(ip) {
    const f = this.fails.get(ip);
    return !!f && Date.now() - f.t < 10 * 60_000 && f.n >= 20;
  }
  fail(ip) {
    const now = Date.now(), f = this.fails.get(ip);
    if (!f || now - f.t > 10 * 60_000) this.fails.set(ip, { t: now, n: 1 }); else f.n++;
    if (this.fails.size > 10000) for (const [k, v] of this.fails) if (now - v.t > 10 * 60_000) this.fails.delete(k);
  }

  /** 令牌换分享会话：返回 { sid, link, maxAge } 或 { reason } */
  open(token, ip) {
    // 限流只针对无效令牌：有效链接总能打开（同一出口 IP 下有人反复尝试无效令牌，不能连带封锁其他同事）
    const r = TOKEN_RE.test(String(token || '')) ? this.check(hashOf(token)) : { reason: 'not_found' };
    if (!r.link || r.reason) { const lim = this.limited(ip); this.fail(ip); return { reason: lim ? 'limited' : r.reason }; }
    const now = Date.now(), exp = Math.min(now + SESSION_MS, r.link.expires_at);
    const sid = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(sid, { id: r.link.id, exp });
    if (this.sessions.size > 20000) for (const [k, v] of this.sessions) if (v.exp <= now) this.sessions.delete(k);
    this.store.touchShare(r.link.id, ip);
    return { sid, link: r.link, maxAge: Math.max(1, Math.floor((exp - now) / 1000)) };
  }
  /** 分享会话 → 有效链接（每次都重新校验链接本身）；无效时返回 { reason } */
  session(sid) {
    const s = sid && this.sessions.get(sid);
    if (!s) return { reason: 'no_session' };
    if (s.exp <= Date.now()) { this.sessions.delete(sid); return { reason: 'no_session' }; }
    const r = this.check(s.id);
    // 链接已过期 / 已撤销：只返回原因，不返回链接对象（调用方以 link 是否存在判断能否读取）
    if (r.reason) { this.sessions.delete(sid); return { reason: r.reason }; }
    return r;
  }
  /** 撤销：已打开的分享会话在下一次读取时由 session() 校验到“已撤销”并失效（返回 410 与原因，页面提示“链接已被撤销”） */
  revoke(id, by) { return this.store.revokeShares(id || null, by); }
}

/**
 * 按推送范围过滤 /api/data 的数据：账单、上期、历史、调用量、Key 列表、业务空间、标签、活跃度、预算。
 * pred(row) 接收 { api_key_id, workspace_id }；限定范围时不返回月度总预算（总预算对应全部费用，与范围内费用不可比）
 */
export function filterData(out, pred) {
  if (!pred) return out;
  const table = t => {
    if (!t || !Array.isArray(t.rows)) return t;
    const ik = t.cols.indexOf('api_key_id'), iw = t.cols.indexOf('workspace_id');
    return { cols: t.cols, rows: t.rows.filter(r => pred({ api_key_id: ik >= 0 ? r[ik] : '', workspace_id: iw >= 0 ? r[iw] : '' })) };
  };
  const keys = out.apiKeys.filter(k => pred({ api_key_id: k.apiKeyId, workspace_id: k.workspaceId }));
  const keyIds = new Set(keys.map(k => k.apiKeyId));
  for (const t of ['lines', 'daily', 'prev', 'prevMtd', 'prevDaily', 'history']) if (out[t]) out[t] = table(out[t]);
  // 账单中出现、但 Key 列表中没有的 Key（已删除等）同样属于范围
  for (const t of ['lines', 'daily', 'history']) {
    const ik = out[t]?.cols?.indexOf('api_key_id');
    if (ik >= 0) for (const r of out[t].rows) if (r[ik]) keyIds.add(r[ik]);
  }
  if (out.usage) { const ik = out.usage.cols.indexOf('api_key_id'); out.usage = { cols: out.usage.cols, rows: out.usage.rows.filter(r => keyIds.has(r[ik])) }; }
  const wsIds = new Set(keys.map(k => k.workspaceId).filter(Boolean));
  for (const t of ['lines', 'daily']) { const iw = out[t]?.cols?.indexOf('workspace_id'); if (iw >= 0) for (const r of out[t].rows) if (r[iw]) wsIds.add(r[iw]); }
  out.apiKeys = keys;
  out.workspaces = out.workspaces.filter(w => wsIds.has(w.workspaceId));
  out.extraTags = (out.extraTags || []).filter(t => keyIds.has(t.apiKeyId));
  out.keyActivity = (out.keyActivity || []).filter(a => keyIds.has(a.apiKeyId));
  const b = out.budgets || {};
  out.budgets = { ...b, monthly: null, keys: Object.fromEntries(Object.entries(b.keys || {}).filter(([id]) => keyIds.has(id))) };
  return out;
}
