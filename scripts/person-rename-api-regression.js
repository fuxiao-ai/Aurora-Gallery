'use strict';
/**
 * 网页端人物改名接口（POST /api/person-rename）—— 直接打 handler 的契约回归。
 *
 * 为什么不走 HTTP：这条链路唯一的「新代码」就是 handler 自己（路由分发那行由
 * ai-web-views-regression 做静态断言），起一个真实 server + 登录态反而把断言
 * 稀释成「能不能连上」。这里用最小 req/res 替身直接调 handlePersonRename，
 * 把「只收 POST / payload 校验 / 落到 FaceService.run('rename') / 错误码」全部钉住。
 *
 * 真实性边界：FaceService 用替身（不碰真实人脸索引），因此本脚本只覆盖协议与校验，
 * 真正的落库读写由桌面端的 face-regression / 端到端验收覆盖。
 */
const assert = require('node:assert/strict');

const WebServer = require('../src/web-server');

function fakeReq(method, body) {
  const listeners = {};
  const req = {
    method,
    on(name, fn) {
      listeners[name] = fn;
      return req;
    },
  };
  process.nextTick(() => {
    if (listeners.data && body != null) listeners.data(body);
    if (listeners.end) listeners.end();
  });
  return req;
}

function fakeRes() {
  return {
    destroyed: false,
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status;
    },
    end() {},
  };
}

/** 只替掉 jsonResponse（其它方法/状态都走真实原型链），并把 FaceService 换成记录器。 */
function makeServer(opts = {}) {
  const server = Object.create(WebServer.prototype);
  server.jsonResponse = function (res, data, status) {
    res.status = status;
    res.payload = data;
  };
  server.runCalls = [];
  server.faceService =
    opts.faceService === undefined
      ? {
          run(op, args) {
            server.runCalls.push({ op, args });
            if (args.name === 'BOOM') return Promise.reject(new Error('FACE_PERSON_MISSING'));
            return Promise.resolve({});
          },
        }
      : opts.faceService;
  return server;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function call(server, method, payload) {
  const res = fakeRes();
  server.handlePersonRename(
    fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload)),
    res,
  );
  await flush();
  return res;
}

async function main() {
  // 只收 POST：GET 一律 405，且不得碰到 FaceService
  {
    const server = makeServer();
    const res = await call(server, 'GET');
    assert.equal(res.status, 405, 'GET 应当被拒');
    assert.equal(server.runCalls.length, 0, '被拒的请求不得触达 FaceService');
  }

  // payload 校验：坏 body / 非法 personId / 超长名字，全部 400 且不触达 FaceService
  {
    const server = makeServer();
    const badBodies = [
      ['非 JSON body', 'not-json'],
      ['personId 为 0', JSON.stringify({ personId: 0, name: 'x' })],
      ['personId 为负', JSON.stringify({ personId: -3, name: 'x' })],
      ['personId 非数字', JSON.stringify({ personId: 'abc', name: 'x' })],
      ['名字超过 80 字', JSON.stringify({ personId: 1, name: 'x'.repeat(81) })],
      ['name 不是字符串', JSON.stringify({ personId: 1, name: 42 })],
    ];
    for (const [label, body] of badBodies) {
      const res = fakeRes();
      server.handlePersonRename(fakeReq('POST', body), res);
      await flush();
      assert.equal(res.status, 400, label + ' → 应当 400');
      assert.equal(res.payload.error, 'FACE_NAME_INVALID', label + ' → 错误码');
    }
    assert.equal(server.runCalls.length, 0, '校验不过的请求不得触达 FaceService');
  }

  // 合法请求：落到 rename，名字被 trim，personId 转成数字
  {
    const server = makeServer();
    const res = await call(server, 'POST', { personId: '7', name: '  张三  ' });
    assert.equal(res.status, 200, '合法请求返回 200');
    assert.deepEqual(
      server.runCalls,
      [{ op: 'rename', args: { personId: 7, name: '张三' } }],
      'personId 转数字、名字 trim，且操作名就是 rename',
    );
  }

  // 空名字 = 取消命名，属于合法请求（与桌面端行为一致）
  {
    const server = makeServer();
    const res = await call(server, 'POST', { personId: 7, name: '   ' });
    assert.equal(res.status, 200, '清空名字是合法操作');
    assert.equal(server.runCalls[0].args.name, '', '空名字被规整为空串');
  }

  // 落库失败：把底层错误码透出去，前端才能翻成人话
  {
    const server = makeServer();
    const res = await call(server, 'POST', { personId: 7, name: 'BOOM' });
    assert.equal(res.status, 503, '落库失败返回 503');
    assert.equal(res.payload.error, 'FACE_PERSON_MISSING', '透出底层错误码');
  }

  // 未启用人脸功能
  {
    const server = makeServer({ faceService: null });
    const res = await call(server, 'POST', { personId: 1, name: 'x' });
    assert.equal(res.status, 503, '无 FaceService 返回 503');
    assert.equal(res.payload.error, 'FACE_UNAVAILABLE', '给出明确错误码');
  }

  // 路由确实把 /api/person-rename 指到了这个 handler
  {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../src/web-server.js'),
      'utf8',
    );
    assert.ok(src.includes("pathname === '/api/person-rename'"), '路由表里挂着 /api/person-rename');
    assert.ok(
      src.includes('this.handlePersonRename(req, res)'),
      '路由把请求转给 handlePersonRename',
    );
  }

  console.log('[person-rename-api-regression] PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
