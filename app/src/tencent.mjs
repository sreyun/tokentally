/**
 * 腾讯云 API 3.0 客户端（TC3-HMAC-SHA256 签名），只开放本系统需要的只读接口。
 *  - 大模型服务平台 TokenHub 2026-03-22：DescribeApiKeyList / DescribeModelEndpointList / DescribeUsageRankList / DescribeModelList
 *  - 计费 Billing 2018-07-09：DescribeBillSummaryByProduct / DescribeBillDetail
 *
 * 腾讯云账单按“资源”（推理服务 / 模型）出账，不含 API Key 维度；TokenHub 用量统计提供“API Key × 模型 × 日”的精确 Token 用量。
 * 因此 Key 级费用 = 当日该模型（该计费项）真实账单金额 × 该 Key 在当日该模型（对应 Token 类型）的用量占比，标记为“按用量分摊”。
 * 账单资源 ID 本身就是 API Key ID 时直接归属，不做分摊。
 */
import crypto from 'node:crypto';
import { recordCall, summarize } from './calllog.mjs';
import { tokenCount } from './aliyun.mjs';

export const TC_REGIONS = ['ap-guangzhou', 'ap-singapore'];
export const TC_SITES = { cn: 'tencentcloudapi.com', intl: 'intl.tencentcloudapi.com' };
export const TC_REGION_NAMES = { 'ap-guangzhou': '广州', 'ap-singapore': '新加坡' };
const SERVICES = {
  tokenhub: { version: '2026-03-22', regional: true, actions: ['DescribeApiKeyList', 'DescribeModelEndpointList', 'DescribeUsageRankList', 'DescribeModelList'] },
  billing: { version: '2018-07-09', regional: false, actions: ['DescribeBillSummaryByProduct', 'DescribeBillDetail'] },
};
/** 账单中识别 TokenHub / 混元等大模型产品的名称规则（可在管理页面固定 BusinessCode） */
export const TC_PRODUCT_RE = /tokenhub|大模型服务平台|混元|hunyuan|大模型知识引擎|lkeap|deepseek/i;

export class TencentError extends Error {
  constructor(action, status, code, message, requestId) {
    super(`${action}: ${code || status}${message ? ' ' + message : ''}`);
    Object.assign(this, { action, status, code: code || String(status), aliMessage: message || '', requestId: requestId || '' });
  }
}

export function explainTencentError(e) {
  const c = `${e?.code || ''} ${e?.aliMessage || e?.message || ''}`;
  if (/SecretIdNotFound|InvalidSecretId/i.test(c)) return 'SecretId 不存在、已禁用或不是云 API 密钥';
  if (/SignatureFailure/i.test(c)) return 'SecretKey 不正确（签名校验失败）';
  if (/SignatureExpire/i.test(c)) return '服务器时间与标准时间偏差超过 5 分钟，请校准系统时间';
  if (/UnauthorizedOperation|AuthFailure\.Unauthorized|NotAuthorized|OperationDenied/i.test(c)) return 'CAM 子用户缺少该接口权限';
  if (/NetworkError|fetch failed|ENOTFOUND|ECONN|timeout/i.test(c)) return '无法连接腾讯云 API，请检查容器的出网访问与 DNS';
  return '';
}

const sha256hex = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d, enc) => crypto.createHmac('sha256', k).update(d).digest(enc);

