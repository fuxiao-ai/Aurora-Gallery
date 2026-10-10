'use strict';
// Controller lifecycle checks only; this does not test browser layout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
class Element {
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    if (this.listeners.close) this.listeners.close();
  }
  focus() {}
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.classList = { add() {} };
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
  find(text) {
    return this.children
      .flatMap((item) => [item, ...item.all()])
      .find((item) => item.textContent === text);
  }
  all() {
    return this.children.flatMap((item) => [item, ...item.all()]);
  }
}
const body = new Element('body'),
  container = new Element('main');
body.append(container);
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
require('../src/web/js/people');
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function run() {
  let active = true,
    previewed = false,
    resolvePhotos;
  const page = global.window.PeopleUI.mount({
    manage: true,
    browseOnly: true,
    container,
    isActive: () => active,
    preview: () => {
      previewed = true;
    },
    call: async (operation) => {
      if (operation === 'status')
        return { ready: true, indexed: 1, running: false, phase: 'complete' };
      if (operation === 'groups')
        return { items: [{ id: 1, name: 'Family', photoCount: 1, thumbnail: 'fixture' }] };
      if (operation === 'photos')
        return new Promise((resolve) => {
          resolvePhotos = resolve;
        });
      throw Error(operation);
    },
  });
  try {
    page.show();
    await settle();
    const view = container.children[0];
    assert.equal(view.tag, 'section', 'desktop uses an embedded page, not a modal');
    assert.equal(body.children.length, 1, 'no redundant topbar entry or body dialog');
    const family = view.find('Family');
    assert.equal(
      view.find('Build / update face index'),
      undefined,
      'browse page has no index controls',
    );
    assert.equal(
      view.find('Save recognition settings'),
      undefined,
      'browse page has no recognition form',
    );
    assert.ok(family);
    family.parent.listeners.click();
    await settle();
    active = false;
    page.hide();
    resolvePhotos({ items: [{ id: 2, faceId: 2, file_name: 'sample.jpg', thumbnail: 'fixture' }] });
    await settle();
    active = true;
    page.show();
    await settle();
    assert.ok(view.find('Family #1'), 'in-flight details survive navigation away and back');
    view.find('sample.jpg').parent.listeners.click();
    assert.equal(previewed, true);
    assert.equal(view.hidden, false, 'preview retains the underlying people page');
    view.find('All people').listeners.click();
    await settle();
    assert.ok(view.find('Family'));
    const settingsContainer = new Element('section');
    const operations = [];
    const settings = global.window.PeopleUI.mount({
      manage: true,
      settingsOnly: true,
      container: settingsContainer,
      isActive: () => true,
      call: async (operation) => {
        operations.push(operation);
        if (operation === 'status')
          return { ready: true, indexed: 1, running: false, phase: 'complete' };
        if (operation === 'settings') return { matchThreshold: 0.34, thumbnailFallback: false };
        throw Error(operation);
      },
    });
    try {
      settings.show();
      await settle();
      const panel = settingsContainer.children[0];
      assert.ok(panel.find('Build / update face index'));
      assert.ok(panel.find('Save recognition settings'));
      assert.equal(panel.find('Refresh people'), undefined);      // 零人物（下面 status 里没有 people 字段）：引导整格收起，不再输出解释。
      // 原先这里显示的是「索引已完成，但没有检测到可分组的人脸。请确认照片中有清晰的正脸，
      // 或到下方「识别设置」调整参数后重建索引。」——它把结果归因到用户照片质量，而
      // 「下方识别设置」当时还是个默认收起的 <details>，指路指不准，整句已删。
      // （那个折叠后来也一并取消了，见下方断言。）
      const guide = panel.children.find((item) => item.className === 'people-guide');
      assert.ok(guide, '设置面板保留引导节点');
      assert.equal(guide.textContent, '', '零人物时引导不再输出解释');
      assert.equal(guide.hidden, true, '零人物时引导整格收起（空文案不得留成空色条）');
      // 2026-10-05：识别设置独立成「AI 与索引」面板的一节，折叠理由（展开的表单比
      // 「后台任务」清单其它行高一个量级）随之消失，用户明确要求「不要存在设置项按钮
      // 隐藏」→ 折叠入口不得复活。下面三条一起看：既没有 <details>/<summary>，
      // 也要确认设置块本身还在（别把整块删掉来让断言通过）。
      assert.equal(
        panel.all().find((item) => item.tag === 'details'),
        undefined,
        '识别设置不得再折叠成 <details>（设置项要直接铺开）',
      );
      assert.equal(
        panel.all().find((item) => item.tag === 'summary'),
        undefined,
        '不得再有 summary 折叠入口',
      );
      assert.ok(
        panel
          .all()
          .find((item) => item.tag === 'section' && item.className === 'people-settings'),
        '识别设置块保留（只是不再折叠）',
      );
      // 铺开态下不能再依赖「用户展开」这个动作来加载：加载时机现由 refresh() 的状态
      // 回调负责（panel 模式下面板可见即加载）。这里刻意不做任何交互，直接读值 ——
      // 若忘了改触发点，下面的 groupingSelect / 阈值断言会在默认值上失败。
      // 归组方式：曾经是「标准 / 严格」两档预设，后来是「视觉聚类 / 按文件夹」，
      // 现在还多了「按目录分域聚类」—— 目录只当边界，域内照旧比对特征（见 docs/people-groups.md）。
      const groupingSelect = panel.all().find((item) => item.tag === 'select');
      assert.ok(groupingSelect, '识别设置里要有归组方式下拉');
      assert.deepEqual(
        groupingSelect.children.map((item) => item.value),
        ['cluster', 'scoped', 'folder'],
        '下拉必须提供 cluster、scoped 与 folder 三个取值',
      );
      // 阈值与文件夹层级是两个数字输入框，DOM 顺序固定：阈值在前、层级在后。
      const numbers = panel
        .all()
        .filter((item) => item.tag === 'input' && item.type === 'number');
      assert.equal(numbers.length, 2, '识别设置里要有阈值与文件夹层级两个数字输入框');
      const [thresholdInput, depthInput] = numbers;
      assert.equal(thresholdInput.value, '0.34', '读回阈值要落进输入框');
      // 阈值域随聚类算法一起变过：从 [0.15, 0.90] 收到 [0.10, 0.50]。
      // 上沿收到 0.50 是因为 Chinese Whispers 的阈值是**配对级**连边门槛，
      // 再高只会把每个人拆成一堆碎片（真库实测 0.50 时 3501 张脸被切成 103 组）。
      assert.equal(thresholdInput.min, '0.1');
      assert.equal(thresholdInput.max, '0.5');
      // 框里显示的必须等于真正生效的值：服务端给了域外值时按域夹紧后再显示，
      // 不能原样写进框里（否则界面写着一个并不会生效的数字）。
      assert.equal(global.window.PeopleUI.clampThreshold('0.9'), 0.5);
      assert.equal(global.window.PeopleUI.clampThreshold('0.02'), 0.1);
      assert.equal(depthInput.min, '1');
      assert.equal(depthInput.max, '4');
      // 夹具没给 groupingDepth：UI 必须回落默认值，而不是把 "undefined" 写进框里。
      assert.equal(depthInput.value, '1', '缺字段时层级回落到默认值');
      assert.equal(thresholdInput.parent.hidden, false, '视觉聚类下阈值可见');
      assert.equal(depthInput.parent.hidden, true, '视觉聚类下层级收起');
      // 切到「按文件夹」：阈值那一行要藏起来、层级那一行要露出来 —— 否则用户会在阈值上
      // 拧半天才发现这个模式根本不看阈值。
      groupingSelect.value = 'folder';
      groupingSelect.listeners.change();
      assert.equal(thresholdInput.parent.hidden, true, '按文件夹归组时阈值那一行要收起');
      assert.equal(depthInput.parent.hidden, false, '按文件夹归组时层级要露出来');
      // 「按目录分域聚类」要同时露出三样：阈值（域内要比特征）、层级（决定域的粒度）、
      // 以及域分组文本框（同一个人的照片散在多个目录时把它们圈进同一个域）。
      const domainsInput = panel.all().find((item) => item.tag === 'textarea');
      assert.ok(domainsInput, '识别设置里要有「域分组」文本框');
      assert.equal(domainsInput.value, '', '夹具缺 domainGroups 字段时文本框必须是空的，而不是 undefined');
      assert.equal(domainsInput.parent.hidden, true, '按文件夹归组不圈域（域分组要收起）');
      groupingSelect.value = 'scoped';
      groupingSelect.listeners.change();
      assert.equal(thresholdInput.parent.hidden, false, '分域聚类要用阈值（域内照旧比对特征）');
      assert.equal(depthInput.parent.hidden, false, '分域聚类要用层级（深度决定域的粒度）');
      assert.equal(domainsInput.parent.hidden, false, '分域聚类要露出域分组输入框');
      groupingSelect.value = 'folder';
      groupingSelect.listeners.change();
      assert.equal(domainsInput.parent.hidden, true, '切回按文件夹后域分组要收起');
      // 「重新归组」是让已有分组用上新设置的唯一入口（否则只能删库重跑 CNN），
      // 按钮与保存按钮同为设置面板的一等公民。文案从「按当前阈值」改成「按当前设置」，
      // 因为按文件夹归组时它用的不是阈值。
      assert.ok(panel.find('Regroup with current settings'), '设置面板要有重新归组入口');
      assert.ok(!operations.includes('groups'), 'settings never loads person groups');
    } finally {
      settings.hide();
    }
    // 正向对照：有可分组人物时引导必须给出人物数，证明确实只砍掉了「零人物」那一支，
    // 而不是把整条引导删掉。
    const okContainer = new Element('section');
    const okSettings = global.window.PeopleUI.mount({
      manage: true,
      settingsOnly: true,
      container: okContainer,
      isActive: () => true,
      call: async (operation) => {
        if (operation === 'status')
          return { ready: true, indexed: 5, running: false, phase: 'complete', people: 3 };
        if (operation === 'settings') return { matchThreshold: 0.35, thumbnailFallback: true };
        throw Error(operation);
      },
    });
    try {
      okSettings.show();
      await settle();
      const okGuide = okContainer.children[0].children.find(
        (item) => item.className === 'people-guide',
      );
      assert.match(okGuide.textContent, /3/, '有分组时引导要给出人物数');
      assert.equal(okGuide.hidden, false, '有分组时引导正常显示');
    } finally {
      okSettings.hide();
    }
    require('../src/web/js/semantic-search');
    const aiContainer = new Element('section');
    const ai = global.window.SemanticSearchUI.mount({
      manage: true,
      settingsOnly: true,
      container: aiContainer,
      isActive: () => true,
      call: async () => ({ ready: true, indexed: 2, running: false, phase: 'complete' }),
    });
    try {
      ai.show();
      await settle();
      assert.ok(aiContainer.find('Build / update index'));
      assert.equal(aiContainer.find('Search'), undefined, 'settings contains no query form');
    } finally {
      ai.hide();
    }
    global.window.SemanticSearchUI.mount({
      manage: true,
      openSettings() {},
      call: async () => ({ ready: true, indexed: 2, running: false }),
    });
    body.children.find((item) => item.id === 'semanticSearchButton').listeners.click();
    await settle();
    const search = body.children.find((item) => item.tag === 'dialog');
    try {
      assert.ok(search.find('Search'));
      assert.equal(
        search.find('Model and index settings'),
        undefined,
        'search dialog keeps no settings entry',
      );
      assert.equal(
        search.find('Build / update index'),
        undefined,
        'search contains no index controls',
      );
    } finally {
      search.close();
    }
    // 索引进行中：文案不得沿用 people-grid（否则会被压进一个 160px 网格列里逐字换行）。
    const mountLive = (container, status) =>
      global.window.PeopleUI.mount({
        manage: false,
        container,
        isActive: () => true,
        preview() {},
        call: async (operation) => {
          if (operation === 'status') return status();
          if (operation === 'groups') return { items: status().items };
          throw Error(operation);
        },
      });
    const emptyContainer = new Element('section');
    const empty = mountLive(emptyContainer, () => ({
      ready: true,
      indexed: 30,
      running: true,
      phase: 'indexing',
      people: 0,
      items: [],
    }));
    try {
      empty.show();
      await settle();
      const view = emptyContainer.children[0];
      const message = view.all().find((item) => item.className === 'people-message');
      assert.ok(message, '文案态必须切到 people-message 布局');
      assert.equal(
        view.all().some((item) => item.className === 'people-grid'),
        false,
        '文案态不得残留网格布局',
      );
      assert.ok(view.find('Detecting faces…'), '尚未识别到人物时给出索引提示');
    } finally {
      empty.hide();
    }
    // 索引进行中且已有人物：直接列出结果，而不是停在一句「索引处理中」。
    const liveContainer = new Element('section');
    let livePeople = 1;
    const live = mountLive(liveContainer, () => ({
      ready: true,
      indexed: 40,
      running: true,
      phase: 'indexing',
      people: livePeople,
      items: [{ id: 1, name: 'Family', photoCount: 3, thumbnail: 'fixture' }].concat(
        livePeople > 1 ? [{ id: 2, name: 'Friend', photoCount: 2, thumbnail: 'fixture' }] : [],
      ),
    }));
    try {
      live.show();
      await settle();
      await settle();
      const view = liveContainer.children[0];
      assert.ok(view.find('Family'), '索引进行中也要显示已识别人物');
      assert.ok(view.find('Indexing · 1 people'), '索引进行中给出实时结果提示条');
      // 人数变化后（下一次状态轮询）应自动增量拉取，无需等索引跑完。
      livePeople = 2;
      live.show();
      await settle();
      await settle();
      assert.ok(view.find('Friend'), '人物总数变化后自动追加新分组');
    } finally {
      live.hide();
    }
    // ---- 「索引是上一代识别器建的」必须能被界面说出来 ----
    // 这一组守的是本轮修的坑：库里 16155 条 v1（SFace）记录 + 3501 张脸仍在磁盘上，
    // 但 VERSION 一升、所有读路径都被 `s.version = ?` 挡掉，于是 faces / people / indexed
    // 一起归零 —— 与「从来没建过索引」在数字上**完全一样**。界面原先只会说「还没有建立索引」，
    // 用户看到的就是「人物索引全空了」。
    // ⚠️ 这件事只说**一遍**：由任务行的引导句承担。「识别设置」里曾并排放过一行「当前方案」
    // 和一行红框归因，三句讲同一件事、把表单推远 —— 已整块删除（见下方静态守护）。
    const staleStatus = () => ({
      ready: true,
      running: false,
      phase: 'complete',
      indexed: 0,
      faces: 0,
      people: 0,
      library: 1224615,
      recognizer: 'YuNet + InsightFace w600k_mbf (512-d) + Chinese Whispers',
      version: 'yunet2023-insightface-w600kmbf-align112-refine-v3',
      staleScans: 16155,
      staleVersions: [
        { version: 'yunet2023-sface2021-align112-v1', label: 'OpenCV SFace (128-d)', scans: 16155 },
      ],
      items: [],
    });
    const mountSettings = (container, status) =>
      global.window.PeopleUI.mount({
        manage: true,
        settingsOnly: true,
        container,
        isActive: () => true,
        call: async (operation) => {
          if (operation === 'status') return status();
          if (operation === 'settings') return { matchThreshold: 0.3, thumbnailFallback: true };
          throw Error(operation);
        },
      });
    /** stateLine 没有类名（就是裸 <p>），只能按内容找 —— 覆盖率那句以 "Indexed" 开头。 */
    const findStateLine = (panel) =>
      panel.all().find((item) => item.tag === 'p' && /Indexed/.test(item.textContent || ''));
    const staleContainer = new Element('section');
    const staleSettings = mountSettings(staleContainer, staleStatus);
    try {
      staleSettings.show();
      await settle();
      const panel = staleContainer.children[0];
      const staleGuide = panel.children.find((item) => item.className === 'people-guide');
      assert.match(
        staleGuide.textContent,
        /OpenCV SFace/,
        '引导要说清「索引是上一代识别器建的」，不能只说「还没有建立索引」',
      );
      assert.match(staleGuide.textContent, /不兼容|incompatible/, '引导要点明「与当前识别器不兼容」');
      assert.match(staleGuide.textContent, /重建|rebuild/i, '引导要给下一步动作（重建）');
      assert.equal(staleGuide.hidden, false, '这条引导必须显示 —— 它就是「人物页为什么是空的」的答案');
      // 识别设置里不得再有说明行：那两句与上面的引导讲的是同一件事，用户已明确要求去掉。
      assert.equal(
        panel.all().find((item) => item.className === 'people-scheme'),
        undefined,
        '识别设置里不得再出现「当前方案」说明行',
      );
      assert.equal(
        panel.all().find((item) => item.className === 'people-stale-note'),
        undefined,
        '识别设置里不得再出现红框归因行（与引导重复）',
      );
      // 覆盖率要写成「已索引 / 全库」：只报一个「已索引 0」看不出索引根本没铺开
      // （本机真实数据是 16155 / 1224615 = 1.3%）。
      assert.match(findStateLine(panel).textContent, /Indexed 0 \/ 1\.2M/, '覆盖率要带分母');
    } finally {
      staleSettings.hide();
    }
    // 健康库：同样不得长出说明行 —— 这两行是按状态渲染的，旧记录清零后不该留下任何残留。
    const freshContainer = new Element('section');
    const freshSettings = mountSettings(freshContainer, () => ({
      ready: true,
      running: false,
      phase: 'complete',
      indexed: 40000,
      faces: 12000,
      people: 3,
      library: 100000,
      recognizer: 'YuNet + InsightFace w600k_mbf (512-d) + Chinese Whispers',
      version: 'yunet2023-insightface-w600kmbf-align112-refine-v3',
      staleScans: 0,
      staleVersions: [],
      items: [],
    }));
    try {
      freshSettings.show();
      await settle();
      const panel = freshContainer.children[0];
      assert.equal(
        panel.all().find((item) => item.className === 'people-scheme'),
        undefined,
        '健康库里同样不得有「当前方案」说明行',
      );
      assert.equal(
        panel.all().find((item) => item.className === 'people-stale-note'),
        undefined,
        '健康库里同样不得有归因行（避免新旧两态长得不一样）',
      );
      assert.match(findStateLine(panel).textContent, /40k \/ 100k/, '健康库同样要报覆盖率');
    } finally {
      freshSettings.hide();
    }
    // 空列表的话术：同样都是「0 个人物」，但「索引是上一代识别器建的」与「还没有识别到人物」
    // 指向的动作完全不同（重建 vs 等索引 / 怀疑照片）。
    const staleEmptyContainer = new Element('section');
    const staleEmpty = mountLive(staleEmptyContainer, () => ({ ...staleStatus(), running: false }));
    try {
      staleEmpty.show();
      await settle();
      await settle();
      await settle();
      // 文案挂在 .people-message 里的 .people-empty-title 上（外层只是个布局容器，
      // 直接读 .people-message 会拿到空串）。
      const message = staleEmptyContainer.children[0]
        .all()
        .find((item) => item.className === 'people-empty-title');
      assert.ok(message, '文案态必须渲染出空态标题');
      assert.match(
        message.textContent,
        /older recognizer/,
        '空列表要说「上一代识别器」而不是「还没有识别到人物」',
      );
    } finally {
      staleEmpty.hide();
    }
    // 静态守护：空引导必须真的不显示。.people-guide 自带 padding / 背景色 / 左边框，
    // 只把文案清空而不收起，会在设置页里留一条没有文字的空色条。
    const peopleCss = fs.readFileSync(path.join(__dirname, '../src/web/css/people.css'), 'utf8');
    assert.ok(
      /\.people-guide\[hidden\]\s*\{[^}]*display:\s*none/.test(peopleCss),
      '.people-guide[hidden] 必须显式 display:none（空引导不得留成空色条）',
    );
    // 静态守护：识别设置里那两行说明不得复活（用户要求从设置界面去掉：它们与上面的
    // 任务行引导讲同一件事，同一块面板读两遍只会把表单推远）。类名与样式一并清干净，
    // 否则残留的 CSS 会成为「加回去很容易」的邀请。
    assert.ok(
      !/people-scheme|people-stale-note/.test(peopleCss),
      'people.css 里不得再留 .people-scheme / .people-stale-note 规则',
    );
    // 反面：被删掉的那句解释不得复活（它把零结果归因到用户照片质量，指路的
    // 「下方识别设置」当时还是个默认收起的 <details>）。
    const peopleJs = fs.readFileSync(path.join(__dirname, '../src/web/js/people.js'), 'utf8');
    assert.equal(
      /没有检测到可分组的人脸|no groupable faces/.test(peopleJs),
      false,
      '零人物不得再输出归因于用户照片质量的解释',
    );
    assert.ok(
      !/people-scheme|people-stale-note/.test(peopleJs),
      'people.js 不得再渲染「当前方案」/「旧记录归因」行（识别设置里只留控件）',
    );
    // 静态守护：「归组方式」下拉不得与数值输入框共用固定宽度。它的选项是**整句文案**
    // （中文最长「按目录分域聚类（目录内比对特征）」16 字，英文 59 字符），早先与
    // 阈值 / 文件夹层级两个数值框挤在同一条 `width: 96px` 里 —— 实测最长选项中文只
    // 显示 4/16 字、英文 9/59 字符（英文渲染成「Visual clu▾」），不报错、不进日志，
    // 只有逐字比对才看得出来。数值框该窄、下拉该按内容自适应，两者必须拆开写。
    // （`min-width` 不算数：断言特意用 `(?:^|[;\s])width:` 把 `min-width` 排除在外，
    // 下拉与数值框的 min-width 保持一致是为了排版不参差。）
    const selectRule = peopleCss.match(/\.people-settings\s+select[^{}]*\{[^}]*\}/);
    assert.ok(selectRule, 'people.css 必须有独立的 `.people-settings select` 规则');
    assert.ok(
      /(?:^|[;\s])width:\s*auto/.test(selectRule[0]),
      '「归组方式」下拉必须按内容自适应（width: auto），否则整句选项被静默截断',
    );
    assert.ok(
      !/(?:^|[;\s])width:\s*96px/.test(selectRule[0]),
      '「归组方式」下拉不得退回 96px 固定宽度（选项最长中文 16 字 / 英文 59 字符）',
    );
    // PASS 放在最后：早先它打在这一段之前，后面还有语义搜索与上面的静态守护，
    // 一旦那些检查失败，日志里已经躺着一行 PASS，只看日志的人会被骗过去。
    console.log('[people-page-regression] PASS');
  } finally {
    page.hide();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
