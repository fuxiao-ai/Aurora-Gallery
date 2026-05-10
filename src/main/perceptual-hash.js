/**
 * 感知哈希（dHash）计算引擎
 * - 水平差值哈希：对压缩/亮度变化鲁棒
 * - 纯 JS + sharp，无需额外 native 依赖
 */

'use strict';

const sharp = require('sharp');

/**
 * 计算单张图片的 dHash
 * @param {string|Buffer} input 文件路径或 Buffer
 * @returns {Promise<string|null>} 16 位 hex 字符串，失败时返回 null
 */
async function computeDhash(input) {
  try {
    var raw = await sharp(input, { sequentialRead: true })
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();

    var hash = 0n;
    for (var row = 0; row < 8; row++) {
      for (var col = 0; col < 8; col++) {
        if (raw[row * 9 + col] > raw[row * 9 + col + 1]) {
          hash |= 1n << BigInt(row * 8 + col);
        }
      }
    }
    return hash.toString(16).padStart(16, '0');
  } catch (e) {
    return null;
  }
}

/**
 * 将 16 位 hex dHash 拆分为 16 个 4-bit bucket 值（用于 LSH 索引）
 * @param {string} dhash
 * @returns {number[]}
 */
function getDhashBuckets(dhash) {
  if (!dhash || dhash.length !== 16) return new Array(16).fill(0);
  var buckets = new Array(16);
  for (var i = 0; i < 16; i++) {
    buckets[i] = parseInt(dhash[i], 16);
  }
  return buckets;
}

// 预计算 16-bit POPCOUNT 查表（65536 项，约 64 KB）
var POPCOUNT16 = new Uint8Array(65536);
for (var i = 0; i < 65536; i++) {
  var n = i;
  var c = 0;
  while (n) {
    c++;
    n &= n - 1;
  }
  POPCOUNT16[i] = c;
}

/**
 * 计算两个 dHash 的汉明距离（查表法）
 * @param {string} hex1
 * @param {string} hex2
 * @returns {number} 0-64
 */
function hammingDistance(hex1, hex2) {
  return (
    POPCOUNT16[parseInt(hex1.slice(0, 4), 16) ^ parseInt(hex2.slice(0, 4), 16)] +
    POPCOUNT16[parseInt(hex1.slice(4, 8), 16) ^ parseInt(hex2.slice(4, 8), 16)] +
    POPCOUNT16[parseInt(hex1.slice(8, 12), 16) ^ parseInt(hex2.slice(8, 12), 16)] +
    POPCOUNT16[parseInt(hex1.slice(12, 16), 16) ^ parseInt(hex2.slice(12, 16), 16)]
  );
}

/**
 * 汉明距离（支持提前退出）
 * @param {string} hex1
 * @param {string} hex2
 * @param {number} maxDistance 超过此值则提前返回 >maxDistance 的累计值
 * @returns {number}
 */
function hammingDistanceEarlyExit(hex1, hex2, maxDistance) {
  var d = POPCOUNT16[parseInt(hex1.slice(0, 4), 16) ^ parseInt(hex2.slice(0, 4), 16)];
  if (d > maxDistance) return d;
  d += POPCOUNT16[parseInt(hex1.slice(4, 8), 16) ^ parseInt(hex2.slice(4, 8), 16)];
  if (d > maxDistance) return d;
  d += POPCOUNT16[parseInt(hex1.slice(8, 12), 16) ^ parseInt(hex2.slice(8, 12), 16)];
  if (d > maxDistance) return d;
  return d + POPCOUNT16[parseInt(hex1.slice(12, 16), 16) ^ parseInt(hex2.slice(12, 16), 16)];
}

module.exports = {
  computeDhash: computeDhash,
  getDhashBuckets: getDhashBuckets,
  hammingDistance: hammingDistance,
  hammingDistanceEarlyExit: hammingDistanceEarlyExit,
};