/** TC3-HMAC-SHA256：签名头固定为 content-type;host;x-tc-action */
export function tc3Sign({ secretId, secretKey, service, host, action, payload, timestamp, contentType = 'application/json; charset=utf-8', payloadHash }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // 必须是 UTC 日期
  const hashed = payloadHash || sha256hex(payload);
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n\n${signedHeaders}\n${hashed}`;
  const hashedCanonicalRequest = sha256hex(canonicalRequest);
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hashedCanonicalRequest}`;
  const signing = hmac(hmac(hmac('TC3' + secretKey, date), service), 'tc3_request');
  const signature = hmac(signing, stringToSign, 'hex');
  return { hashedCanonicalRequest, signature, authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** 使用腾讯云官方文档“签名方法 v3”中的完整示例自检（CVM DescribeInstances，时间戳 1551113065） */
export function tc3SelfTest() {
  const bs = String.fromCharCode(92);
  const payload = '{"Limit": 1, "Filters": [{"Values": ["' + ['672a', '547d', '540d'].map(x => bs + 'u' + x).join('') + '"], "Name": "instance-name"}]}';
  const r = tc3Sign({ secretId: 'AKID', secretKey: '*'.repeat(32), service: 'cvm', host: 'cvm.tencentcloudapi.com', action: 'DescribeInstances', payload, timestamp: 1551113065 });
  return sha256hex(payload) === '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064'
    && r.hashedCanonicalRequest === '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84'
    && r.signature === '10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class TencentClient {
  /** endpoint：仅用于测试或私有网关，形如 http://127.0.0.1:9555（为空时使用官方域名） */
  constructor({ secretId, secretKey, region = 'ap-guangzhou', site = 'cn', endpoint = '' }) {
    if (!TC_REGIONS.includes(region)) throw new Error(`不支持的 TokenHub 地域: ${region}`);
    if (!TC_SITES[site]) throw new Error(`不支持的腾讯云站点: ${site}`);
    Object.assign(this, { secretId, secretKey, region, site, endpoint: endpoint.replace(/\/+$/, '') });
    this.calls = 0;
    this.lastBill = 0;
  }

  async call(service, action, params = {}, attempt = 0) {
    const svc = SERVICES[service];
    if (!svc || !svc.actions.includes(action)) throw new Error(`接口不在白名单中: ${service}.${action}`);
    // 计费接口默认限频 5 次/秒：同一客户端内串行并保持间隔
    if (service === 'billing') { const wait = this.lastBill + 230 - Date.now(); if (wait > 0) await sleep(wait); this.lastBill = Date.now(); }
    const host = this.endpoint ? new URL(this.endpoint).host : `${service}.${TC_SITES[this.site]}`;
    const url = this.endpoint ? this.endpoint + '/' : `https://${host}/`;
    const payload = JSON.stringify(params);
    const timestamp = Math.floor(Date.now() / 1000);
    const s = tc3Sign({ secretId: this.secretId, secretKey: this.secretKey, service, host, action, payload, timestamp });
    const headers = {
      Authorization: s.authorization, 'Content-Type': 'application/json; charset=utf-8', 'X-TC-Action': action, 'X-TC-Version': svc.version,
      'X-TC-Timestamp': String(timestamp), 'X-TC-Language': 'zh-CN', 'User-Agent': 'tokentally/1.2',
    };
    if (svc.regional) headers['X-TC-Region'] = this.region;
    const t0 = Date.now();
    const entry = { ts: t0, provider: 'tencent', product: service, action, query: summarize(params), status: 0, ms: 0, ok: false, code: '', message: '', requestId: '' };
    this.calls++;
    let res, text;
    try {
      res = await fetch(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(60_000) });
      text = await res.text();
    } catch (e) {
      Object.assign(entry, { ms: Date.now() - t0, code: 'NetworkError', message: e.cause?.code || e.message });
      recordCall(entry);
      if (attempt < 2) { await sleep(1500 * (attempt + 1)); return this.call(service, action, params, attempt + 1); }
      throw new TencentError(action, 0, 'NetworkError', entry.message);
    }
    let json;
    try { json = JSON.parse(text); } catch { json = { Response: { Error: { Code: 'BadResponse', Message: text.slice(0, 300) } } }; }
    const r = json.Response || {};
    const ok = res.ok && !r.Error;
    Object.assign(entry, { ms: Date.now() - t0, status: res.status, ok, code: ok ? '' : String(r.Error?.Code || res.status), message: ok ? '' : String(r.Error?.Message || ''), requestId: r.RequestId || '' });
    recordCall(entry);
    if (!ok) {
      if (/RequestLimitExceeded|InternalError|ResourceUnavailable|ServiceUnavailable/i.test(entry.code) && attempt < 4) {
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
        return this.call(service, action, params, attempt + 1);
      }
      throw new TencentError(action, res.status, entry.code, entry.message, entry.requestId);
    }
    return r;
  }

  /** Offset / Limit 分页 */
  async pages(service, action, base, arrKey, limit = 100) {
    const out = [];
    for (let offset = 0, i = 0; i < 500; i++) {
      const r = await this.call(service, action, { ...base, Limit: limit, Offset: offset });
      const items = r[arrKey] || [];
      out.push(...items);
      offset += items.length;
      if (!items.length || offset >= (r.TotalCount ?? 0)) break;
    }
    return out;
  }
  listApiKeys() { return this.pages('tokenhub', 'DescribeApiKeyList', { Platform: 'maas' }, 'ApiKeySet'); }
  listEndpoints() { return this.pages('tokenhub', 'DescribeModelEndpointList', {}, 'ModelEndpointSet'); }
  listModels() { return this.pages('tokenhub', 'DescribeModelList', {}, 'ModelSet'); }

  /** 时间窗内有用量的 API Key（含已删除 Key 的原名称），ShowAll 返回全量、不含曲线 */
  async usageKeys(start, end) {
    try {
      const r = await this.call('tokenhub', 'DescribeUsageRankList', { Dimension: 'apikey', MetricType: 'tokens', StartTime: start, EndTime: end, ShowAll: true });
      return r.TopList || [];
    } catch (e) {
      if (!/TooManyObjects/i.test(e.code || '')) throw e;
      // Key 数量过多时 ShowAll 不可用：改为分页（每页固定 10 个）
      const out = [];
      for (let offset = 0, i = 0; i < 1000; i++) {
        const r = await this.call('tokenhub', 'DescribeUsageRankList', { Dimension: 'apikey', MetricType: 'tokens', StartTime: start, EndTime: end, Period: 86400, Offset: offset });
        const list = r.TopList || [];
        out.push(...list.map(x => ({ Rank: x.Rank, Key: x.Key, Name: x.Name, Stats: x.Stats })));
        offset += list.length;
        if (!list.length || offset >= (r.Total ?? 0)) break;
      }
      return out;
    }
  }
  /** 某个 API Key 在时间窗内按模型 × 日的用量（每页固定 10 个对象） */
  async usageOfKey(keyId, start, end) {
    const out = { timestamps: [], items: [] };
    for (let offset = 0, i = 0; i < 100; i++) {
      const r = await this.call('tokenhub', 'DescribeUsageRankList', { Dimension: 'model', MetricType: 'apikey_usage', Anchor: keyId, StartTime: start, EndTime: end, Period: 86400, Offset: offset });
      if (r.Timestamps?.length) out.timestamps = r.Timestamps;
      const list = r.TopList || [];
      out.items.push(...list);
      offset += list.length;
      if (!list.length || offset >= (r.Total ?? 0)) break;
    }
    return out;
  }
  /** 产品费用分布（用于识别 TokenHub 的 BusinessCode） */
  billSummary(month) { return this.call('billing', 'DescribeBillSummaryByProduct', { BeginTime: month, EndTime: month }); }
  /** 账单明细：Month + BusinessCode，Context 加速翻页（单页最多 300 条） */
  async billDetail(month, businessCode) {
    const out = [];
    let context = '';
    for (let offset = 0, i = 0; i < 2000; i++) {
      const r = await this.call('billing', 'DescribeBillDetail', { Month: month, BusinessCode: businessCode, Offset: offset, Limit: 300, ...(context ? { Context: context } : {}) });
      const items = r.DetailSet || [];
      out.push(...items);
      offset += items.length;
      context = r.Context || '';
      if (items.length < 300) break;
    }
    return out;
  }
}

/* ===================================================================
 * 解析与归一化
 * =================================================================== */
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
export const tcWorkspaceId = region => `tc:${region}`;
export const tcWorkspaceName = region => `TokenHub · ${TC_REGION_NAMES[region] || region}`;

/** "2026-03-25 19:50:56"（北京时间）→ 毫秒时间戳 */
export function parseCnTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}

