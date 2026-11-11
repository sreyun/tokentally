/* =========================================================================
 * IP 归属地（离线，零依赖）
 * - 本机 / 内网 / 运营商级 NAT 等保留地址直接识别
 * - 公网地址查询 ip2region xdb 离线库（https://github.com/lionsoul2014/ip2region，Apache-2.0 / MIT），
 *   不调用任何在线接口，客户端 IP 不会发送给第三方
 * - 库文件查找顺序：环境变量 IP_REGION_DB（IPv4）/ IP_REGION_DB_V6 → 数据目录 ip2region_v4.xdb / ip2region_v6.xdb
 *   → 内置 app/geo/ip2region_v4.xdb；IPv6 库体积较大（约 37 MB）未内置，放到数据目录即可启用
 * - 整个 xdb 文件读入内存（IPv4 约 11 MB），单次查询为内存中的二分查找（微秒级），结果另有 LRU 缓存
 * ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const HEADER = 256, VCOLS = 256, VSIZE = 8;
const BUILTIN_DIR = path.join(import.meta.dirname, '..', 'geo');

export function parseIPv4(s) {
  if (!net.isIPv4(s)) return null;
  return Buffer.from(s.split('.').map(Number));
}
export function parseIPv6(s) {
  s = String(s).replace(/%.*$/, '');
  if (!net.isIPv6(s)) return null;
  const m4 = s.match(/:(\d+\.\d+\.\d+\.\d+)$/); // 末尾内嵌 IPv4（如 ::ffff:1.2.3.4）
  if (m4) { const b = parseIPv4(m4[1]); s = s.slice(0, -m4[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`; }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return buf;
}
/** IPv4 映射 / 兼容地址（::ffff:a.b.c.d）转为 IPv4 字节，其余返回 null */
function mappedV4(b16) {
  for (let i = 0; i < 10; i++) if (b16[i]) return null;
  return b16[10] === 0xff && b16[11] === 0xff ? b16.subarray(12) : null;
}

/** 保留地址：返回中文类别，公网地址返回 null */
export function reservedLabel(ip) {
  const s = String(ip || '').trim();
  let b = parseIPv4(s);
  if (!b) {
    const b6 = parseIPv6(s);
    if (!b6) return null;
    const v4 = mappedV4(b6);
    if (v4) b = v4;
    else {
      if (b6.every((x, i) => (i < 15 ? x === 0 : x === 1))) return '本机';
      if (b6.every(x => x === 0)) return '未指定地址';
      if ((b6[0] & 0xfe) === 0xfc) return '内网';
      if (b6[0] === 0xfe && (b6[1] & 0xc0) === 0x80) return '链路本地';
      if (b6[0] === 0xff) return '组播地址';
      if (b6[0] === 0x20 && b6[1] === 0x01 && b6[2] === 0x0d && b6[3] === 0xb8) return '文档示例地址';
      return null;
    }
  }
  const [a, c] = b;
  if (a === 127) return '本机';
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168)) return '内网';
  if (a === 100 && c >= 64 && c <= 127) return '运营商级 NAT';
  if (a === 169 && c === 254) return '链路本地';
  if (a === 0) return '未指定地址';
  if (a === 198 && (c === 18 || c === 19)) return '测试网段';
  if (a >= 224 && a <= 239) return '组播地址';
  if (a >= 240) return '保留地址';
  return null;
}

/** xdb 文件（结构版本 2 / 3，IPv4 / IPv6） */
export class Xdb {
  constructor(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < HEADER + VCOLS * VCOLS * VSIZE) throw new Error('文件过小，不是有效的 xdb 文件');
    const ver = buf.readUInt16LE(0);
    if (ver !== 2 && ver !== 3) throw new Error(`不支持的 xdb 结构版本 ${ver}`);
    const ipVer = ver === 3 ? buf.readUInt16LE(16) : 4;
    const ptrBytes = ver === 3 ? buf.readUInt16LE(18) : 4;
    if (ipVer !== 4 && ipVer !== 6) throw new Error(`不支持的 IP 版本 ${ipVer}`);
    if (ptrBytes !== 4) throw new Error(`不支持的指针宽度 ${ptrBytes}`);
    this.file = file; this.buf = buf; this.ipVersion = ipVer;
    this.bytes = ipVer === 6 ? 16 : 4;
    this.indexSize = this.bytes * 2 + 6; // 起始 IP + 结束 IP + 数据长度(2) + 数据指针(4)
    this.createdAt = buf.readUInt32LE(4) * 1000;
    this.size = buf.length;
  }
  /** IPv4 索引按小端存储，IPv6 按大端存储 */
  cmp(ip, off) {
    const b = this.buf;
    if (this.bytes === 4) {
      for (let i = 0; i < 4; i++) { const d = ip[i] - b[off + 3 - i]; if (d) return d; }
      return 0;
    }
    return ip.compare(b, off, off + 16);
  }
  search(ip) {
    if (!ip || ip.length !== this.bytes) return '';
    const b = this.buf, n = this.bytes;
    const vi = HEADER + (ip[0] * VCOLS + ip[1]) * VSIZE;
    const sPtr = b.readUInt32LE(vi), ePtr = b.readUInt32LE(vi + 4);
    if (!sPtr || !ePtr || ePtr < sPtr || ePtr + this.indexSize > b.length) return '';
    let l = 0, h = Math.floor((ePtr - sPtr) / this.indexSize);
    while (l <= h) {
      const m = (l + h) >> 1, p = sPtr + m * this.indexSize;
      if (this.cmp(ip, p) < 0) h = m - 1;
      else if (this.cmp(ip, p + n) > 0) l = m + 1;
      else {
        const len = b.readUInt16LE(p + n * 2), ptr = b.readUInt32LE(p + n * 2 + 2);
        return len && ptr + len <= b.length ? b.toString('utf8', ptr, ptr + len) : '';
      }
    }
    return '';
  }
}

