(function (global) {
  'use strict';

  /**
   * 二维码渲染适配层 —— 把 vendor 编码器的具体 API 关在这一个文件里。
   *
   * 为什么要有这一层：`src/renderer/vendor/qrcode.js` 是第三方压缩产物
   * （qrcode-generator 1.4.4，MIT，Kazuhiko Arase），它的 `qrcode(typeNumber, ecLevel)`
   * → `addData()` → `make()` → `createDataURL()` 这套调用样式只在这里出现一次；
   * 将来换实现（或换成 Web API）只需要改本文件，调用方（设置页网络面板）不动。
   *
   * 🔴 三条硬约束（调用方也要守，见 ui-shell.js 的 renderWebQr）：
   *   1. 载荷必须是**与「点击复制」逐字符相同**的那串（同一个 state.webUrl），
   *      否则会出现「扫码装不上、复制却能用」；
   *   2. 状态不当（服务未开启 / 未就绪 / 地址为空）时**不画码** —— 旧码会指向一个已关闭的服务；
   *   3. 载荷里**绝不含访问密码**。
   *
   * 渲染方式用 `createDataURL()` 拿 data URI 塞进 `<img>`：不 innerHTML 任何生成型字符串
   * （避开注入面），尺寸交给 CSS 控，也天然适配 DPR。
   */

  /** 编码器暴露的全局（vendor 文件顶层是 `var qrcode = …`，普通 <script> 下即 window.qrcode） */
  function encoder() {
    return typeof global.qrcode === 'function' ? global.qrcode : null;
  }

  /**
   * 🔴 把 vendor 的字符串→字节转换器换成它自带的 UTF-8 实现（只需一次）。
   *
   * 不换会怎样：库的默认实现是 `charCodeAt(i) & 0xff` —— **凡是 U+00FF 以上的字符
   * 都会被静默截断成单字节**（「可」= U+53EF → 一个 0xEF 字节，而 UTF-8 需要 3 字节）。
   * 后果是二维码**画得完全正常、结构也合法**，但扫出来是一串乱码。
   * 也就是「像二维码」但不等于「扫得出来」—— 本项目最忌讳的那类静默失效。
   *
   * 换法是库自己的扩展点（`stringToBytesFuncs` 就是为这个准备的，且它默认把
   * `qrcode.stringToBytes` 指向 default 那一份）。渲染端只有本适配层用它，
   * 所以全局改这一处的副作用面为零；一旦换了编码器实现，这段要跟着重来。
   */
  function ensureUtf8() {
    var qr = encoder();
    if (!qr || !qr.stringToBytesFuncs) return;
    var utf8 = qr.stringToBytesFuncs['UTF-8'];
    if (typeof utf8 === 'function' && qr.stringToBytes !== utf8) qr.stringToBytes = utf8;
  }

  /**
   * @param {string} text 要编码的内容
   * @param {{cellSize?:number, margin?:number, ecLevel?:string}} [options]
   * @returns {string} data URI；编码器不可用 / 内容为空 / 编码失败时返回空串（调用方据此不画码）
   */
  function createDataUrl(text, options) {
    var o = options || {};
    var qr = encoder();
    if (!qr) return '';
    var payload = String(text == null ? '' : text);
    if (!payload) return '';
    ensureUtf8();
    var cellSize = o.cellSize || 4;
    // 🔴 静区（quiet zone）**不能**按「几个像素」随意给：QR 规范要求四周各留 4 个模块，
    // 换算成像素即 cellSize * 4。库的默认值正是这个（createDataURL 里 `cellSize * 4`），
    // 一旦显式传个小数字（早先这里给过 2）就等于把静区压成 2px，
    // 低端手机摄像头会因为找不到码的边界而扫不出 —— 而且它「看起来完全正常」，
    // 只有真机扫才知道坏了。所以这里只在调用方明确要求时才覆盖。
    var margin = o.margin == null ? cellSize * 4 : o.margin;
    try {
      // typeNumber 0 = 按内容长度自动选版本
      var q = qr(0, o.ecLevel || 'M');
      q.addData(payload);
      q.make();
      return q.createDataURL(cellSize, margin);
    } catch (e) {
      // 内容超出容量（>2953 字节）或编码器异常：返回空串，由调用方决定显示什么，
      // 绝不返回一个「画出来但扫不出来」的码。
      return '';
    }
  }

  global.RendererQrCode = {
    createDataUrl: createDataUrl,
  };
})(typeof window !== 'undefined' ? window : this);
