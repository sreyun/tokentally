/**
 * 阿里云 OpenAPI 客户端（ACS3-HMAC-SHA256 / V3 签名），只开放本系统需要的只读接口。
 *  - ModelStudio 2026-02-10（ROA）：ListWorkspaces / ListApiKeys / GetApiKey / GetBillingOverview / GetBillingTrend
 *  - BssOpenApi 2017-12-14（RPC）：QueryBillOverview / DescribeInstanceBill
 */
import crypto from 'node:crypto';
import { callLog, recordCall, summarize } from './calllog.mjs';

export { callLog };
export const MS_REGIONS = ['cn-beijing', 'cn-hongkong', 'ap-southeast-1', 'us-east-1', 'eu-central-1'];
export const BSS_ENDPOINTS = { cn: 'business.aliyuncs.com', intl: 'business.ap-southeast-1.aliyuncs.com' };

const PRODUCTS = {
  modelstudio: {
    version: '2026-02-10',
    actions: {
      ListWorkspaces: ['GET', '/modelstudio/workspaces'],
      ListApiKeys: ['GET', '/modelstudio/apikeys'],
      GetApiKey: ['GET', '/modelstudio/apikeys/{apiKeyId}'],
      GetBillingOverview: ['GET', '/modelstudio/billing/overview'],
      GetBillingTrend: ['GET', '/modelstudio/billing/trend'],
    },
  },
  bss: {
    version: '2017-12-14',
    actions: {
      QueryBillOverview: ['POST', '/'],
      DescribeInstanceBill: ['POST', '/'],
    },
  },
};

export class AliyunError extends Error {
  constructor(action, status, code, message, requestId) {
    super(`${action}: ${code || status}${message ? ' ' + message : ''}`);
    Object.assign(this, { action, status, code: code || String(status), aliMessage: message || '', requestId: requestId || '' });
  }
}

export function explainAliyunError(e) {
  const c = `${e?.code || ''} ${e?.aliMessage || e?.message || ''}`;
  if (/InvalidAccessKeyId/i.test(c)) return 'AccessKey ID 不存在或已禁用';
  if (/SignatureDoesNotMatch|IncompleteSignature/i.test(c)) return 'AccessKey Secret 不正确（签名校验失败）';
  if (/Forbidden|NoPermission|NotAuthorized|AccessDenied|Unauthorized/i.test(c)) return 'RAM 用户缺少该接口权限';
  if (/InvalidTimeStamp/i.test(c)) return '服务器时间与标准时间偏差过大，请校准系统时间';
  if (/NetworkError|fetch failed|ENOTFOUND|ECONN|timeout/i.test(c)) return '无法连接阿里云 OpenAPI，请检查容器的出网访问与 DNS';
  return '';
}

/** RFC3986 编码：仅 A-Z a-z 0-9 - _ . ~ 不编码 */
export const percentEncode = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha256hex = data => crypto.createHash('sha256').update(data).digest('hex');
const hmacHex = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');

