/**
 * 演示数据：无需任何云账号即可体验全部功能（DEMO_DATA=true 且数据库为空时生成）。
 * 数据为确定性随机生成的虚构 Key / 模型 / 账单，覆盖阿里云百炼与腾讯云 TokenHub、成本中心、预算、
 * 治理问题（无描述、权限过宽、已删除仍计费、闲置）、费用异常日等场景。配置真实访问密钥后自动清除。
 */
import crypto from 'node:crypto';
import { addDays, addMonths, daysInCycle, isCycleFinal } from './sync.mjs';

const rnd = s => crypto.createHash('md5').update(String(s)).digest().readUInt32BE(0) / 0xffffffff;
// 单价：元 / 千 Token（仅用于演示，与实际价格无关）
const ALI_PRICE = {
  'qwen-plus': { in: 0.0008, out: 0.002, cache: 0.00032 }, 'qwen-max': { in: 0.0024, out: 0.0096, cache: 0.00096 },
  'qwen-turbo': { in: 0.0003, out: 0.0006, cache: 0.00012 }, 'qwen3-coder-plus': { in: 0.004, out: 0.016, cache: 0.0016 },
  'deepseek-v3.2': { in: 0.002, out: 0.003, cache: 0.0002 }, 'text-embedding-v3': { emb: 0.0005 },
};
const TC_PRICE = { 'deepseek-v3.2': { in: 0.002, out: 0.003, cache: 0.0002 }, 'hunyuan-turbos-latest': { in: 0.0008, out: 0.002, cache: 0.00016 }, 'kimi-k2.5': { in: 0.004, out: 0.016, cache: 0.0007 } };
const WS = [['llm-demo-ecom', '电商事业部'], ['llm-demo-rd', '研发中心'], ['llm-demo-cs', '客户服务部']];
// models：日均输入 Token（百万）
const ALI_KEYS = [
  { id: '100101', desc: '智能客服-生产', ws: 'llm-demo-cs', models: { 'qwen-plus': 9, 'qwen-turbo': 4 }, cc: '客户服务部', owner: '王敏', ips: ['10.0.0.0/8'], budget: 1500, age: 160 },
  { id: '100102', desc: '商品文案生成', ws: 'llm-demo-ecom', models: { 'qwen-max': 2.6, 'qwen-plus': 2 }, cc: '电商事业部', owner: '李华', ips: ['10.20.0.0/16'], budget: 1100, age: 140 },
  { id: '100103', desc: '研发-代码助手', ws: 'llm-demo-rd', models: { 'qwen3-coder-plus': 1.8, 'deepseek-v3.2': 1.5 }, cc: '研发中心', owner: '张伟', allowAll: true, age: 120 },
  { id: '100104', desc: '知识库向量检索', ws: 'llm-demo-rd', models: { 'text-embedding-v3': 14, 'qwen-plus': 1.2 }, cc: '研发中心', owner: '赵磊', ips: ['172.16.0.0/12'], age: 110 },
  { id: '100105', desc: '经营分析 Agent', ws: 'llm-demo-ecom', models: { 'qwen-max': 1.1 }, cc: '电商事业部', owner: '陈静', ips: ['10.30.0.0/16'], spike: true, budget: 260, age: 90 },
  { id: '100106', desc: '', ws: 'llm-demo-rd', models: { 'qwen-turbo': 0.8 }, allowAll: true, age: 75 },
  { id: '100107', desc: '旧版网关', ws: 'llm-demo-cs', models: { 'qwen-plus': 0.35 }, deleted: true, age: 200 },
  { id: '100108', desc: '压测-临时', ws: 'llm-demo-rd', models: {}, age: 65 },
];
const TC_KEYS = [
  { id: 'ak-demo-tc-0001', desc: '智能外呼', models: { 'deepseek-v3.2': 5.5 }, cc: '客户服务部', owner: '刘洋', age: 100 },
  { id: 'ak-demo-tc-0002', desc: '代码评审机器人', models: { 'kimi-k2.5': 0.9, 'deepseek-v3.2': 1.4 }, cc: '研发中心', owner: '张伟', age: 95 },
  { id: 'ak-demo-tc-0003', desc: '内容审核', models: { 'hunyuan-turbos-latest': 6.5 }, cc: '电商事业部', owner: '孙悦', age: 80 },
];

/** 某 Key × 模型 × 日 的 Token 用量（含趋势、周末效应、随机波动、演示用异常峰值） */
function dayUsage(key, model, base, day, start, today) {
  const t = (Date.parse(day) - Date.parse(start)) / 864e5;
  const wd = new Date(day + 'T00:00:00Z').getUTCDay();
  let f = (1 + t * 0.006) * (wd === 0 || wd === 6 ? 0.55 : 1) * (0.78 + 0.44 * rnd(key.id + model + day));
  if (key.spike && day === addDays(today, -3)) f *= 6;
  if (key.deleted && day > addDays(today, -45)) f *= 0.15;
  const input = Math.round(base * 1e6 * f);
  const cacheRate = model === 'qwen-plus' ? 0.55 : model === 'text-embedding-v3' ? 0 : 0.32;
  const outRate = model === 'text-embedding-v3' ? 0 : model.includes('coder') ? 0.38 : model.includes('max') ? 0.3 : 0.22;
  return { input, cache: Math.round(input * cacheRate * (0.85 + 0.3 * rnd('c' + day + key.id))), output: Math.round(input * outRate * (0.8 + 0.4 * rnd('o' + day + model))) };
}

