(function (global) {
  'use strict';
  /**
   * 匹配阈值的范围与默认值。**必须与 `src/ai/index-store.js` 的 `MATCH_THRESHOLD_RANGE` 一致**——
   * 渲染层拿不到主进程模块，这里只能各写一份，`scripts/semantic-regression.js` 会解析两边比对。
   */
  var MATCH_RANGE = { min: 0, max: 0.03, step: 0.001, default: 0.01 };
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
    let thresholdInput;
    /** 输入框里那个「当前生效」的值：写回失败时用它回滚显示。 */
    let thresholdLast = MATCH_RANGE.default;
    /** 用户是否已经在框里动过手：动过之后就不再让迟到的 read 覆盖他刚填的值。 */
    let thresholdTouched = false;
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
      else if (state.busy)
        message = text('索引正在后台更新', 'Index is updating in the background');
      notice.hidden = !message;
      if (message)
        notice.replaceChildren(node('span', '', 'search-notice-dot'), node('p', message));
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
            (state.busy
              ? ' · ' +
                text('本轮完成 ', 'Processed ') +
                (state.processed || 0) +
                ' · ' +
                text('失败 ', 'Failed ') +
                (state.failed || 0)
              : '') +
            (state.file ? ' · ' + state.file + ' ' + state.percent + '%' : '') +
            (!state.busy && state.failed ? ' · ' + text('失败 ', 'Failed ') + state.failed : '') +
            (state.skipped ? ' · ' + text('跳过 ', 'Skipped ') + state.skipped : '');
        if (searchButton) searchButton.disabled = state.busy || !state.ready || !state.indexed;
        if (installButton) installButton.disabled = state.busy;
        if (indexButton) indexButton.disabled = state.busy || !state.ready;
        if (cancelButton) cancelButton.disabled = !state.busy;
        renderNotice(state);
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
    function renderResults(photos) {
      results.className = 'ai-results';
      results.replaceChildren();
      const top = typeof photos[0].similarity === 'number' ? photos[0].similarity : 0;
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
    /** 阈值在框里长什么样：整数不补小数位（0.01 而不是 0.010），范围外/非法值交给 clamp 处理。 */
    function formatThreshold(value) {
      const number = Number(value);
      return isFinite(number) ? String(number) : String(MATCH_RANGE.default);
    }
    /**
     * 输入框里的文字 → 真正生效的阈值。**空与非法都回到默认值**：阈值 0 是有意义的一档
     * （不过滤），所以不能把「空框」顺手当成 0 —— 用户清空输入框的意思通常是「我不想管这个」，
     * 而不是「把所有照片都返回」。
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
    /**
     * 「匹配设置」：检索阈值（数字输入框）。
     *
     * 阈值归**检索**而不是索引：索引只负责把照片编码成向量，与「返回多少条」无关。
     * 之前检索固定取相似度最高的 60 条，于是任何查询都恰好 60 张、看不出相关性差异；
     * 现在按阈值筛选，条数由内容本身决定。口径是「基线差」——每张照片先减掉它与泛化文本的
     * 相似度，剩下的才是这个查询带来的信号（原因见 `src/ai/embedding.js` 的 GENERIC_TEXT）。
     *
     * 用输入框而不是滑杆：有效区间只有 [0, 0.03] 这么窄，滑杆上能对齐的有意义取值就那几档，
     * 拖拽精度还不如直接敲数字；而且滑杆没法表达「清空 = 回到默认」。
     *
     * 收进折叠块：这一块是「后台任务」清单里的一行，阈值是偶尔才动一次的东西。
     */
    function buildTuning() {
      const tuning = node('details', '', 'ai-tune');
      tuning.append(node('summary', text('匹配设置', 'Match settings')));
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
      body.append(thresholdInput, reset);
      tuning.append(
        body,
        node(
          'p',
          text(
            '越大越严：只有达到阈值的照片才会返回，库里没有这个概念时可能一张都不返回；0 表示不过滤。留空或填非法值会回到默认 ' +
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
        // 与桌面端同一口径：数字是「有多少张达到阈值」，不是「找到了多少张相关照片」。
        const matched = data && data.matched != null ? Number(data.matched) : photos.length;
        status.textContent = text(
          matched + ' 张达到匹配阈值',
          matched + ' above the match threshold',
        );
        if (!photos.length)
          renderPlaceholder(
            text(
              '没有达到匹配阈值的照片，换个说法或调低阈值再试试。',
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
        // 已删除：这一块现在是「后台任务」清单里的一行，同清单其它行只有一行说明，
        // 这里堆三段解释会把整行撑高三倍；动态状态由 status 承担。
        dialog.append(controls, status, buildTuning(), errorLine);
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
