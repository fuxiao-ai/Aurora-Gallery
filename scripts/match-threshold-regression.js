'use strict';
// 搜图「匹配设置」里的阈值输入框（设置 → 后台任务 → 搜图索引 → 匹配设置）。
//
// 这一块是假 DOM 的控制器测试，不测浏览器布局。要钉住的是「框里打的字」到
// 「写进设置的值」之间那段换算，因为它的每一条都反直觉：
//   - 空框 ≠ 0：0 是有意义的一档（不过滤），清空输入框的意思通常是「我不想管它」，
//     所以空与非法都回落到**默认值**，而不是顺手当成 0；
//   - 越界不报错：1 会被夹成上限，-5 会被夹成 0；
//   - 框里显示的永远等于真正生效的值，否则「填了 1」会留在框里造成已生效的假象。
// 常量只有一处定义（src/ai/index-store.js 的 MATCH_THRESHOLD_RANGE），面板里那份
// 由 scripts/semantic-regression.js 解析比对；这里断言的是行为，不是数字。
// ⚠️ 所以下面三个取值也必须**从唯一定义处派生**，不能在脚本里再写一遍数字：
//    2026-10-07 默认值两次往返（0.01→0.02→0.01）时，写死的 `DEFAULT = 0.02`
//    正是靠「读到真值之前就带默认值」这条用例把守护打红的 —— 守护跟着实现漂移，
//    就等于没守护，而且它还会把人引向「改数字让它变绿」这条错路。
const assert = require('node:assert/strict');
const { MATCH_THRESHOLD_RANGE } = require('../src/ai/index-store');
const DEFAULT = MATCH_THRESHOLD_RANGE.default;
const MAX = MATCH_THRESHOLD_RANGE.max;

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
// 一个「在范围内、且**故意不等于默认值**」的取值。
// 下面有几条用例要测的是「输入了另一个值 → 写库」，一旦这个值和 DEFAULT 相等，
// 它们就退化成「值没变不重复写库」，断言以 `writes: []` 的形式失败 —— 2026-10-07
// 默认值两次往返时，写死的 `'0.02'` 正是这么把守护打红的。
// 所以这里不仅用常量，还要**显式保证 ≠ DEFAULT**：默认值哪天真的挪到 0.015，
// 这些用例也不会因此静默退化成空断言。
const OTHER = DEFAULT === 0.015 ? 0.02 : 0.015;
// 嵌板 open() 会起一个 2.5s 的状态轮询；不 hide 的话 setInterval 会吊住整个进程。
const mounted = [];

/**
 * 挂一个「设置页嵌板」，并**带上 tag 层那一节**（`tagLayer` 钩子）。
 *
 * 为什么放在这个文件里：假 DOM 挂载器在这一份里已经建好了，而新加的
 * 「标签展示线」输入框（`aiTagDisplayInput`）与这里的阈值输入框是**同一套换算规则**
 * （空/非法回落默认值、越界夹取、框里显示的永远等于真正生效的值），
 * 再抄一份挂载器只会让两边各自漂。
 */
