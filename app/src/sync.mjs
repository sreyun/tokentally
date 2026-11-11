/**
 * 定时同步（多云：阿里云百炼 + 腾讯云 TokenHub，各自独立调度、互不阻塞）：
 *  - 元数据（业务空间 / API Key / 描述 / 权限）：默认每 5 分钟，与云厂商保持一致，记录新增/修改/删除
 *  - 账单：
 *    阿里云：按“账期(月)”与“日”两种粒度分别拉取实例账单整体替换入库，口径与费用中心一致
 *    腾讯云：按账期拉取账单明细（按资源出账）+ TokenHub 用量（Key × 模型 × 日），按用量占比把真实账单金额分摊到 Key
 */
import { AliyunClient, normalizeBillItem } from './aliyun.mjs';
import {
  TencentClient, normalizeTencentKey, tencentBillRows, rollupMonth, allocate, parseSeries, priceTable, estimateRows,
  tcWorkspaceId, tcWorkspaceName, TC_PRODUCT_RE,
} from './tencent.mjs';
import { PromClient, fetchCalls, buildUsageRows, MAPPING_FIELDS } from './prom.mjs';

const BAILIAN_RE = /百炼|bailian|model\s*studio|dashscope|灵积/i;
/** 腾讯云账单日（BillDay）与 TokenHub 用量统计都按北京时间划分，与 BILL_TZ 无关 */
const TC_TZ = 'Asia/Shanghai';
/** TokenHub 用量统计的保留天数：更早的日期接口不再返回数据，只能使用本地已保存的用量 */
export const TC_USAGE_RETENTION_DAYS = 60;
export const PROVIDER_LIST = ['aliyun', 'tencent'];
export const PROVIDER_NAMES = { aliyun: '阿里云', tencent: '腾讯云' };

export function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function hourIn(tz) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date())) % 24;
}
export function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function addMonths(cycle, n) {
  const [y, m] = cycle.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
export const lastDayOf = cycle => addDays(addMonths(cycle, 1) + '-01', -1);
export function daysInCycle(cycle, today) {
  const out = [];
  for (let d = cycle + '-01'; d.slice(0, 7) === cycle && d <= today; d = addDays(d, 1)) out.push(d);
  return out;
}
/** 次月 3 日后出账，4 日起视为已结算（阿里云、腾讯云均于次月初出账） */
export const isCycleFinal = (cycle, today) => today >= addDays(addMonths(cycle, 1) + '-01', 3);

export async function pool(tasks, n, onDone) {
  const results = new Array(tasks.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = { ok: true, v: await tasks[i]() }; } catch (e) { results[i] = { ok: false, e }; }
      onDone?.(++done, tasks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tasks.length)) }, worker));
  return results;
}

/**
 * 合并排队中的同步请求：明确指定的账期取并集，任一请求不限账期则同时包含默认回溯范围（includeDefault），强制同步取或。
 * 默认范围与明确指定的账期分开保存：默认范围之外、明确请求的旧账期不会因为合并而丢失
 */
export function mergeOpts(prev, next) {
  if (!prev) return { provider: next.provider, cycles: next.cycles?.length ? [...next.cycles] : undefined, includeDefault: !next.cycles?.length || !!next.includeDefault, force: !!next.force };
  const cycles = [...new Set([...(prev.cycles || []), ...(next.cycles || [])])].sort().reverse().slice(0, 36);
  return { provider: next.provider || prev.provider, cycles: cycles.length ? cycles : undefined, includeDefault: !!prev.includeDefault || !next.cycles?.length || !!next.includeDefault, force: !!(prev.force || next.force) };
}

const SECRET_KEYS = {
  aliyun: ['aliyun.accessKeyId', 'aliyun.accessKeySecret'],
  tencent: ['tencent.secretId', 'tencent.secretKey'],
};
const PERM_RE = /Unauthorized|OperationDenied|AuthFailure\.Unauthorized|NotAuthorized|Forbidden|NoPermission/i;

export class SyncService {
  constructor({ store, tz, log, tencentEndpoint = '', promAllowLoopback = false }) {
    Object.assign(this, { store, tz, log, tencentEndpoint, promAllowLoopback });
    this.callsBusy = null;
    this.running = {};     // `${provider}:${kind}` → runId
    this.pending = {};     // `${provider}:${kind}` → { trig, opts }：运行中收到的手动 / 配置变更请求，结束后执行
    this.progress = {};
    this.lastAttempt = {};
    this.timer = null;
  }

  /** 'ok' | 'none' | 'undecryptable' */
  secretState(provider) {
    try {
      const [a, b] = SECRET_KEYS[provider];
      return this.store.getSecret(a) && this.store.getSecret(b) ? 'ok' : 'none';
    } catch { return 'undecryptable'; }
  }
  credentials(provider) {
    try {
      const [a, b] = SECRET_KEYS[provider];
      const id = this.store.getSecret(a), secret = this.store.getSecret(b);
      return id && secret ? { id, secret } : null;
    } catch { return null; }
  }
  configured() { return PROVIDER_LIST.filter(p => this.credentials(p)); }

