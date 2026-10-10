'use strict';

/**
 * 文件摘要（查重指纹）的**两条入口**，共用同一个 SHA-256。
 *
 * 🔴 为什么它们必须住在同一个模块里：两条路写进的是**同一列** `photos.file_hash`，
 *    而「重复项」就是按这一列分组的。一旦两条路算出的摘要不同，成对的图片会被**静默**
 *    分到不同的组里 —— 不报错、不写日志，只是「重复项」莫名少了几对。所以它们共用同一段
 *    实现；而且这个模块**不依赖 electron**，回归脚本能真跑着比对两条路的输出。
 *    （历史上两者分别写在 `main.js` 里，require 不到 electron 就没法验，只能靠肉眼看代码。）
 *
 * 什么时候用哪条：
 * - `hashFileSha256(path)` —— **只有指纹要算**时的流式实现：内存是常数，支持取消与超时。
 * - `hashBufferSha256(buf)` —— 调用方**已经把文件读进内存**了（缩略图补全为了解码读过一遍），
 *   顺手算。喂进去的字节与流式那条完全一样 ⇒ 摘要逐字符相同，省掉同一份字节的第二次读盘。
 */

var fs = require('fs');
var crypto = require('crypto');

/** 大缓冲减少读系统调用；并发由 `runDuplicateHashDetection` 控制，避免机械盘一次性开太多流 */
var DUP_HASH_READ_BUFFER = 1024 * 1024;

/** 单文件哈希超时（毫秒），防止异常文件/设备导致任务长时间卡住不前 */
var DUP_HASH_FILE_TIMEOUT_MS = 90000;

/**
 * 流式算一个文件的 SHA-256。
 *
 * @param {string} filePath
 * @param {() => boolean} [shouldCancel] 每次拿到 chunk 时问一次；为真则中止并 reject
 * @returns {Promise<string>} 64 位 hex
 */
function hashFileSha256(filePath, shouldCancel) {
  return new Promise(function (resolve, reject) {
    var hash = crypto.createHash('sha256');
    var stream = fs.createReadStream(filePath, { highWaterMark: DUP_HASH_READ_BUFFER });
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try {
        stream.destroy(new Error('hash timeout'));
      } catch (e0) {
        void e0;
      }
      reject(new Error('hash timeout'));
    }, DUP_HASH_FILE_TIMEOUT_MS);
    function done(err, digest) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(digest);
    }
    stream.on('data', function (chunk) {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        try {
          stream.destroy(new Error('hash cancelled'));
        } catch (eStop) {
          void eStop;
        }
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', function (err) {
      done(err);
    });
    stream.on('end', function () {
      done(null, hash.digest('hex'));
    });
  });
}

/**
 * 对**已经在内存里的一份字节**算 SHA-256。
 *
 * 🔴 它和 `hashFileSha256(path)` 必须给出**完全相同**的摘要：喂给 `crypto` 的是同一段字节，
 *    SHA-256 是确定性函数 ⇒ 逐字符相同。两条路写进 `file_hash` 的值可以混着用。
 *    回归脚本对同一份内容两条路各算一次并逐字符比对。
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {string} 64 位 hex
 */
function hashBufferSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = {
  hashFileSha256: hashFileSha256,
  hashBufferSha256: hashBufferSha256,
  DUP_HASH_READ_BUFFER: DUP_HASH_READ_BUFFER,
  DUP_HASH_FILE_TIMEOUT_MS: DUP_HASH_FILE_TIMEOUT_MS,
};
