import path from 'node:path';
import net from 'node:net';

const env = process.env;
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
/** 启动时打印的配置警告：格式不正确而被忽略的环境变量不能静默失效（尤其是安全相关配置） */
const warnings = [];
const checked = (name, ok, msg) => { if (env[name] != null && String(env[name]).trim() !== '' && !ok) warnings.push(`环境变量 ${name} ${msg}，已忽略`); return ok; };
/** COOKIE_SECURE：auto（默认，HTTPS 请求自动加 Secure）/ true / false，布尔写法与其他开关一致（1/yes/on、0/no/off） */
const cookieSecure = (() => {
  const v = String(env.COOKIE_SECURE || '').trim().toLowerCase();
  if (!v || v === 'auto') return 'auto';
  if (/^(1|true|yes|on)$/.test(v)) return 'true';
  if (/^(0|false|no|off)$/.test(v)) return 'false';
  warnings.push(`环境变量 COOKIE_SECURE=${v.slice(0, 20)} 无法识别（应为 auto / true / false），按 auto 处理`);
  return 'auto';
})();
const validTz = tz => { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(0); return true; } catch { return false; } };
const billTz = (env.BILL_TZ || '').trim() || 'Asia/Shanghai';
const cidrOk = c => {
  const [addr, prefix, extra] = String(c).split('/');
  const fam = net.isIP(addr);
  if (!fam || extra != null) return false;
  if (prefix == null) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (fam === 6 ? 128 : 32);
};
const allowCidrs = (env.ALLOW_CIDRS || '').split(/[,\s]+/).filter(Boolean);
const trustedProxies = (env.TRUSTED_PROXIES || '').split(/[,\s]+/).filter(Boolean);
const badCidrs = [...allowCidrs, ...trustedProxies].filter(c => !cidrOk(c));

export const config = {
  port: int(env.PORT, 8080, 1, 65535),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  /**
   * 位于反向代理（如 Caddy/Nginx）之后时设为 true（或可信代理层数，如 SLB + Nginx 为 2），才会信任 X-Forwarded-For / X-Forwarded-Proto。
   * 客户端 IP 取 X-Forwarded-For 从右往左第 N 个地址（N = 可信代理层数）：最左侧的地址可由客户端伪造，不能用于限流与 IP 白名单
   */
  trustProxy: /^\d+$/.test((env.TRUST_PROXY || '').trim()) ? Number(env.TRUST_PROXY.trim()) > 0 : bool(env.TRUST_PROXY),
  proxyHops: /^\d+$/.test((env.TRUST_PROXY || '').trim()) ? Math.min(10, Math.max(1, Number(env.TRUST_PROXY.trim()))) : 1,
  /** 只信任来自这些地址的 X-Forwarded-* 头（默认本机、内网与 100.64.0.0/10）；服务端口可被公网直接访问时请设置为代理的地址 */
  trustedProxies,
  /** auto：HTTPS 请求时自动加 Secure；true/false 强制 */
  cookieSecure,
  sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 120, 5, 24 * 60),
  sessionMaxHours: int(env.SESSION_MAX_HOURS, 12, 1, 24 * 30),
  adminUsername: (env.ADMIN_USERNAME || 'admin').trim(),
  adminPassword: env.ADMIN_PASSWORD || '',
  /** 用于加密 AccessKey 的主密钥（建议 openssl rand -base64 32 生成，放在 .env，不要与数据卷放在一起） */
  masterKey: env.APP_MASTER_KEY || '',
  /** 阿里云账单的自然日按北京时间划分；无效时区在启动时报错退出（否则每个接口都会 500） */
  billTz,
  billTzValid: validTz(billTz),
  /** 可选：只允许这些来源 IP/网段访问，如 "10.0.0.0/8,203.0.113.5"；格式错误时启动报错退出（安全配置不能被静默忽略） */
  allowCidrs,
  badCidrs,
  /** 每个 IP 每分钟的接口请求上限（静态资源不计入） */
  rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 600, 60, 100_000),
  /** 系统日志保留天数 */
  systemLogDays: int(env.SYSTEM_LOG_DAYS, 30, 1, 365),
  /** 可选：首次启动时导入的 AccessKey（导入后加密存库，之后以管理页面配置为准） */
  bootstrapAkId: env.ALIBABA_CLOUD_ACCESS_KEY_ID || '',
  bootstrapAkSecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '',
  /** 可选：首次启动时导入的腾讯云 API 密钥（导入后加密存库） */
  bootstrapTcId: env.TENCENTCLOUD_SECRET_ID || '',
  bootstrapTcKey: env.TENCENTCLOUD_SECRET_KEY || '',
  /** 仅用于测试或私有 API 网关：覆盖腾讯云 API 地址，例如 http://127.0.0.1:9555（生产环境请留空） */
  tencentEndpoint: checked('TENCENT_ENDPOINT_OVERRIDE', /^https?:\/\/[^\s/?#]+$/i.test((env.TENCENT_ENDPOINT_OVERRIDE || '').trim()), '格式应为 http(s)://host[:port]') ? env.TENCENT_ENDPOINT_OVERRIDE.trim() : '',
  /** 可选：Prometheus 指标 /metrics 的访问令牌（Bearer），留空则关闭该接口 */
  metricsToken: checked('METRICS_TOKEN', (env.METRICS_TOKEN || '').trim().length >= 16, '长度不足 16 位（/metrics 保持关闭）') ? env.METRICS_TOKEN.trim() : '',
  /** 演示模式：数据库为空且未配置任何云厂商时生成虚构演示数据；配置真实访问密钥后自动清除 */
  demo: bool(env.DEMO_DATA),
  /** 自动备份：每天保留最近 N 份（0 关闭），备份时间（时，账单时区） */
  backupKeep: int(env.BACKUP_KEEP, 7, 0, 90),
  backupHour: int(env.BACKUP_HOUR, 3, 0, 23),
  /** 可选：对外访问地址（如 https://cost.example.com），用于告警消息中的跳转链接 */
  publicUrl: checked('PUBLIC_URL', /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test((env.PUBLIC_URL || '').trim()), '格式应为 http(s)://host[/path]（告警消息中不附带链接）') ? env.PUBLIC_URL.trim() : '',
  /** 可选：允许通用 Webhook 指向内网地址（默认禁止，防 SSRF） */
  alertAllowPrivate: bool(env.ALERT_ALLOW_PRIVATE),
  /** 可选：允许阿里云调用次数的 Prometheus 地址指向本机回环（同机部署的 Prometheus / 测试用；元数据地址始终禁止） */
  promAllowLoopback: bool(env.PROM_ALLOW_LOOPBACK),
  login: {
    maxFailuresPerUser: int(env.LOGIN_MAX_FAILURES, 5, 3, 20),
    lockMinutes: int(env.LOGIN_LOCK_MINUTES, 15, 1, 24 * 60),
    maxAttemptsPerIp: int(env.LOGIN_MAX_PER_IP, 20, 5, 1000),
    ipWindowMinutes: 15,
  },
  warnings,
};
checked('TRUST_PROXY', /^(\d+|1|true|yes|on|0|false|no|off)$/i.test(String(env.TRUST_PROXY || '').trim()), '应为 true / false 或可信代理层数（如 2），按 false 处理');