  client(provider) {
    const c = this.credentials(provider);
    if (provider === 'tencent') {
      if (!c) throw new Error('尚未配置腾讯云 API 密钥（或主密钥变化导致无法解密），请在“系统管理 → 腾讯云接入”中配置');
      const t = this.store.tencentSettings();
      return new TencentClient({ secretId: c.id, secretKey: c.secret, region: t.region, site: t.site, endpoint: this.tencentEndpoint });
    }
    if (!c) throw new Error('尚未配置阿里云 AccessKey（或主密钥变化导致无法解密），请在“系统管理 → 阿里云接入”中配置');
    const a = this.store.aliyunSettings();
    return new AliyunClient({ accessKeyId: c.id, accessKeySecret: c.secret, msRegion: a.msRegion, bssSite: a.bssSite });
  }

  start() {
    this.resetSchedule();
    setTimeout(() => this.tick(), 5_000);
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref?.();
  }
  /** 按数据库中的同步记录重新计算调度时间（清除演示数据后调用：演示数据的同步记录不能推迟真实数据的首次同步） */
  resetSchedule() {
    for (const p of PROVIDER_LIST) for (const k of ['meta', 'bills']) {
      const key = `${p}:${k}`;
      if (!this.running[key]) this.lastAttempt[key] = this.store.lastRun(k, null, p)?.started_at || 0;
    }
  }
  /** 访问密钥或地域变化：立即同步元数据（运行中则排队），账单在元数据同步完成后由调度立即执行 */
  credentialsChanged(provider) {
    this.run('meta', 'key-changed', { provider, queue: true });
    const b = `${provider}:bills`;
    if (this.running[b]) this.pending[b] = { trig: 'key-changed', opts: mergeOpts(this.pending[b]?.opts, { provider }) };
    else this.lastAttempt[b] = 0;
  }

  /** 定时检查（同步的数据库读写异常不能让整个服务退出） */
  tick() {
    try {
      const s = this.store.syncSettings();
      const now = Date.now();
      for (const p of this.configured()) {
        const m = `${p}:meta`, b = `${p}:bills`;
        if (!this.running[m] && now - (this.lastAttempt[m] || 0) >= s.metaIntervalMin * 60_000) this.run('meta', 'schedule', { provider: p });
        if (!this.running[b] && !this.running[m] && now - (this.lastAttempt[b] || 0) >= s.billIntervalMin * 60_000) this.run('bills', 'schedule', { provider: p });
      }
    } catch (e) {
      this.log(`同步调度检查失败：${e.message}`);
    }
  }

  /**
   * 异步启动任务；同一厂商同类任务运行中时返回运行中的任务。
   * opts.queue=true（指定账期 / 强制重新同步 / 配置变更）时把请求排队，在运行中的任务结束后执行，多个请求合并（账期取并集）
   */
  run(kind, trig, opts = {}) {
    const provider = opts.provider || 'aliyun';
    const key = `${provider}:${kind}`;
    if (this.running[key]) {
      if (!opts.queue) return { runId: this.running[key], alreadyRunning: true, provider };
      this.pending[key] = { trig, opts: mergeOpts(this.pending[key]?.opts, { ...opts, provider }) };
      return { runId: this.running[key], alreadyRunning: true, queued: true, provider };
    }
    const runId = Number(this.store.startRun(kind, trig, provider));
    this.running[key] = runId;
    this.lastAttempt[key] = Date.now();
    this.progress[key] = { text: '准备中…', done: 0, total: 0 };
    const t0 = Date.now();
    (async () => {
      let client;
      try {
        client = this.client(provider);
        const detail = provider === 'tencent'
          ? (kind === 'meta' ? await this.syncTencentMeta(client) : await this.syncTencentBills(client, opts))
          : (kind === 'meta' ? await this.syncMeta(client) : await this.syncBills(client, opts));
        const status = detail.warnings?.length ? 'partial' : 'success';
        this.store.finishRun(runId, status, detail, detail.warnings?.length ? detail.warnings.slice(0, 5).join('；') : null, client.calls);
        this.log(`同步[${PROVIDER_NAMES[provider]}·${kind}] ${status} ${Date.now() - t0}ms ${client.calls} 次调用`);
        if (kind === 'bills') Promise.resolve().then(() => this.onBillsSynced?.(provider)).catch(e => this.log('账单同步后处理失败：' + e.message));
      } catch (e) {
        this.store.finishRun(runId, 'error', null, String(e.message || e).slice(0, 500), client?.calls ?? 0);
        this.log(`同步[${PROVIDER_NAMES[provider]}·${kind}] 失败: ${e.message}`);
      } finally {
        this.running[key] = null;
        this.progress[key] = null;
        this.lastAttempt[key] = Date.now();
        Promise.resolve().then(() => this.onRunFinished?.(provider, kind)).catch(() => { /* ignore */ });
        const next = this.pending[key];
        if (next) {
          delete this.pending[key];
          setTimeout(() => { try { if (this.credentials(provider)) this.run(kind, next.trig, next.opts); } catch (e) { this.log(`排队的同步任务启动失败：${e.message}`); } }, 200).unref?.();
        }
        setTimeout(() => this.tick(), 1000).unref?.(); // 元数据同步完成后立即检查是否需要同步账单
      }
    })();
    return { runId, provider };
  }

  setProgress(provider, kind, text, done = 0, total = 0) { this.progress[`${provider}:${kind}`] = { text, done, total }; }