/** TokenHub ApiKeyDetail → 与阿里云 ListApiKeys 相同结构，供 Store.applyMeta 使用 */
export function normalizeTencentKey(k, region) {
  const items = Array.isArray(k.BindingItems) ? k.BindingItems : [];
  const models = items.filter(b => b.ResourceType === 'model').map(b => String(b.ResourceId));
  const eps = items.filter(b => b.ResourceType === 'endpoint').map(b => 'ep:' + b.ResourceId);
  const bind = String(k.BindType || '');
  return {
    apiKeyId: String(k.ApiKeyId || ''), apiKeyValue: k.ApiKey || '', description: k.Name || '', remark: k.Remark || '',
    workspaceId: tcWorkspaceId(region), workspaceName: tcWorkspaceName(region),
    disabled: String(k.Status || '').toLowerCase() !== 'enable',
    auth: { type: bind, modelAccessScope: { allowAllModels: /model_all/i.test(bind) || (!models.length && !eps.length && !/custom/i.test(bind)), accessibleModels: [...models, ...eps] }, accessIps: Array.isArray(k.IpWhitelist) ? k.IpWhitelist : [] },
    createdBy: k.Creator || k.SubUin || '', gmtCreate: parseCnTime(k.CreateTime),
  };
}

/** 计费项名称 → 与阿里云计费项编码兼容的 io（前端据此识别输入/输出/缓存/思考） */
export function tcIo(text) {
  const t = String(text || '');
  if (/缓存命中|命中缓存|缓存读|读缓存|cache.?(hit|read)/i.test(t)) return 'input_token_cache';
  if (/缓存写|写缓存|缓存创建|cache.?(write|creat)/i.test(t)) return 'input_token_cache_creation';
  if (/思考|thinking|reasoning/i.test(t)) return 'thinking_output_token';
  if (/输出|output|completion/i.test(t)) return 'output_token';
  if (/输入|input|prompt/i.test(t)) return 'input_token';
  if (/缓存|cache/i.test(t)) return 'input_token_cache';
  if (/搜索|search/i.test(t)) return 'search';
  return '';
}
const looksId = s => /^(ep|ins|ak|res|pre)-[\w-]+$/i.test(s) || /^\d+$/.test(s);
const stripIo = s => String(s || '').replace(/[-_\s（(]*(输入|输出|缓存命中|缓存写入|缓存|思考|在线推理|按量计费|后付费)[\s]*(tokens?|token)?[)）]*/gi, '').replace(/[-_\s]+$/, '').trim();

