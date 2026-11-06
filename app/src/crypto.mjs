import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/* ---------------- 密码（scrypt） ---------------- */
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scryptAsync(String(pw).normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expect = Buffer.from(h, 'base64');
    const got = await scryptAsync(String(pw).normalize('NFKC'), Buffer.from(s, 'base64'), expect.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(got, expect);
  } catch {
    return false;
  }
}

let dummyHash = null;
/** 用户不存在时也做一次等价计算，避免通过响应时间枚举用户名 */
export async function burnPasswordCheck(pw) {
  if (!dummyHash) dummyHash = await hashPassword(randomToken(12));
  await verifyPassword(pw, dummyHash);
  return false;
}

export function checkPasswordPolicy(pw, username = '') {
  if (typeof pw !== 'string' || pw.length < 10) return '密码长度至少 10 位';
  if (pw.length > 128) return '密码长度不能超过 128 位';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '密码需同时包含字母和数字';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return '密码不能包含用户名';
  if (/^(.)\1+$/.test(pw)) return '密码过于简单';
  return '';
}

export function randomPassword(len = 16) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits + '@#%+=';
  for (;;) {
    const bytes = crypto.randomBytes(len);
    const pw = [...bytes].map(b => all[b % all.length]).join('');
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

/* ---------------- 主密钥 & AES-256-GCM ---------------- */
/**
 * 主密钥优先取环境变量 APP_MASTER_KEY（推荐，与数据卷分离保存）；
 * 未设置时在数据目录生成 .master.key（权限 600），并在管理页面提示风险。
 */
export function loadMasterKey(dataDir, envKey) {
  if (envKey && envKey.trim()) {
    if (envKey.trim().length < 32) throw new Error('APP_MASTER_KEY 长度至少 32 个字符（建议 openssl rand -base64 32 生成）');
    return { key: crypto.createHash('sha256').update(envKey.trim(), 'utf8').digest(), source: 'env' };
  }
  const file = path.join(dataDir, '.master.key');
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} 内容无效`);
    return { key, source: 'file' };
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return { key, source: 'file' };
}

export function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(key, blob, aad) {
  if (typeof blob !== 'string' || !blob.startsWith('v1:')) throw new Error('密文格式无效');
  const b = Buffer.from(blob.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from(String(aad), 'utf8'));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

export function maskId(id) {
  if (!id) return '';
  id = String(id);
  if (id.length <= 8) return id.slice(0, 2) + '****';
  return id.slice(0, 4) + '****' + id.slice(-4);
}