  /* ===================== 阿里云 ===================== */
  async syncMeta(c) {
    const s = this.store.syncSettings();
    const P = (t, d, n) => this.setProgress('aliyun', 'meta', t, d, n);
    P('读取业务空间…');
    const ws = await c.listAll('ListWorkspaces', {}, 'workspaces');
    P('读取 API Key…');
    const keys = new Map();
    for (const k of await c.listAll('ListApiKeys', {}, 'apiKeys')) keys.set(String(k.apiKeyId), k);
    const warnings = [];
    let complete = true;
    const failedWs = new Set();
    if (s.perWorkspaceKeys) {
      let i = 0;
      for (const w of ws) {
        P(`补全业务空间 API Key ${++i}/${ws.length}`, i, ws.length);
        try {
          for (const k of await c.listAll('ListApiKeys', { workspaceId: w.workspaceId }, 'apiKeys')) {
            const id = String(k.apiKeyId);
            const cur = keys.get(id);
            // 全局列表缺少归属信息时，用按业务空间查询的结果补全
            if (!cur) keys.set(id, k);
            else if ((!cur.workspaceId || cur.workspaceId === '-') && k.workspaceId && k.workspaceId !== '-') keys.set(id, { ...cur, workspaceId: k.workspaceId, workspaceName: k.workspaceName || cur.workspaceName });
          }
        } catch (e) {
          // 只跳过这个业务空间的删除检测（其中的 Key 不标记删除），其余业务空间照常检测
          failedWs.add(String(w.workspaceId || ''));
          warnings.push(`业务空间 ${w.workspaceName} 的 API Key 获取失败：${e.code || e.message}`);
        }
      }
    }
    // 接口异常返回空列表时不能把全部 Key 标记为已删除（会产生大量“删除”变更与告警，下次同步又全部“恢复”）
    if (complete && !keys.size && this.store.listApiKeys().some(k => k.provider === 'aliyun' && !k.deleted_at)) {
      complete = false;
      warnings.push('API Key 列表返回为空，本次不标记删除（如确已全部删除，下次同步仍为空时请核对百炼控制台）');
    }
    if (complete && !ws.length && this.store.listWorkspaces().some(w => w.provider === 'aliyun' && !w.deleted_at)) {
      complete = false;
      warnings.push('业务空间列表返回为空，本次不标记删除');
    }
    const changes = this.store.applyMeta('aliyun', ws, [...keys.values()], { markMissing: complete, skipWs: failedWs });
    return { workspaces: ws.length, apiKeys: keys.size, changes, warnings };
  }

  /**
   * 识别本账期百炼的产品代码：返回 { codes, authoritative }。
   * authoritative=true（管理员固定的代码，或账单总览接口成功）时结果可靠：可清理不再出现的旧代码账单、可将已出账账期定稿；
   * 账单总览失败时按默认 sfm 拉取，但不清理、不定稿，下次同步重试
   */
  async detectCodes(c, cycle, warnings) {
    const fixed = (this.store.aliyunSettings().productCode || '').split(/[,\s]+/).filter(Boolean);
    if (fixed.length) return { codes: fixed, authoritative: true };
    try {
      const r = await c.call('bss', 'QueryBillOverview', { BillingCycle: cycle });
      const items = Array.isArray(r.Data?.Items) ? r.Data.Items : (r.Data?.Items?.Item || []);
      const codes = [...new Set(items.filter(it => BAILIAN_RE.test(it.ProductName || '') || /^sfm/i.test(it.ProductCode || '') || /^sfm/i.test(it.PipCode || ''))
        .map(it => it.ProductCode).filter(Boolean))];
      return { codes, authoritative: true };
    } catch (e) {
      // 账单总览不可用（如 RAM 未授权 bss:QueryBillOverview）：沿用此前识别到的产品代码，没有时用默认 sfm；不清理旧代码、不定稿账期
      const known = this.store.knownCodes('aliyun', cycle);
      const codes = known.length ? known : ['sfm'];
      warnings.push(`${cycle} 账单总览获取失败，按${known.length ? '此前识别的' : '默认'}产品代码 ${codes.join(', ')} 拉取（账期暂不定稿；缺少 bss:QueryBillOverview 权限时可在“阿里云接入”中固定产品代码）：${e.code || e.message}`);
      return { codes, authoritative: false };
    }
  }

  needDay(day, code, today, final) {
    const p = this.store.getPeriod('aliyun', 'D', day, code);
    if (!p) return true;
    if (p.final) return false;
    if (final) return true;                         // 账期已出账：再同步一次并标记为终版
    if (day >= addDays(today, -3)) return true;      // 最近 3 天账单仍会持续入账
    return Date.now() - p.synced_at > 12 * 3600_000; // 其余未出账日每 12 小时校正一次
  }

  /**
   * 需要同步的账期：手动指定的账期，或从本月起向前 backfillMonths 个月。
   * 上月尚未定稿时总是包含上月（backfillMonths=1 时，月初出账的上月账单与最后一天的日账单也要继续同步直到定稿）
   */
  cyclesToSync(opts, provider = 'aliyun') {
    const s = this.store.syncSettings();
    const cur = todayIn(this.tz).slice(0, 7);
    const back = Math.min(18, Math.max(1, s.backfillMonths || 3));
    const useDefault = !opts.cycles?.length || opts.includeDefault;
    const list = useDefault ? Array.from({ length: back }, (_, i) => addMonths(cur, -i)) : [];
    if (useDefault) {
      const prev = addMonths(cur, -1);
      if (!list.includes(prev) && !this.store.getCycle(prev, provider)?.final) list.push(prev);
    }
    for (const c of opts.cycles || []) if (!list.includes(c)) list.push(c);
    return list.filter(x => /^\d{4}-(0[1-9]|1[0-2])$/.test(x) && x <= cur).sort().reverse();
  }