export function tcModelOf(d, c, endpointModel) {
  const rid = String(d.ResourceId || '');
  if (rid && endpointModel?.has(rid)) return endpointModel.get(rid);
  for (const cfg of Array.isArray(c.ComponentConfig) ? c.ComponentConfig : []) {
    if (/模型|model/i.test(cfg.Name || '') && cfg.Value) return String(cfg.Value);
  }
  const rn = String(d.ResourceName || '');
  if (rn && !looksId(rn)) return rn;
  if (rid && !looksId(rid)) return rid;
  const fromItem = stripIo(c.ItemCodeName) || stripIo(c.ComponentCodeName);
  if (fromItem && !/^(输入|输出|tokens?)$/i.test(fromItem)) return fromItem;
  return `[${d.ProductCodeName || d.BusinessCodeName || '腾讯云其他费用'}]`;
}

/** 直接按 API Key 计费的费用项名称：优先组件配置中的模型，否则用计费组件名（如“[联网搜索]”） */
function keyFeeName(d, c, endpointModel) {
  for (const cfg of Array.isArray(c.ComponentConfig) ? c.ComponentConfig : []) {
    if (/模型|model/i.test(cfg.Name || '') && cfg.Value) return String(cfg.Value);
  }
  const name = String(c.ComponentCodeName || '').trim() || stripIo(c.ItemCodeName) || String(d.ProductCodeName || '').replace(/^.*?[-—]/, '') || '腾讯云其他费用';
  return `[${name}]`;
}

