(function (global) {
  'use strict';
  /**
   * 匹配阈值的范围与默认值。**必须与 `src/ai/index-store.js` 的 `MATCH_THRESHOLD_RANGE` 一致**——
   * 渲染层拿不到主进程模块，这里只能各写一份，`scripts/semantic-regression.js` 会解析两边比对。
   */
  var MATCH_RANGE = { min: 0, max: 0.15, step: 0.001, default: 0.01 };
  /**
   * **tag 检索层**查询线的范围与默认值。同样必须与主进程的 `TAG_ROUTE_RANGE`
   * （`src/ai/tag-index-store.js`）一致 —— 渲染层拿不到主进程模块，只能各写一份，
   * `scripts/tag-fusion-regression.js` 会解析两边逐字段比对。
   *
   * 🔴 **与 `MATCH_RANGE` 是两份，不许合并**：量纲不同（CLIP 是基线差，有效区间 [0, 0.03]；
   *    tag 是标签概率 0.2–0.95）。合成一个区间就只能是「为了压住一边的误报把另一边砍没」。
   */
  var TAG_RANGE = { min: 0.2, max: 0.95, step: 0.01, default: 0.55 };
  /**
   * **标签展示线**（读侧分数线）的范围与默认值。同样必须与主进程的 `TAG_DISPLAY_RANGE`
   * （`src/ai/tag-index-store.js`）一致 —— `scripts/tag-fusion-regression.js` 会解析两边逐字段比对。
   *
   * 🔴 **与 `TAG_RANGE` 也是两份**：查询线管「搜得到什么」（上界 0.95，可以很严），
   *    展示线管「看到的算不算数」，它的**上下界是两条硬约束，不是拍的**：
   *    下界 = 入库线 0.15（低于它的行库里根本不存在），上界 = 查询线 0.55
   *    （高过查询线 = 导航比搜索还严，标签页看起来像缺图）。合并两份就没人记得住这层关系。
   */
  var TAG_DISPLAY_RANGE = { min: 0.15, max: 0.55, step: 0.01, default: 0.35 };
  function mount(options) {
    const en = () => document.documentElement.lang.startsWith('en');
    const text = (zh, english) => (en() ? english : zh);
    function node(tag, value, className) {
      const element = document.createElement(tag);
      if (value) element.textContent = value;
      if (className) element.className = className;
      return element;
    }
    function button(label, action) {
      const element = node('button', label, 'ai-button');
      element.type = 'button';
      element.addEventListener('click', action);
      return element;
    }
    const entry = button(text('AI 搜图', 'AI search'), open);
    entry.id = 'semanticSearchButton';
    const anchor = document.getElementById('searchInput');
    // embedded：设置页里的模型/索引面板；pageMode：桌面端左栏「搜图」整页；
    // inline：网页端顶栏按钮弹出的搜索弹窗。后两者都是纯搜索界面，不含说明与设置。
    const embedded = !!options.settingsOnly;
    const pageMode = !!options.page;
    const inline = !embedded && !pageMode;
    if (inline) {
      if (anchor) anchor.parentNode.insertAdjacentElement('afterend', entry);
      else document.body.appendChild(entry);
    }
    const dialog = node(
      embedded || pageMode ? 'section' : 'dialog',
      '',
      embedded
        ? 'ai-settings-panel'
        : pageMode
          ? 'ai-dialog search-page'
          : 'ai-dialog search-dialog',
    );
    if (pageMode) dialog.id = 'searchPage';
    if (embedded || pageMode) dialog.hidden = true;
    (options.container || document.body).appendChild(dialog);
    const surface = embedded || pageMode;
    const isOpen = () => (surface ? !dialog.hidden && options.isActive() : dialog.open);
    let interval;
    let polling = false;
    let queryRunning = false;
    let generation = 0;
    let status;
    let results;
    let notice;
    let searchButton;
    let queryInput;
    let installButton;
    let indexButton;
    let cancelButton;
    let errorLine;
    let gpuLine;
    let thresholdInput;
    /** 输入框里那个「当前生效」的值：写回失败时用它回滚显示。 */
    let thresholdLast = MATCH_RANGE.default;
    /** 用户是否已经在框里动过手：动过之后就不再让迟到的 read 覆盖他刚填的值。 */
    let thresholdTouched = false;
    // ---------- tag 检索层（M4）的控件状态 ----------
    /** 开关的当前值。默认开：与主进程 `createDefaultSettings()` 同源，改一处要改两处。 */
    let tagEnabledLast = true;
    let tagThresholdLast = TAG_RANGE.default;
    let tagToggleInput;
    let tagThresholdInput;
    /**
     * 展示线（读侧分数线）的控件状态。**刻意与 tag 开关分开一套**：这条线管的是
     * 「标签页与照片信息面板显示什么」，与「搜图走不走 tag 路」无关 ⇒
     * 关掉标签检索层时它**不跟着置灰**（置灰了用户会以为「关了检索就看不见标签了」）。
     */
    let tagDisplayLast = TAG_DISPLAY_RANGE.default;
    let tagDisplayInput;
    /** 与 `thresholdTouched` 同义、分开各一份：两个输入框的「别覆盖我刚填的」互不相干。 */
    let tagThresholdTouched = false;
    let tagDisplayTouched = false;
    let tagTouched = false;
    const phases = {
      idle: ['未启用', 'Not enabled'],
      status: ['读取状态', 'Reading status'],
      install: ['准备下载', 'Preparing download'],
      downloading: ['下载模型', 'Downloading model'],
      loading: ['加载本地模型', 'Loading local model'],
      indexing: ['建立索引', 'Indexing'],
      searching: ['搜索中', 'Searching'],
      suggest: ['匹配预选词', 'Scoring suggestions'],
      search: ['准备搜索', 'Preparing search'],
      index: ['准备索引', 'Preparing index'],
      stopping: ['正在停止', 'Stopping'],
      cancelled: ['已停止', 'Stopped'],
      failed: ['失败', 'Failed'],
      complete: ['就绪', 'Ready'],
    };
    // 示例查询只是给搜索框一个起点，点一下就直接搜，不需要用户先读说明。
    const examples = () => [
      text('夕阳下的海滩', 'a beach at sunset'),
      text('雪山和湖泊', 'a lake below snowy mountains'),
      text('沙发上的猫', 'a cat on a sofa'),
      text('城市夜景', 'city skyline at night'),
      text('生日聚会', 'a birthday party'),
    ];
    function errorMessage(error) {
      const message = String(error.message || error);
      const errors = {
        AI_BUSY: ['AI 任务正在运行，请稍后再试。', 'An AI task is running. Try again shortly.'],
        AI_MAINTENANCE: [
          '数据库维护进行中，请稍后再试。',
          'Database maintenance is running. Try again shortly.',
        ],
        AI_MODEL_MISSING: [
          '请先在桌面端「设置 → 本地 AI / 多语言搜图」下载模型。',
          'Download the model in the desktop app first.',
        ],
        AI_CANCELLED: [
          '任务已停止，已完成索引保留。',
          'Stopped. Completed index entries are retained.',
        ],
        AI_QUERY_INVALID: ['请输入 1–500 个字符。', 'Enter 1–500 characters.'],
        AI_TIMEOUT: ['任务超时，请稍后重试。', 'Task timed out. Try again.'],
      };
      const key = Object.keys(errors).find((code) => message.includes(code));
      return key
        ? text(...errors[key])
        : text('操作失败：', 'Operation failed: ') + message.slice(0, 250);
    }
    // 非设置界面只把状态翻译成一句人话（模型/索引/更新中），不再罗列进度数字。
    function renderNotice(state) {
      if (!notice) return;
      let message = '';
      if (!state.ready)
        message = text(
          '本地模型尚未就绪，请先在「设置 → 本地 AI」完成下载。',
          'Local models are not ready. Finish the download in Settings → Local AI.',
        );
      else if (!state.indexed)
        message = text(
          '还没有建立索引，请先在「设置 → 本地 AI」建立。',
          'Nothing is indexed yet. Build the index in Settings → Local AI.',
        );
      else if (state.running)
        message = text('索引正在后台更新', 'Index is updating in the background');
      notice.hidden = !message;
      if (message)
        notice.replaceChildren(node('span', '', 'search-notice-dot'), node('p', message));
    }
    /**
     * 「硬件加速」一行（只出现在设置页的嵌入式面板里）。
     *
     * ## 为什么这行必须存在
     *
     * 后半条链路的答案（「这台机器到底有没有用上 GPU」）本来只写在日志里，而生产档 logger
     * 是 `warn` 级、用户也不会去翻日志。结果是：探测失败静默回落到 CPU 时，界面看起来
     * 一切正常 —— 用户能得到的唯一结论是「换了显卡怎么没变快」。
     * 把它摆到设置页，等于把「回落」这件事变成**用户看得见**的状态。
     *
     * ## 三种取值必须可区分
     *
     *   · `state.gpu == null` ⇒ **还没探完**（探测在启动 +6s 才点火），显示「检测中…」；
     *   · `stale: true` ⇒ 这是**上次启动**的结论，本次正在重探，必须标明，否则「上次可用、
     *     这次驱动坏了」会被显示成「可用」；
     *   · 有值且 `stale: false` ⇒ 本次实测结论。
     * 把前两种合并成一句话，用户就分不清「没有 GPU」和「还没测」。
     *
     * 失败原因（ORT 的原文，英文＋技术细节）只挂在 `title` 上，正文保持一句中文：
     * 正文要给人看懂，原因要给排障的人拿到。
     */
    function renderGpu(state) {
      if (!gpuLine) return;
      const gpu = state && state.gpu;
      if (!gpu) {
        gpuLine.textContent = text('硬件加速：检测中…', 'Hardware acceleration: detecting…');
        gpuLine.removeAttribute('title');
        return;
      }
      const summary = gpu.available
        ? text('硬件加速：DirectML 可用', 'Hardware acceleration: DirectML available')
        : text('硬件加速：不可用，AI 任务走 CPU', 'Hardware acceleration: unavailable, using CPU');
      gpuLine.textContent = gpu.stale
        ? summary + text('（上次检测结果，本次正在重测）', ' (last check; re-checking now)')
        : summary;
      if (gpu.reason) gpuLine.setAttribute('title', gpu.reason);
      else gpuLine.removeAttribute('title');
    }
    async function refresh() {
      if (polling || !isOpen() || queryRunning) return;
      polling = true;
      const current = generation;
      try {
        const state = await options.call('status');
        if (!isOpen() || current !== generation) return;
        if (status && embedded)
          status.textContent =
            text(...(phases[state.phase] || phases.idle)) +
            ' · ' +
            text('模型：', 'Model: ') +
            (state.ready ? text('已下载', 'Downloaded') : text('未下载', 'Not downloaded')) +
            ' · ' +
            text('有效索引 ', 'Indexed ') +
            (state.indexed || 0) +
            (state.running
              ? ' · ' +
                text('本轮完成 ', 'Processed ') +
                (state.done || 0) +
                ' · ' +
                text('失败 ', 'Failed ') +
                (state.failed || 0)
              : '') +
            (state.file ? ' · ' + state.file + ' ' + state.percent + '%' : '') +
            (!state.running && state.failed ? ' · ' + text('失败 ', 'Failed ') + state.failed : '') +
            (state.skipped ? ' · ' + text('跳过 ', 'Skipped ') + state.skipped : '');
        if (searchButton) searchButton.disabled = state.running || !state.ready || !state.indexed;
        if (installButton) installButton.disabled = state.running;
        if (indexButton) indexButton.disabled = state.running || !state.ready;
        if (cancelButton) cancelButton.disabled = !state.running;
        renderNotice(state);
        renderGpu(state);
        if (state.error) errorLine.textContent = errorMessage(state.error);
      } catch (error) {
        if (current === generation) errorLine.textContent = errorMessage(error);
      } finally {
        polling = false;
      }
    }
    async function action(name) {
      errorLine.textContent = '';
      try {
        await options.call(name);
        await refresh();
      } catch (error) {
        errorLine.textContent = errorMessage(error);
      }
    }
    function renderSkeleton() {
      results.className = 'ai-results search-skeleton-grid';
      results.replaceChildren();
      for (let index = 0; index < 12; index += 1)
        results.append(node('span', '', 'search-skeleton'));
    }
    function renderPlaceholder(message) {
      results.className = 'search-empty';
      results.replaceChildren(node('p', message));
    }
    /**
     * 状态行旁边那**一行说明**：这一趟 tag 路为什么没参与（参与时返回空串）。
     *
     * 🔴 为什么非要有这一行：tag 路会**静默不参与**（词表里有但没有对应标签、索引没建、
     *    用户关了开关、查询当场失败），而这四种情况和「这个查询确实没结果」在界面上
     *    长得一模一样 —— 用户唯一能得到的结论是「搜图不准」。所以 worker 把原因原样带上来
     *    （`data.tag.reason`），这里必须说出去。
     *
     * ⚠️ **`FREE_TEXT` 刻意不提示**：自由词（「穿黑丝的女生」）只走语义路是**正常形态**，
     *    给每一句都加一句提示等于噪声，而噪声会把真正该看的那几种情况一起淹掉。
     *    同理 `both` 结果不标来源 —— 它是绝大多数命中。
     */
    function tagNote(tag) {
      if (!tag || typeof tag !== 'object') return '';
      switch (tag.reason) {
        case 'UNSUPPORTED': {
          const missing = Array.isArray(tag.missing) ? tag.missing.filter(Boolean) : [];
          const detail = missing.length ? '（' + missing.join('、') + '）' : '';
          return text(
            '这个词的标签不在本地模型里' + detail + '，本次只用语义匹配。',
            'This term’s tags are not in the local model' + detail + '. Semantic matching only.',
          );
        }
        case 'DISABLED':
          return text('标签检索已关闭，本次只用语义匹配。', 'Tag matching is off; semantic matching only.');
        case 'NO_INDEX':
          return text(
            '标签索引尚未建立，本次只用语义匹配。',
            'The tag index is not built yet; semantic matching only.',
          );
        case 'QUERY_FAILED':
          return text(
            '标签索引本次读取失败，已退回语义匹配。',
            'Reading the tag index failed this time; fell back to semantic matching.',
          );
        default:
          return '';
      }
    }
    function renderResults(photos) {
      results.className = 'ai-results';
      results.replaceChildren();
      /**
       * 「本次最高分」= 列表里**所有** `similarity` 的最大值。
       *
       * ⚠️ 这里曾经直接取 `photos[0].similarity` —— 在纯 CLIP 下等价（那一路按分数降序），
       *    但 M4 融合之后排序依据是 RRF，**首位可能是 tag 独有条目**（它的 `similarity` 是
       *    `null`，因为 tag 的 0.55–0.95 与 CLIP 的基线差不是一套量纲）。
       *    此时 `top` 会变成 0，于是 `top > 0` 这个闸门把所有卡片的匹配度条**一次全关掉** ——
       *    不报错、不警告，只是「条不见了」。取全表最大值既躲开这个坑，又更贴近
       *    「按本次最高分做相对长度」这句话的字面意思。
       */
      const top = photos.reduce(
        (max, photo) => (typeof photo.similarity === 'number' && photo.similarity > max ? photo.similarity : max),
        0,
      );
      photos.forEach((photo, index) => {
        const card = node('button', '', 'search-card');
        card.type = 'button';
        card.addEventListener('click', () => {
          if (inline) dialog.close();
          options.preview(photo);
        });
        const media = node('span', '', 'search-card-media');
        const image = node('img');
        image.src = options.thumbnail(photo);
        image.alt = photo.file_name || '';
        image.loading = index < 12 ? 'eager' : 'lazy';
        image.onerror = () => {
          image.removeAttribute('src');
          image.alt = text('缩略图不可用', 'Thumbnail unavailable');
        };
        media.append(image, node('span', String(index + 1), 'search-card-rank'));
        // 来源标注叠在缩略图上（`.search-card-rank` 占左上，这里占右上），**不进卡片流**：
        // 卡片的高度由 `.search-card-media` 的 4:3 决定，往名字下面加一行会让整行变高、
        // 网格参差不齐（同一页里两种高度的卡片看起来像渲染坏了）。
        const route = routeBadge(photo);
        if (route) media.append(route);
        if (top > 0 && typeof photo.similarity === 'number') {
          const bar = node('span', '', 'search-card-bar');
          // 相似度是余弦值，绝对值不可比，只按本次最高分做相对长度，避免误读成置信度。
          bar.setAttribute(
            'style',
            '--match: ' + Math.max(8, Math.round((photo.similarity / top) * 100)) + '%',
          );
          media.append(bar);
        }
        card.append(media, node('span', photo.file_name, 'search-card-name'));
        results.append(card);
      });
    }
    /**
     * 一条结果的来源标注。`both` / 缺失一律返回 `null`。
     *
     * `both`（两路都命中）不标：它是融合后**排在前面**的那一批，标出来等于给大多数卡片
     * 加一个恒定徽标；真正有信息量的是「只靠一路找到的」—— 用户据此判断这条是运气还是贴题。
     *
     * `missing` 返回 null（而不是当作 `clip`）是**有意的**：拿不到 `route` 时（老 worker、
     * 降级路径）我们并不知道它走的哪条路，标一个猜的比不标更糟。
     *
     * ⚠️ 两个类名**必须写成完整字面量**，不许 `'search-card-route search-card-route--' + route`：
     *    `css-reference-regression` 是拿 JS 里的字符串字面量去比对 CSS 选择器的，
     *    拼接出来的 `--tag` / `--clip` 在源码里找不到，那两个规则会被判成**死规则**（本版实测就红了）。
     *    这不是绕开守护：那个检查问的问题正是「这条 CSS 到底有没有人用」，而拼接让它无法回答。
     */
    function routeBadge(photo) {
      if (!photo || (photo.route !== 'tag' && photo.route !== 'clip')) return null;
      if (photo.route === 'tag')
        return node('span', text('标签', 'Tag'), 'search-card-route search-card-route--tag');
      return node('span', text('语义', 'Semantic'), 'search-card-route search-card-route--clip');
    }
    /** 阈值在框里长什么样：整数不补小数位（0.01 而不是 0.010），范围外/非法值交给 clamp 处理。 */
    function formatThreshold(value) {
      const number = Number(value);
      return isFinite(number) ? String(number) : String(MATCH_RANGE.default);
    }
    /**
     * 输入框里的文字 → 真正生效的阈值。**空与非法都回到默认值**：阈值 0 是有意义的一档
     * （不过滤），所以不能把「空框」顺手当成 0 —— 用户清空输入框的意思通常是「我不想管这个」，
     * 而不是「把所有图片都返回」。
     */
    function clampThreshold(raw) {
      const trimmed = String(raw == null ? '' : raw).trim();
      if (!trimmed) return MATCH_RANGE.default;
      const number = Number(trimmed);
      if (!isFinite(number)) return MATCH_RANGE.default;
      return Math.min(MATCH_RANGE.max, Math.max(MATCH_RANGE.min, number));
    }
    /**
     * 提交阈值：先把输入框回写成真正生效的值（否则「1」这种越界输入会留在框里造成假象），
     * 再乐观更新 + 失败回滚——与人物改名同一套写法。
     */
    function commitThreshold(raw) {
      const value = clampThreshold(raw);
      const previous = thresholdLast;
      thresholdTouched = true;
      thresholdLast = value;
      if (thresholdInput) thresholdInput.value = formatThreshold(value);
      if (value === previous) return;
      Promise.resolve(options.matchThreshold.write(value)).catch((error) => {
        thresholdLast = previous;
        if (thresholdInput) thresholdInput.value = formatThreshold(previous);
        errorLine.textContent = errorMessage(error);
      });
    }
    /** tag 查询线的显示形态：与 `formatThreshold` 同一套规则，只是回落到自己的默认值。 */
    function formatTagThreshold(value) {
      const number = Number(value);
      return isFinite(number) ? String(number) : String(TAG_RANGE.default);
    }
    /** 空 / 非法都回默认值，越界夹取（理由与 `clampThreshold` 相同）。 */
    function clampTagThreshold(raw) {
      const trimmed = String(raw == null ? '' : raw).trim();
      if (!trimmed) return TAG_RANGE.default;
      const number = Number(trimmed);
      if (!isFinite(number)) return TAG_RANGE.default;
      return Math.min(TAG_RANGE.max, Math.max(TAG_RANGE.min, number));
    }
    /** 展示线的显示形态与夹取。三套输入框各一份，规则完全同构 —— 合并成一个函数
     *  反而要在里面分「现在处理的是哪一条线」，那才是漂移的起点。 */
    function formatTagDisplay(value) {
      const number = Number(value);
      return isFinite(number) ? String(number) : String(TAG_DISPLAY_RANGE.default);
    }
    function clampTagDisplay(raw) {
      const trimmed = String(raw == null ? '' : raw).trim();
      if (!trimmed) return TAG_DISPLAY_RANGE.default;
      const number = Number(trimmed);
      if (!isFinite(number)) return TAG_DISPLAY_RANGE.default;
      // 对齐到步长：主进程也这么收口（`clampDisplayMinScore`），两边都不对齐时
      // 「界面显示 0.345 / 实际按 0.34 过滤」会差一行且无人报错。
      const stepped =
        Math.round(number / TAG_DISPLAY_RANGE.step) * TAG_DISPLAY_RANGE.step;
      return Math.min(
        TAG_DISPLAY_RANGE.max,
        Math.max(TAG_DISPLAY_RANGE.min, Number(stepped.toFixed(2))),
      );
    }
    /**
     * tag 层的总开关与查询线。**设置项直接铺开、不折叠**（与上面那条阈值设置一致）。
     *
     * ## 为什么是两个控件，而不是把 tag 查询线并进「匹配阈值」
     *
     * 两者**量纲不同**：匹配阈值是 CLIP 的「基线差」（有效区间 [0, 0.03]），
     * tag 查询线是标签概率（0.2–0.95）。共用一个输入框就只能取一个区间，
     * 结果必然是「为了压住 tag 的误报把 CLIP 砍没」，或者反过来。
     *
     * ## 为什么默认开
     *
     * tag 路的收益正是「词表词 / 预选词点下去更准」，而 tag 索引不存在时它会**自己降级**
     * （worker 报 `tag.reason = 'NO_INDEX'`，状态行会说一句）—— 默认开不会让任何人变差。
     * 关掉它的唯一理由是用户觉得融合后的排序不如纯语义。
     *
     * ## 关闭时把查询线**置灰**，而不是藏起来
     *
     * 藏起来会让「刚才那个数字去哪了」变成一次困惑，而且布局要跳一下；
     * 置灰既说明「它现在不生效」，又保住用户填过的值，重新打开时还在。
     *
     * ## 生效时机
     *
     * 两个控件都是**立即落库**（乐观更新 + 失败回滚，与阈值同一套写法）。它们影响的是
     * **下一次查询**，不需要重建任何索引 —— 查询线是检索期的参数，与倒排库里的分数无关。
     */
    function buildTagLayer() {
      if (!options.tagLayer) return null;
      const section = node('section', '', 'ai-tune');
      const toggleRow = node('div', '', 'ai-tune-body');
      const toggleLabel = node(
        'label',
        text('启用标签检索层', 'Enable the tag layer'),
        'ai-tune-label',
      );
      toggleLabel.setAttribute('for', 'aiTagLayerToggle');
      tagToggleInput = node('input');
      tagToggleInput.type = 'checkbox';
      tagToggleInput.id = 'aiTagLayerToggle';
      tagToggleInput.checked = tagEnabledLast;
      tagToggleInput.addEventListener('change', () => commitTagEnabled(tagToggleInput.checked));
      toggleRow.append(toggleLabel, tagToggleInput);

      const lineRow = node('div', '', 'ai-tune-body');
      const lineLabel = node('label', text('标签查询线', 'Tag threshold'), 'ai-tune-label');
      lineLabel.setAttribute('for', 'aiTagThresholdInput');
      tagThresholdInput = node('input', '', 'ai-tune-input');
      tagThresholdInput.type = 'number';
      tagThresholdInput.id = 'aiTagThresholdInput';
      tagThresholdInput.min = String(TAG_RANGE.min);
      tagThresholdInput.max = String(TAG_RANGE.max);
      tagThresholdInput.step = String(TAG_RANGE.step);
      tagThresholdInput.value = formatTagThreshold(TAG_RANGE.default);
      tagThresholdInput.placeholder = formatTagThreshold(TAG_RANGE.default);
      tagThresholdInput.setAttribute('inputmode', 'decimal');
      tagThresholdInput.setAttribute('aria-label', text('标签查询线', 'Tag threshold'));
      tagThresholdInput.addEventListener('change', () =>
        commitTagThreshold(tagThresholdInput.value),
      );
      tagThresholdInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        tagThresholdInput.blur();
      });
      const reset = node('button', text('恢复默认', 'Reset'), 'ai-tune-reset');
      reset.type = 'button';
      reset.addEventListener('click', () => commitTagThreshold(TAG_RANGE.default));
      lineRow.append(lineLabel, tagThresholdInput, reset);
      // 置灰与否**只由开关派生**，所以只在这一处同步（另找地方再写一遍就会漂）。
      tagThresholdInput.disabled = !tagEnabledLast;
      reset.disabled = !tagEnabledLast;

      /**
       * 第三行：**标签展示线**。
       *
       * 🔴 它**不跟着上面的开关置灰**：展示线管的是「标签导航页与照片信息面板显示哪些标签」，
       *    与「搜图走不走 tag 路」是两件事 —— 关掉标签检索层之后，用户照样在看标签页。
       *    跟着置灰会让人以为「关了检索，标签也就不显示了」，而实际照常显示。
       *    这条差别写成了断言（`scripts/tag-nav-regression.js`）：谁顺手把它加进
       *    `disabled = !tagEnabledLast` 那一串，守护就红。
       */
      const displayRow = node('div', '', 'ai-tune-body');
      const displayLabel = node('label', text('标签展示线', 'Tag display threshold'), 'ai-tune-label');
      displayLabel.setAttribute('for', 'aiTagDisplayInput');
      tagDisplayInput = node('input', '', 'ai-tune-input');
      tagDisplayInput.type = 'number';
      tagDisplayInput.id = 'aiTagDisplayInput';
      tagDisplayInput.min = String(TAG_DISPLAY_RANGE.min);
      tagDisplayInput.max = String(TAG_DISPLAY_RANGE.max);
      tagDisplayInput.step = String(TAG_DISPLAY_RANGE.step);
      tagDisplayInput.value = formatTagDisplay(TAG_DISPLAY_RANGE.default);
      tagDisplayInput.placeholder = formatTagDisplay(TAG_DISPLAY_RANGE.default);
      tagDisplayInput.setAttribute('inputmode', 'decimal');
      tagDisplayInput.setAttribute('aria-label', text('标签展示线', 'Tag display threshold'));
      tagDisplayInput.addEventListener('change', () => commitTagDisplay(tagDisplayInput.value));
      tagDisplayInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        tagDisplayInput.blur();
      });
      const displayReset = node('button', text('恢复默认', 'Reset'), 'ai-tune-reset');
      displayReset.type = 'button';
      displayReset.addEventListener('click', () => commitTagDisplay(TAG_DISPLAY_RANGE.default));
      displayRow.append(displayLabel, tagDisplayInput, displayReset);

      section.append(
        toggleRow,
        lineRow,
        displayRow,
        node(
          'p',
          text(
            '标签检索层用本地模型的标签做一次倒排匹配，再与语义结果融合（都命中会排在前面）。' +
              '查询线 ' +
              formatTagThreshold(TAG_RANGE.min) +
              '–' +
              formatTagThreshold(TAG_RANGE.max) +
              '，越高越严。词表里没有的说法不会走这条路，只用语义匹配。',
            'The tag layer runs an inverted-index match with the local model’s tags and fuses it with the semantic results (items found by both rank first). Threshold range ' +
              formatTagThreshold(TAG_RANGE.min) +
              '–' +
              formatTagThreshold(TAG_RANGE.max) +
              ', higher is stricter. Wording outside the vocabulary skips this route entirely.',
          ),
          'ai-tune-note',
        ),
        /**
         * 展示线的说明**单独一段**，不与上面那段合并：它**不属于**标签检索层
         * （关掉检索层它照样生效），合并成一段会让「关掉检索后这段说明还算不算数」变成谜。
         */
        node(
          'p',
          text(
            '标签展示线 ' +
              formatTagDisplay(TAG_DISPLAY_RANGE.min) +
              '–' +
              formatTagDisplay(TAG_DISPLAY_RANGE.max) +
              '：低于这条线的标签不当结论显示 —— 只影响**标签页里每个标签的张数**与' +
              '**图片信息里的画面标签**，不影响搜图。默认 ' +
              formatTagDisplay(TAG_DISPLAY_RANGE.default) +
              '（低分区的 JoyTag 概率多是噪声）。' +
              '这条线不依赖上面的开关，改完**立刻生效**，不用重启。',
            'Tag display threshold ' +
              formatTagDisplay(TAG_DISPLAY_RANGE.min) +
              '–' +
              formatTagDisplay(TAG_DISPLAY_RANGE.max) +
              ': tags below it are not shown as conclusions — it only affects the counts in the ' +
              'tag page and the visual tags in photo info, not search. Default ' +
              formatTagDisplay(TAG_DISPLAY_RANGE.default) +
              ' (low-scoring JoyTag probabilities are mostly noise). ' +
              'Independent of the switch above; takes effect immediately, no restart.',
          ),
          'ai-tune-note',
        ),
      );
      Promise.resolve(options.tagLayer.read())
        .then((value) => {
          if (!value || typeof value !== 'object') return;
          // 开关与查询线：`tagTouched` 之后不再覆盖（用户刚动过手，迟到的回包不许顶掉）。
          if (!tagTouched && tagToggleInput && tagThresholdInput) {
            const enabled = value.tagEnabled !== false;
            tagEnabledLast = enabled;
            tagToggleInput.checked = enabled;
            tagThresholdInput.disabled = !enabled;
            reset.disabled = !enabled;
            const number = Number(value.tagThreshold);
            if (!tagThresholdTouched && isFinite(number)) {
              tagThresholdLast = clampTagThreshold(number);
              tagThresholdInput.value = formatTagThreshold(tagThresholdLast);
            }
          }
          /**
           * 🔴 展示线**必须有自己的 early-return 分支，不许并进上面那个 `if`**：
           *    上面那段被 `tagTouched` 一票否决（用户拨过开关就不再回填）。并进去的后果是
           *    「先拨开关、再收到回包 ⇒ 展示线永远停在占位值 0.35」，而用户实际设的是别的数
           *    —— 界面不报错、只是显示错，正是本仓最怕的那类静默。
           */
          if (!tagDisplayTouched && tagDisplayInput) {
            const number = Number(value.tagDisplayThreshold);
            if (isFinite(number)) {
              tagDisplayLast = clampTagDisplay(number);
              tagDisplayInput.value = formatTagDisplay(tagDisplayLast);
            }
          }
        })
        .catch(() => {});
      return section;
    }
    /** 开关落库。失败回滚到原值并提示 —— 不留「界面显示打开、实际是关的」这种假象。 */
    function commitTagEnabled(next) {
      const value = next !== false;
      const previous = tagEnabledLast;
      tagTouched = true;
      tagEnabledLast = value;
      if (tagToggleInput) tagToggleInput.checked = value;
      // 查询线跟着一起置灰：它是这个开关的下级参数，两处状态必须是同一帧改的。
      if (tagThresholdInput) tagThresholdInput.disabled = !value;
      if (value === previous) return;
      Promise.resolve(options.tagLayer.write({ tagEnabled: value })).catch((error) => {
        tagEnabledLast = previous;
        if (tagToggleInput) tagToggleInput.checked = previous;
        if (tagThresholdInput) tagThresholdInput.disabled = !previous;
        errorLine.textContent = errorMessage(error);
      });
    }
    /** 查询线落库。写法与 `commitThreshold` 逐字同构（含「先把框回写成真正生效的值」）。 */
    function commitTagThreshold(raw) {
      const value = clampTagThreshold(raw);
      const previous = tagThresholdLast;
      tagTouched = true;
      tagThresholdTouched = true;
      tagThresholdLast = value;
      if (tagThresholdInput) tagThresholdInput.value = formatTagThreshold(value);
      if (value === previous) return;
      Promise.resolve(options.tagLayer.write({ tagThreshold: value })).catch((error) => {
        tagThresholdLast = previous;
        if (tagThresholdInput) tagThresholdInput.value = formatTagThreshold(previous);
        errorLine.textContent = errorMessage(error);
      });
    }
    /**
     * 展示线落库。写法与 `commitTagThreshold` 逐字同构（含「先把框回写成真正生效的值」）。
     *
     * ⚠️ 这里**不设 `tagTouched`**：那个标记是「用户拨过检索层开关」的意思，
     *    用来否决开关/查询线的迟到回包；展示线不受开关管辖，跟着设会让它在用户
     *    拨过开关之后再也回填不上（见 `buildTagLayer` 里 read 回调的分支说明）。
     *
     * 生效时机：写完即落库并写进主进程内存的 `settings`，两个读侧服务每次查询现取 ⇒
     * **下一次取数就生效**（点节点、翻页、打开下一张照片），不需要重启、不需要重建索引。
     * 屏幕上已经画好的数字由桌面端主动失效缓存（`tagNavUi.invalidateCounts()`）。
     */
    function commitTagDisplay(raw) {
      const value = clampTagDisplay(raw);
      const previous = tagDisplayLast;
      tagDisplayTouched = true;
      tagDisplayLast = value;
      if (tagDisplayInput) tagDisplayInput.value = formatTagDisplay(value);
      if (value === previous) return;
      Promise.resolve(options.tagLayer.write({ tagDisplayThreshold: value })).catch((error) => {
        tagDisplayLast = previous;
        if (tagDisplayInput) tagDisplayInput.value = formatTagDisplay(previous);
        errorLine.textContent = errorMessage(error);
      });
    }
    /**
     * 「匹配设置」：检索阈值（数字输入框）。
     *
     * 阈值归**检索**而不是索引：索引只负责把图片编码成向量，与「返回多少条」无关。
     * 之前检索固定取相似度最高的 60 条，于是任何查询都恰好 60 张、看不出相关性差异；
     * 现在按阈值筛选，条数由内容本身决定。口径是「基线差」——每张图片先减掉它与泛化文本的
     * 相似度，剩下的才是这个查询带来的信号（原因见 `src/ai/embedding.js` 的 GENERIC_TEXT）。
     *
     * 用输入框而不是滑杆：有效区间只有 [0, 0.03] 这么窄，滑杆上能对齐的有意义取值就那几档，
     * 拖拽精度还不如直接敲数字；而且滑杆没法表达「清空 = 回到默认」。
     *
     * 设置项直接铺开、没有折叠入口（用户反馈：不要存在设置项按钮隐藏）。
     * 这里曾是个 <details> 折叠块，理由是它当初挤在「后台任务」清单里的一行 ——
     * 那个约束随独立面板消失，折叠也就失去理由。⚠️ 本函数只会在 embedded
     * （设置页 settingsOnly）分支里被调用，故不再需要折叠与否的分叉。
     */
    function buildTuning() {
      const tuning = node('section', '', 'ai-tune');
      if (!options.matchThreshold) {
        tuning.append(
          node(
            'p',
            text(
              '匹配阈值在桌面端的设置里调整。',
              'Adjust the match threshold in the desktop app.',
            ),
            'ai-tune-note',
          ),
        );
        return tuning;
      }
      const body = node('div', '', 'ai-tune-body');
      thresholdInput = node('input', '', 'ai-tune-input');
      thresholdInput.type = 'number';
      thresholdInput.min = String(MATCH_RANGE.min);
      thresholdInput.max = String(MATCH_RANGE.max);
      thresholdInput.step = String(MATCH_RANGE.step);
      // 开箱即带默认值：读到真值之前框里也不是空的，用户不必先猜这里能填什么。
      thresholdInput.value = formatThreshold(MATCH_RANGE.default);
      thresholdInput.placeholder = formatThreshold(MATCH_RANGE.default);
      thresholdInput.setAttribute('inputmode', 'decimal');
      thresholdInput.setAttribute('aria-label', text('搜图匹配阈值', 'Search match threshold'));
      thresholdInput.addEventListener('change', () => commitThreshold(thresholdInput.value));
      thresholdInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        // 不是 form，回车不会提交；失焦即可触发上面那条 change（值没变则不重复写库）。
        event.preventDefault();
        thresholdInput.blur();
      });
      const reset = node('button', text('恢复默认', 'Reset'), 'ai-tune-reset');
      reset.type = 'button';
      reset.addEventListener('click', () => commitThreshold(MATCH_RANGE.default));
      // 可见标签：折叠块取消后，原先承担「这是什么设置」的 summary 一并消失，阈值输入框
      // 就会变成一只没有可见名字的裸数字框（只剩 aria-label，屏幕阅读器读得到、眼睛读不到）。
      // 字号字重对齐设置页 `.setting-label` 的约定，与同页其它设置项一致。
      body.append(
        node('span', text('匹配阈值', 'Match threshold'), 'ai-tune-label'),
        thresholdInput,
        reset,
      );
      tuning.append(
        body,
        node(
          'p',
          text(
            '越大越严：只有达到阈值的图片才会返回，库里没有这个概念时可能一张都不返回；0 表示不过滤。留空或填非法值会回到默认 ' +
              formatThreshold(MATCH_RANGE.default) +
              '。',
            'Higher is stricter: only photos above the threshold come back, and a concept your library does not contain may return nothing. 0 disables filtering. An empty or invalid entry falls back to the default ' +
              formatThreshold(MATCH_RANGE.default) +
              '.',
          ),
          'ai-tune-note',
        ),
      );
      Promise.resolve(options.matchThreshold.read())
        .then((value) => {
          if (!thresholdInput || thresholdTouched) return;
          const number = Number(value);
          if (!isFinite(number)) return;
          thresholdLast = clampThreshold(number);
          thresholdInput.value = formatThreshold(thresholdLast);
        })
        .catch(() => {});
      return tuning;
    }

    async function search(value) {
      if (queryRunning || !queryInput || searchButton.disabled) return;
      const query = String(value || queryInput.value || '').trim();
      if (!query) {
        queryInput.focus();
        return;
      }
      queryInput.value = query;
      queryRunning = true;
      const current = generation;
      errorLine.textContent = '';
      if (notice) notice.hidden = true;
      searchButton.disabled = true;
      renderSkeleton();
      status.textContent = text('正在本机搜索…', 'Searching locally…');
      try {
        const data = await options.call('query', query);
        if (!isOpen() || current !== generation) return;
        const photos = (data && data.photos) || [];
        // 与桌面端同一口径：数字是「有多少张达到阈值」，不是「找到了多少张相关图片」。
        const matched = data && data.matched != null ? Number(data.matched) : photos.length;
        // tag 路没参与时把原因接在后面（参与时为空串）。理由见 tagNote 的注释 ——
        // 不加这一句，四种「静默降级」与「确实没结果」在界面上完全一样。
        const note = tagNote(data && data.tag);
        status.textContent =
          text(matched + ' 张达到匹配阈值', matched + ' above the match threshold') +
          (note ? ' · ' + note : '');
        if (!photos.length)
          renderPlaceholder(
            text(
              '没有达到匹配阈值的图片，换个说法或调低阈值再试试。',
              'No photos above the match threshold. Try different wording or a lower threshold.',
            ),
          );
        else renderResults(photos);
      } catch (error) {
        if (current === generation) {
          errorLine.textContent = errorMessage(error);
          renderPlaceholder(text('搜索失败，请重试。', 'Search failed. Try again.'));
        }
      } finally {
        queryRunning = false;
        if (current === generation) searchButton.disabled = false;
      }
    }
    function open() {
      if (isOpen()) return;
      generation++;
      dialog.replaceChildren();
      const label = embedded
        ? text('本地 AI 搜图', 'Local AI photo search')
        : text('搜图', 'Search photos');
      dialog.setAttribute('aria-label', label);
      const header = node('header', '', 'ai-header');
      // 标题与左栏「搜图」同名——同一功能只留一个叫法（曾出现左栏「搜图」/
      // 设置导航「智能索引」/ 面板内「本地 AI / 多语言搜图」三个名字）。
      // 注意：设置页的嵌入式面板**不挂载这个 header**，那里命名由设置页的
      // 类目标题承担（见下方 embedded 分支），否则会重复且容易再分叉。
      header.append(node('h2', text('搜图', 'Search'), 'search-title'));
      if (inline) header.append(button(text('关闭 · Esc', 'Close · Esc'), () => dialog.close()));
      status = node('p', '', 'search-status');
      status.setAttribute('role', 'status');
      errorLine = node('p', '', 'ai-error');
      errorLine.setAttribute('role', 'alert');
      if (embedded) {
        const controls = node('div', '', 'ai-controls');
        if (options.manage) {
          installButton = button(text('下载 / 修复模型', 'Download / repair models'), () =>
            action('install'),
          );
          indexButton = button(text('建立 / 更新索引', 'Build / update index'), () =>
            action('index'),
          );
          cancelButton = button(text('停止任务', 'Stop task'), () => action('cancel'));
          indexButton.disabled = true;
          cancelButton.disabled = true;
          controls.append(installButton, indexButton, cancelButton);
        }
        // 设置页嵌入式面板不挂 header：命名由设置页的类目标题（「搜图」）承担。
        // 这里曾渲染过一条独立的 h2，结果是同义重复 + 与类目标题名字不一致。
        // 两段静态说明（「用中文、英文等语言描述画面…」「建立索引后，从左栏…」）
        // 已删除：这一块当时是「后台任务」清单里的一行，同清单其它行只有一行说明，
        // 这里堆三段解释会把整行撑高三倍；动态状态由 status 承担。
        // 「硬件加速」这行复用 `.ai-tune-note` 的样式（与阈值说明同一档），不新增 CSS 类。
        gpuLine = node('p', text('硬件加速：检测中…', 'Hardware acceleration: detecting…'), 'ai-tune-note');
        // ⚠️ 两个构建函数**各调一次、结果存下来**。写成
        //    `...(buildTagLayer() ? [buildTagLayer()] : [])` 会造出两个 section：
        //    第一个被丢掉、但它把模块级的 `tagToggleInput` / `tagThresholdInput` 指向了自己，
        //    于是界面上那节控件与代码里操作的对象**不是同一个**（经典「改了没反应」）。
        const tuningSection = buildTuning();
        // tag 层（M4）是**独立一节**：它的两个控件在设置页里要整行展开
        // （`.settings-ai-index-body > .ai-settings-panel > .ai-tune` 那条 grid 规则），
        // 塞进上面那节就会被 `.ai-tune-body` 的 flex 排成一行、窄栏里挤碎。
        const tagSection = buildTagLayer();
        dialog.append(
          controls,
          status,
          tuningSection,
          ...(tagSection ? [tagSection] : []),
          gpuLine,
          errorLine,
        );
        dialog.hidden = false;
        void refresh();
        interval = setInterval(refresh, 2500);
        return;
      }
      const form = node('form', '', 'ai-query search-query');
      const field = node('label', '', 'search-field');
      queryInput = node('input');
      queryInput.type = 'search';
      queryInput.maxLength = 500;
      queryInput.placeholder = text(
        '描述你想找的画面，例如：夕阳下的海滩',
        'Describe what you are looking for, e.g. a beach at sunset',
      );
      queryInput.setAttribute('aria-label', text('画面描述', 'Scene description'));
      field.append(queryInput);
      searchButton = node('button', text('搜索', 'Search'), 'ai-button search-submit');
      searchButton.classList.add('ai-button-primary');
      searchButton.type = 'submit';
      searchButton.disabled = true;
      const chips = node('div', '', 'search-chips');
      examples().forEach((example) => {
        const chip = node('button', example, 'search-chip');
        chip.type = 'button';
        chip.addEventListener('click', () => void search(example));
        chips.append(chip);
      });
      notice = node('div', '', 'search-notice');
      notice.hidden = true;
      results = node('div', '', 'ai-results');
      form.append(field, searchButton);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void search(queryInput.value);
      });
      header.append(form);
      dialog.append(header, chips, notice, status, errorLine, results);
      if (surface) {
        dialog.hidden = false;
        if (pageMode) queryInput.focus();
      } else {
        dialog.showModal();
        queryInput.focus();
      }
      void refresh();
      interval = setInterval(refresh, 2500);
    }
    dialog.addEventListener('close', () => {
      generation++;
      clearInterval(interval);
      dialog.replaceChildren();
      entry.focus();
    });
    global.addEventListener(
      'keydown',
      (event) => {
        if (surface || !dialog.open) return;
        // Keep native input and form keyboard events, but isolate background shortcuts.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          dialog.close();
        }
      },
      true,
    );
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    new global.MutationObserver(() => {
      entry.textContent = text('AI 搜图', 'AI search');
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return {
      show() {
        open();
      },
      hide() {
        if (surface) {
          dialog.hidden = true;
          generation++;
          clearInterval(interval);
        }
      },
    };
  }
  global.SemanticSearchUI = { mount };
})(window);