  async syncBills(c, opts = {}) {
    const s = this.store.syncSettings();
    const today = todayIn(this.tz);
    const warnings = [];
    const summary = { cycles: [], warnings };
    const P = (t, d, n) => this.setProgress('aliyun', 'bills', t, d, n);
    let attempted = 0, succeeded = 0, firstError = null;
    for (const cycle of this.cyclesToSync(opts, 'aliyun')) {
      const final = isCycleFinal(cycle, today);
      const known = this.store.getCycle(cycle, 'aliyun');
      if (final && known?.final && !opts.force) { summary.cycles.push({ cycle, skipped: '已出账且已同步' }); continue; } // 跳过的账期不计为成功调用
      // 每个账期、每个产品代码独立处理：一个账期的月账单失败不能中断其余账期与调用次数同步
      try {
        P(`${cycle}：识别百炼产品代码…`);
        const { codes, authoritative } = await this.detectCodes(c, cycle, warnings);
        let monthly = 0, daily = 0, failed = 0;
        for (const code of codes) {
          try {
            P(`${cycle}：拉取账期（月）账单…`);
            attempted++;
            const m = await c.describeInstanceBill({ BillingCycle: cycle, ProductCode: code, Granularity: 'MONTHLY', IsBillingItem: true });
            this.store.replaceBillPeriod('aliyun', 'M', cycle, cycle, code, m.map(normalizeBillItem), final && authoritative);
            monthly += m.length; succeeded++;
          } catch (e) {
            failed++;
            warnings.push(`${cycle}${codes.length > 1 ? `（${code}）` : ''} 月账单拉取失败：${e.code || e.message}`);
            firstError ||= e;
          }
          const days = daysInCycle(cycle, today).filter(d => opts.force || this.needDay(d, code, today, final));
          const res = await pool(days.map(day => async () => {
            const items = await c.describeInstanceBill({ BillingCycle: cycle, ProductCode: code, Granularity: 'DAILY', BillingDate: day, IsBillingItem: true });
            // 日账单拉取成功后按日期定稿（每个产品代码单独记录）：产品代码识别不可靠时也不会每次重新下载已结算账期的每一天
            this.store.replaceBillPeriod('aliyun', 'D', day, cycle, code, items.map(normalizeBillItem), final);
            return items.length;
          }), Math.min(6, Math.max(1, s.concurrency || 3)), (d, t) => P(`${cycle}：拉取按日账单 ${d}/${t}`, d, t));
          // 按产品代码分别统计：多个产品代码时，前一个代码的失败不能让后一个代码的告警读取不存在的失败项
          const bad = res.filter(r => !r.ok);
          attempted += res.length;
          for (const r of res) if (r.ok) { daily += r.v; succeeded++; }
          failed += bad.length;
          if (bad.length) { warnings.push(`${cycle}${codes.length > 1 ? `（${code}）` : ''} 有 ${bad.length} 天的日账单拉取失败：${bad[0].e?.code || bad[0].e?.message || '未知错误'}`); firstError ||= bad[0].e; }
        }
        // 产品代码识别可靠时，清理不再出现的旧代码账单（否则旧代码的账单会一直留在库里并被合计）；
        // 识别为空但库里已有账单时不清理（账单总览可能延迟），也不定稿
        let settled = authoritative && !failed;
        if (authoritative && codes.length && !monthly && !daily && this.store.cycleLineCount('aliyun', cycle) > this.store.cycleLineCount('aliyun', cycle, codes)) {
          // 保留的产品代码本次没有任何账单、而其他代码有：多半是产品代码填写错误，不能据此清空真实账单并定稿为 ¥0
          settled = false;
          warnings.push(`${cycle} 产品代码 ${codes.join(', ')} 没有返回任何账单，已保留本地其他产品代码的账单（请核对“阿里云接入”中的产品代码）`);
        } else if (authoritative && codes.length) {
          const n = this.store.pruneCycleCodes('aliyun', cycle, codes);
          if (n) warnings.push(`${cycle} 已清理 ${n} 行不再属于百炼产品代码（${codes.join(', ')}）的旧账单`);
        } else if (authoritative && !codes.length && this.store.cycleLineCount('aliyun', cycle)) {
          settled = false;
          warnings.push(`${cycle} 账单总览中未识别到百炼产品，已保留本地已有账单（如产品代码有变化，请在“阿里云接入”中固定产品代码）`);
        }
        try {
          P(`${cycle}：百炼账单接口对账…`);
          const r = await c.call('modelstudio', 'GetBillingOverview', { billMonth: cycle, groupBy: [{ code: 'API_KEY_ID' }], topNum: 20, zeroFilter: true, locale: 'zh-CN' });
          this.store.replaceMsOverview(cycle, 'API_KEY_ID', r.data?.groups || []);
        } catch (e) {
          warnings.push(`${cycle} 百炼账单汇总接口（对账）不可用：${e.code || e.message}`);
        }
        this.store.markCycle('aliyun', cycle, codes, final && settled);
        summary.cycles.push({ cycle, codes, monthly, daily, final: final && settled });
      } catch (e) {
        warnings.push(`${cycle} 账单同步失败：${e.code || e.message}`);
        summary.cycles.push({ cycle, failed: true });
        firstError ||= e;
      }
    }
    // 没有任何一次账单接口调用成功（如密钥无效、无权限、网络不通）：整次任务记为失败，触发同步故障告警
    if (attempted && !succeeded && firstError) throw firstError;
    // 调用次数（可选）：账单入库后再读取，单次平均 Token 使用刚同步的按日账单
    if (this.callsConfig()) {
      P('读取调用次数（云监控 Prometheus）…');
      try { summary.calls = await this.syncAliyunCalls(); for (const w of summary.calls.warnings) warnings.push(w); } catch (e) { warnings.push(`调用次数同步失败：${e.message}`); summary.calls = { error: e.message }; }
    }
    return summary;
  }

