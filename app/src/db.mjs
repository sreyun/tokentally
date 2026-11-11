/**
 * SQLite 持久化（node:sqlite，无第三方依赖）
 * v3 起支持多云：业务空间 / API Key / 账单 / 同步记录均带 provider（aliyun | tencent）
 */
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { encrypt, decrypt, sha256, randomToken } from './crypto.mjs';
import { DEFAULT_CALLS } from './prom.mjs';

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER, last_login_ip TEXT,
  pw_changed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  ip TEXT, ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, username TEXT, ip TEXT, action TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY, name TEXT, region TEXT, service_site TEXT, api_host TEXT, tenant_id TEXT, gmt_create INTEGER,
  first_seen INTEGER, last_seen INTEGER, deleted_at INTEGER, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
  api_key_id TEXT PRIMARY KEY, api_key_masked TEXT, description TEXT, workspace_id TEXT, workspace_name TEXT,
  disabled INTEGER, auth_type TEXT, allow_all_models INTEGER, accessible_models TEXT, access_ips TEXT,
  created_by TEXT, gmt_create INTEGER,
  first_seen INTEGER, last_seen INTEGER, deleted_at INTEGER, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT,
  change TEXT NOT NULL, before_json TEXT, after_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_ts ON change_log(ts);

CREATE TABLE IF NOT EXISTS bill_lines (
  id INTEGER PRIMARY KEY,
  granularity TEXT NOT NULL,          -- D=按日账单  M=按月(账期)账单
  period TEXT NOT NULL,               -- D: YYYY-MM-DD   M: YYYY-MM
  cycle TEXT NOT NULL,                -- 账期 YYYY-MM
  product_code TEXT NOT NULL,
  instance_id TEXT, api_key_id TEXT, workspace_id TEXT, model TEXT, io TEXT, channel TEXT, stop_flag TEXT, kind TEXT,
  billing_item TEXT, billing_item_code TEXT, commodity_code TEXT, product_detail TEXT,
  usage REAL, usage_unit TEXT, tokens REAL, list_price TEXT, list_price_unit TEXT,
  gross REAL, pretax REAL, after_discount REAL, invoice_discount REAL, coupons REAL, cash_coupons REAL, prepaid REAL, resource_pkg TEXT,
  currency TEXT, region TEXT, item TEXT, subscription_type TEXT,
  synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bill_gp ON bill_lines(granularity, period);
CREATE INDEX IF NOT EXISTS idx_bill_cycle ON bill_lines(granularity, cycle);
CREATE INDEX IF NOT EXISTS idx_bill_key ON bill_lines(api_key_id);

CREATE TABLE IF NOT EXISTS bill_periods (
  granularity TEXT NOT NULL, period TEXT NOT NULL, product_code TEXT NOT NULL,
  cycle TEXT NOT NULL, synced_at INTEGER NOT NULL, line_count INTEGER, pretax REAL, final INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (granularity, period, product_code)
);

CREATE TABLE IF NOT EXISTS bill_cycles (
  cycle TEXT PRIMARY KEY, product_codes TEXT, synced_at INTEGER NOT NULL, final INTEGER NOT NULL DEFAULT 0, pretax REAL, gross REAL
);

CREATE TABLE IF NOT EXISTS ms_overview (
  cycle TEXT NOT NULL, group_code TEXT NOT NULL, key TEXT NOT NULL, name TEXT, amount REAL, article_codes TEXT, synced_at INTEGER,
  PRIMARY KEY (cycle, group_code, key)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, trig TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
  status TEXT NOT NULL, detail TEXT, error TEXT, api_calls INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_kind ON sync_runs(kind, started_at);
`;

/* v3：多云 + 用量明细 + 成本中心标签 */
const SCHEMA_V3 = `
ALTER TABLE api_keys ADD COLUMN provider TEXT NOT NULL DEFAULT 'aliyun';
ALTER TABLE api_keys ADD COLUMN remark TEXT;
ALTER TABLE workspaces ADD COLUMN provider TEXT NOT NULL DEFAULT 'aliyun';
ALTER TABLE bill_lines ADD COLUMN provider TEXT NOT NULL DEFAULT 'aliyun';
ALTER TABLE bill_lines ADD COLUMN alloc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'aliyun';
CREATE INDEX IF NOT EXISTS idx_bill_prov ON bill_lines(provider, granularity, period);

CREATE TABLE bill_periods_v3 (
  provider TEXT NOT NULL DEFAULT 'aliyun', granularity TEXT NOT NULL, period TEXT NOT NULL, product_code TEXT NOT NULL,
  cycle TEXT NOT NULL, synced_at INTEGER NOT NULL, line_count INTEGER, pretax REAL, final INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, granularity, period, product_code)
);
INSERT INTO bill_periods_v3 SELECT 'aliyun', granularity, period, product_code, cycle, synced_at, line_count, pretax, final FROM bill_periods;
DROP TABLE bill_periods;
ALTER TABLE bill_periods_v3 RENAME TO bill_periods;

CREATE TABLE bill_cycles_v3 (
  provider TEXT NOT NULL DEFAULT 'aliyun', cycle TEXT NOT NULL, product_codes TEXT, synced_at INTEGER NOT NULL, final INTEGER NOT NULL DEFAULT 0, pretax REAL, gross REAL,
  PRIMARY KEY (provider, cycle)
);
INSERT INTO bill_cycles_v3 SELECT 'aliyun', cycle, product_codes, synced_at, final, pretax, gross FROM bill_cycles;
DROP TABLE bill_cycles;
ALTER TABLE bill_cycles_v3 RENAME TO bill_cycles;

CREATE TABLE IF NOT EXISTS usage_lines (
  provider TEXT NOT NULL, day TEXT NOT NULL, api_key_id TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens REAL, output_tokens REAL, cache_tokens REAL, total_tokens REAL, requests REAL, fails REAL, synced_at INTEGER,
  PRIMARY KEY (provider, day, api_key_id, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_lines(day);

CREATE TABLE IF NOT EXISTS key_tags (
  api_key_id TEXT PRIMARY KEY, cost_center TEXT, owner TEXT, note TEXT, updated_at INTEGER, updated_by TEXT
);
`;

export const PROVIDERS = { aliyun: '阿里云', tencent: '腾讯云' };
export const LINE_COLS = [
  'period', 'provider', 'api_key_id', 'workspace_id', 'model', 'io', 'channel', 'stop_flag', 'kind', 'usage', 'usage_unit', 'tokens',
  'list_price', 'list_price_unit', 'gross', 'pretax', 'after_discount', 'invoice_discount', 'coupons', 'cash_coupons', 'prepaid',
  'resource_pkg', 'currency', 'billing_item', 'commodity_code', 'product_detail', 'instance_id', 'region', 'item', 'alloc',
];
const SLIM_COLS = ['period', 'provider', 'api_key_id', 'workspace_id', 'model', 'io', 'channel', 'kind', 'usage', 'usage_unit', 'tokens', 'list_price', 'list_price_unit', 'gross', 'pretax', 'after_discount', 'alloc'];
const INSERT_COLS = ['provider', 'granularity', 'period', 'cycle', 'product_code', 'instance_id', 'api_key_id', 'workspace_id', 'model', 'io', 'channel', 'stop_flag', 'kind',
  'billing_item', 'billing_item_code', 'commodity_code', 'product_detail', 'usage', 'usage_unit', 'tokens', 'list_price', 'list_price_unit',
  'gross', 'pretax', 'after_discount', 'invoice_discount', 'coupons', 'cash_coupons', 'prepaid', 'resource_pkg', 'currency', 'region', 'item', 'subscription_type', 'alloc', 'synced_at'];

export const DEFAULT_ALIYUN = { msRegion: 'cn-beijing', bssSite: 'cn', productCode: '' };
export const DEFAULT_TENCENT = { region: 'ap-guangzhou', site: 'cn', businessCode: '', estimate: true };
export const DEFAULT_SYNC = { metaIntervalMin: 5, billIntervalMin: 60, backfillMonths: 3, perWorkspaceKeys: true, concurrency: 3 };
export const DEFAULT_BRANDING = { name: '大模型费用分析', subtitle: 'TokenTally · 多云 LLM 成本' };

const n0 = v => (v == null || v === '' ? null : v);
const shiftDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const DEFAULT_BUDGETS = { monthly: null, alertPct: 80, keys: {} };
/** 阿里云对未归属业务空间的 Key 可能返回 "-"，统一视为空 */
const clean = v => (v == null || v === '-' ? '' : String(v));
const jsonOrNull = v => (v == null ? null : JSON.stringify(v));

export class Store {
  constructor(file, masterKey) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.key = masterKey;
    this.stmts = new Map();
    // WAL + NORMAL：读写并发与崩溃安全兼顾；限制 WAL 文件大小，临时排序放内存
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 67108864; PRAGMA temp_store = MEMORY;');
    this.migrate();
  }
  /** 定期更新查询规划统计信息（SQLite 推荐在长连接上周期性执行） */
  optimize() { try { this.db.exec('PRAGMA optimize;'); } catch { /* ignore */ } }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v < 1) { this.db.exec(SCHEMA_V1); this.db.exec('PRAGMA user_version = 1'); }
    if (v < 2) {
      // v2：阿里云用 "-" 表示空业务空间，统一清洗为空字符串
      this.db.exec(`UPDATE bill_lines SET workspace_id = '' WHERE workspace_id = '-';
        UPDATE api_keys SET workspace_id = '' WHERE workspace_id = '-';
        UPDATE api_keys SET workspace_name = '' WHERE workspace_name = '-';
        PRAGMA user_version = 2;`);
    }
    if (v < 3) {
      this.db.exec('BEGIN IMMEDIATE');
      try { this.db.exec(SCHEMA_V3); this.db.exec('PRAGMA user_version = 3'); this.db.exec('COMMIT'); }
      catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    if (v < 4) {
      // v4：按访问路径补索引——账期维护（厂商 + 账期 + 产品代码）、同步记录查询（每次状态轮询）、用量数据版本（MAX(synced_at)）
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bill_pc ON bill_lines(provider, cycle, product_code);
        CREATE INDEX IF NOT EXISTS idx_runs_kps ON sync_runs(kind, provider, status, id);
        CREATE INDEX IF NOT EXISTS idx_runs_kp ON sync_runs(kind, provider, id);
        CREATE INDEX IF NOT EXISTS idx_usage_synced ON usage_lines(synced_at);
        CREATE INDEX IF NOT EXISTS idx_change_entity ON change_log(entity_id);
        PRAGMA user_version = 4;`);
    }
  }

  /* ---------------- settings ---------------- */
  getSetting(k, d = null) {
    const r = this.q('SELECT v FROM settings WHERE k = ?').get(k);
    if (!r || r.v == null) return d;
    try { return JSON.parse(r.v); } catch { return d; }
  }
  setSetting(k, v) {
    this.q('INSERT INTO settings(k, v, updated_at) VALUES(?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
      .run(k, JSON.stringify(v), Date.now());
  }
  /** 加密字段：AES-256-GCM，AAD 绑定字段名 */
  getSecret(k) {
    const blob = this.getSetting(k, null);
    if (!blob) return '';
    return decrypt(this.key, blob, k);
  }
  setSecret(k, v) { this.setSetting(k, v ? encrypt(this.key, v, k) : null); }
  aliyunSettings() { return { ...DEFAULT_ALIYUN, ...(this.getSetting('aliyun', {}) || {}) }; }
  tencentSettings() { return { ...DEFAULT_TENCENT, ...(this.getSetting('tencent', {}) || {}) }; }
  /** 阿里云调用次数（百炼监控投递 → 云监控 Prometheus） */
  aliyunCallsSettings() { return { ...DEFAULT_CALLS, ...(this.getSetting('aliyunCalls', {}) || {}) }; }
  syncSettings() { return { ...DEFAULT_SYNC, ...(this.getSetting('sync', {}) || {}) }; }
  budgets() { return { ...DEFAULT_BUDGETS, ...(this.getSetting('budgets', {}) || {}) }; }
  branding() { return { ...DEFAULT_BRANDING, ...(this.getSetting('branding', {}) || {}) }; }

  /* ---------------- users / sessions ---------------- */
  countUsers() { return this.q('SELECT COUNT(*) AS n FROM users').get().n; }
  countAdmins() { return this.q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n; }
  userByName(u) { return this.q('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(u)); }
  userById(id) { return this.q('SELECT * FROM users WHERE id = ?').get(Number(id)); }
  listUsers() {
    return this.q(`SELECT u.id, u.username, u.role, u.disabled, u.must_change, u.locked_until, u.last_login_at, u.last_login_ip, u.pw_changed_at, u.created_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions FROM users u ORDER BY u.id`).all(Date.now());
  }
  createUser({ username, passHash, role, mustChange }) {
    const now = Date.now();
    return this.q('INSERT INTO users(username, pass_hash, role, must_change, created_at, updated_at, pw_changed_at) VALUES(?,?,?,?,?,?,?)')
      .run(username, passHash, role, mustChange ? 1 : 0, now, now, now).lastInsertRowid;
  }
  updateUser(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    this.db.prepare(`UPDATE users SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(c => fields[c]), Date.now(), Number(id));
  }
  /** 登录失败计数在 SQL 中原子加一（并发猜测不能基于过期的 failed_count），达到上限时锁定并清零；返回 { n, locked } */
  noteUserLoginFail(id, max, lockMs) {
    const now = Date.now();
    const r = this.q('UPDATE users SET failed_count = failed_count + 1, updated_at = ? WHERE id = ? RETURNING failed_count').get(now, Number(id));
    const n = r?.failed_count || 0;
    if (n >= max) { this.q('UPDATE users SET failed_count = 0, locked_until = ?, updated_at = ? WHERE id = ?').run(now + lockMs, now, Number(id)); return { n, locked: true }; }
    return { n, locked: false };
  }
  deleteUser(id) { this.q('DELETE FROM users WHERE id = ?').run(Number(id)); }

  createSession(userId, ip, ua, maxMs) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const now = Date.now();
    this.q('INSERT INTO sessions(id_hash, user_id, csrf, created_at, last_seen, expires_at, ip, ua) VALUES(?,?,?,?,?,?,?,?)')
      .run(sha256(token), userId, csrf, now, now, now + maxMs, ip || '', String(ua || '').slice(0, 200));
    return { token, csrf };
  }
  /** touch=false：后台轮询请求不刷新空闲计时，空闲超时才能真正生效 */
  getSession(token, idleMs, touch = true) {
    if (!token) return null;
    const s = this.q(`SELECT s.id_hash, s.user_id, s.csrf, s.last_seen, s.expires_at, u.username, u.role, u.disabled, u.must_change
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).get(sha256(token));
    const now = Date.now();
    if (!s || s.disabled || s.expires_at <= now || s.last_seen + idleMs <= now) {
      if (s) this.q('DELETE FROM sessions WHERE id_hash = ?').run(s.id_hash);
      return null;
    }
    if (touch && now - s.last_seen > 60_000) this.q('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(now, s.id_hash);
    return s;
  }
  sessionExists(idHash) { return !!this.q('SELECT 1 FROM sessions WHERE id_hash = ?').get(idHash); }
  deleteSession(idHash) { this.q('DELETE FROM sessions WHERE id_hash = ?').run(idHash); }
  deleteUserSessions(userId, exceptHash = '') { this.q('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?').run(Number(userId), exceptHash); }
  purgeSessions(idleMs) { this.q('DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?').run(Date.now(), Date.now() - idleMs); }
  countSessions() { return this.q('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').get(Date.now()).n; }

  audit(username, ip, action, detail) {
    this.q('INSERT INTO audit_log(ts, username, ip, action, detail) VALUES(?,?,?,?,?)')
      .run(Date.now(), username || '', ip || '', action, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  }
  listAudit(limit = 500) { return this.q('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit); }
  purgeOld() {
    const yearAgo = Date.now() - 365 * 864e5;
    this.q('DELETE FROM audit_log WHERE ts < ?').run(yearAgo);
    this.q('DELETE FROM sync_runs WHERE started_at < ?').run(Date.now() - 90 * 864e5);
    this.optimize();
  }

  /* ---------------- 业务空间 / API Key 同步 ---------------- */
  logChange(entity, id, name, change, before, after) {
    this.q('INSERT INTO change_log(ts, entity, entity_id, name, change, before_json, after_json) VALUES(?,?,?,?,?,?,?)')
      .run(Date.now(), entity, id, name || '', change, jsonOrNull(before), jsonOrNull(after));
  }

  /**
   * 写入某个云厂商一次完整的元数据同步结果，记录新增/修改/删除/恢复。
   * markMissing=true 时，本次未出现的（同一厂商的）记录标记为已删除（保留历史，账单仍可关联描述）。
   */
  /**
   * scopeWs：只在这些业务空间范围内标记删除（腾讯云只同步当前地域，切换地域时不能把其他地域的 Key 标记为已删除）；
   * skipWs：这些业务空间的 Key 列表获取失败，其中的 Key 不标记删除（其余业务空间照常检测删除）
   */
  applyMeta(provider, wsList, keyList, { markMissing, scopeWs = null, skipWs = null }) {
    const now = Date.now();
    let changes = 0;
    const diff = (cur, row, fields) => {
      const b = {}, a = {};
      for (const f of fields) if (String(cur[f] ?? '') !== String(row[f] ?? '')) { b[f] = cur[f]; a[f] = row[f]; }
      return Object.keys(a).length ? [b, a] : null;
    };
    this.tx(() => {
      const seenWs = new Set();
      const WS_FIELDS = ['name', 'region', 'service_site', 'api_host'];
      for (const w of wsList) {
        const id = String(w.workspaceId || '');
        if (!id) continue;
        seenWs.add(id);
        const row = {
          name: w.workspaceName || '', region: w.region || '', service_site: w.serviceSite || '', api_host: w.apiHost || '',
          tenant_id: w.tenantId == null ? '' : String(w.tenantId), gmt_create: Number(w.gmtCreate) || null,
        };
        const cur = this.q('SELECT * FROM workspaces WHERE workspace_id = ?').get(id);
        if (!cur) {
          this.q(`INSERT INTO workspaces(workspace_id, provider, name, region, service_site, api_host, tenant_id, gmt_create, first_seen, last_seen, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, provider, row.name, row.region, row.service_site, row.api_host, row.tenant_id, row.gmt_create, now, now, now);
          this.logChange('workspace', id, row.name, 'create', null, row); changes++;
          continue;
        }
        const d = diff(cur, row, WS_FIELDS);
        if (d) { this.logChange('workspace', id, row.name, 'update', d[0], d[1]); changes++; }
        if (cur.deleted_at) { this.logChange('workspace', id, row.name, 'restore', null, null); changes++; }
        this.q(`UPDATE workspaces SET provider=?, name=?, region=?, service_site=?, api_host=?, tenant_id=?, gmt_create=?, last_seen=?, deleted_at=NULL,
          updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE workspace_id=?`)
          .run(provider, row.name, row.region, row.service_site, row.api_host, row.tenant_id, row.gmt_create, now, d || cur.deleted_at ? 1 : 0, now, id);
      }
      if (markMissing) {
        for (const cur of this.q('SELECT workspace_id, name FROM workspaces WHERE deleted_at IS NULL AND provider = ?').all(provider)) {
          if (seenWs.has(cur.workspace_id) || (scopeWs && !scopeWs.has(cur.workspace_id))) continue;
          this.q('UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE workspace_id = ?').run(now, now, cur.workspace_id);
          this.logChange('workspace', cur.workspace_id, cur.name, 'delete', null, null); changes++;
        }
      }

      const seenKeys = new Set();
      const KEY_FIELDS = ['api_key_masked', 'description', 'remark', 'workspace_id', 'workspace_name', 'disabled', 'auth_type', 'allow_all_models', 'accessible_models', 'access_ips'];
      for (const k of keyList) {
        const id = String(k.apiKeyId ?? '');
        if (!id) continue;
        seenKeys.add(id);
        const auth = k.auth || {};
        const scope = auth.modelAccessScope || {};
        const dis = k.disabled;
        const row = {
          api_key_masked: k.apiKeyValue || '', description: k.description || '', remark: k.remark || '', workspace_id: clean(k.workspaceId), workspace_name: clean(k.workspaceName),
          disabled: dis == null ? null : (dis === true || dis === 1 || dis === '1' || dis === 'true') ? 1 : 0,
          auth_type: auth.type || '', allow_all_models: scope.allowAllModels == null ? null : (scope.allowAllModels ? 1 : 0),
          accessible_models: JSON.stringify([...(scope.accessibleModels || [])].sort()), access_ips: JSON.stringify(auth.accessIps || []),
          created_by: k.createdBy == null ? '' : String(k.createdBy), gmt_create: Number(k.gmtCreate) || null,
        };
        const cur = this.q('SELECT * FROM api_keys WHERE api_key_id = ?').get(id);
        // 部分同步（某些业务空间的 Key 获取失败）时全局列表可能缺少归属信息：保留已知的业务空间，避免误记“修改”、下次同步又改回
        if (cur && !markMissing && !row.workspace_id && cur.workspace_id) { row.workspace_id = cur.workspace_id; row.workspace_name = cur.workspace_name || ''; }
        // 用量 / 账单中先出现、尚未被元数据同步看到的 Key 以“已删除占位”保存（ensureGhostKey）：首次被元数据看到时记为“新增”，而不是“修改 + 恢复”
        if (cur && cur.deleted_at && cur.auth_type == null && cur.api_key_masked == null) {
          this.q(`UPDATE api_keys SET provider=?, api_key_masked=?, description=?, remark=?, workspace_id=?, workspace_name=?, disabled=?, auth_type=?, allow_all_models=?,
            accessible_models=?, access_ips=?, created_by=?, gmt_create=?, last_seen=?, deleted_at=NULL, updated_at=? WHERE api_key_id=?`)
            .run(provider, row.api_key_masked, row.description, row.remark, row.workspace_id, row.workspace_name, row.disabled, row.auth_type, row.allow_all_models,
              row.accessible_models, row.access_ips, row.created_by, row.gmt_create, now, now, id);
          this.logChange('api_key', id, row.description, 'create', null, { description: row.description, workspace_name: row.workspace_name }); changes++;
          continue;
        }
        if (!cur) {
          this.q(`INSERT INTO api_keys(api_key_id, provider, api_key_masked, description, remark, workspace_id, workspace_name, disabled, auth_type, allow_all_models,
            accessible_models, access_ips, created_by, gmt_create, first_seen, last_seen, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, provider, row.api_key_masked, row.description, row.remark, row.workspace_id, row.workspace_name, row.disabled, row.auth_type, row.allow_all_models,
              row.accessible_models, row.access_ips, row.created_by, row.gmt_create, now, now, now);
          this.logChange('api_key', id, row.description, 'create', null, { description: row.description, workspace_name: row.workspace_name }); changes++;
          continue;
        }
        const d = diff({ ...cur, remark: cur.remark ?? '' }, row, KEY_FIELDS);
        if (d) { this.logChange('api_key', id, row.description, 'update', d[0], d[1]); changes++; }
        if (cur.deleted_at) { this.logChange('api_key', id, row.description, 'restore', null, null); changes++; }
        this.q(`UPDATE api_keys SET provider=?, api_key_masked=?, description=?, remark=?, workspace_id=?, workspace_name=?, disabled=?, auth_type=?, allow_all_models=?,
          accessible_models=?, access_ips=?, created_by=?, gmt_create=?, last_seen=?, deleted_at=NULL,
          updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE api_key_id=?`)
          .run(provider, row.api_key_masked, row.description, row.remark, row.workspace_id, row.workspace_name, row.disabled, row.auth_type, row.allow_all_models,
            row.accessible_models, row.access_ips, row.created_by, row.gmt_create, now, d || cur.deleted_at ? 1 : 0, now, id);
      }
      if (markMissing) {
        for (const cur of this.q('SELECT api_key_id, description, workspace_id FROM api_keys WHERE deleted_at IS NULL AND provider = ?').all(provider)) {
          if (seenKeys.has(cur.api_key_id)) continue;
          if (scopeWs && !scopeWs.has(cur.workspace_id || '')) continue;
          if (skipWs && skipWs.has(cur.workspace_id || '')) continue;
          this.q('UPDATE api_keys SET deleted_at = ?, updated_at = ? WHERE api_key_id = ?').run(now, now, cur.api_key_id);
          this.logChange('api_key', cur.api_key_id, cur.description, 'delete', null, null); changes++;
        }
      }
    });
    return changes;
  }
  /** 用量中出现、但 Key 列表里没有的已删除 Key（腾讯云用量接口保留原名称）：补一条“已删除”记录，便于关联描述 */
  ensureGhostKey(provider, id, name, workspaceId) {
    if (!id || this.q('SELECT 1 FROM api_keys WHERE api_key_id = ?').get(id)) return false;
    const now = Date.now();
    this.q(`INSERT INTO api_keys(api_key_id, provider, description, workspace_id, first_seen, last_seen, deleted_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, provider, name || '', workspaceId || '', now, now, now, now);
    return true;
  }

  listWorkspaces() { return this.q('SELECT * FROM workspaces ORDER BY provider, gmt_create').all(); }
  listApiKeys() { return this.q('SELECT * FROM api_keys ORDER BY provider, CAST(api_key_id AS INTEGER) DESC, api_key_id DESC').all(); }
  listChanges(limit = 1000) { return this.q('SELECT * FROM change_log ORDER BY id DESC LIMIT ?').all(limit); }
  /** 某个 Key / 业务空间的全部变更（最近 1000 条） */
  changesOf(entityId) { return this.q('SELECT * FROM change_log WHERE entity_id = ? ORDER BY id DESC LIMIT 1000').all(entityId); }
  changesSince(id) { return this.q('SELECT * FROM change_log WHERE id > ? ORDER BY id LIMIT 200').all(Number(id) || 0); }
  maxChangeId() { return this.q('SELECT COALESCE(MAX(id), 0) AS n FROM change_log').get().n; }
  providersInUse() { return this.q('SELECT DISTINCT provider FROM api_keys UNION SELECT DISTINCT provider FROM bill_lines').all().map(r => r.provider); }

  /* ---------------- 成本中心 / 负责人标签 ---------------- */
  listKeyTags() { return this.q('SELECT * FROM key_tags').all(); }
  setKeyTag(id, { costCenter = '', owner = '', note = '' }, by = '') {
    const cc = String(costCenter || '').trim().slice(0, 40), ow = String(owner || '').trim().slice(0, 40), nt = String(note || '').trim().slice(0, 200);
    if (!cc && !ow && !nt) { this.q('DELETE FROM key_tags WHERE api_key_id = ?').run(id); return null; }
    this.q(`INSERT INTO key_tags(api_key_id, cost_center, owner, note, updated_at, updated_by) VALUES(?,?,?,?,?,?)
      ON CONFLICT(api_key_id) DO UPDATE SET cost_center=excluded.cost_center, owner=excluded.owner, note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(id, cc, ow, nt, Date.now(), by);
    return { costCenter: cc, owner: ow, note: nt };
  }

  /* ---------------- 账单 ---------------- */
  getPeriod(provider, gran, period, code) {
    return this.q('SELECT * FROM bill_periods WHERE provider = ? AND granularity = ? AND period = ? AND product_code = ?').get(provider, gran, period, code);
  }
  /** 账期同步状态（多云合并：任一厂商已同步即视为已同步；全部已出账才视为终版） */
  getCycle(cycle, provider) {
    if (provider) return this.q('SELECT * FROM bill_cycles WHERE provider = ? AND cycle = ?').get(provider, cycle);
    return this.q(`SELECT cycle, MAX(synced_at) AS synced_at, MIN(final) AS final, SUM(pretax) AS pretax, SUM(gross) AS gross, GROUP_CONCAT(provider) AS providers
      FROM bill_cycles WHERE cycle = ? GROUP BY cycle`).get(cycle);
  }
  listCycles() {
    return this.q(`SELECT cycle, MAX(synced_at) AS synced_at, MIN(final) AS final, SUM(pretax) AS pretax, SUM(gross) AS gross, GROUP_CONCAT(provider) AS providers
      FROM bill_cycles GROUP BY cycle ORDER BY cycle DESC`).all();
  }
  listCyclesByProvider() { return this.q('SELECT * FROM bill_cycles ORDER BY cycle DESC, provider').all(); }

  insertLines(provider, gran, period, cycle, code, rows, now) {
    const ins = this.q(`INSERT INTO bill_lines(${INSERT_COLS.join(',')}) VALUES(${INSERT_COLS.map(() => '?').join(',')})`);
    let pretax = 0;
    for (const r of rows) {
      pretax += r.pretax || 0;
      ins.run(provider, gran, period, cycle, code, r.instance_id, r.api_key_id, r.workspace_id, r.model, r.io, r.channel, r.stop_flag, r.kind,
        r.billing_item, r.billing_item_code, r.commodity_code, r.product_detail, n0(r.usage), r.usage_unit, n0(r.tokens), r.list_price, r.list_price_unit,
        r.gross, r.pretax, r.after_discount, r.invoice_discount, r.coupons, r.cash_coupons, r.prepaid, r.resource_pkg, r.currency, r.region, r.item,
        r.subscription_type, r.alloc || 0, now);
    }
    this.q(`INSERT INTO bill_periods(provider, granularity, period, product_code, cycle, synced_at, line_count, pretax, final) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider, granularity, period, product_code) DO UPDATE SET synced_at=excluded.synced_at, line_count=excluded.line_count, pretax=excluded.pretax, final=excluded.final`)
      .run(provider, gran, period, code, cycle, now, rows.length, pretax, 0);
    return pretax;
  }
  /** 以“厂商 + 账期/日 + 产品”为单位整体替换，保证与云厂商账单一致（含金额回调、出账修正） */
  replaceBillPeriod(provider, gran, period, cycle, code, rows, final) {
    const now = Date.now();
    this.tx(() => {
      this.q('DELETE FROM bill_lines WHERE provider = ? AND granularity = ? AND period = ? AND product_code = ?').run(provider, gran, period, code);
      this.insertLines(provider, gran, period, cycle, code, rows, now);
      if (final) this.q('UPDATE bill_periods SET final = 1 WHERE provider = ? AND granularity = ? AND period = ? AND product_code = ?').run(provider, gran, period, code);
    });
  }
  /** 一个账期的日账单 + 月账单整体替换（腾讯云：按月拉取明细后在本地拆分到日） */
  replaceBillCycle(provider, cycle, code, dayRows, days, monthRows, final) {
    const now = Date.now();
    this.tx(() => {
      // 产品代码可能随账单变化（如新增混元等产品），整账期替换，不按产品代码删除
      this.q('DELETE FROM bill_lines WHERE provider = ? AND cycle = ?').run(provider, cycle);
      this.q('DELETE FROM bill_periods WHERE provider = ? AND cycle = ?').run(provider, cycle);
      for (const day of days) this.insertLines(provider, 'D', day, cycle, code, dayRows.get(day) || [], now);
      this.insertLines(provider, 'M', cycle, cycle, code, monthRows, now);
      if (final) this.q('UPDATE bill_periods SET final = 1 WHERE provider = ? AND cycle = ? AND product_code = ?').run(provider, cycle, code);
    });
  }
  /** 删除某账期中不在 codes 内的产品代码的账单（产品代码识别结果可靠时调用，避免旧代码的账单永远留在库里被重复合计） */
  pruneCycleCodes(provider, cycle, codes) {
    const keep = [...new Set(codes)];
    if (!keep.length) return 0;
    const ph = keep.map(() => '?').join(',');
    let n = 0;
    this.tx(() => {
      n = Number(this.q(`DELETE FROM bill_lines WHERE provider = ? AND cycle = ? AND product_code NOT IN (${ph})`).run(provider, cycle, ...keep).changes);
      this.q(`DELETE FROM bill_periods WHERE provider = ? AND cycle = ? AND product_code NOT IN (${ph})`).run(provider, cycle, ...keep);
    });
    return n;
  }
  /** 某账期已保存的账单行数；codes 不为空时只统计这些产品代码 */
  cycleLineCount(provider, cycle, codes = null) {
    if (!codes?.length) return this.q('SELECT COUNT(*) AS n FROM bill_lines WHERE provider = ? AND cycle = ?').get(provider, cycle).n;
    return this.q(`SELECT COUNT(*) AS n FROM bill_lines WHERE provider = ? AND cycle = ? AND product_code IN (${codes.map(() => '?').join(',')})`).get(provider, cycle, ...codes).n;
  }
  /** 此前识别到的产品代码：该账期已保存的代码，没有时取最近一个已同步账期记录的代码 */
  knownCodes(provider, cycle) {
    const own = this.q('SELECT DISTINCT product_code AS c FROM bill_periods WHERE provider = ? AND cycle = ?').all(provider, cycle).map(r => r.c).filter(Boolean);
    if (own.length) return own;
    const r = this.q("SELECT product_codes FROM bill_cycles WHERE provider = ? AND product_codes <> '' ORDER BY cycle DESC LIMIT 1").get(provider);
    return r ? r.product_codes.split(',').filter(Boolean) : [];
  }
  markCycle(provider, cycle, codes, final) {
    const t = this.q("SELECT COALESCE(SUM(pretax),0) AS p, COALESCE(SUM(gross),0) AS g FROM bill_lines WHERE provider = ? AND granularity = 'M' AND cycle = ?").get(provider, cycle);
    this.q(`INSERT INTO bill_cycles(provider, cycle, product_codes, synced_at, final, pretax, gross) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(provider, cycle) DO UPDATE SET product_codes=excluded.product_codes, synced_at=excluded.synced_at, final=excluded.final, pretax=excluded.pretax, gross=excluded.gross`)
      .run(provider, cycle, codes.join(','), Date.now(), final ? 1 : 0, t.p, t.g);
  }
  replaceMsOverview(cycle, groupCode, groups) {
    const now = Date.now();
    this.tx(() => {
      this.q('DELETE FROM ms_overview WHERE cycle = ? AND group_code = ?').run(cycle, groupCode);
      for (const g of groups) {
        this.q('INSERT INTO ms_overview(cycle, group_code, key, name, amount, article_codes, synced_at) VALUES(?,?,?,?,?,?,?)')
          .run(cycle, groupCode, String(g.key ?? ''), String(g.name ?? ''), parseFloat(g.amount) || 0, JSON.stringify(g.articleCodes || []), now);
      }
    });
  }
  msOverview(cycle, groupCode = 'API_KEY_ID') {
    return this.q('SELECT key, name, amount, article_codes, synced_at FROM ms_overview WHERE cycle = ? AND group_code = ? ORDER BY amount DESC').all(cycle, groupCode);
  }

  /* ---------------- 用量明细（腾讯云 TokenHub：Key × 模型 × 日） ---------------- */
  replaceUsage(provider, from, to, rows) {
    const now = Date.now();
    this.tx(() => {
      this.q('DELETE FROM usage_lines WHERE provider = ? AND day >= ? AND day <= ?').run(provider, from, to);
      const ins = this.q(`INSERT INTO usage_lines(provider, day, api_key_id, model, input_tokens, output_tokens, cache_tokens, total_tokens, requests, fails, synced_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, day, api_key_id, model) DO UPDATE SET input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens, cache_tokens=excluded.cache_tokens, total_tokens=excluded.total_tokens,
        requests=excluded.requests, fails=excluded.fails, synced_at=excluded.synced_at`);
      for (const r of rows) ins.run(provider, r.day, r.api_key_id, r.model, r.input_tokens || 0, r.output_tokens || 0, r.cache_tokens || 0, r.total_tokens || 0, r.requests || 0, r.fails || 0, now);
    });
    this.bumpRev();
  }
  /**
   * 合并写入但不缩小：已有记录的请求数不小于新值时保留已有记录。
   * 用于数据源保留期边缘的“残缺日”（只剩部分时段的数据），避免残缺值覆盖此前保存的完整值
   */
  mergeUsageMax(provider, rows) {
    const now = Date.now();
    this.tx(() => {
      const ins = this.q(`INSERT INTO usage_lines(provider, day, api_key_id, model, input_tokens, output_tokens, cache_tokens, total_tokens, requests, fails, synced_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, day, api_key_id, model) DO UPDATE SET input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens, cache_tokens=excluded.cache_tokens, total_tokens=excluded.total_tokens,
        requests=excluded.requests, fails=excluded.fails, synced_at=excluded.synced_at WHERE excluded.requests > usage_lines.requests`);
      for (const r of rows) ins.run(provider, r.day, r.api_key_id, r.model, r.input_tokens || 0, r.output_tokens || 0, r.cache_tokens || 0, r.total_tokens || 0, r.requests || 0, r.fails || 0, now);
    });
  }
  /** 删除类写入不一定改变 MAX(synced_at) / MAX(rowid)：额外推进数据版本 */
  bumpRev() { this.setSetting('data.rev', Date.now()); }
  clearUsage(provider) { this.q('DELETE FROM usage_lines WHERE provider = ?').run(provider); this.bumpRev(); }
  /** 阿里云按日账单 Token：日 × Key × 模型 × 计费项（用于调用次数的单次平均 Token） */
  billTokenCells(provider, from, to) {
    return this.q(`SELECT period AS day, COALESCE(api_key_id, '') AS api_key_id, COALESCE(model, '') AS model, io, SUM(tokens) AS tokens
      FROM bill_lines WHERE provider = ? AND granularity = 'D' AND period >= ? AND period <= ? AND tokens > 0 GROUP BY period, api_key_id, model, io`).all(provider, from, to);
  }
  usageRows(provider, from, to) {
    return this.q('SELECT day, api_key_id, model, input_tokens, output_tokens, cache_tokens, total_tokens, requests, fails FROM usage_lines WHERE provider = ? AND day >= ? AND day <= ?').all(provider, from, to);
  }
  /** 前端：按 日 × Key × 模型 的请求次数、失败次数与 Token（腾讯云 TokenHub 用量统计） */
  queryUsage(from, to) {
    const cols = ['provider', 'day', 'api_key_id', 'model', 'requests', 'fails', 'input_tokens', 'output_tokens', 'cache_tokens', 'total_tokens'];
    const rows = this.q(`SELECT provider, day, api_key_id, model, requests, fails, input_tokens, output_tokens, cache_tokens, total_tokens
      FROM usage_lines WHERE day >= ? AND day <= ? ORDER BY day`).all(from, to);
    return { cols, rows: rows.map(r => cols.map(c => r[c])) };
  }

  /** 返回紧凑数组：{ cols, rows }；slim=true 时只返回趋势/对比所需的列 */
  queryLines(gran, from, to, slim = false) {
    const cols = slim ? SLIM_COLS : LINE_COLS;
    const rows = this.q(`SELECT ${cols.join(',')} FROM bill_lines WHERE granularity = ? AND period >= ? AND period <= ? ORDER BY period`).all(gran, from, to);
    return { cols, rows: rows.map(r => cols.map(c => r[c])) };
  }
  /** 同比/环比用：按维度聚合的上期数据 */
  queryAgg(gran, from, to) {
    const cols = ['provider', 'api_key_id', 'workspace_id', 'model', 'io', 'channel', 'kind', 'gross', 'pretax', 'after_discount', 'tokens', 'usage_unit'];
    const rows = this.q(`SELECT provider, api_key_id, workspace_id, model, io, channel, kind, SUM(gross) AS gross, SUM(pretax) AS pretax, SUM(after_discount) AS after_discount,
      SUM(tokens) AS tokens, usage_unit FROM bill_lines WHERE granularity = ? AND period >= ? AND period <= ?
      GROUP BY provider, api_key_id, workspace_id, model, io, channel, kind, usage_unit`).all(gran, from, to);
    return { cols, rows: rows.map(r => cols.map(c => r[c])) };
  }
  /** 每个 Key 的最近消费日、近 7/30 天应付金额（基于日账单） */
  keyActivity(today) {
    const d7 = shiftDay(today, -6), d30 = shiftDay(today, -29);
    const recent = this.q(`SELECT api_key_id AS id, SUM(CASE WHEN period >= ? THEN pretax ELSE 0 END) AS c7, SUM(pretax) AS c30, COUNT(DISTINCT period) AS days30
      FROM bill_lines WHERE granularity = 'D' AND period >= ? GROUP BY api_key_id`).all(d7, d30);
    const last = this.q(`SELECT api_key_id AS id, MAX(period) AS lastDay FROM bill_lines WHERE granularity = 'D' AND (pretax > 0 OR gross > 0 OR tokens > 0) GROUP BY api_key_id`).all();
    const out = new Map();
    for (const r of last) out.set(r.id || '', { apiKeyId: r.id || '', lastDay: r.lastDay, c7: 0, c30: 0, days30: 0 });
    for (const r of recent) out.set(r.id || '', { ...(out.get(r.id || '') || { apiKeyId: r.id || '', lastDay: null }), c7: r.c7 || 0, c30: r.c30 || 0, days30: r.days30 || 0 });
    return [...out.values()];
  }
  /** 预算告警用：指定账期的月账单按 Key 汇总，以及日账单按 Key×日汇总（应付金额） */
  budgetUsage(cycle) {
    const month = this.q("SELECT COALESCE(api_key_id, '') AS id, SUM(pretax) AS cost FROM bill_lines WHERE granularity = 'M' AND period = ? GROUP BY COALESCE(api_key_id, '')").all(cycle);
    const daily = this.q("SELECT period AS day, SUM(pretax) AS cost FROM bill_lines WHERE granularity = 'D' AND period >= ? AND period <= ? GROUP BY period").all(cycle + '-01', cycle + '-31');
    return { month, daily };
  }
  /** 日报 / 周报 / 异常检测：日账单按 日 × Key 汇总（含 Token） */
  dailyByKey(from, to) {
    return this.q(`SELECT period AS day, COALESCE(api_key_id, '') AS id, provider, SUM(pretax) AS cost, SUM(COALESCE(tokens, 0)) AS tokens
      FROM bill_lines WHERE granularity = 'D' AND period >= ? AND period <= ? GROUP BY period, COALESCE(api_key_id, ''), provider`).all(from, to);
  }
  dailyByModel(from, to) {
    return this.q(`SELECT model, SUM(pretax) AS cost, SUM(COALESCE(tokens, 0)) AS tokens FROM bill_lines WHERE granularity = 'D' AND period >= ? AND period <= ? GROUP BY model`).all(from, to);
  }
  countLines(gran, from, to) { return this.q('SELECT COUNT(*) AS n FROM bill_lines WHERE granularity = ? AND period >= ? AND period <= ?').get(gran, from, to).n; }
  /** 按日应付金额合计（日账单） */
  dailyCost(from, to) {
    return this.q("SELECT period AS day, SUM(pretax) AS cost FROM bill_lines WHERE granularity = 'D' AND period >= ? AND period <= ? GROUP BY period").all(from, to).map(r => ({ day: r.day, cost: r.cost || 0 }));
  }
  monthByKey(cycle) {
    return this.q(`SELECT COALESCE(api_key_id, '') AS id, provider, SUM(pretax) AS cost, SUM(gross) AS gross FROM bill_lines WHERE granularity = 'M' AND period = ? GROUP BY COALESCE(api_key_id, ''), provider`).all(cycle);
  }
  monthByModel(cycle) {
    return this.q(`SELECT model, SUM(pretax) AS cost FROM bill_lines WHERE granularity = 'M' AND period = ? GROUP BY model`).all(cycle);
  }
  /**
   * 数据版本指纹：账单、用量、Key/空间元数据、标签、预算任一变化都会改变，用于 /api/data 的 ETag 与前端轮询判断是否需要重新加载。
   * 不含 last_seen：元数据同步每 5 分钟刷新一次 last_seen，即使没有任何变化；计入后会让所有打开的页面每 5 分钟重新下载全部数据
   */
  dataVersion() {
    const r = this.q(`SELECT
      (SELECT COALESCE(MAX(synced_at), 0) || ':' || COUNT(*) FROM bill_periods) AS b,
      (SELECT COALESCE(MAX(synced_at), 0) || ':' || COUNT(*) FROM bill_cycles) AS c,
      (SELECT COALESCE(MAX(synced_at), 0) FROM ms_overview) AS m,
      (SELECT COALESCE(MAX(synced_at), 0) || ':' || COALESCE(MAX(rowid), 0) FROM usage_lines) AS u,
      (SELECT COALESCE(MAX(updated_at), 0) || ':' || COUNT(*) FROM api_keys) AS k,
      (SELECT COALESCE(MAX(updated_at), 0) || ':' || COUNT(*) FROM workspaces) AS w,
      (SELECT COALESCE(MAX(updated_at), 0) || ':' || COUNT(*) FROM key_tags) AS t,
      (SELECT COALESCE(MAX(updated_at), 0) FROM settings WHERE k IN ('budgets', 'branding', 'data.rev')) AS s`).get();
    return [r.b, r.c, r.m, r.u, r.k, r.w, r.t, r.s].join('|');
  }
  dataRange() {
    const d = this.q("SELECT MIN(period) AS min, MAX(period) AS max, COUNT(*) AS n FROM bill_lines WHERE granularity = 'D'").get();
    return { minDay: d.min, maxDay: d.max, dailyLines: d.n, cycles: this.listCycles() };
  }

  /* ---------------- 同步任务 ---------------- */
  startRun(kind, trig, provider = 'aliyun') {
    return this.q("INSERT INTO sync_runs(kind, trig, provider, started_at, status) VALUES(?,?,?,?,'running')").run(kind, trig, provider, Date.now()).lastInsertRowid;
  }
  finishRun(id, status, detail, error, calls) {
    this.q('UPDATE sync_runs SET finished_at = ?, status = ?, detail = ?, error = ?, api_calls = ? WHERE id = ?')
      .run(Date.now(), status, jsonOrNull(detail), error || null, calls ?? null, id);
  }
  lastRun(kind, status, provider = 'aliyun') {
    return status
      ? this.q('SELECT * FROM sync_runs WHERE kind = ? AND status = ? AND provider = ? ORDER BY id DESC LIMIT 1').get(kind, status, provider)
      : this.q("SELECT * FROM sync_runs WHERE kind = ? AND provider = ? AND status <> 'running' ORDER BY id DESC LIMIT 1").get(kind, provider);
  }
  /** 最近 n 次（已结束）同步结果，用于判断连续失败 */
  recentRuns(kind, provider, n = 5) {
    return this.q("SELECT id, status, started_at, finished_at, error FROM sync_runs WHERE kind = ? AND provider = ? AND status <> 'running' ORDER BY id DESC LIMIT ?").all(kind, provider, n);
  }
  /**
   * 连续失败统计：anchor 为 beforeId 之前最后一次非失败任务的 ID（没有则为 0），n 为其后到 beforeId 之前的失败次数。
   * 告警以 anchor 去重：同一轮故障的标识不随新的失败任务变化
   */
  errorStreak(kind, provider, beforeId = Number.MAX_SAFE_INTEGER) {
    const anchor = this.q("SELECT COALESCE(MAX(id), 0) AS id FROM sync_runs WHERE kind = ? AND provider = ? AND status NOT IN ('error', 'running') AND id < ?").get(kind, provider, beforeId).id;
    const n = this.q("SELECT COUNT(*) AS n FROM sync_runs WHERE kind = ? AND provider = ? AND status = 'error' AND id > ? AND id < ?").get(kind, provider, anchor, beforeId).n;
    return { n, anchor };
  }
  listRuns(limit = 100) { return this.q('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit); }
  failStaleRuns() { this.q("UPDATE sync_runs SET status = 'error', error = '服务重启，任务中断', finished_at = ? WHERE status = 'running'").run(Date.now()); }

  /* ---------------- 备份 ---------------- */
  /** 在线一致性备份：SQLite 增量备份 API，分批复制页面，不长时间阻塞请求处理 */
  async backupTo(file) {
    return sqliteBackup(this.db, file, { rate: 256 });
  }
}
