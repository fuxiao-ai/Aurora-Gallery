'use strict';

/**
 * `src/ai/ep-probe.onnx` 的**生成器与唯一真相源**。
 *
 * ## 为什么要有它，为什么模型不是「一个碰巧在包里的二进制」
 *
 * 产品的启动期 GPU 探测要真建一个 dml 会话（判据说明见 `src/main/gpu-probe.js`），
 * 那就需要一个**能被 dml 吃下的小模型**。把它当成一个来路不明的二进制放进仓库，
 * 会出现两个典型问题：① 没人知道它是什么图、改了没有；② 想换算子时无从下手。
 * 所以这里用**代码**把图描述出来，`scripts/gpu-probe-regression.js` 每次都会
 * **重新生成一遍并与磁盘文件逐字节比对** —— 改了生成器忘了重新生成、或者有人手工替换了
 * 那个 .onnx，守护当场变红。
 *
 * ## 图长什么样
 *
 * 单个 `Conv`：`float32[1,1,8,8] ⊛ float32[1,1,3,3]` → `float32[1,1,6,6]`。
 * 挑 `Conv` 是因为它是 DirectML EP **必然实现**的算子：换成 `Identity` 这类，
 * 一个 DML 不支持的图也会建会话成功、然后把节点**静默回退 CPU** ⇒ 探测变成假阳性。
 * 核全 1、输入常数 0.5 ⇒ 每个输出分量都必须正好 **4.5**（worker 里就是这么校验的）。
 *
 * ## 为什么手写 protobuf 而不是装 `onnx`
 *
 * 这条链路要**离线、可复算、零依赖**（本文件只用到 Buffer）。代价是字段号必须照
 * `onnx.proto` 抄，不能按记忆写 —— 踩过的两处：`ModelProto.opset_import = 8`
 * （不是 2）、`TensorProto.name = 8`（不是 5）。写错时 ORT 报的是
 * 「Missing opset in the model」这种**指向别处**的错，很费时间。
 *
 * 用法:
 *   node scripts/ep-probe-model.js           # 写盘
 *   node scripts/ep-probe-model.js --check   # 只比对，不写（守护用）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'ai', 'ep-probe.onnx');

/** 与 `src/workers/gpu-probe-worker.js` 的 INPUT_VALUE / EXPECTED 同源，守护会比对两边。 */
const INPUT_VALUE = 0.5;
const EXPECTED = 4.5;
const INPUT_DIMS = [1, 1, 8, 8];
const OUTPUT_DIMS = [1, 1, 6, 6];

// ------------------------------------------------ 极简 protobuf 编码
function varint(n) {
  const out = [];
  let value = n;
  for (;;) {
    const byte = value & 0x7f;
    value >>>= 7;
    if (value) out.push(byte | 0x80);
    else {
      out.push(byte);
      return Buffer.from(out);
    }
  }
}

const tag = (field, wire) => varint((field << 3) | wire);
const vint = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
/** 长度前缀（wire type 2）。子消息、字符串、打包数组都走它。 */
const bytes = (field, payload) => Buffer.concat([tag(field, 2), varint(payload.length), payload]);
const str = (field, text) => bytes(field, Buffer.from(text, 'utf8'));
/** 变长整数（proto3 里 `repeated int64` 默认打包，所以这里统一写打包形式）。 */
const packedInts = (field, values) => bytes(field, Buffer.concat(values.map((v) => varint(v))));
const packedFloats = (field, values) => {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return bytes(field, buf);
};

// ------------------------------------------------ ONNX 各层（字段号照 onnx.proto）
function tensor(name, dims, floats, dataType = 1) {
  return Buffer.concat([
    packedInts(1, dims), // dims
    vint(2, dataType), // data_type = 1 (FLOAT)
    packedFloats(4, floats), // float_data（packed）
    str(8, name), // TensorProto.name = 8
  ]);
}
function tensorType(dims, elemType = 1) {
  const shape = Buffer.concat(dims.map((d) => bytes(1, vint(1, d)))); // dim { dim_value }
  const inner = Buffer.concat([vint(1, elemType), bytes(2, shape)]);
  return bytes(1, inner); // TypeProto.tensor_type
}
function valueInfo(name, dims, elemType = 1) {
  return Buffer.concat([str(1, name), bytes(2, tensorType(dims, elemType))]);
}
function node(opType, inputs, outputs, name) {
  return Buffer.concat([
    ...inputs.map((x) => str(1, x)),
    ...outputs.map((x) => str(2, x)),
    str(3, name),
    str(4, opType),
  ]);
}
function graph() {
  return Buffer.concat([
    bytes(1, node('Conv', ['x', 'w'], ['y'], 'conv')),
    str(2, 'ep_probe'),
    bytes(5, tensor('w', [1, 1, 3, 3], [1, 1, 1, 1, 1, 1, 1, 1, 1])),
    bytes(11, valueInfo('x', INPUT_DIMS)),
    bytes(12, valueInfo('y', OUTPUT_DIMS)),
  ]);
}
function model() {
  return Buffer.concat([
    vint(1, 7), // ir_version
    str(2, 'aurora-ep-probe'), // producer_name（审计用）
    bytes(8, vint(2, 17)), // opset_import { version: 17 }；字段号 8，不是 2
    bytes(7, graph()),
  ]);
}

function main() {
  const data = model();
  const check = process.argv.includes('--check');
  const relative = path.relative(ROOT, TARGET).replace(/\\/g, '/');
  if (check) {
    let current = null;
    try {
      current = fs.readFileSync(TARGET);
    } catch (_) {}
    if (current && current.equals(data)) {
      console.log('[' + relative + '] OK（' + data.length + ' B，与生成器逐字节一致）');
      return 0;
    }
    console.error(
      '[' +
        relative +
        '] 与生成器不一致' +
        (current ? '（磁盘 ' + current.length + ' B / 生成 ' + data.length + ' B）' : '（磁盘上没有这个文件）'),
    );
    return 1;
  }
  fs.writeFileSync(TARGET, data);
  console.log('wrote ' + relative + ' (' + data.length + ' bytes)');
  return 0;
}

module.exports = { buildModel: model, INPUT_VALUE, EXPECTED, INPUT_DIMS, OUTPUT_DIMS, TARGET };

if (require.main === module) process.exit(main());
