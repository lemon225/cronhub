/*
 * 私网地址判定（纯函数，零依赖）。
 *
 * 从 server.js 里搬出来是因为脚本执行已经挪到 worker 线程，两处必须用同一套判据 ——
 * 复制一份到 worker 里迟早会分叉：改了主线程忘了 worker，脚本侧就成了绕过口。
 *
 * 只按字面 host 判断、不解析 DNS：不防 DNS 重绑定，也不追 302 跳转后的地址。
 * 定位是「防手滑填错 / 挡住最直白的探测」，不是完整的 SSRF 防御体系。
 */
'use strict';

const net = require('node:net');

function isPrivateHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  if (net.isIPv6(h)) {
    return h === '::1' || h === '::'
      || h.startsWith('fc') || h.startsWith('fd')          // fc00::/7 唯一本地
      || /^fe[89ab]/.test(h)                               // fe80::/10 链路本地
      || h.startsWith('::ffff:');                          // IPv4 映射
  }
  if (net.isIPv4(h)) {
    const p = h.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || (p[0] === 169 && p[1] === 254)                    // 含 169.254.169.254 元数据
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168)
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
      || (p[0] === 192 && p[1] === 0 && p[2] === 0)
      || (p[0] === 192 && p[1] === 0 && p[2] === 2)
      || (p[0] === 198 && (p[1] === 18 || p[1] === 19))
      || (p[0] === 198 && p[1] === 51 && p[2] === 100)
      || (p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  return false;
}

module.exports = { isPrivateHost };
