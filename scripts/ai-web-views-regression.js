'use strict';
/**
 * 网页端「搜图 / 人物」适配层（src/web/js/ai-views.js）的控制器行为回归。
 *
 * 改造后这一层是「侧栏独占」：
 *   - 搜图：侧栏（#aiSidebar）放搜索框 + 预选词（随机抽）+ 搜索历史，历史落本机 localStorage；
 *   - 人物：侧栏放人物列表（头像 + 名字 + 张数），点某个人才拉 TA 的照片；
 *   - 结果一律灌进主照片网格（#photoGrid），从而白送网页端既有的卡片渲染 /
 *     预览翻页 / 幻灯片 / 收藏 / 选择。
 *
 * 顶栏的 AI 搜索框、文件名搜索框、返回键都随改造退场，因此本回归里
 * 不再有 aiSearchBox / aiSearchForm / aiBackBtn / #headerStats 这些顶栏断言。
 * 这里用假的 DOM + 假的 renderPhotoGrid 断言「侧栏承载输入、结果落进网格」这条契约，
 * 不测浏览器布局（那部分由无头截图验收负责）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------- 极简 DOM 替身 ----------

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.textContent = '';
    this.className = '';
    this.attributes = {};
    this.hidden = false;
    this._classes = new Set();
    const self = this;
    this.classList = {
      add: (name) => self._classes.add(name),
      remove: (name) => self._classes.delete(name),
      contains: (name) => self._classes.has(name),
      toggle: (name, force) => {
        const has = self._classes.has(name);
        const want = force === undefined ? !has : !!force;
        if (want) self._classes.add(name);
        else self._classes.delete(name);
        return want;
      },
    };
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
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  // 与其它几个回归替身对齐（compare / match-threshold / people-page / search-page 都有）：
  // 预选词的加载态会在拿到词之后摘掉 `aria-busy`，缺这个方法会把「取到词」这条路径测崩。
  removeAttribute(name) {
    delete this.attributes[name];
  }
}

/** 主照片网格替身：innerHTML 写入时记下来即可 */
class Grid extends Element {
  constructor() {
    super('div');
    this.scrollTop = 0;
    this._html = '';
  }
  set innerHTML(value) {
    this._html = String(value);
  }
  get innerHTML() {
    return this._html;
  }
}

const slots = {};
function slot(selector) {
  if (!slots[selector]) slots[selector] = { textContent: '', style: {} };
  return slots[selector];
}
const setDisplay = (selector, value) => {
  slot(selector).style.display = value;
};

// ---------- 侧栏遍历工具 ----------

function walk(node, fn) {
  fn(node);
  for (const child of node.children || []) walk(child, fn);
}
function hasClass(node, cls) {
  return typeof node.className === 'string' && node.className.split(/\s+/).indexOf(cls) >= 0;
}
function findByClass(root, cls) {
  let found = null;
  walk(root, (node) => {
    if (!found && hasClass(node, cls)) found = node;
  });
  return found;
}
function findAllByClass(root, cls) {
  const out = [];
  walk(root, (node) => {
    if (hasClass(node, cls)) out.push(node);
  });
  return out;
}
function findByTag(root, tag) {
  let found = null;
  walk(root, (node) => {
    if (!found && node.tag === tag) found = node;
  });
  return found;
}
/** 递归拼出节点及其子孙的文本，模拟浏览器里的 textContent 聚合。 */
function deepText(node) {
  let out = node.textContent || '';
  for (const child of node.children || []) out += deepText(child);
  return out;
}

// ---------- 全局环境 ----------

global.document = {
  documentElement: { lang: 'zh-CN' },
  createElement: (tag) => new Element(tag),
};
// 搜索历史落在 localStorage：给一个内存实现，方便断言读写与上限。
// 适配层 IIFE 以 window 为 global，因此 localStorage 要挂在 window 上。
const store = {};
const localStorageMock = {
  getItem: (key) => (key in store ? store[key] : null),
  setItem: (key, value) => {
    store[key] = String(value);
  },
  removeItem: (key) => {
    delete store[key];
  },
};
global.window = { addEventListener() {}, localStorage: localStorageMock };

// ---------- 依赖替身 ----------

const grid = new Grid();
const sidebar = new Element('div');
const dom = {
  photoGrid: grid,
  headerTitle: new Element('div'),
  // 侧栏宿主：#aiSidebar 的替身，搜索框 / 历史 / 人物列表都渲染进这里。
  sidebar: sidebar,
};

let status = { ready: true, indexed: 4, busy: false, people: 0 };
let hits = [{ id: 7, file_name: 'hit.jpg', date_modified: '2026-01-02' }];
// 搜索响应里的「已索引张数」：真实服务端会带回，界面据它说明结果覆盖率。
let searchIndexed = null;
// 搜索响应里的「达标总数」：阈值制下它可能大于返回条数，界面必须按它显示而不是按卡片数。
let searchMatched = null;
const groupItems = [{ id: 1, name: 'Family', photoCount: 3, thumbnail: '/thumb/1' }];
const personPhotos = [{ id: 2, file_name: 'sample.jpg' }];
const gridBatches = [];