function mountTagPanel(tagRead) {
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
        return { ready: true, indexed: 4, running: false, phase: 'complete' };
      return {};
    },
    thumbnail: () => 'thumb://x',
    preview: () => {},
    tagLayer: {
      read: () => Promise.resolve(tagRead),
      // 面板约定：**部分更新**，只写被改的那一个键。
      write: (patch) => {
        writes.push(patch);
        return Promise.resolve();
      },
    },
  });
  panel.show();
  mounted.push(panel);
  const view = container.children[0];
  const byId = (id) => view.all().find((item) => item.id === id);
  return {
    panel,
    view,
    writes,
    toggle: byId('aiTagLayerToggle'),
    threshold: byId('aiTagThresholdInput'),
    display: byId('aiTagDisplayInput'),
    resets: view.all().filter((item) => item.className === 'ai-tune-reset'),
    /** 展示线的那个「恢复默认」按钮（与阈值那个同类名，按顺序取后一个）。 */
    get displayReset() {
      return this.resets[this.resets.length - 1];
    },
  };
}

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
        return { ready: true, indexed: 4, running: false, phase: 'complete' };
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
      ui.input.value = String(OTHER);
      ui.input.listeners.change();
      await settle();
      assert.deepEqual(ui.writes, [OTHER], '改完值写回设置');
      assert.equal(typeof ui.writes[0], 'number', '写回的是数字，不是字符串');
      assert.equal(ui.input.value, String(OTHER), '框里显示的等于真正生效的值');
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
    // 挂载值用 OTHER（≠ DEFAULT）：否则「回落到默认值」写出来的数与当前生效值相同，
    // 会被「值没变不重复写库」挡住，这条用例就白跑了。
    for (const raw of ['', '   ', 'abc', '0.0.1', '--']) {
      const ui = mountPanel(OTHER);
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
            return { ready: true, indexed: 4, running: false, phase: 'complete' };
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

    // ================================================================
    // 标签展示线（设置 → AI 与索引 → 标签检索层 的第三行；2026-10-09 起可调）
    //
    // 用户原话是「设置可调，调了怎么生效」。**生效**那一半由
    // `tag-nav-regression`（主进程读侧现取 + 渲染层缓存失效）与
    // `tag-fusion-regression`（跨端镜像）钉；这里钉的是**面板这一端**：
    // 框里打的字 → 写进设置的值，以及它与「标签检索层开关」的关系。
    // ================================================================
    {
      const { TAG_DISPLAY_RANGE, STORE_MIN_SCORE, TAG_ROUTE_THRESHOLD } = require('../src/ai/tag-index-store');
      const D_DEFAULT = TAG_DISPLAY_RANGE.default;
      const D_OTHER = TAG_DISPLAY_RANGE.default === 0.45 ? 0.4 : 0.45;
      const readAll = (tagDisplayThreshold) => ({
        tagEnabled: true,
        tagThreshold: TAG_ROUTE_THRESHOLD,
        tagDisplayThreshold,
      });

      // ---------- 形态：三个控件都在，且上下界就是那两条硬约束 ----------
      {
        const ui = mountTagPanel(readAll(D_DEFAULT));
        await settle();
        assert.ok(ui.toggle, '标签检索层开关不见了');
        assert.ok(ui.threshold, '标签查询线输入框不见了');
        assert.ok(ui.display, '标签展示线输入框不见了');
        assert.equal(ui.display.type, 'number', '展示线用数字输入框（与查询线同款）');
        // ⚠️ 期望值**从唯一定义处派生**，不写数字：面板里那份镜像如果漂了，
        //    这条会红（比纯文本比对更硬 —— 那是「界面上能选到什么」的事实）。
        assert.equal(ui.display.min, String(STORE_MIN_SCORE), '下界 = 入库线（低于它的行库里根本不存在）');
        assert.equal(ui.display.max, String(TAG_ROUTE_THRESHOLD), '上界 = 查询线（高过它 = 导航比搜索还严）');
        assert.equal(ui.display.step, String(TAG_DISPLAY_RANGE.step), '步长来自唯一定义处');
        assert.equal(ui.display.autocomplete, undefined, '不需要自动填充');
      }

      // ---------- 读到的真值要回填（否则用户会以为「设置没保存」） ----------
      {
        const ui = mountTagPanel(readAll(D_OTHER));
        await settle();
        assert.equal(ui.display.value, String(D_OTHER), '打开面板要显示当前生效的展示线');
        assert.deepEqual(ui.writes, [], '回填不是写入');
      }

      // ---------- 读不回来（老版本 / 读取失败）时框里也不是空的 ----------
      {
        const ui = mountTagPanel(null);
        await settle();
        assert.equal(ui.display.value, String(D_DEFAULT), '读到真值之前就带默认值');
        assert.deepEqual(ui.writes, [], '只是显示默认值，不许顺手写库');
      }

      // ---------- 正常填写：部分更新，只带这一个键 ----------
      {
        const ui = mountTagPanel(readAll(D_DEFAULT));
        await settle();
        ui.display.value = String(D_OTHER);
        ui.display.listeners.change();
        await settle();
        assert.deepEqual(
          ui.writes,
          [{ tagDisplayThreshold: D_OTHER }],
          '写库必须是**部分更新**（只带 tagDisplayThreshold）：带上 tagEnabled/tagThreshold 会把' +
            '用户没动过的那两项按界面旧值覆盖回去',
        );
        assert.equal(typeof ui.writes[0].tagDisplayThreshold, 'number', '写回的是数字，不是字符串');
        assert.equal(ui.display.value, String(D_OTHER), '框里显示的等于真正生效的值');
      }

      // ---------- 空框 / 非法输入 → 回落默认值（不是最低档） ----------
      // 挂载值用 D_OTHER（≠ 默认值），否则「回落默认值」写出的数与当前生效值相同，
      // 会被「值没变不重复写库」挡住，用例白跑。
      for (const raw of ['', '   ', 'abc', '0.3.5', '--']) {
        const ui = mountTagPanel(readAll(D_OTHER));
        await settle();
        ui.display.value = raw;
        ui.display.listeners.change();
        await settle();
        assert.deepEqual(
          ui.writes,
          [{ tagDisplayThreshold: D_DEFAULT }],
          '「' + raw + '」应当回落到默认展示线：清空输入框的意思是「我不想管它」，' +
            '而 0.15（最低档）是「什么都放出来」的极端档，不是清空时想要的结果',
        );
      }

      // ---------- 越界夹回范围（不报错，也不把原文留在框里） ----------
      {
        const ui = mountTagPanel(readAll(D_DEFAULT));
        await settle();
        ui.display.value = '0.9';
        ui.display.listeners.change();
        await settle();
        assert.deepEqual(ui.writes, [{ tagDisplayThreshold: TAG_ROUTE_THRESHOLD }], '超过查询线要夹回上界');
        assert.equal(ui.display.value, String(TAG_ROUTE_THRESHOLD), '越界的原文不许留在框里造成假象');
        ui.display.value = '0.01';
        ui.display.listeners.change();
        await settle();
        assert.deepEqual(
          ui.writes,
          [{ tagDisplayThreshold: TAG_ROUTE_THRESHOLD }, { tagDisplayThreshold: STORE_MIN_SCORE }],
          '低于入库线要夹回下界（再往下没有一行数据，滑杆却让人以为还能更松）',
        );
      }

      // ---------- 值没变就不重复写库 ----------
      {
        const ui = mountTagPanel(readAll(D_DEFAULT));
        await settle();
        ui.display.value = String(D_DEFAULT);
        ui.display.listeners.change();
        await settle();
        assert.deepEqual(ui.writes, [], '填的和当前一致时不必打一次写请求');
      }

      // ---------- 「恢复默认」 ----------
      {
        const ui = mountTagPanel(readAll(D_OTHER));
        await settle();
        assert.ok(ui.displayReset, '展示线要有自己的「恢复默认」按钮');
        ui.displayReset.listeners.click();
        await settle();
        assert.deepEqual(ui.writes, [{ tagDisplayThreshold: D_DEFAULT }], '按钮把设置写回默认值');
        assert.equal(ui.display.value, String(D_DEFAULT), '框里同步显示默认值');
      }

      /**
       * ---------- 🔴 展示线**不随**标签检索层开关置灰 ----------
       *
       * 它管的是「标签导航页 / 照片信息面板显示哪些标签」，与「搜图走不走 tag 路」
       * 是两件事：关掉检索层之后用户照样在看标签页。跟着置灰会让人以为
       * 「关了检索，标签也就不显示了」，而实际照常显示。
       */
      {
        const ui = mountTagPanel(readAll(D_DEFAULT));
        await settle();
        assert.equal(!!ui.threshold.disabled, false, '默认（开关开）时查询线可用');
        ui.toggle.checked = false;
        ui.toggle.listeners.change();
        await settle();
        assert.equal(!!ui.threshold.disabled, true, '阳性对照：查询线确实会随开关置灰');
        assert.equal(
          !!ui.display.disabled,
          false,
          '展示线**必须仍然可用**：它不属于标签检索层（跟它一起置灰 = 用户以为关了检索标签也没了）',
        );
      }

      /**
       * ---------- 🔴 拨过开关之后，迟到的 read 仍要把展示线填上 ----------
       *
       * 面板的 read 回调里，开关/查询线那一段被 `tagTouched` 一票否决（用户拨过就不再回填）。
       * 展示线**必须有自己的分支**：并进去的后果是「先拨开关、再收到回包 ⇒ 展示线永远停在
       * 占位默认值」，而用户实际设的是别的数 —— 界面不报错，只是显示错。
       * 结构上由 `tag-fusion-regression` 钉，这里钉行为。
       */
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
              return { ready: true, indexed: 4, running: false, phase: 'complete' };
            return {};
          },
          thumbnail: () => '',
          preview: () => {},
          tagLayer: {
            read: () => new Promise((resolve) => (resolveRead = resolve)),
            write: (patch) => {
              writes.push(patch);
              return Promise.resolve();
            },
          },
        });
        panel.show();
        mounted.push(panel);
        const view = container.children[0];
        const byId = (id) => view.all().find((item) => item.id === id);
        const toggle = byId('aiTagLayerToggle');
        const display = byId('aiTagDisplayInput');
        assert.ok(toggle && display, 'tag 层控件没挂上');
        // 用户先动开关（把 `tagTouched` 置真），read 的回包还没到
        toggle.checked = false;
        toggle.listeners.change();
        await settle();
        assert.ok(writes.length >= 1, '拨开关要走一次写请求');
        resolveRead({ tagEnabled: false, tagThreshold: TAG_ROUTE_THRESHOLD, tagDisplayThreshold: D_OTHER });
        await settle();
        assert.equal(
          display.value,
          String(D_OTHER),
          '拨过开关之后迟到的 read 仍必须回填展示线 —— 并进 tagTouched 那段就是「永远停在 0.35」',
        );
        assert.equal(!!display.disabled, false, '开关关着也不影响展示线可用');
      }
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