const COUNTRY = { 'United States': '美国', Japan: '日本', 'South Korea': '韩国', Korea: '韩国', Singapore: '新加坡', 'Hong Kong': '中国香港', Taiwan: '中国台湾', Macao: '中国澳门', Macau: '中国澳门', Germany: '德国', 'United Kingdom': '英国', France: '法国', Netherlands: '荷兰', Canada: '加拿大', Australia: '澳大利亚', Russia: '俄罗斯', India: '印度', Malaysia: '马来西亚', Thailand: '泰国', Vietnam: '越南', Indonesia: '印度尼西亚', Philippines: '菲律宾', Brazil: '巴西', Ireland: '爱尔兰', Sweden: '瑞典', Switzerland: '瑞士', Italy: '意大利', Spain: '西班牙', 'United Arab Emirates': '阿联酋', 'Saudi Arabia': '沙特阿拉伯', Turkey: '土耳其', Israel: '以色列', Finland: '芬兰', Norway: '挪威', Denmark: '丹麦', Poland: '波兰', Mexico: '墨西哥', 'New Zealand': '新西兰', 'South Africa': '南非' };
/**
 * ip2region 地域信息 “国家|省份|城市|ISP|国家代码”（0 表示缺失）→ 便于阅读的中文文本
 * 例：中国|广东省|深圳市|电信|CN → 广东省 深圳市 · 电信；中国|上海|上海市|联通 → 上海市 · 联通
 */
export function formatRegion(raw) {
  const f = String(raw || '').split('|').map(s => (s === '0' ? '' : s.trim()));
  if (!f.some(Boolean)) return '';
  const [country0, prov, city, isp] = f;
  if (country0 === 'Reserved') return '保留地址';
  const country = COUNTRY[country0] || country0;
  const parts = [];
  if (country === '中国') {
    if (prov) parts.push(prov);
    if (city && city !== prov && city.replace(/市$/, '') !== prov.replace(/市$/, '')) parts.push(city);
    else if (city && city !== prov) parts[parts.length - 1] = city; // 直辖市：上海 / 上海市 → 上海市
    if (!parts.length) parts.push('中国');
  } else {
    if (country) parts.push(country);
    if (prov && prov !== country0) parts.push(prov);
    if (city && city !== prov) parts.push(city);
  }
  return parts.join(' ') + (isp && !/^(内网IP|0)$/.test(isp) ? ` · ${isp}` : '');
}

/* ---------------- 服务端单例 ---------------- */
const state = { loaded: false, v4: null, v6: null, errors: [], dataDir: '', env: {} };
const cache = new Map();
const CACHE_MAX = 20000;

/** 配置数据目录与环境变量（启动时调用一次；库文件在首次查询时才读入内存） */
export function configureIpLoc({ dataDir = '', env = process.env } = {}) {
  state.dataDir = dataDir; state.env = env; state.loaded = false; state.v4 = state.v6 = null; state.errors = []; cache.clear();
}
function tryLoad(files, ver) {
  for (const f of files.filter(Boolean)) {
    if (!fs.existsSync(f)) continue;
    try {
      const db = new Xdb(f);
      if (db.ipVersion !== ver) throw new Error(`这是 IPv${db.ipVersion} 库，需要 IPv${ver} 库`);
      return db;
    } catch (e) { state.errors.push(`${path.basename(f)}：${e.message}`); }
  }
  return null;
}
function load() {
  if (state.loaded) return;
  state.loaded = true;
  const d = state.dataDir, e = state.env || {};
  state.v4 = tryLoad([e.IP_REGION_DB, d && path.join(d, 'ip2region_v4.xdb'), d && path.join(d, 'ip2region.xdb'), path.join(BUILTIN_DIR, 'ip2region_v4.xdb')], 4);
  state.v6 = tryLoad([e.IP_REGION_DB_V6, d && path.join(d, 'ip2region_v6.xdb'), path.join(BUILTIN_DIR, 'ip2region_v6.xdb')], 6);
}

/**
 * 归属地文本：本机 / 内网 等保留地址返回类别；公网地址返回“省份 城市 · 运营商”；无法识别返回 ''
 */
export function ipLoc(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  if (cache.has(s)) return cache.get(s);
  let out = reservedLabel(s);
  if (out == null) {
    load();
    out = '';
    try {
      let b = parseIPv4(s), db = state.v4;
      if (!b) { const b6 = parseIPv6(s); const v4 = b6 && mappedV4(b6); if (v4) b = v4; else { b = b6; db = state.v6; } }
      if (b && db) out = formatRegion(db.search(b));
    } catch { out = ''; }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(s, out);
  return out;
}

/** 库状态（系统管理 → 安全与审计） */
export function ipLocInfo() {
  load();
  const d = db => (db ? { file: db.file.startsWith(BUILTIN_DIR) ? `内置 geo/${path.basename(db.file)}` : db.file, builtin: db.file.startsWith(BUILTIN_DIR), createdAt: db.createdAt, size: db.size } : null);
  return { v4: d(state.v4), v6: d(state.v6), errors: state.errors.slice(0, 5) };
}