function get(url) {
  if (url.indexOf('/api/ai-search-status') === 0) return Promise.resolve({ ...status });
  if (url.indexOf('/api/ai-search?') === 0)
    return Promise.resolve({
      photos: hits.slice(),
      ...(searchMatched == null ? {} : { matched: searchMatched }),
      ...(searchIndexed == null ? {} : { indexed: searchIndexed }),
    });
  if (url.indexOf('/api/face-status') === 0) return Promise.resolve({ ...status });
  if (url.indexOf('/api/people?') === 0) return Promise.resolve({ items: groupItems.slice() });
  if (url.indexOf('/api/person-photos?') === 0)
    return Promise.resolve({ items: personPhotos.slice() });
  return Promise.reject(new Error('unexpected url ' + url));
}

// 改名是唯一的写操作：只走 POST /api/person-rename，且失败要能回滚。
const postCalls = [];
let renameFails = false;
/**
 * 「预选词」：新契约下界面**不带词表**，只发 `{ lang, limit }`；服务端从
 * `src/ai/search-vocabulary.js` 那份词表里按本库真实命中数排序取前 N 个回来。
 * 替身直接给一份排好序的名单 —— 界面上出现名单以外的词就说明它又在自己造词。
 */
const WORKBUDDY_SUGGEST = [
  { text: '人物肖像', hits: 84 },
  { text: '逆光', hits: 40 },
  { text: '棚拍', hits: 33 },
  { text: '双马尾', hits: 21 },
  { text: '粉色', hits: 17 },
  { text: '街拍', hits: 13 },
  { text: '蕾丝', hits: 9 },
  { text: '汉服', hits: 6 },
  { text: '小巷', hits: 4 },
  { text: '镜面反射', hits: 1 },
];
/** 最近一次预选词请求（用来核对「带语言、一要就是一批」）。 */
const suggestRequests = [];
/** 预选词接口改成失败（任务忙 / 超时 / 无索引），用来验证加载态能退出。 */
let suggestFails = false;
function post(url, payload) {
  postCalls.push({ url, payload });
  if (url.indexOf('/api/ai-search-suggest') === 0) {
    suggestRequests.push(payload || {});
    if (suggestFails) return Promise.reject(new Error('AI_TASK_BUSY'));
    return Promise.resolve({ sampled: 3000, terms: WORKBUDDY_SUGGEST });
  }
  if (renameFails) return Promise.reject(new Error('FACE_PERSON_MISSING'));
  return Promise.resolve({});
}
/** 改名请求（postCalls 里还混着搜图预选词的打分请求，断言要按接口过滤）。 */
const renameCalls = () => postCalls.filter((call) => call.url.indexOf('/api/person-rename') === 0);

const state = { currentView: 'all', currentPhotos: [] };

require('../src/web/js/ai-views');
const views = global.window.WebAiViews.init({
  state,
  dom,
  get,
  post,
  renderPhotoGrid: (photos) => {
    gridBatches.push(photos.length);
    grid.innerHTML =
      '<div class="grid">' +
      photos.map((photo) => '<div class="photo-card">' + photo.file_name + '</div>').join('') +
      '</div>';
  },
  escapeHtml: (value) => String(value == null ? '' : value),
  setDisplay,
});
views.bind();

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await settle();
}

