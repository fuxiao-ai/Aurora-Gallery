'use strict';
// 搜图「匹配设置」里的阈值输入框（设置 → 后台任务 → 搜图索引 → 匹配设置）。
//
// 这一块是假 DOM 的控制器测试，不测浏览器布局。要钉住的是「框里打的字」到
// 「写进设置的值」之间那段换算，因为它的每一条都反直觉：
//   - 空框 ≠ 0：0 是有意义的一档（不过滤），清空输入框的意思通常是「我不想管它」，
//     所以空与非法都回落到默认值（0.01），而不是顺手当成 0；
//   - 越界不报错：1 会被夹成上限 0.03，-5 会被夹成 0；
//   - 框里显示的永远等于真正生效的值，否则「填了 1」会留在框里造成已生效的假象。
// 常量只有一处定义（src/ai/index-store.js 的 MATCH_THRESHOLD_RANGE），面板里那份
// 由 scripts/semantic-regression.js 解析比对；这里断言的是行为，不是数字。
const assert = require('node:assert/strict');

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get childElementCount() {
    return this.children.length;
  }
  append(...items) {
    for (const item of items) {
      item.parent = this;
      this.children.push(item);
    }
  }
  appendChild(item) {
    this.append(item);
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  removeAttribute(name) {
    delete this[name];
  }
  insertAdjacentElement(_where, item) {
    this.parent.append(item);
  }
  focus() {}
  // 浏览器语义：值被改过时先派发 change，再派发 blur —— 回车走的就是这条路。
  blur() {
    if (this.listeners.change) this.listeners.change();
    if (this.listeners.blur) this.listeners.blur();
  }
  close() {
    throw new Error('settings panel must not call close()');
  }
  showModal() {
    throw new Error('settings panel must not call showModal()');
  }
  find(text) {
    return this.all().find((item) => item.textContent === text);
  }
  all() {
    return this.children.flatMap((item) => [item, ...item.all()]);
  }
}

const body = new Element('body');
global.document = {
  body,
  documentElement: { lang: 'en' },
  createElement: (tag) => new Element(tag),
  getElementById: () => null,
};
global.window = {
  addEventListener() {},
  MutationObserver: class {
    observe() {}
  },
};
require('../src/web/js/semantic-search');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const DEFAULT = 0.01;
const MAX = 0.03;
// 嵌板 open() 会起一个 2.5s 的状态轮询；不 hide 的话 setInterval 会吊住整个进程。
const mounted = [];

/**
 * 挂一个「设置页嵌板」。readValue 可以是数字、'never'（读不回来）或 Promise。
 */
function mountPanel(readValue) {
  const container = new Element('main');
  body.append(container);
  const writes = [];
  let writeFails = false;
  const read =
    readValue === 'never'
      ? () => new Promise(() => {})
      : () => Promise.resolve(readValue == null ? DEFAULT : readValue);
  const panel = global.window.SemanticSearchUI.mount({
    settingsOnly: true,
    manage: true,
    container,
    isActive: () => true,
    call: async (operation) => {
      if (operation === 'status')
        return { ready: true, indexed: 4, busy: false, phase: 'complete' };
      return {};
    },
    thumbnail: () => 'thumb://x',
    preview: () => {},
    matchThreshold: {
      read,
      write: (value) => {
        writes.push(value);
        return writeFails ? Promise.reject(new Error('AI_BUSY')) : Promise.resolve();
      },
    },
  });
  panel.show();
  mounted.push(panel);
  const view = container.children[0];
  const find = (className) => view.all().find((item) => item.className === className);
  return {
    panel,
    view,
    writes,
    failNextWrite() {
      writeFails = true;
    },
    input: find('ai-tune-input'),
    reset: find('ai-tune-reset'),
    errorLine: find('ai-error'),
    note: find('ai-tune-note'),
  };
}