export function canonicalQuery(query) {
  return Object.entries(query)
    .map(([k, v]) => [percentEncode(k), percentEncode(v ?? '')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function sign({ method, host, path, query, action, version, accessKeyId, accessKeySecret, securityToken, date, nonce, body = '' }) {
  const payloadHash = sha256hex(body);
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': date,
    'x-acs-signature-nonce': nonce,
    'x-acs-content-sha256': payloadHash,
  };
  if (securityToken) headers['x-acs-security-token'] = securityToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(n => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const cqs = canonicalQuery(query);
  const canonicalRequest = `${method}\n${path}\n${cqs}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const hashed = sha256hex(canonicalRequest);
  const signature = hmacHex(accessKeySecret, `ACS3-HMAC-SHA256\n${hashed}`);
  return {
    headers,
    query: cqs,
    hashedCanonicalRequest: hashed,
    signature,
    authorization: `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

/** 使用阿里云官方文档中的固定签名示例自检 */
export function selfTest() {
  const r = sign({
    method: 'POST', host: 'ecs.cn-shanghai.aliyuncs.com', path: '/',
    query: { ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd', RegionId: 'cn-shanghai' },
    action: 'RunInstances', version: '2014-05-26', accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret',
    date: '2023-10-26T10:22:32Z', nonce: '3156853299f313e23d1673dc12e1703d',
  });
  return r.hashedCanonicalRequest === '7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259'
    && r.signature === '06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const MS_GAP_MS = 250;

export class AliyunClient {
  constructor({ accessKeyId, accessKeySecret, securityToken = '', msRegion = 'cn-beijing', bssSite = 'cn' }) {
    if (!MS_REGIONS.includes(msRegion)) throw new Error(`不支持的百炼地域: ${msRegion}`);
    if (!Object.hasOwn(BSS_ENDPOINTS, bssSite)) throw new Error(`不支持的费用中心站点: ${bssSite}`);
    Object.assign(this, { accessKeyId, accessKeySecret, securityToken, msRegion, bssSite });
    this.calls = 0;
    this.msNext = 0;
    this.msLast = 0; // 上一次百炼请求实际发出的时间
  }

  async call(product, action, query = {}, attempt = 0) {
    const p = PRODUCTS[product];
    const def = p && p.actions[action];
    if (!def) throw new Error(`接口不在白名单中: ${product}.${action}`);
    // 百炼 OpenAPI 限频较严（连续约 10 次调用即返回 Throttling.User）：同一客户端内的调用间隔至少 250ms。
    // 同步预约时间片，并发调用也会依次排开
    if (product === 'modelstudio') {
      const slot = Math.max(Date.now(), this.msNext);
      this.msNext = slot + MS_GAP_MS;
      while (Date.now() < slot) await sleep(slot - Date.now()); // 定时器可能提前触发（Windows 时钟精度），循环直到时间片开始
    }
    const [method, pathTpl] = def;
    const q = {};
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      q[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    const path = pathTpl.replace(/\{(\w+)\}/g, (_, n) => { const v = q[n]; delete q[n]; return percentEncode(v ?? ''); });
    const host = product === 'modelstudio' ? `modelstudio.${this.msRegion}.aliyuncs.com` : BSS_ENDPOINTS[this.bssSite];
    const s = sign({
      method, host, path, query: q, action, version: p.version,
      accessKeyId: this.accessKeyId, accessKeySecret: this.accessKeySecret, securityToken: this.securityToken,
      date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), nonce: crypto.randomBytes(16).toString('hex'),
    });
    const headers = { Accept: 'application/json', 'User-Agent': 'tokentally/1.2', Authorization: s.authorization };
    for (const [k, v] of Object.entries(s.headers)) if (k !== 'host') headers[k] = v;
    const url = `https://${host}${path}${s.query ? '?' + s.query : ''}`;
    if (product === 'modelstudio') {
      // 时间片只保证排队顺序：机器繁忙时上一个请求可能比它的时间片晚十几毫秒才真正发出，
      // 下一个按时发出时两者实际间隔不足 250ms。发出前再按上一次的实际发出时间补足间隔
      while (Date.now() < this.msLast + MS_GAP_MS) await sleep(this.msLast + MS_GAP_MS - Date.now());
      this.msLast = Date.now();
    }
    const t0 = Date.now();
    const entry = { ts: t0, provider: 'aliyun', product, action, query: summarize(q), status: 0, ms: 0, ok: false, code: '', message: '', requestId: '' };
    this.calls++;
    let res, text;
    try {
      res = await fetch(url, { method, headers, signal: AbortSignal.timeout(60_000) });
      text = await res.text();
    } catch (e) {
      Object.assign(entry, { ms: Date.now() - t0, code: 'NetworkError', message: e.cause?.code || e.message });
      recordCall(entry);
      if (attempt < 2) { await sleep(1500 * (attempt + 1)); return this.call(product, action, query, attempt + 1); }
      throw new AliyunError(action, 0, 'NetworkError', entry.message);
    }
    // 非 JSON 响应（网关 / 代理返回的 HTML 错误页等）即使是 HTTP 200 也不能当成功：否则会被当作“空列表 / 无账单”入库
    let json, parsed = true;
    try { json = JSON.parse(text); } catch { parsed = false; }
    if (!parsed || !json || typeof json !== 'object') json = { Code: 'BadResponse', Message: `响应不是有效的 JSON（HTTP ${res.status}）：${String(text).slice(0, 200)}` };
    const ok = parsed && res.ok && json.success !== false && json.Success !== false;
    Object.assign(entry, {
      ms: Date.now() - t0, status: res.status, ok,
      code: ok ? '' : String(json.Code ?? json.code ?? res.status),
      message: ok ? '' : String(json.Message ?? json.message ?? ''),
      requestId: json.RequestId ?? json.requestId ?? '',
    });
    recordCall(entry);
    if (!ok) {
      if ((/Throttling|ServiceUnavailable|InternalError|SystemBusy|BadResponse/i.test(entry.code) || res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
        return this.call(product, action, query, attempt + 1);
      }
      throw new AliyunError(action, res.status, entry.code, entry.message, entry.requestId);
    }
    return json;
  }

  /** ModelStudio 分页（nextToken / maxResults） */
  async listAll(action, base, arrKey) {
    const out = [];
    const seen = new Set();
    let token = '';
    for (let i = 0; i < 200; i++) {
      const r = await this.call('modelstudio', action, { ...base, maxResults: 100, nextToken: token || undefined });
      if (r[arrKey] != null && !Array.isArray(r[arrKey])) throw new AliyunError(action, 200, 'BadResponse', `响应中的 ${arrKey} 不是列表`, r.requestId || r.RequestId);
      const items = r[arrKey] || [];
      out.push(...items);
      token = r.nextToken || '';
      if (!token || !items.length) return out;
      // 重复的 nextToken 或达到页数上限：列表不完整，必须报错——元数据同步会把未取到的 Key 标记为已删除
      if (seen.has(token)) throw new AliyunError(action, 200, 'BadResponse', '分页返回重复的 nextToken，列表不完整');
      seen.add(token);
    }
    throw new AliyunError(action, 200, 'BadResponse', '分页超过 200 页，列表不完整');
  }

  /** BssOpenApi DescribeInstanceBill 分页（NextToken / MaxResults ≤ 300） */
  async describeInstanceBill(query) {
    const out = [];
    const seen = new Set();
    let token = '';
    for (let i = 0; i < 2000; i++) {
      const r = await this.call('bss', 'DescribeInstanceBill', { ...query, MaxResults: 300, NextToken: token || undefined });
      // 缺少 Data 的响应不是“当天没有账单”，不能用空结果替换已入库的账单
      if (!r.Data || typeof r.Data !== 'object') throw new AliyunError('DescribeInstanceBill', 200, 'BadResponse', '响应缺少 Data', r.RequestId || r.requestId);
      const d = r.Data;
      const items = Array.isArray(d.Items) ? d.Items : (d.Items?.Item || []);
      out.push(...items);
      token = d.NextToken || '';
      // 接口异常返回重复的 NextToken 时停止，避免同一页被反复拉取（重复计费行 + 长时间占用）
      if (!token || !items.length || seen.has(token)) break;
      seen.add(token);
    }
    return out;
  }
}


/* ===================================================================
 * 账单解析：实例ID = ApiKeyID;业务空间ID;模型;计费项;[调用渠道];[免费额度用完即停]
 * =================================================================== */
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

export function parseInstanceId(id) {
  const r = { kind: 'other', apiKeyId: '', workspaceId: '', model: '', io: '', channel: '', stopFlag: '' };
  if (!id) return r;
  if (!id.includes(';')) {
    if (id.includes('!')) {
      const [ws, , task] = id.split('!');
      return { ...r, kind: 'training', workspaceId: ws || '', model: task || '', channel: 'training' };
    }
    return r;
  }
  const s = id.split(';').map(x => (x === '-' ? '' : x)); // "-" 表示该段为空（如未归属业务空间）
  let i;
  if (/^\d*$/.test(s[0])) { r.apiKeyId = s[0]; i = 1; }
  else if (/^(llm-|ws-)/i.test(s[0])) i = 0;
  else i = 1; // 旧格式：计费类型;业务空间;模型;...
  r.kind = 'inference';
  r.workspaceId = s[i] || '';
  r.model = s[i + 1] || '';
  r.io = s[i + 2] || '';
  for (const x of s.slice(i + 3)) { if (/^[01]$/.test(x)) r.stopFlag = x; else if (x) r.channel = x; }
  return r;
}

export function tokenCount(usage, unit) {
  if (usage == null || !/token/i.test(unit || '')) return null;
  const pre = String(unit).replace(/\s*tokens?\s*/i, '').trim();
  const mul = /^百万|^M$/i.test(pre) ? 1e6 : /^万/.test(pre) ? 1e4 : /^千|^K$/i.test(pre) ? 1e3 : 1;
  return usage * mul;
}

export function normalizeBillItem(it) {
  const inst = String(it.InstanceID ?? '');
  const p = parseInstanceId(inst);
  const usage = it.Usage === '' || it.Usage == null ? null : num(it.Usage);
  const unit = it.UsageUnit || '';
  const model = p.model || (p.kind === 'other' ? `[${it.BillingItem || it.ProductDetail || '其他费用'}]` : '(未知模型)');
  const pretax = num(it.PretaxAmount);
  return {
    instance_id: inst, api_key_id: p.apiKeyId, workspace_id: p.workspaceId, model, io: p.io, channel: p.channel, stop_flag: p.stopFlag, kind: p.kind,
    billing_item: it.BillingItem || '', billing_item_code: it.BillingItemCode || '', commodity_code: it.CommodityCode || '', product_detail: it.ProductDetail || '',
    usage, usage_unit: unit, tokens: tokenCount(usage, unit),
    list_price: it.ListPrice == null ? '' : String(it.ListPrice), list_price_unit: it.ListPriceUnit || '',
    gross: num(it.PretaxGrossAmount), pretax,
    after_discount: it.AfterDiscountAmount == null || it.AfterDiscountAmount === '' ? pretax : num(it.AfterDiscountAmount),
    invoice_discount: num(it.InvoiceDiscount), coupons: num(it.DeductedByCoupons), cash_coupons: num(it.DeductedByCashCoupons),
    prepaid: num(it.DeductedByPrepaidCard), resource_pkg: String(it.DeductedByResourcePackage ?? ''),
    currency: it.Currency || 'CNY', region: it.Region || '', item: it.Item || '', subscription_type: it.SubscriptionType || '',
  };
}