async function run() {
  try {
    assert.equal(views.isShowing(), false, '尚未进入智能视图');

    // ---------- 搜图：引导态（输入搬到侧栏） ----------
    state.currentView = 'ai_search';
    views.enter('ai_search');
    assert.equal(views.isShowing(), true);
    assert.equal(views.isActive(), true);
    assert.ok(grid.innerHTML.includes('描述你想找的画面'), '搜图首屏是引导页');
    assert.equal(
      (grid.innerHTML.match(/class="ai-web-chip"/g) || []).length,
      5,
      '引导页给出 5 个示例词',
    );
    assert.equal(slot('#headerMediaFilterSelect').style.display, 'none');
    assert.equal(slot('#sortSelect').style.display, 'none');
    assert.equal(slot('#pagination').style.display, 'none');
    assert.equal(slot('#browseFooter').style.display, 'none', '智能视图收起整条页脚');

    // 侧栏独占：搜索框 + 搜索历史都在 #aiSidebar 里。
    const searchForm = findByClass(sidebar, 'ai-web-sidebar-search');
    assert.ok(searchForm, '侧栏里出现搜索表单');
    assert.ok(findByTag(searchForm, 'input'), '侧栏里有画面描述输入框');
    assert.equal(findAllByClass(sidebar, 'ai-web-history-item').length, 0, '初始没有搜索历史');
    const emptyHint = findByClass(sidebar, 'ai-web-sidebar-empty');
    assert.ok(emptyHint && emptyHint.textContent.includes('还没有搜索记录'), '空历史给出提示');

    // 顶栏的 AI 搜索框随改造退场：这里不再有这些元素。
    assert.equal(dom.aiSearchBox, undefined, '顶栏 AI 搜索框已移除');
    assert.equal(dom.aiBackBtn, undefined, '顶栏返回键已移除');

    await views.load();
    await flush();
    assert.ok(grid.innerHTML.includes('描述你想找的画面'), '状态就绪时不打断引导页');

    // ---------- 搜图：结果落进照片网格 ----------
    const input = findByTag(sidebar, 'input');
    input.value = 'a beach at sunset';
    searchForm.listeners.submit({ preventDefault() {} });
    await flush();
    assert.equal(state.currentPhotos.length, 1);
    assert.ok(gridBatches.includes(1), '结果复用 renderPhotoGrid 渲染照片卡');
    assert.ok(grid.innerHTML.includes('hit.jpg'));
    const sideStatus = findByClass(sidebar, 'ai-web-sidebar-status');
    assert.equal(sideStatus.textContent, '1 张达到匹配阈值 · 按相似度排序', '状态写进侧栏');
    // 预览窗口必须收成单页：否则翻页会去按页码拉浏览列表，把结果集冲掉。
    assert.equal(state.previewTotalPages, 1);
    assert.equal(state.previewPageStart, 1);
    assert.equal(state.previewTotalPhotos, 1);
    assert.equal(state.page, 1);

    // 搜索成功后写历史：去重、置顶、落 localStorage。
    const historyRows = findAllByClass(sidebar, 'ai-web-history-item');
    assert.equal(historyRows.length, 1, '搜索成功后历史里出现一条');
    assert.ok(
      findByClass(historyRows[0], 'ai-web-history-text').textContent.includes('a beach at sunset'),
    );
    assert.deepEqual(JSON.parse(store['photoManager.aiSearchHistory'] || '[]'), [
      'a beach at sunset',
    ]);
    // 同词再搜不会重复：历史回到一条。
    searchForm.listeners.submit({ preventDefault() {} });
    await flush();
    assert.equal(findAllByClass(sidebar, 'ai-web-history-item').length, 1, '同词去重');

    // 状态行的数字是「达标总数」而不是「返回条数」：阈值制下两者会分叉
    // （内部为内存起见只保留最相近的一批，见 MAX_RESULTS），所以文案必须跟 matched 走，
    // 否则用户看到的数字比卡片还少，像是丢图了。
    searchMatched = 1800;
    searchForm.listeners.submit({ preventDefault() {} });
    await flush();
    assert.ok(
      findByClass(sidebar, 'ai-web-sidebar-status').textContent.includes('1800 张达到匹配阈值'),
      '状态行报的是达标总数（matched），不是卡片数',
    );
    assert.equal(state.currentPhotos.length, 1, '卡片仍只有服务端真返回的那一张');
    searchMatched = null;

    // ---------- 搜图：空结果 ----------
    hits = [];
    input.value = 'nothing at all';
    searchForm.listeners.submit({ preventDefault() {} });
    await flush();
    assert.ok(grid.innerHTML.includes('没有达到匹配阈值的照片'));
    assert.equal(state.currentPhotos.length, 0);

    // ---------- 搜图：模型未就绪时只给一句人话 ----------
    status = { ready: false, indexed: 0, busy: false, people: 0 };
    hits = [{ id: 7, file_name: 'hit.jpg' }];
    views.enter('ai_search');
    await views.load();
    await flush();
    assert.ok(
      findByClass(sidebar, 'ai-web-sidebar-status').textContent.includes('本地模型尚未就绪'),
      '状态栏翻译成一句人话',
    );
    assert.ok(grid.innerHTML.includes('本地模型尚未就绪'), '引导页同样给出提醒');

    // ---------- 人物：侧栏列出人物，网格先给引导态 ----------
    status = { ready: true, indexed: 40, busy: false, people: 1 };
    state.currentView = 'people';
    views.enter('people');
    assert.ok(grid.innerHTML.includes('从左侧选择一个人'), '人物首屏是「从左侧选择」');
    assert.equal(state.currentPhotos.length, 0, '未选人前不拉任何照片');
    await views.load();
    await flush();
    const personRows = findAllByClass(sidebar, 'ai-web-people-item');
    assert.equal(personRows.length, 1, '侧栏列出 1 个人物');
    assert.ok(
      findByClass(personRows[0], 'ai-web-people-name').textContent.includes('Family'),
      '人物行带名字',
    );
    assert.ok(findByClass(personRows[0], 'ai-web-people-avatar'), '人物行带头像位');
    assert.equal(
      findByClass(personRows[0], 'ai-web-people-count').textContent,
      '3 张',
      '人物行带张数',
    );
    assert.equal(findByClass(sidebar, 'ai-web-sidebar-status').textContent, '1 人');
    assert.equal(state.currentPhotos.length, 0, '只列人物、不自动拉照片');
    assert.ok(grid.innerHTML.includes('从左侧选择一个人'), '网格仍停在引导态');

    // ---------- 人物：点某个人 → 该人的照片落进网格 ----------
    personRows[0].listeners.click.call(personRows[0]);
    await flush();
    assert.equal(state.currentPhotos.length, 1);
    assert.ok(grid.innerHTML.includes('sample.jpg'));
    assert.equal(state.previewTotalPages, 1);
    assert.ok(personRows[0].classList.contains('active'), '选中的人物高亮');
    assert.ok(
      findByClass(sidebar, 'ai-web-sidebar-status').textContent.includes('Family'),
      '侧栏状态切到该人物',
    );

    // 返回键随改造退场：适配层不再导出 back()。
    assert.equal(typeof views.back, 'undefined', '不再有返回键语义');

    // ---------- 人物：侧栏搜索只筛列表 ----------
    groupItems.length = 0;
    groupItems.push(
      { id: 1, name: 'Family', photoCount: 3, thumbnail: '/thumb/1' },
      { id: 2, name: 'Friends', photoCount: 2, thumbnail: '/thumb/2' },
      { id: 3, name: '', photoCount: 1, thumbnail: '' },
    );
    state.currentView = 'people';
    views.enter('people');
    await views.load();
    await flush();
    assert.equal(findAllByClass(sidebar, 'ai-web-people-item').length, 3, '默认列出全部人物');

    const peopleSearch = findByClass(sidebar, 'ai-web-people-search');
    assert.ok(peopleSearch, '人物侧栏出现搜索区');
    const peopleInput = findByTag(peopleSearch, 'input');
    assert.ok(peopleInput, '搜索区里是输入框');
    const typePeople = (value) => {
      peopleInput.value = value;
      peopleInput.listeners.input();
    };

    typePeople('friend');
    let filteredRows = findAllByClass(sidebar, 'ai-web-people-item');
    assert.equal(filteredRows.length, 1, '按名字过滤（大小写不敏感）');
    assert.ok(
      findByClass(filteredRows[0], 'ai-web-people-name').textContent.includes('Friends'),
      '留下的正是匹配的那一个',
    );

    typePeople('未命名');
    filteredRows = findAllByClass(sidebar, 'ai-web-people-item');
    assert.equal(filteredRows.length, 1, '搜「未命名」能捞到还没起名的人');
    assert.equal(filteredRows[0].getAttribute('data-person-id'), '3');

    typePeople('zzz');
    assert.equal(findAllByClass(sidebar, 'ai-web-people-item').length, 0, '无匹配时不渲染人物行');
    assert.ok(
      findByClass(sidebar, 'ai-web-sidebar-empty').textContent.includes('没有匹配的人物'),
      '无匹配时给出提示',
    );

    peopleInput.listeners.keydown({ key: 'Escape' });
    assert.equal(peopleInput.value, '', 'Esc 清空搜索词');
    assert.equal(findAllByClass(sidebar, 'ai-web-people-item').length, 3, '清空后恢复完整列表');

    // ---------- 人物：双击改名 ----------
    groupItems[0].name = 'Family'; // 上一步的改名断言会改数据源，这里先复位
    const familyRow = findAllByClass(sidebar, 'ai-web-people-item').find(
      (row) => row.getAttribute('data-person-id') === '1',
    );
    assert.equal(findByClass(familyRow, 'ai-web-people-name').textContent, 'Family');
    assert.ok(
      String(findByClass(familyRow, 'ai-web-people-name').title || '').includes('双击'),
      '名字上带「双击可改名」提示（行内编辑要能被发现）',
    );

    findByClass(familyRow, 'ai-web-people-name').listeners.dblclick({
      preventDefault() {},
      stopPropagation() {},
    });
    let editor = findByClass(familyRow, 'ai-web-people-rename');
    assert.ok(editor, '双击后名字位置换成输入框');
    assert.equal(editor.value, 'Family', '输入框预填当前名字');
    assert.ok(familyRow.classList.contains('is-renaming'), '行标记为改名中');

    // Esc 取消：不落库且还原
    editor.value = 'XX';
    editor.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    await flush();
    assert.equal(renameCalls().length, 0, 'Esc 取消不发改名请求');
    assert.equal(
      findByClass(familyRow, 'ai-web-people-name').textContent,
      'Family',
      'Esc 取消把名字还原',
    );

    // 回车保存（前后空格要被 trim）
    findByClass(familyRow, 'ai-web-people-name').listeners.dblclick({
      preventDefault() {},
      stopPropagation() {},
    });
    editor = findByClass(familyRow, 'ai-web-people-rename');
    editor.value = '  Kinfolk  ';
    editor.listeners.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await flush();
    assert.equal(renameCalls().length, 1, '回车触发一次改名请求');
    assert.equal(renameCalls()[0].url, '/api/person-rename', '打的是改名接口');
    assert.deepEqual(
      renameCalls()[0].payload,
      { personId: 1, name: 'Kinfolk' },
      'payload 只带 personId + trim 后的名字',
    );
    assert.equal(
      findByClass(familyRow, 'ai-web-people-name').textContent,
      'Kinfolk',
      '行内文本立刻更新（乐观更新）',
    );
    assert.ok(!familyRow.classList.contains('is-renaming'), '改名结束清掉行标记');

    // 落库失败 → 回滚 + 提示
    renameFails = true;
    findByClass(familyRow, 'ai-web-people-name').listeners.dblclick({
      preventDefault() {},
      stopPropagation() {},
    });
    editor = findByClass(familyRow, 'ai-web-people-rename');
    editor.value = 'Nope';
    editor.listeners.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await flush();
    assert.equal(renameCalls().length, 2, '失败那次也发过请求');
    assert.equal(
      findByClass(familyRow, 'ai-web-people-name').textContent,
      'Kinfolk',
      '落库失败必须回滚到上一个名字',
    );
    assert.ok(
      findByClass(sidebar, 'ai-web-sidebar-status').textContent.includes('FACE_PERSON_MISSING'),
      '侧栏给出失败提示',
    );
    renameFails = false;

    // 恢复成单人物，供后续「索引进行中」阶段使用
    groupItems.length = 0;
    groupItems.push({ id: 1, name: 'Family', photoCount: 3, thumbnail: '/thumb/1' });

    // ---------- 人物：索引进行中 → 侧栏实时条（不占用结果计数） ----------
    status = {
      ready: true,
      indexed: 3702,
      scanned: 12420,
      faces: 36,
      busy: true,
      phase: 'indexing',
      people: 1,
    };
    views.enter('people');
    await views.load();
    await flush();
    const liveBar = findByClass(sidebar, 'ai-web-live-bar');
    assert.ok(liveBar, '索引进行中在侧栏给出实时读数');
    assert.equal(liveBar.hidden, false, '实时读数可见');
    assert.equal(
      findByClass(liveBar, 'ai-web-live-text').textContent,
      '正在识别人脸',
      '标题只留状态，数字不再拼进同一句',
    );
    // 断言拆到「格」这一级：以前整句一个 textContent，折行会把「检出」拆成「检 / 出」两半、
    // 还在行首留下孤零零的「·」；只对整句做子串匹配是抓不住这类坏形态的。
    const statCells = findByClass(liveBar, 'ai-web-live-stats').children;
    assert.equal(statCells.length, 3, '三个指标各占一格（已扫描 / 检出人脸 / 人物）');
    const readStat = (i) => ({
      value: statCells[i].children[0].textContent,
      label: statCells[i].children[1].textContent,
      hidden: !!statCells[i].hidden,
    });
    assert.deepEqual(
      readStat(0),
      { value: '1.2万', label: '已扫描', hidden: false },
      '已扫描张数：大数压成万，数字在标签上方',
    );
    assert.deepEqual(
      readStat(1),
      { value: '36', label: '检出人脸', hidden: false },
      '已检出人脸数自成一格',
    );
    assert.deepEqual(
      readStat(2),
      { value: '1', label: '人物', hidden: false },
      '已识别人物数自成一格',
    );

    // 切界面语言后标签必须跟着变。setLocale 只认 data-i18n 属性、不会重跑这里，
    // 所以标签文字不能跟格子一起缓存 —— 缓存了就会一直停在旧语言那两个词上。
    global.document.documentElement.lang = 'en';
    await views.load();
    await flush();
    assert.equal(readStat(0).label, 'Scanned', '切英文后标签跟着变，不留在旧语言');
    assert.equal(readStat(1).label, 'Faces', '第二格同样跟着变');
    assert.equal(readStat(2).label, 'People', '第三格同样跟着变');
    assert.equal(readStat(0).value, '12k', '大数压法也按月语言切（1.2万 → 12k）');
    global.document.documentElement.lang = 'zh-CN';

    // ---------- 搜图：索引进行中允许搜，但要说清只覆盖已索引部分 ----------
    status = { ready: true, indexed: 12000, busy: true, phase: 'indexing', people: 0 };
    searchIndexed = 12000;
    hits = [{ id: 7, file_name: 'hit.jpg' }];
    state.currentView = 'ai_search';
    views.enter('ai_search');
    await views.load();
    await flush();
    assert.ok(grid.innerHTML.includes('现在就能搜'), '索引进行中不拦搜图，引导页说明这点');
    const partialInput = findByTag(sidebar, 'input');
    const partialForm = findByClass(sidebar, 'ai-web-sidebar-search');
    partialInput.value = 'a beach at sunset';
    partialForm.listeners.submit({ preventDefault() {} });
    await flush();
    const partialStatus = findByClass(sidebar, 'ai-web-sidebar-status');
    assert.ok(partialStatus.textContent.includes('1 张达到匹配阈值'), '索引进行中照样出结果');
    assert.ok(
      partialStatus.textContent.includes('仅基于已索引 1.2万 张'),
      '结果覆盖率如实说明，避免把「搜不到」误读成「没这张照片」',
    );
    searchIndexed = null;
    status = { ready: true, indexed: 40, busy: false, people: 1 };
    hits = [{ id: 7, file_name: 'hit.jpg' }];

    // ---------- 搜图：侧栏预选词（搜索框下方随机一组，点一下直接搜） ----------
    {
      const suggestBox = findByClass(sidebar, 'ai-web-sidebar-suggest');
      assert.ok(suggestBox, '搜索框下方存在预选词区域');
      const chips = findAllByClass(suggestBox, 'ai-web-chip');
      assert.equal(chips.length, 5, '预选词每次抽 5 个');
      const labels = chips.map((chip) => chip.textContent);
      assert.equal(new Set(labels).size, labels.length, '同一批预选词不得重复');
      assert.ok(
        labels.every((word) => word && word.trim()),
        '预选词都是非空文本',
      );
      assert.ok(
        deepText(suggestBox).includes('预选词'),
        '预选词区域带标题，不会让用户误以为是搜索历史',
      );
      // 词表与排序都在服务端，界面只发 `{ lang, limit }`、只摆服务端挑出来的词。
      assert.ok(suggestRequests.length >= 1, '进搜索视图会要一次预选词');
      assert.equal(suggestRequests[0].lang, 'zh-CN', '请求要带上界面语言（词表分中英两版）');
      assert.ok(suggestRequests[0].limit >= 5, '一次要多要几个当池子，供「换一批」本地洗牌');
      const allowed = new Set(WORKBUDDY_SUGGEST.map((term) => term.text));
      assert.ok(
        labels.every((word) => allowed.has(word)),
        '侧栏只摆服务端挑出来的词，界面不得自己造词：' + labels.join('/'),
      );
      const shuffle = findByClass(suggestBox, 'ai-web-sidebar-clear');
      assert.ok(shuffle, '预选词区域带「换一批」按钮');

      // 点第 2 个词：回填输入框 + 直接开搜 + 进历史
      const picked = labels[1];
      chips[1].listeners.click();
      await flush();
      assert.equal(findByTag(sidebar, 'input').value, picked, '点预选词回填搜索框');
      assert.equal(state.aiSearchQuery, picked, '点预选词直接发起搜索');
      assert.ok(
        findAllByClass(sidebar, 'ai-web-history-item').length >= 1,
        '点预选词搜过的词进搜索历史',
      );

      // 「换一批」：多次点击后必须出现过不同的一批（10 选 5 全同概率可忽略）
      const batchKey = () =>
        findAllByClass(suggestBox, 'ai-web-chip')
          .map((chip) => chip.textContent)
          .join('|');
      const seen = new Set([batchKey()]);
      for (let i = 0; i < 20 && seen.size < 2; i += 1) {
        shuffle.listeners.click();
        seen.add(batchKey());
      }
      assert.ok(seen.size >= 2, '「换一批」能换出不同的词（随机真的在起作用）');
      assert.equal(findAllByClass(suggestBox, 'ai-web-chip').length, 5, '换一批后仍是 5 个');
    }

    // ---------- 搜图：预选词的加载态（骨架 → 真词 / 整块收起） ----------
    // 取词不便宜：起只读 worker 载模型 ~2.1s + 打开索引 ~0.7s + 打分 ~1s，冷启还要现算
    // 308 个词的词表向量（~15s）。旧实现把这段等待留成空白，用户读到的是「没有预选词」
    // 而不是「正在挑」。三种形态都要钉住，尤其「失败后骨架必须退场」。
    {
      // 上面那批已经是 done/zh-CN，换语言才会重取（同语言同批复用，这是有意的）。
      // 顺带覆盖「换语言时先丢掉旧语言的池」——不然中文界面会短暂摆出英文词。
      global.document.documentElement.lang = 'en';
      state.currentView = 'ai_search';
      views.enter('ai_search');
      // 不 await：请求刚发出去，DOM 必须已经是加载态
      const pendingBox = findByClass(sidebar, 'ai-web-sidebar-suggest');
      assert.ok(pendingBox, '重取期间预选词区域仍在');
      assert.equal(
        pendingBox.hidden,
        false,
        '等待期间不整块隐藏，否则用户看到的是「没有」而不是「正在挑」',
      );
      assert.equal(
        findAllByClass(pendingBox, 'ai-web-suggest-skeleton').length,
        5,
        '等待期间摆 5 个骨架占位（和真词一样多）',
      );
      assert.equal(
        findAllByClass(pendingBox, 'ai-web-chip').length,
        0,
        '骨架期间不得混进真词（更不许留着上一批）',
      );
      assert.equal(pendingBox.getAttribute('aria-busy'), 'true', '等待期间对读屏声明忙');
      assert.equal(
        findByClass(pendingBox, 'ai-web-sidebar-clear'),
        null,
        '骨架期间没有「换一批」——还没有词可换',
      );
      assert.equal(
        suggestRequests[suggestRequests.length - 1].lang,
        'en',
        '换语言后按新语言重取，而不是继续用旧语言的池',
      );

      await flush();
      const readyBox = findByClass(sidebar, 'ai-web-sidebar-suggest');
      assert.equal(
        findAllByClass(readyBox, 'ai-web-suggest-skeleton').length,
        0,
        '词到了骨架要撤掉，不能留着变成「假词」',
      );
      assert.equal(findAllByClass(readyBox, 'ai-web-chip').length, 5, '词到了换成真词');
      assert.equal(readyBox.getAttribute('aria-busy'), null, '词到了摘掉忙碌标记');

      // 取不到（任务忙 / 超时 / 无索引）：骨架必须退场，整块收起。
      // ⚠️ 这是加载态最容易做错的地方：失败分支若不重画，整块会**永久停在「挑选中…」**。
      // 加载态假死比原本的空白更糟（空白至少是诚实的）。
      global.document.documentElement.lang = 'zh-CN';
      suggestFails = true;
      views.enter('ai_search');
      const failingBox = findByClass(sidebar, 'ai-web-sidebar-suggest');
      assert.equal(
        findAllByClass(failingBox, 'ai-web-suggest-skeleton').length,
        5,
        '请求在途时同样是加载态（失败要等结果回来才知道）',
      );
      await flush();
      const failedBox = findByClass(sidebar, 'ai-web-sidebar-suggest');
      assert.equal(
        failedBox.hidden,
        true,
        '取不到就整块收起：骨架不许永久停在加载态',
      );
      assert.equal(
        findAllByClass(failedBox, 'ai-web-suggest-skeleton').length,
        0,
        '收起时骨架一并清掉',
      );
      assert.equal(failedBox.children.length, 0, '收起时不留残留节点（含标题）');
      suggestFails = false;
    }

    // ---------- 离开：浏览态工具栏 / 页脚 / 侧栏恢复 ----------
    // 真实调用方（app.js 的 loadPhotos）会先把 currentView 拨回浏览态再调 leave()。
    state.currentView = 'all';
    views.leave();
    assert.equal(views.isShowing(), false);
    assert.equal(views.isActive(), false);
    assert.equal(slot('#headerMediaFilterSelect').style.display, '');
    assert.equal(slot('#sortSelect').style.display, '');
    assert.equal(slot('#browseFooter').style.display, '');
    assert.equal(sidebar.children.length, 0, '离开后侧栏清空，交还给文件夹 / 日期列表');

    // ---------- 静态契约：app.js 的侧栏两态切换 ----------
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/web/js/app.js'), 'utf8');
    assert.match(appSrc, /function isFolderSidebarTab\(tab\)\s*\{\s*return tab === 'folders';/);
    assert.match(appSrc, /function showBrowseSidebar\(\)/);
    assert.match(appSrc, /function showAiSidebar\(\)/);
    assert.ok(
      appSrc.includes("setDisplay('#sidebarContent', 'none')") &&
        appSrc.includes("setDisplay('#aiSidebar', '')"),
      '进入智能视图要把侧栏让给 #aiSidebar',
    );
    assert.ok(
      appSrc.includes("setDisplay('#sidebarContent', '')") &&
        appSrc.includes("setDisplay('#aiSidebar', 'none')"),
      '离开智能视图要把侧栏还给 #sidebarContent',
    );
    assert.match(appSrc, /function leaveWebAiViewForBrowse\(tab\)/);
    assert.ok(
      appSrc.includes("leaveWebAiViewForBrowse('folders')"),
      'viewFolder / viewAllPhotos 等入口要收回搜图 / 人物页签',
    );
    assert.ok(appSrc.includes("leaveWebAiViewForBrowse('dates')"));

    // ---------- 静态契约：index.html 的侧栏宿主 ----------
    const htmlSrc = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
    assert.ok(htmlSrc.includes('id="aiSidebar"'), '网页新增侧栏宿主 #aiSidebar');
    assert.ok(htmlSrc.includes('id="sidebarContent"'), '保留文件夹 / 日期侧栏 #sidebarContent');
    assert.ok(!htmlSrc.includes('id="aiSearchBox"'), '顶栏 AI 搜索框已移除');
    assert.ok(!htmlSrc.includes('id="aiBackBtn"'), '顶栏返回键已移除');

    // ---------- 静态契约：改名写接口 ----------
    assert.ok(appSrc.includes('post: webAiPost'), 'app.js 把 POST 传输注入 WebAiViews');
    assert.ok(
      appSrc.includes("'/api/person-rename'") || appSrc.includes('webAiPost'),
      '网页端存在改名用的 POST 通道',
    );
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/web-server.js'), 'utf8');
    assert.ok(serverSrc.includes("pathname === '/api/person-rename'"), '服务端新增改名路由');
    assert.match(serverSrc, /WebServer\.prototype\.handlePersonRename = function \(req, res\)/);
    assert.ok(
      /handlePersonRename[\s\S]{0,400}req\.method !== 'POST'/.test(serverSrc),
      '改名只接受 POST（GET 一律 405）',
    );
    assert.ok(
      /handlePersonRename[\s\S]{0,1600}\.run\('rename'/.test(serverSrc),
      '改名最终落到 FaceService 的 rename 操作（不自己拼 SQL）',
    );
    const cssSrc = fs.readFileSync(path.join(__dirname, '../src/web/css/ai-web-views.css'), 'utf8');
    assert.ok(cssSrc.includes('.ai-web-people-rename'), '网页端改名输入框有样式');
    assert.ok(cssSrc.includes('.ai-web-sidebar-suggest'), '网页端预选词区域有样式');
    assert.ok(
      /\.ai-web-sidebar-suggest \.ai-web-chip\s*\{[^}]*max-width:\s*100%/.test(cssSrc),
      '侧栏内预选词要限宽（否则长词会把侧栏撑破）',
    );
    // 加载态：取词要起 worker 载模型 + 打开索引 + 打分（冷启还要现算词表向量），
    // 这段等待必须有骨架，且骨架的底色不能挑错。
    assert.ok(
      /\.ai-web-suggest-chips \.ai-web-suggest-skeleton\s*\{[^}]*background:\s*var\(--bg-hover\)/.test(
        cssSrc,
      ),
      '骨架用 --bg-hover 打底：--bg-card 在浅色下是纯白（贴浅色玻璃侧栏看不见），' +
        '--text-muted 混色在深色下几乎与背景同色',
    );
    assert.ok(
      /\.ai-web-suggest-chips \.ai-web-suggest-skeleton::after/.test(cssSrc),
      '骨架要有扫光，否则静止灰块看不出「在加载」',
    );
    assert.ok(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,300}ai-web-suggest-skeleton/.test(cssSrc),
      '系统开了「减少动态效果」时要停掉骨架动画（静态灰块同样能表达加载）',
    );
    assert.ok(
      /\.ai-web-people-item\s*\{[^}]*box-sizing:\s*border-box/.test(cssSrc),
      '人物行变成 div 后要显式 border-box，否则 padding 会把行撑出侧栏',
    );

    // ---------- 静态契约：索引实时读数是「标题一行 + 数字一栏」 ----------
    // 坏形态是「胶囊 + 一整句」：侧栏一窄就折行，胶囊成了两头极圆的两行块，
    // 折行处还会把「检出」拆成「检 / 出」两半（overflow-wrap: anywhere）。
    // 这几条钉住新形态，别退回去。桌面端同款契约在 ai-sidebar-regression.js。
    const aiSrc = fs.readFileSync(path.join(__dirname, '../src/web/js/ai-views.js'), 'utf8');
    assert.ok(/function syncLiveStats\(/.test(aiSrc), '三格与数字都由 syncLiveStats 统一刷新');
    assert.ok(/function setLiveStat\(/.test(aiSrc), '每轮只改数字（setLiveStat）');
    assert.ok(
      !/parts\.join\(' · '\)/.test(aiSrc),
      '数字不许再拼成「· 」分隔的一整句 —— 折行会在行首留下孤零零的分隔符',
    );
    assert.ok(
      /h\('span', 'ai-web-live-label'\)/.test(aiSrc),
      '标签格建的时候不带文字 —— 带了就等于把当时的语言冻在 DOM 里',
    );
    assert.ok(
      /ref\.label\.textContent\s*=\s*t\(/.test(aiSrc),
      '标签文字每轮重写：切语言时不会重跑这里，缓存住就永远不跟着变',
    );
    const webLive = /\.ai-web-live-bar\s*\{[^}]*\}/.exec(cssSrc);
    assert.ok(webLive, '有 .ai-web-live-bar 样式');
    assert.ok(
      !/border-radius:\s*999px/.test(webLive[0]),
      '.ai-web-live-bar 不许退回胶囊（折行会变成两头极圆的块）',
    );
    assert.ok(
      !/flex-wrap:\s*wrap/.test(webLive[0]),
      '.ai-web-live-bar 不许靠换行容纳长内容 —— 长的是数字栏，不是这一行',
    );
    const webLiveText = /\.ai-web-live-text\s*\{[^}]*\}/.exec(cssSrc);
    assert.ok(
      webLiveText && /text-overflow:\s*ellipsis/.test(webLiveText[0]),
      '标题行窄了要省略号收尾，不许折行',
    );
    assert.ok(
      !/\.ai-web-live-text\s*\{[^}]*overflow-wrap:\s*anywhere/.test(cssSrc),
      '标题行不许 overflow-wrap: anywhere —— 那正是把「检出」拆成「检 / 出」的原因',
    );
    const webLiveStats = /\.ai-web-live-stats\s*\{[^}]*\}/.exec(cssSrc);
    assert.ok(webLiveStats, '有数字栏样式');
    assert.ok(
      /grid-auto-flow:\s*column/.test(webLiveStats[0]) &&
        /grid-auto-columns:\s*minmax\(0,\s*1fr\)/.test(webLiveStats[0]),
      '数字栏用 grid-auto-flow: column —— 指标缺一格时剩下两格自动摊平，右边不空一块',
    );
    assert.ok(
      /\.ai-web-live-label\s*\{[^}]*white-space:\s*nowrap/.test(cssSrc),
      '标签不许折行（折了会把数字挤下去）',
    );
    assert.ok(
      /\.ai-web-live-stat\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(cssSrc),
      '指标缺数据时整格藏起来 —— 显示「—」比不显示更容易让人以为出了错',
    );

    console.log('[ai-web-views-regression] PASS');
  } finally {
    // 轮询定时器会让进程不退出：无论断言结果如何都要收干净。
    views.leave();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