function lineRow({ provider, keyId, ws, model, io, tokens, price, discount, day }) {
  const gross = tokens / 1000 * price, pretax = gross * discount;
  return {
    day, instance_id: provider === 'aliyun' ? `${keyId || '-'};${ws || '-'};${model};${io}` : (model === 'deepseek-v3.2' ? 'ep-demo-ds' : model),
    api_key_id: keyId, workspace_id: ws, model, io, channel: '', stop_flag: '', kind: 'inference', billing_item: io, billing_item_code: '', commodity_code: '',
    product_detail: provider === 'aliyun' ? '大模型服务平台百炼' : '大模型服务平台 TokenHub', usage: tokens, usage_unit: 'tokens', tokens,
    list_price: String(price), list_price_unit: '元/千tokens', gross, pretax, after_discount: pretax, invoice_discount: gross - pretax, coupons: 0, cash_coupons: 0, prepaid: 0,
    resource_pkg: '', currency: 'CNY', region: provider === 'aliyun' ? 'cn-beijing' : '华南地区（广州）', item: '', subscription_type: '后付费', alloc: provider === 'tencent' ? 1 : 0,
  };
}

export function seedDemo(store, today) {
  const cur = today.slice(0, 7), cycles = [addMonths(cur, -2), addMonths(cur, -1), cur];
  const start = cycles[0] + '-01';
  const now = Date.now();
  const tcWs = 'tc:ap-guangzhou';
  // 元数据（applyMeta 会生成“新增”变更记录）
  store.applyMeta('aliyun', WS.map(([id, name], i) => ({ workspaceId: id, workspaceName: name, region: 'cn-beijing', gmtCreate: now - (300 - i * 20) * 864e5 })),
    ALI_KEYS.map(k => ({ apiKeyId: k.id, apiKeyValue: `sk-****${k.id.slice(-4)}`, description: k.desc, workspaceId: k.ws, workspaceName: WS.find(w => w[0] === k.ws)[1], disabled: false,
      auth: { type: k.allowAll ? 'All' : 'Custom', modelAccessScope: { allowAllModels: !!k.allowAll, accessibleModels: k.allowAll ? [] : Object.keys(k.models) }, accessIps: k.ips || [] }, createdBy: '200001', gmtCreate: now - k.age * 864e5 })),
    { markMissing: false });
  store.applyMeta('tencent', [{ workspaceId: tcWs, workspaceName: 'TokenHub · 广州', region: 'ap-guangzhou' }],
    TC_KEYS.map(k => ({ apiKeyId: k.id, apiKeyValue: `sk-${k.id.slice(-4)}***`, description: k.desc, workspaceId: tcWs, workspaceName: 'TokenHub · 广州', disabled: false,
      auth: { type: 'model_custom_endpoint_custom', modelAccessScope: { allowAllModels: false, accessibleModels: Object.keys(k.models) }, accessIps: [] }, createdBy: '300001', gmtCreate: now - k.age * 864e5 })),
    { markMissing: false });
  store.tx(() => {
    for (const k of ALI_KEYS.filter(x => x.deleted)) {
      store.q('UPDATE api_keys SET deleted_at = ? WHERE api_key_id = ?').run(now - 40 * 864e5, k.id);
      store.logChange('api_key', k.id, k.desc, 'delete', null, null);
    }
    store.logChange('api_key', '100102', '商品文案生成', 'update', { description: '文案生成' }, { description: '商品文案生成' });
    for (const k of [...ALI_KEYS, ...TC_KEYS]) if (k.cc) store.setKeyTag(k.id, { costCenter: k.cc, owner: k.owner }, 'demo');

    const usageRows = [];
    for (const cycle of cycles) {
      const days = daysInCycle(cycle, today), final = isCycleFinal(cycle, today);
      for (const provider of ['aliyun', 'tencent']) {
        const keys = provider === 'aliyun' ? ALI_KEYS : TC_KEYS, PRICE = provider === 'aliyun' ? ALI_PRICE : TC_PRICE, code = provider === 'aliyun' ? 'sfm' : 'p_tokenhub';
        const month = new Map();
        for (const day of days) {
          const rows = [];
          for (const k of keys) {
            if (now - k.age * 864e5 > Date.parse(day + 'T23:59:59Z')) continue;
            const ws = provider === 'aliyun' ? k.ws : tcWs;
            for (const [model, base] of Object.entries(k.models)) {
              const u = dayUsage(k, model, base, day, start, today), p = PRICE[model];
              const disc = provider === 'aliyun' ? 0.88 : 0.9;
              if (p.emb) rows.push(lineRow({ provider, keyId: k.id, ws, model, io: 'embedding_token', tokens: u.input, price: p.emb, discount: disc, day }));
              else {
                rows.push(lineRow({ provider, keyId: k.id, ws, model, io: 'input_token', tokens: u.input - u.cache, price: p.in, discount: disc, day }));
                if (u.cache) rows.push(lineRow({ provider, keyId: k.id, ws, model, io: 'input_token_cache', tokens: u.cache, price: p.cache, discount: disc, day }));
                rows.push(lineRow({ provider, keyId: k.id, ws, model, io: 'output_token', tokens: u.output, price: p.out, discount: disc, day }));
              }
              // 调用次数：腾讯云来自 TokenHub 用量；阿里云模拟“监控数据投递”最近 60 天的数据（Token 与账单一致）
              if (provider === 'tencent' || day >= addDays(today, -59)) {
                const requests = Math.max(1, Math.round(u.input / (1600 + 900 * rnd('r' + model + k.id))));
                usageRows.push({ provider, day, api_key_id: k.id, model, input_tokens: u.input, output_tokens: p.emb ? 0 : u.output, cache_tokens: p.emb ? 0 : u.cache, total_tokens: p.emb ? u.input : u.input + u.output, requests, fails: Math.round(requests * 0.012 * (0.5 + rnd('f' + day + k.id))) });
              }
            }
          }
          if (provider === 'aliyun' && day.endsWith('-01')) {
            rows.push({ ...lineRow({ provider, keyId: '', ws: '', model: '[订阅套餐]', io: '', tokens: 0, price: 0, discount: 1, day }), usage: null, tokens: null, list_price: '', list_price_unit: '', gross: 50, pretax: 50, after_discount: 50, invoice_discount: 0, kind: 'other', instance_id: '' });
          }
          store.insertLines(provider, 'D', day, cycle, code, rows, now);
          for (const r of rows) {
            const mk = [r.api_key_id, r.model, r.io].join('|');
            const m = month.get(mk) || { ...r, usage: null, tokens: null, gross: 0, pretax: 0, after_discount: 0, invoice_discount: 0 };
            if (r.tokens != null) { m.tokens = (m.tokens || 0) + r.tokens; m.usage = m.tokens; }
            for (const f of ['gross', 'pretax', 'after_discount', 'invoice_discount']) m[f] += r[f];
            month.set(mk, m);
          }
        }
        store.insertLines(provider, 'M', cycle, cycle, code, [...month.values()], now);
        if (final) store.q('UPDATE bill_periods SET final = 1 WHERE provider = ? AND cycle = ?').run(provider, cycle);
        store.markCycle(provider, cycle, [code], final);
      }
    }
    const ins = store.q(`INSERT INTO usage_lines(provider, day, api_key_id, model, input_tokens, output_tokens, cache_tokens, total_tokens, requests, fails, synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const u of usageRows) ins.run(u.provider, u.day, u.api_key_id, u.model, u.input_tokens, u.output_tokens, u.cache_tokens, u.total_tokens, u.requests, u.fails, now);
  });
  // 预算：总预算略高于上月，部分 Key 设置预算（其中一个会超出）
  const last = store.q("SELECT SUM(pretax) AS c FROM bill_lines WHERE granularity = 'M' AND period = ?").get(addMonths(cur, -1)).c || 0;
  store.setSetting('budgets', { monthly: Math.ceil(last * 1.08 / 100) * 100, alertPct: 80, keys: Object.fromEntries(ALI_KEYS.filter(k => k.budget).map(k => [k.id, k.budget])) });
  for (const p of ['aliyun', 'tencent']) for (const kind of ['meta', 'bills']) {
    const id = store.startRun(kind, 'demo', p);
    store.finishRun(id, 'success', kind === 'meta' ? { workspaces: p === 'aliyun' ? WS.length : 1, apiKeys: (p === 'aliyun' ? ALI_KEYS : TC_KEYS).length, changes: 0, warnings: [] } : { cycles: cycles.map(c => ({ cycle: c, demo: true })), warnings: [] }, null, 0);
  }
  store.setSetting('demo', true);
}

/** 清除演示数据（配置真实访问密钥时调用） */
export function clearDemo(store) {
  store.tx(() => {
    for (const t of ['bill_lines', 'bill_periods', 'bill_cycles', 'usage_lines', 'api_keys', 'workspaces', 'change_log', 'key_tags', 'ms_overview']) store.db.exec(`DELETE FROM ${t}`);
    store.q("DELETE FROM sync_runs WHERE trig = 'demo'").run();
  });
  store.setSetting('budgets', { monthly: null, alertPct: 80, keys: {} });
  store.setSetting('demo', false);
}