  /* ---------- 阿里云调用次数：百炼监控投递 → 云监控 Prometheus ---------- */
  callsConfig() {
    const c = this.store.aliyunCallsSettings();
    return c.enabled && c.url && c.metric && c.keyLabel ? c : null;
  }
  promClient(cfg, override = {}) {
    let token = '', password = '';
    try { token = this.store.getSecret('aliyunCalls.token'); password = this.store.getSecret('aliyunCalls.password'); } catch { throw new Error('Prometheus 认证信息无法解密（主密钥已变化），请重新填写'); }
    return new PromClient({ url: cfg.url, authType: cfg.authType, username: cfg.username, token, password, ...override, allowLoopback: this.promAllowLoopback });
  }
  /** 读取最近 lookbackDays 天的调用次数并写入用量表；Prometheus 无数据的更早日期保留已有记录（数据保留期过后不丢历史） */
  async syncAliyunCalls({ cfg = this.callsConfig(), client } = {}) {
    if (!cfg) throw new Error('尚未启用阿里云调用次数');
    if (this.callsBusy) return this.callsBusy;
    const t0 = Date.now();
    this.callsBusy = (async () => {
      const warnings = [];
      const today = todayIn(this.tz), from = addDays(today, -(cfg.lookbackDays - 1));
      try {
        client ||= this.promClient(cfg); // 认证信息解密失败也要记录为失败，不能保留过期的“最近成功”
        const cells = await fetchCalls(client, cfg, { from, to: today, tz: this.tz });
        const keys = this.store.listApiKeys().filter(k => k.provider === 'aliyun');
        const { rows, unmatched, firstDay } = buildUsageRows(cells, { keys, billTokens: this.store.billTokenCells('aliyun', from, today) });
        // 同步期间管理员修改了指标映射（已清空旧口径数据）：丢弃本次按旧口径读取的结果
        const now = this.store.aliyunCallsSettings();
        if (MAPPING_FIELDS.some(k => (now[k] || '') !== (cfg[k] || ''))) throw new Error('同步期间调用次数配置已修改，本次结果已丢弃，请重新同步');
        if (firstDay) {
          // 最早有数据的一天可能落在 Prometheus 数据保留期的边界上（只剩部分时段）：不覆盖已保存的完整值，只在新值更大时更新
          const head = rows.filter(r => r.day === firstDay), rest = rows.filter(r => r.day > firstDay);
          if (firstDay < today) this.store.replaceUsage('aliyun', addDays(firstDay, 1), today, rest);
          this.store.mergeUsageMax('aliyun', firstDay < today ? head : rows);
        } else warnings.push(`云监控 Prometheus 最近 ${cfg.lookbackDays} 天没有调用次数数据，请确认已开启百炼“监控数据投递”且指标映射正确`);
        if (unmatched.size) {
          const sample = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, n]) => `${String(v).slice(0, 40)}（${n} 次）`).join('、');
          warnings.push(`调用次数中有 ${unmatched.size} 个 API Key 标签值未匹配到已同步的阿里云 Key，已忽略：${sample}`);
        }
        const result = { ok: true, at: Date.now(), from: firstDay || null, to: today, rows: rows.length, requests: rows.reduce((s, r) => s + r.requests, 0), unmatched: unmatched.size, calls: client.calls, ms: Date.now() - t0, warnings };
        this.store.setSetting('aliyunCalls.last', { ...result, warnings: warnings.slice(0, 3) });
        return result;
      } catch (e) {
        this.store.setSetting('aliyunCalls.last', { ok: false, at: Date.now(), error: String(e.message || e).slice(0, 300) });
        throw e;
      }
    })();
    try { return await this.callsBusy; } finally { this.callsBusy = null; }
  }

  /* ===================== 腾讯云 TokenHub ===================== */
  async syncTencentMeta(c) {
    const t = this.store.tencentSettings();
    const warnings = [];
    this.setProgress('tencent', 'meta', '读取 TokenHub API Key…');
    const keys = await c.listApiKeys();
    try {
      this.setProgress('tencent', 'meta', '读取推理服务（接入点）…');
      const eps = await c.listEndpoints();
      this.store.setSetting('tencent.endpoints', eps.filter(e => e.EndpointId).map(e => [String(e.EndpointId), String(e.ModelId || e.ModelName || '')]));
    } catch (e) {
      warnings.push(`推理服务列表获取失败（不影响 Key 同步）：${e.code || e.message}`);
    }
    const ws = [{ workspaceId: tcWorkspaceId(t.region), workspaceName: tcWorkspaceName(t.region), region: t.region, serviceSite: t.site }];
    // 只在当前地域范围内检测删除（切换地域后，原地域的 Key 不能被标记为已删除）；接口异常返回空列表时不标记删除
    const scope = new Set([tcWorkspaceId(t.region)]);
    let markMissing = true;
    if (!keys.length && this.store.listApiKeys().some(k => k.provider === 'tencent' && !k.deleted_at && (k.workspace_id || '') === tcWorkspaceId(t.region))) {
      markMissing = false;
      warnings.push('API Key 列表返回为空，本次不标记删除（如确已全部删除，下次同步仍为空时请核对 TokenHub 控制台）');
    }
    const changes = this.store.applyMeta('tencent', ws, keys.map(k => normalizeTencentKey(k, t.region)), { markMissing, scopeWs: scope });
    return { workspaces: 1, apiKeys: keys.length, changes, warnings };
  }

  /**
   * 识别本账期 TokenHub 的 BusinessCode：返回 { codes, authoritative }。
   * 账单数据准备中（Ready=0）时抛出 BillNotReady：不能用空结果替换已有账单、更不能把已出账账期定稿为 ¥0；
   * 账单中有其他产品但没有识别到大模型产品时（authoritative=false）保留本地已有账单、不定稿
   */
  async detectTencentCodes(c, cycle) {
    const fixed = (this.store.tencentSettings().businessCode || '').split(/[,\s]+/).filter(Boolean);
    if (fixed.length) return { codes: fixed, authoritative: true };
    const r = await c.billSummary(cycle);
    if (r.Ready === 0) throw Object.assign(new Error(`${cycle} 腾讯云账单数据准备中（首次出账约需 10 分钟），稍后自动重试`), { code: 'BillNotReady' });
    const all = r.SummaryOverview || [];
    const codes = [...new Set(all.filter(x => TC_PRODUCT_RE.test(`${x.BusinessCodeName || ''} ${x.BusinessCode || ''}`)).map(x => x.BusinessCode).filter(Boolean))];
    return { codes, authoritative: codes.length > 0 || !all.some(x => Math.abs(Number(x.RealTotalCost || 0)) > 0) };
  }

  /**
   * 读取一个账期的 TokenHub 用量（Key × 模型 × 日）。返回 { usage, ok }：
   *  - 只请求用量统计保留期内的日期；更早的日期接口不再返回数据，使用本地已保存的用量（不能被空结果删除）
   *  - 分页结果按 Key / 模型去重（排行在翻页期间变化时同一项可能出现在两页）
   *  - 接口成功但返回为空、而本地已有该时段用量时，视为异常结果：保留本地用量，不定稿
   */
  async tencentUsage(c, { cycle, from, to, today, ws, warnings, P, concurrency }) {
    const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dayOf = ts => fmtDay.format(new Date(Number(ts) * 1000));
    const winFrom = [from, addDays(today, -(TC_USAGE_RETENTION_DAYS - 1))].sort()[1];
    const stored = this.store.usageRows('tencent', from, to);
    const old = stored.filter(u => u.day < winFrom);
    if (winFrom > to) return { usage: stored, ok: true, retained: true }; // 整个账期都已超出保留期
    const start = `${winFrom}T00:00:00+08:00`, end = `${addDays(to, 1)}T00:00:00+08:00`;
    try {
      P(`${cycle}：读取 TokenHub 用量排行…`);
      const active = [...new Map((await c.usageKeys(start, end)).filter(k => k.Key).map(k => [String(k.Key), k])).values()];
      for (const k of active) this.store.ensureGhostKey('tencent', String(k.Key), k.Name, ws);
      const res = await pool(active.map(k => async () => {
        const u = await c.usageOfKey(String(k.Key), start, end);
        const rows = new Map();
        for (const it of u.items) for (const r of parseSeries(u.timestamps, it.Series, dayOf)) {
          if (r.day < winFrom || r.day > to) continue;
          const row = { ...r, api_key_id: String(k.Key), model: String(it.Key || '(未知模型)') };
          rows.set(`${row.day}\u0001${row.model}`, row);
        }
        return [...rows.values()];
      }), concurrency, (d, n) => P(`${cycle}：读取 API Key 用量 ${d}/${n}`, d, n));
      const failed = res.filter(r => !r.ok);
      const inWin = stored.filter(u => u.day >= winFrom);
      if (failed.length) {
        warnings.push(`${cycle} 有 ${failed.length} 个 API Key 的用量获取失败：${failed[0].e.code || failed[0].e.message}`);
        return { usage: stored.length ? stored : res.filter(r => r.ok).flatMap(r => r.v), ok: false };
      }
      const fresh = res.flatMap(r => r.v);
      if (!fresh.length && inWin.some(u => u.total_tokens > 0)) {
        warnings.push(`${cycle} TokenHub 用量接口返回为空，但本地已有该时段的用量，已保留本地数据`);
        return { usage: stored, ok: false };
      }
      this.store.replaceUsage('tencent', winFrom, to, fresh);
      return { usage: [...old, ...fresh], ok: true };
    } catch (e) {
      warnings.push(`${cycle} TokenHub 用量获取失败，费用暂按本地已保存的用量分摊：${e.code || e.message}`);
      return { usage: stored, ok: false };
    }
  }

  async syncTencentBills(c, opts = {}) {
    const s = this.store.syncSettings(), t = this.store.tencentSettings();
    const today = todayIn(TC_TZ);
    const warnings = [];
    const summary = { cycles: [], warnings };
    const P = (x, d, n) => this.setProgress('tencent', 'bills', x, d, n);
    const ws = tcWorkspaceId(t.region);
    let prices = null, billingOk = false, attempted = 0, succeeded = 0, firstError = null, usageAny = false;
    const currency = t.site === 'intl' ? 'USD' : 'CNY'; // 国际站账单与目录价为美元
    // 账期从新到旧处理：本次已能读取费用中心账单时，此前按目录价估算并定稿的账期重新按真实账单同步
    for (const cycle of this.cyclesToSync(opts, 'tencent')) {
      const final = isCycleFinal(cycle, today);
      const known = this.store.getCycle(cycle, 'tencent');
      const wasEstimate = known?.product_codes === 'estimate';
      if (final && known?.final && !opts.force && !(wasEstimate && billingOk)) { summary.cycles.push({ cycle, skipped: '已出账且已同步' }); continue; }
      const days = daysInCycle(cycle, today);
      if (!days.length) continue;
      const from = days[0], to = days[days.length - 1];

      // 1) 用量：Key × 模型 × 日（精确值，用于分摊与请求数分析）
      const { usage, ok: usageOk } = await this.tencentUsage(c, { cycle, from, to, today, ws, warnings, P, concurrency: Math.min(4, Math.max(1, s.concurrency || 3)) });
      if (usageOk) usageAny = true; // 用量同步成功也算部分成功（如无计费权限且关闭估算时）

      // 2) 账单：识别 BusinessCode → 拉取明细（无费用权限时可按目录价估算）
      let rows = null, codes = [], estimated = false, authoritative = true;
      try {
        P(`${cycle}：识别 TokenHub 产品代码…`);
        ({ codes, authoritative } = await this.detectTencentCodes(c, cycle));
        const raw = [];
        // 逐条追加：整月明细可能有十几万条，展开为函数参数会超出调用栈
        for (const code of codes) { P(`${cycle}：拉取账单明细（${code}）…`); for (const x of await c.billDetail(cycle, code)) raw.push(x); }
        const keyIds = new Set(this.store.listApiKeys().filter(k => k.provider === 'tencent').map(k => k.api_key_id));
        rows = tencentBillRows(raw, { region: t.region, endpointModel: new Map(this.store.getSetting('tencent.endpoints', []) || []), keyIds, currency });
        billingOk = true;
        // 账单中有其他产品、但未识别到大模型产品：本地已有账单时保留；没有时也不定稿（产品名称规则可能需要更新）
        if (!authoritative) {
          warnings.push(`${cycle} 腾讯云账单中未识别到大模型产品${this.store.cycleLineCount('tencent', cycle) ? '，已保留本地已有账单' : ''}（如产品有变化，请在“腾讯云接入”中固定 BusinessCode）`);
          if (this.store.cycleLineCount('tencent', cycle)) { summary.cycles.push({ cycle, kept: true }); attempted++; succeeded++; continue; }
        }
      } catch (e) {
        if (e.code === 'BillNotReady') warnings.push(e.message);
        else if (PERM_RE.test(e.code || '') && t.estimate) {
          try {
            P(`${cycle}：无费用中心权限，按模型目录价估算…`);
            prices ||= priceTable(await c.listModels(), { usd: currency === 'USD' }); // 目录价每次任务只读取一次
            rows = estimateRows(usage, prices, t.region, id => this.keyWs(id), currency);
            estimated = true; codes = ['estimate'];
            warnings.push(`${cycle} 缺少腾讯云费用中心只读权限，已按 TokenHub 目录价估算费用（不含折扣与阶梯价）`);
          } catch (e2) { warnings.push(`${cycle} 目录价估算失败：${e2.code || e2.message}`); firstError ||= e2; }
        } else { warnings.push(`${cycle} 腾讯云账单获取失败：${e.code || e.message}`); firstError ||= e; }
        if (e.code !== 'BillNotReady') attempted++; // 账单准备中不算失败（首次出账约 10 分钟）
      }
      if (!rows) { summary.cycles.push({ cycle, failed: true }); continue; }
      if (!estimated) attempted++;
      succeeded++;

      // 3) 拆分到日并按用量分摊：先用当日用量，未匹配到的再用整月用量（模型名按整月用量统一匹配，优先精确匹配）
      const keyWs = id => this.keyWs(id) || ws;
      const models = [...new Set(usage.map(u => u.model))];
      const monthUsage = new Map();
      for (const u of usage) {
        const k = u.api_key_id + '\u0001' + u.model;
        const m = monthUsage.get(k) || { api_key_id: u.api_key_id, model: u.model, input_tokens: 0, output_tokens: 0, cache_tokens: 0, total_tokens: 0, requests: 0 };
        for (const f of ['input_tokens', 'output_tokens', 'cache_tokens', 'total_tokens', 'requests']) m[f] += u[f] || 0;
        monthUsage.set(k, m);
      }
      const usageByDay = new Map();
      for (const u of usage) { if (!usageByDay.has(u.day)) usageByDay.set(u.day, []); usageByDay.get(u.day).push(u); }
      const byDay = new Map();
      for (const r of rows) {
        const day = r.day >= from && r.day <= to ? r.day : (r.day < from ? from : to);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(r);
      }
      const dayRows = new Map();
      let allocated = 0, unassigned = 0, foreign = 0;
      for (const r of rows) if (r.foreign) foreign += r.pretax;
      for (const [day, list] of byDay) {
        const first = estimated ? list : allocate(list, usageByDay.get(day) || [], keyWs, models);
        const rest = first.filter(r => !r.api_key_id);
        const out = [...first.filter(r => r.api_key_id), ...(rest.length ? allocate(rest, [...monthUsage.values()], keyWs, models) : [])];
        for (const r of out) { if (r.alloc === 1) allocated += r.pretax; else if (!r.api_key_id && !r.foreign) unassigned += r.pretax; }
        dayRows.set(day, out);
      }
      const monthRows = rollupMonth([...dayRows.values()].flat());
      // 估算账期在出账后同样定稿（product_codes='estimate'），不再每小时重复拉取；之后能读取真实账单时会重新同步
      const settled = final && usageOk && authoritative;
      this.store.replaceBillCycle('tencent', cycle, estimated ? 'estimate' : (codes.join('+') || 'tokenhub'), dayRows, days, monthRows, settled);
      this.store.markCycle('tencent', cycle, codes, settled);
      if (unassigned > 0.005 && usage.length) warnings.push(`${cycle} 有 ¥${unassigned.toFixed(2)} 的腾讯云费用未匹配到 API Key 用量（计入“无 API Key”）`);
      // 其他地域的费用：记录在同步明细中（计入“无 API Key”），不作为告警，否则同时使用两个地域的账号每次同步都是“部分成功”
      summary.cycles.push({ cycle, codes, lines: monthRows.length, usage: usage.length, allocated: +allocated.toFixed(4), unassigned: +unassigned.toFixed(4), otherRegion: +foreign.toFixed(4), estimated, final: settled });
    }
    // 所有尝试的账期都失败（如密钥无效、无权限、网络不通）：整次任务记为失败，触发同步故障告警
    if (attempted && !succeeded && !usageAny && firstError) throw firstError;
    return summary;
  }
  keyWs(id) {
    if (!this._wsCache || Date.now() - this._wsCache.t > 5000) this._wsCache = { t: Date.now(), m: new Map(this.store.listApiKeys().map(k => [k.api_key_id, k.workspace_id])) };
    return this._wsCache.m.get(id) || '';
  }

  /* ===================== 状态 ===================== */
  one(provider, kind) {
    const s = this.store.syncSettings();
    const key = `${provider}:${kind}`;
    const last = this.store.lastRun(kind, null, provider);
    const ok = this.store.lastRun(kind, 'success', provider), part = this.store.lastRun(kind, 'partial', provider);
    const okAt = Math.max(ok?.finished_at || 0, part?.finished_at || 0) || null;
    const interval = (kind === 'meta' ? s.metaIntervalMin : s.billIntervalMin) * 60_000;
    return {
      running: !!this.running[key], progress: this.progress[key] || null,
      last: last ? { id: last.id, status: last.status, startedAt: last.started_at, finishedAt: last.finished_at, error: last.error } : null,
      lastSuccessAt: okAt,
      nextAt: this.credentials(provider) ? Math.max(Date.now(), (this.lastAttempt[key] || 0) + interval) : null,
      intervalMin: kind === 'meta' ? s.metaIntervalMin : s.billIntervalMin,
    };
  }
  /** 合并状态：任一厂商运行中即运行中；最近成功取最早（数据新鲜度以最旧者为准）；changedAt 取最新（用于前端轮询刷新） */
  status() {
    const conf = this.configured();
    const providers = Object.fromEntries(PROVIDER_LIST.map(p => [p, { name: PROVIDER_NAMES[p], configured: conf.includes(p), secretState: this.secretState(p), meta: this.one(p, 'meta'), bills: this.one(p, 'bills') }]));
    const merge = kind => {
      const list = (conf.length ? conf : ['aliyun']).map(p => ({ p, x: providers[p][kind] }));
      const runningOne = list.find(o => o.x.running);
      const lasts = list.map(o => o.x.last).filter(Boolean).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      const bad = list.map(o => o.x.last).filter(l => l && l.status === 'error');
      const succ = list.map(o => o.x.lastSuccessAt);
      return {
        running: !!runningOne,
        progress: runningOne ? { ...runningOne.x.progress, text: (conf.length > 1 ? PROVIDER_NAMES[runningOne.p] + '：' : '') + (runningOne.x.progress?.text || '同步中…') } : null,
        last: bad[0] || lasts.find(l => l.status === 'partial') || lasts[0] || null,
        lastSuccessAt: succ.some(v => !v) ? null : Math.min(...succ),
        changedAt: Math.max(0, ...succ.map(v => v || 0)) || null,
        nextAt: Math.min(...list.map(o => o.x.nextAt || Infinity)) === Infinity ? null : Math.min(...list.map(o => o.x.nextAt || Infinity)),
        intervalMin: list[0].x.intervalMin,
      };
    };
    return { meta: merge('meta'), bills: merge('bills'), providers, configured: conf };
  }
}
