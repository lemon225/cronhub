'use strict';
/*
 * 二维码：服务端生成，不外发第三方。
 *
 * 之前用的是 `api.qrserver.com`：把手机号授权链接整串塞进 URL query 发给第三方，
 * 等于把「谁的授权链接、什么时候生成」白送给一个陌生域名（官方文档 6.2 明确要求去掉）。
 * 现在改为本地编码 + 内联 SVG，链接不出服务器。
 *
 * 编码器本体是 vendor 进来的单文件实现（lib/vendor/qrcode.js，MIT，Kazuhiko Arase），
 * 只在本进程内 require，不引入运行时依赖。
 */

const qrcode = require('./vendor/qrcode');

const DEFAULT_SIZE = 200;
const DEFAULT_MARGIN = 4;   // 静区（quiet zone）：QR 规范要求至少 4 个模块，少了扫不出

/**
 * 生成 SVG 字符串。
 * @param {string} text 要编码的内容（授权链接）
 * @param {{size?:number, margin?:number, ecc?:'L'|'M'|'Q'|'H'}} [opts]
 */
function toSvg(text, opts = {}) {
  const content = String(text || '');
  if (!content) throw new Error('二维码内容为空');

  const size = Math.max(64, Math.min(1024, Number(opts.size) || DEFAULT_SIZE));
  const margin = opts.margin === 0 ? 0 : (Number(opts.margin) || DEFAULT_MARGIN);
  const ecc = ['L', 'M', 'Q', 'H'].includes(opts.ecc) ? opts.ecc : 'M';

  // typeNumber=0：按内容长度自动选版本，链接变长也不会截断
  const q = qrcode(0, ecc);
  q.addData(content);
  q.make();

  const count = q.getModuleCount();
  /*
   * 每个模块取整数像素：非整数缩放会让模块边界落在半个像素上，
   * 打印或低分辨率屏上容易出现灰边，某些扫码器会判成噪声。
   */
  const scale = Math.max(1, Math.floor(size / (count + margin * 2)));
  const px = (count + margin * 2) * scale;

  let path = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!q.isDark(r, c)) continue;
      const x = (c + margin) * scale;
      const y = (r + margin) * scale;
      path += `M${x} ${y}h${scale}v${scale}h-${scale}z`;
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px
    + '" viewBox="0 0 ' + px + ' ' + px + '" shape-rendering="crispEdges" role="img" aria-label="授权二维码">'
    + '<rect width="' + px + '" height="' + px + '" fill="#ffffff"/>'
    + '<path d="' + path + '" fill="#000000"/>'
    + '</svg>';
}

/** 同 toSvg，但包成 data: URI，前端可直接塞进 <img src> */
function toDataUrl(text, opts) {
  return 'data:image/svg+xml;base64,' + Buffer.from(toSvg(text, opts), 'utf8').toString('base64');
}

module.exports = { toSvg, toDataUrl };