/**
 * 账单明细 → 归一化账单行（与阿里云 normalizeBillItem 字段一致，另含 day）。
 * 同一 日 × 资源 × 模型 × 计费项 × 单价 合并（按量计费按小时出账，合并到日）。
 */
export function tencentBillRows(details, { region, endpointModel = new Map(), keyIds = new Set() } = {}) {
  const m = new Map();
  for (const d of details || []) {
    const day = String(d.BillDay || d.FeeBeginTime || d.PayTime || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const rid = String(d.ResourceId || '');
    for (const c of Array.isArray(d.ComponentSet) ? d.ComponentSet : []) {
      const item = c.ItemCodeName || c.ComponentCodeName || '';
      const io = tcIo(`${c.ComponentCodeName || ''} ${c.ItemCodeName || ''}`);
      let keyId = keyIds.has(rid) ? rid : '';
      for (const cfg of Array.isArray(c.ComponentConfig) ? c.ComponentConfig : []) if (!keyId && keyIds.has(String(cfg.Value || ''))) keyId = String(cfg.Value);
      // 资源本身是 API Key（如联网搜索按次计费）：资源名称是 Key 名称而不是模型，按计费组件归类为“[费用项]”
      const model = keyId === rid && rid ? keyFeeName(d, c, endpointModel) : tcModelOf(d, c, endpointModel);
      const unit = c.UsedAmountUnit || '';
      const k = [day, rid, model, io, item, c.SinglePrice ?? '', c.PriceUnit || '', unit, keyId].join('\u0001');
      let r = m.get(k);
      if (!r) {
        r = {
          day, instance_id: rid, api_key_id: keyId, workspace_id: tcWorkspaceId(region), model, io, channel: '', stop_flag: '', kind: 'inference',
          billing_item: item, billing_item_code: c.ItemCode || '', commodity_code: d.ProductCode || '', product_detail: d.ProductCodeName || d.BusinessCodeName || '',
          usage: null, usage_unit: unit, tokens: null, list_price: c.SinglePrice == null ? '' : String(num(c.SinglePrice)), list_price_unit: c.PriceUnit || '',
          gross: 0, pretax: 0, after_discount: 0, invoice_discount: 0, coupons: 0, cash_coupons: 0, prepaid: 0, resource_pkg: '',
          currency: 'CNY', region: d.RegionName || '', item: d.ActionTypeName || '', subscription_type: d.PayModeName || '', alloc: 0,
        };
        m.set(k, r);
      }
      const usage = c.UsedAmount === '' || c.UsedAmount == null ? null : num(c.UsedAmount);
      if (usage != null) { r.usage = (r.usage || 0) + usage; const t = tokenCount(usage, unit); if (t != null) r.tokens = (r.tokens || 0) + t; }
      const real = num(c.RealCost);
      r.gross += num(c.Cost); r.pretax += real; r.after_discount += real;
      r.invoice_discount += num(c.Cost) - real;
      r.coupons += num(c.VoucherPayAmount); r.cash_coupons += num(c.IncentivePayAmount); r.prepaid += num(c.TransferPayAmount);
    }
  }
  return [...m.values()];
}

/** 日账单行合并为月（账期）账单行 */
export function rollupMonth(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = [r.instance_id, r.api_key_id, r.model, r.io, r.billing_item, r.list_price, r.list_price_unit, r.usage_unit, r.alloc].join('\u0001');
    let o = m.get(k);
    if (!o) { o = { ...r, usage: null, tokens: null, gross: 0, pretax: 0, after_discount: 0, invoice_discount: 0, coupons: 0, cash_coupons: 0, prepaid: 0 }; delete o.day; m.set(k, o); }
    if (r.usage != null) o.usage = (o.usage || 0) + r.usage;
    if (r.tokens != null) o.tokens = (o.tokens || 0) + r.tokens;
    for (const f of MONEY) o[f] += r[f] || 0;
  }
  return [...m.values()];
}

