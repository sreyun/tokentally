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
  login: {
    maxFailuresPerUser: int(env.LOGIN_MAX_FAILURES, 5, 3, 20),
    lockMinutes: int(env.LOGIN_LOCK_MINUTES, 15, 1, 24 * 60),
    maxAttemptsPerIp: int(env.LOGIN_MAX_PER_IP, 20, 5, 1000),
    ipWindowMinutes: 15,
  },
};