async function run() {
  // 断言挂掉时也必须把面板收干净：open() 起的 2.5s 轮询会吊住事件循环，
  // 否则「断言失败」会表现成「整个回归卡死」，比失败更难查。
  try {
    // ---------- 形态：输入框，不是滑杆 ----------
    {
      const ui = mountPanel(DEFAULT);
      await settle();
      const input = ui.input;
      assert.ok(input, '「匹配设置」里应当有一个阈值输入框');
      assert.equal(input.type, 'number', '阈值用数字输入框');
      assert.equal(
        ui.view.all().some((item) => item.type === 'range'),
        false,
        '滑杆必须已经拆掉（同一块里不允许两种输入并存）',
      );
      assert.equal(input.min, '0', '下限 0 = 不过滤');
      assert.equal(input.max, String(MAX), '上限来自唯一定义处');
      assert.equal(input.step, '0.001', '步进来自唯一定义处');
      assert.ok(ui.reset, '带一个「恢复默认」按钮');
    }

    // ---------- 默认值：读不到真值时框里也不是空的 ----------
    {
      const ui = mountPanel('never');
      await settle();
      assert.equal(ui.input.value, String(DEFAULT), '读到真值之前就带默认值');
      assert.equal(ui.input.placeholder, String(DEFAULT), 'placeholder 也是默认值，清空后仍有提示');
      assert.deepEqual(ui.writes, [], '只是显示默认值，不许顺手写库');
    }

    // ---------- 读到的真值要回填 ----------
    {
      const ui = mountPanel(0.015);
      await settle();
      assert.equal(ui.input.value, '0.015', '打开面板要显示当前生效的阈值');
      assert.deepEqual(ui.writes, [], '回填不是写入');
    }

    // ---------- 正常填写 ----------
    {
      const ui = mountPanel(DEFAULT);
      await settle();
      ui.input.value = '0.02';
      ui.input.listeners.change();
      await settle();
      assert.deepEqual(ui.writes, [0.02], '改完值写回设置');
      assert.equal(typeof ui.writes[0], 'number', '写回的是数字，不是字符串');
      assert.equal(ui.input.value, '0.02', '框里显示的等于真正生效的值');
    }

    // ---------- 0 是合法值，不是「默认」 ----------
    {
      const ui = mountPanel(DEFAULT);
      await settle();
      ui.input.value = '0';
      ui.input.listeners.change();
      await settle();
      assert.deepEqual(ui.writes, [0], '填 0 就是不过滤，不能被当成空框回落到默认值');
      assert.equal(ui.input.value, '0');
    }

    // ---------- 空框 / 非法输入 → 回到默认值 ----------
    for (const raw of ['', '   ', 'abc', '0.0.1', '--']) {
      const ui = mountPanel(0.02);
      await settle();
      ui.input.value = raw;
      ui.input.listeners.change();
      await settle();
      assert.deepEqual(ui.writes, [DEFAULT], '「' + raw + '」应当回落到默认值而不是 0');
      assert.equal(ui.input.value, String(DEFAULT), '框里回写成真正生效的值');
    }

    // ---------- 越界夹回范围（不报错，也不写出去） ----------
    {
      const ui = mountPanel(DEFAULT);
      await settle();
      ui.input.value = '1';
      ui.input.listeners.change();
      await settle();
      assert.deepEqual(ui.writes, [MAX], '超过上限要夹回上限');
      assert.equal(ui.input.value, String(MAX), '越界的原文不许留在框里造成假象');

      ui.input.value = '-5';
      ui.input.listeners.change();
      await settle();
      assert.deepEqual(ui.writes, [MAX, 0], '低于下限要夹回 0');
    }

    // ---------- 值没变就不重复写库 ----------
    {
      const ui = mountPanel(DEFAULT);
      await settle();
      ui.input.value = String(DEFAULT);
      ui.input.listeners.change();
      await settle();
      assert.deepEqual(ui.writes, [], '填的和当前一致时不必打一次写请求');
    }

    // ---------- 回车：失焦提交，且只提交一次 ----------
    {
      const ui = mountPanel(DEFAULT);
      await settle();
      ui.input.value = '0.025';
      let prevented = false;
      ui.input.listeners.keydown({
        key: 'Enter',
        preventDefault() {
          prevented = true;
        },
      });
      await settle();
      assert.equal(prevented, true, '回车不该触发浏览器默认行为');
      assert.deepEqual(ui.writes, [0.025], '回车提交且只提交一次');
      assert.equal(ui.input.value, '0.025');
    }

    // ---------- 「恢复默认」按钮 ----------
    {
      const ui = mountPanel(0.025);
      await settle();
      assert.equal(ui.input.value, '0.025');
      ui.reset.listeners.click();
      await settle();
      assert.deepEqual(ui.writes, [DEFAULT], '按钮把设置写回默认值');
      assert.equal(ui.input.value, String(DEFAULT), '框里同步显示默认值');
      ui.reset.listeners.click();
      await settle();
      assert.deepEqual(ui.writes, [DEFAULT], '已经是默认值时不重复写');
    }

    // ---------- 写库失败：回滚显示 + 报错 ----------
    {
      const ui = mountPanel(0.005);
      await settle();
      ui.failNextWrite();
      ui.input.value = '0.02';
      ui.input.listeners.change();
      await settle();
      assert.equal(ui.input.value, '0.005', '写库失败要把框里回滚到上一个生效值');
      assert.match(
        ui.errorLine.textContent,
        /请稍后再试|Try again shortly/,
        '失败要翻成人话，不是静默吞掉',
      );
      assert.equal(ui.errorLine.textContent.includes('AI_BUSY'), false, '别把裸错误码糊到界面上');
      // 回滚之后再改一次，还是要能写出去（不能因为上次失败就卡死）。
      ui.input.value = '0.02';
      ui.input.listeners.change();
      await settle();
      assert.deepEqual(ui.writes, [0.02, 0.02], '失败之后仍可重试');
    }

    // ---------- 迟到的 read 不许覆盖用户刚填的值 ----------
    {
      let resolveRead;
      const container = new Element('main');
      body.append(container);
      const writes = [];
      const panel = global.window.SemanticSearchUI.mount({
        settingsOnly: true,
        manage: true,
        container,
        isActive: () => true,
        call: async (operation) => {
          if (operation === 'status')
            return { ready: true, indexed: 4, busy: false, phase: 'complete' };
          return {};
        },
        thumbnail: () => '',
        preview: () => {},
        matchThreshold: {
          read: () => new Promise((resolve) => (resolveRead = resolve)),
          write: (value) => {
            writes.push(value);
            return Promise.resolve();
          },
        },
      });
      panel.show();
      mounted.push(panel);
      const view = container.children[0];
      const input = view.all().find((item) => item.className === 'ai-tune-input');
      input.value = '0.028';
      input.listeners.change();
      await settle();
      resolveRead(0.005);
      await settle();
      assert.equal(input.value, '0.028', '用户已经动过手，迟到的读取不许把它改回去');
      assert.deepEqual(writes, [0.028]);
    }

    console.log('[match-threshold-regression] PASS');
  } finally {
    mounted.forEach((panel) => panel.hide());
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