/* ---------------- 按用量分摊 ---------------- */
const MONEY = ['gross', 'pretax', 'after_discount', 'invoice_discount', 'coupons', 'cash_coupons', 'prepaid'];
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
/** 账单模型名与用量模型名匹配：规范化后相等优先，其次互相包含（长度≥4） */
export function matchModel(billModel, usageModels) {
  const b = norm(billModel);
  if (!b || /^\[/.test(billModel)) return null;
  const exact = usageModels.find(u => norm(u) === b);
  if (exact) return exact;
  const part = usageModels.filter(u => { const x = norm(u); return x.length >= 4 && b.length >= 4 && (x.includes(b) || b.includes(x)); });
  return part.sort((x, y) => norm(y).length - norm(x).length)[0] || null;
}
/** 账单计费项对应的用量权重 */
export function weightOf(u, io) {
  if (/cache_creation/.test(io)) return u.input_tokens - u.cache_tokens;
  if (/cache/.test(io)) return u.cache_tokens;
  if (/^input/.test(io)) return Math.max(0, u.input_tokens - u.cache_tokens);
  if (/output/.test(io)) return u.output_tokens;
  return u.total_tokens;
}

/**
 * 把未直接归属 Key 的账单行按用量占比拆分到各 Key。
 * usage：同一周期内的用量行 [{ api_key_id, model, input_tokens, output_tokens, cache_tokens, total_tokens }]
 * 金额按比例拆分，最后一份取余数，保证拆分后合计与原账单完全一致。
 */
export function allocate(rows, usage, keyWs = () => '') {
  const models = [...new Set(usage.map(u => u.model))];
  const out = [];
  for (const r of rows) {
    if (r.api_key_id) { out.push(r); continue; }
    const model = matchModel(r.model, models);
    const cands = model ? usage.filter(u => u.model === model) : [];
    let ws = cands.map(u => ({ u, w: Math.max(0, weightOf(u, r.io)) })).filter(x => x.w > 0);
    if (!ws.length) ws = cands.map(u => ({ u, w: Math.max(0, u.total_tokens) })).filter(x => x.w > 0); // 该 Token 类型无用量时退回按总 Token
    const total = ws.reduce((s, x) => s + x.w, 0);
    if (!total) { out.push(r); continue; }
    const byKey = new Map();
    for (const x of ws) byKey.set(x.u.api_key_id, (byKey.get(x.u.api_key_id) || 0) + x.w);
    const shares = [...byKey.entries()].sort((a, b) => b[1] - a[1]);
    const acc = Object.fromEntries([...MONEY, 'usage', 'tokens'].map(f => [f, 0]));
    shares.forEach(([keyId, w], i) => {
      const last = i === shares.length - 1, f = w / total;
      const o = { ...r, api_key_id: keyId, workspace_id: keyWs(keyId) || r.workspace_id, alloc: 1 };
      for (const k of MONEY) { o[k] = last ? r[k] - acc[k] : r[k] * f; acc[k] += o[k]; }
      for (const k of ['usage', 'tokens']) { if (r[k] == null) continue; o[k] = last ? r[k] - acc[k] : r[k] * f; acc[k] += o[k]; }
      out.push(o);
    });
  }
  return out;
}

/** 用量曲线（JSON 字符串数组）→ [{ day, ...metrics }] */
export function parseSeries(timestamps, series, dayOf) {
  const parse = s => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const f = { input_tokens: parse(series?.InputTotalToken), output_tokens: parse(series?.OutputTotalToken), cache_tokens: parse(series?.CacheTotalToken), total_tokens: parse(series?.TotalToken), requests: parse(series?.RequestCount), fails: parse(series?.RequestFailCount) };
  const out = [];
  (timestamps || []).forEach((ts, i) => {
    const row = { day: dayOf(ts) };
    let any = false;
    for (const [k, arr] of Object.entries(f)) { const v = arr[i]; row[k] = v == null ? 0 : num(v); if (v != null && num(v)) any = true; }
    if (!row.total_tokens) row.total_tokens = row.input_tokens + row.output_tokens;
    if (any) out.push(row);
  });
  return out;
}

/* ---------------- 无费用权限时按目录价估算 ---------------- */
/** DescribeModelList → Map(模型ID/名称 → { input, output, cache }，单位：元/百万 Token） */
export function priceTable(models) {
  const out = new Map();
  for (const m of models || []) {
    const infos = Array.isArray(m.ModelChargingInfo) ? m.ModelChargingInfo : m.ModelChargingInfo ? [m.ModelChargingInfo] : [];
    const info = infos.find(x => x.ChargeUnit === 'TOKEN' && /在线推理|^$/.test(x.Scenario || '')) || infos.find(x => x.ChargeUnit === 'TOKEN');
    if (!info) continue;
    const p = {};
    for (const it of info.ChargingItems || []) {
      const unit = String(it.PriceUnit || '');
      const mul = /百万/.test(unit) ? 1 : /千/.test(unit) ? 1000 : /万/.test(unit) ? 100 : null;
      if (mul == null || !/元/.test(unit)) continue;
      const v = num(it.Price) * mul;
      if (it.PriceName === 'Input') p.input = v; else if (it.PriceName === 'Output') p.output = v; else if (it.PriceName === 'Cache') p.cache = v; else if (it.PriceName === 'Thinking') p.thinking = v;
    }
    if (p.input == null && p.output == null) continue;
    for (const id of [m.ModelId, m.ModelName, ...(Array.isArray(m.ExtraModelIds) ? m.ExtraModelIds : [])].filter(Boolean)) out.set(String(id), p);
  }
  return out;
}
/** 用量 × 目录价 → 估算账单行（alloc=2，表示估算） */
export function estimateRows(usage, prices, region, keyWs = () => '') {
  const rows = [];
  for (const u of usage) {
    const p = prices.get(u.model) || prices.get(matchModel(u.model, [...prices.keys()]) || '');
    if (!p) continue;
    const parts = [['input_token', Math.max(0, u.input_tokens - u.cache_tokens), p.input], ['input_token_cache', u.cache_tokens, p.cache ?? p.input], ['output_token', u.output_tokens, p.output]];
    for (const [io, tokens, price] of parts) {
      if (!tokens || price == null) continue;
      const cost = tokens / 1e6 * price;
      rows.push({
        day: u.day, instance_id: '', api_key_id: u.api_key_id, workspace_id: keyWs(u.api_key_id) || tcWorkspaceId(region), model: u.model, io, channel: '', stop_flag: '', kind: 'inference',
        billing_item: '目录价估算', billing_item_code: '', commodity_code: '', product_detail: 'TokenHub（按目录价估算）', usage: tokens, usage_unit: 'tokens', tokens,
        list_price: String(price), list_price_unit: '元/百万tokens', gross: cost, pretax: cost, after_discount: cost, invoice_discount: 0, coupons: 0, cash_coupons: 0, prepaid: 0,
        resource_pkg: '', currency: 'CNY', region: '', item: '', subscription_type: '', alloc: 2,
      });
    }
  }
  return rows;
}
