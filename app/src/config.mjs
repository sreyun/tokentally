import path from 'node:path';

const env = process.env;
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export const config = {
  port: int(env.PORT, 8080, 1, 65535),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  /** 位于反向代理（如 Caddy/Nginx）之后时设为 true，才会信任 X-Forwarded-For / X-Forwarded-Proto */
  trustProxy: bool(env.TRUST_PROXY),
  /** auto：HTTPS 请求时自动加 Secure；true/false 强制 */
  cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(),
  sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 120, 5, 24 * 60),
  sessionMaxHours: int(env.SESSION_MAX_HOURS, 12, 1, 24 * 30),
  adminUsername: (env.ADMIN_USERNAME || 'admin').trim(),
  adminPassword: env.ADMIN_PASSWORD || '',
  /** 用于加密 AccessKey 的主密钥（建议 openssl rand -base64 32 生成，放在 .env，不要与数据卷放在一起） */
  masterKey: env.APP_MASTER_KEY || '',
  /** 阿里云账单的自然日按北京时间划分 */
  billTz: env.BILL_TZ || 'Asia/Shanghai',
  /** 可选：只允许这些来源 IP/网段访问，如 "10.0.0.0/8,203.0.113.5" */
  allowCidrs: (env.ALLOW_CIDRS || '').split(/[,\s]+/).filter(Boolean),
  /** 可选：首次启动时导入的 AccessKey（导入后加密存库，之后以管理页面配置为准） */
  bootstrapAkId: env.ALIBABA_CLOUD_ACCESS_KEY_ID || '',
  bootstrapAkSecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '',
  /** 可选：首次启动时导入的腾讯云 API 密钥（导入后加密存库） */
  bootstrapTcId: env.TENCENTCLOUD_SECRET_ID || '',
  bootstrapTcKey: env.TENCENTCLOUD_SECRET_KEY || '',
  /** 仅用于测试或私有 API 网关：覆盖腾讯云 API 地址，例如 http://127.0.0.1:9555（生产环境请留空） */
  tencentEndpoint: /^https?:\/\/[^\s/?#]+$/i.test((env.TENCENT_ENDPOINT_OVERRIDE || '').trim()) ? env.TENCENT_ENDPOINT_OVERRIDE.trim() : '',
  /** 可选：Prometheus 指标 /metrics 的访问令牌（Bearer），留空则关闭该接口 */
  metricsToken: (env.METRICS_TOKEN || '').trim().length >= 16 ? env.METRICS_TOKEN.trim() : '',
  /** 演示模式：数据库为空且未配置任何云厂商时生成虚构演示数据；配置真实访问密钥后自动清除 */
  demo: bool(env.DEMO_DATA),
  /** 自动备份：每天保留最近 N 份（0 关闭），备份时间（时，账单时区） */
  backupKeep: int(env.BACKUP_KEEP, 7, 0, 90),
  backupHour: int(env.BACKUP_HOUR, 3, 0, 23),
  /** 可选：对外访问地址（如 https://cost.example.com），用于告警消息中的跳转链接 */
  publicUrl: /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test((env.PUBLIC_URL || '').trim()) ? env.PUBLIC_URL.trim() : '',
  /** 可选：允许通用 Webhook 指向内网地址（默认禁止，防 SSRF） */
  alertAllowPrivate: bool(env.ALERT_ALLOW_PRIVATE),
  login: {
    maxFailuresPerUser: int(env.LOGIN_MAX_FAILURES, 5, 3, 20),
    lockMinutes: int(env.LOGIN_LOCK_MINUTES, 15, 1, 24 * 60),
    maxAttemptsPerIp: int(env.LOGIN_MAX_PER_IP, 20, 5, 1000),
    ipWindowMinutes: 15,
  },
};
