(function (global) {
  'use strict';
  /**
   * 分组阈值这一档的取值域。**唯一真相源是 `src/ai/face-settings.js`**，
   * 这里是浏览器侧镜像（渲染进程不能 require 主进程模块）；两边数字由
   * `scripts/face-regression.js` 静态比对，改一处漏一处会被直接拦下。
   *
   * 默认 0.55 → 0.20 → 0.30，两次都不是「调松了 / 调紧了」而是**量纲变了**：一次是把
   * 「与组内第一张脸比」换成「与组内抽样成员的**平均**比」（平均天然更低）；另一次是
   * 聚类换成 Chinese Whispers（阈值变成**配对级**连边门槛）且识别器换成 InsightFace
   * w600k_mbf（同人相似度整体更低）。老值照搬到新量纲都会明显跑偏，所以设置文件用
   * `version` 做迁移。
   *
   * 为什么最终是 0.30 而不是整库最优的 0.20：**0.20 只在 3501 张脸的整库上好看，
   * 放到 250 / 124 张脸的小库上会整库塌成 2 组**（连边密度随库规模变化，Top-K 剪枝
   * 在小库上不起作用）。新用户装的库可能只有几百张脸，阈值不能只在一种规模上成立。
   */
  var THRESHOLD_RANGE = { min: 0.1, max: 0.5, step: 0.01, default: 0.3 };
  /** 按文件夹归组 / 按目录分域聚类时「根目录下第几层子目录」。1 = `K:\COS\116` 这一层。 */
  var DEPTH_RANGE = { min: 1, max: 4, default: 1 };
  function clampThreshold(raw) {
    // 空框 ≠ 最低值：清空输入框的意思通常是「我不想管它」，回落到默认而不是当成 0.15
    // （0.15 是「见到就并」的极端档，绝不是用户清空输入时想要的）。非法值同理。
    if (raw === undefined || raw === null || String(raw).trim() === '') return THRESHOLD_RANGE.default;
    var number = Number(raw);
    if (!isFinite(number)) return THRESHOLD_RANGE.default;
    var stepped = Math.round(number / THRESHOLD_RANGE.step) * THRESHOLD_RANGE.step;
    return Math.min(THRESHOLD_RANGE.max, Math.max(THRESHOLD_RANGE.min, Number(stepped.toFixed(2))));
  }
  function clampDepth(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEPTH_RANGE.default;
    var number = Number(raw);
    if (!isFinite(number)) return DEPTH_RANGE.default;
    return Math.min(DEPTH_RANGE.max, Math.max(DEPTH_RANGE.min, Math.round(number)));
  }
  function formatThreshold(value) {
    return String(clampThreshold(value));
  }
  /**
   * 大数压成「1.2万 / 3.4k」。
   *
   * 覆盖率的分母是**全库照片数**（本机 122 万），原样写进状态行会把整行撑破；阈值那两个
   * 换行规则与渲染端 `compactCount` 刻意保持一致 —— 同为「怎么把大数说小」的约定，
   * 两端给出不同写法会让用户以为是两个不同的数字。
   */
  function compactCount(value) {
    const n = Number(value) || 0;
    if (document.documentElement.lang.startsWith('en')) {
      if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
      return String(n);
    }
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
    return String(n);
  }
  function mount(options) {
    const t = (zh, en) => (document.documentElement.lang.startsWith('en') ? en : zh);
    function node(tag, text, className) {
      const item = document.createElement(tag);
      item.textContent = text || '';
      if (className) item.className = className;
      return item;
    }
    function button(text, fn) {
      const item = node('button', text, 'ai-button');
      item.type = 'button';
      item.addEventListener('click', fn);
      return item;
    }
    function toolButton(text, fn) {
      const item = button(text, fn);
      item.classList.add('people-tool');
      return item;
    }
    // panel：设置页里「人脸识别」面板，保留模型下载/索引/识别设置等全部配置项；
    // 其余挂载（桌面端整页、网页端弹窗）只做浏览与命名，不含设置与步骤说明。
    const panel = !!options.settingsOnly;
    const embedded = !!options.container;
    const entry = button(t('人物', 'People'), open);
    entry.id = 'peopleButton';
    const anchor = document.getElementById('semanticSearchButton');
    if (!embedded) {
      if (anchor) anchor.insertAdjacentElement('afterend', entry);
      else document.body.appendChild(entry);
    }
    let settingsEntry;
    if (
      options.manage &&
      !options.browseOnly &&
      !options.settingsOnly &&
      document.getElementById('settingsPage')
    ) {
      settingsEntry = button(t('人脸识别与人物索引', 'Face recognition and indexing'), () => {
        if (embedded) options.navigate();
        else open();
      });
      settingsEntry.classList.add('people-settings-entry');
      document.getElementById('settingsPage').append(settingsEntry);
    }
    const dialog = node(embedded ? 'section' : 'dialog', '', 'ai-dialog people-dialog');
    if (embedded) {
      dialog.id = panel ? 'peopleSettingsPanel' : 'peoplePage';
      dialog.classList.add('people-page');
      dialog.hidden = true;
    }
    (options.container || document.body).appendChild(dialog);
    function isOpen() {
      return embedded ? !dialog.hidden && options.isActive() : dialog.open;
    }
    let generation = 0,
      timer,
      busy = false,
      stateLine,
      errorLine,
      controls,
      content,
      navigation,
      toolbar,
      detail,
      guide,
      goPeopleButton,
      progressBar,
      settingsPanel,
      loadPreferences,
      settingsFields,
      settingsLoaded = false,
      lastState;
    let taskButtons = [],
      buildButton,
      stopButton;
    let pendingNavigation;
    const phaseNames = {
      idle: ['未启用', 'Not enabled'],
      status: ['读取状态', 'Reading status'],
      downloading: ['下载模型', 'Downloading'],
      install: ['准备模型', 'Preparing models'],
      index: ['准备索引', 'Preparing index'],
      loading: ['加载模型', 'Loading'],
      indexing: ['识别人脸', 'Detecting faces'],
      stopping: ['正在停止', 'Stopping'],
      cancelled: ['已停止', 'Stopped'],
      failed: ['失败', 'Failed'],
      complete: ['就绪', 'Ready'],
    };
    function explain(error) {
      const message = String(error.message || error);
      if (message.includes('AI_BUSY'))
        return t(
          '后台任务正在运行，请稍后刷新。',
          'A background task is running. Refresh shortly.',
        );
      if (message.includes('AI_MAINTENANCE'))
        return t('数据库维护进行中，请稍后再试。', 'Database maintenance is running. Try shortly.');
      if (message.includes('AI_MODEL_MISSING'))
        return t('请先在桌面端下载人脸模型。', 'Download face models on desktop first.');
      if (message.includes('AI_CANCELLED'))
        return t('已停止，完成的索引已保留。', 'Stopped. Completed entries retained.');
      return t('操作失败：', 'Operation failed: ') + message.slice(0, 180);
    }
    async function call(operation, args, apply) {
      if (busy) return;
      busy = true;
      const current = generation;
      errorLine.textContent = '';
      try {
        const result = await options.call(operation, args);
        if ((embedded || isOpen()) && generation === current && apply) apply(result);
      } catch (error) {
        if (isOpen() && generation === current) errorLine.textContent = explain(error);
      } finally {
        busy = false;
        const resume = pendingNavigation;
        pendingNavigation = null;
        if (isOpen() && resume) resume();
      }
    }
    async function refresh() {
      if (!isOpen() || busy) return;
      await call('status', {}, (state) => {
        const previous = lastState;
        const finished =
          previous &&
          !state.busy &&
          (previous.busy || previous.indexed !== state.indexed || previous.people !== state.people);
        // 索引进行中：人物总数变化 = 有新分组出现，顺手增量拉一次已识别结果，
        // 让「人物」页在索引跑完之前就能显示，而不是停在一句「索引处理中」。
        const liveChanged = previous && state.busy && previous.people !== state.people;
        lastState = state;
        // 引导只讲「这个面板能做的事」（模型 / 索引 / 增量更新），且每行最多一句：
        // 它当初是「后台任务」清单里的一行，旁边是「缩略图补全」这类同样只有一行说明的任务。
        // 早先这里是「第 1/2/3 步」的编号轮播，第 3 步写的却是「查看并命名人物」——那是
        // 「人物」视图的动作，本面板既没有列表也没有命名入口，用户读完只能在本页找一个
        // 不存在的按钮。跨页的那一步改由下方的「前往人物页」按钮承载，编号一并去掉
        // （同一位置一次只显示一句，看不到三步全貌，编号只会暗示后面还有更多步骤）。
        // 「索引跑完但零人物」这一支原先还会补一句解释，让人去核对照片里是否有清晰正脸、
        // 或到下方的「识别设置」调整参数后重建索引。那一整句已删除：它把结果归因到用户的
        // 照片质量，而零结果的常见成因在索引本身（模型没跑通、目录没扫全），这句话反而让人
        // 先去怀疑自己的照片；且「识别设置」当时还是个默认收起的 <details>，指路也指不准。
        // 该状态现在只留 stateLine 的计数，引导整格收起——与同清单里的其它任务行一致。
        const indexed = (state.indexed || 0) > 0;
        const peopleCount = state.people || 0;
        // 「索引是上一代识别器建的」与「从来没建过索引」在数字上**完全一样**（都是 0 个人物
        // / 0 张脸 / 0 条已索引），只有 staleScans 能区分它们。不区分的话，用户看到人物页
        // 空空如也，唯一能得出的结论是「我的数据丢了」—— 而真正该说的是「索引与当前识别器
        // 不匹配，重建即可」。实测：库里 16155 条 v1（SFace）记录、3501 张脸都还在。
        const staleScans = Number(state.staleScans) || 0;
        const staleNames = (state.staleVersions || [])
          .map((item) => item.label || item.version)
          .join(' / ');
        if (guide) {
          let text;
          if (!state.ready)
            text = t(
              '先下载并校验模型（约 39 MB），再建立人脸索引。',
              'Download and verify the models (~39 MB) first, then build the face index.',
            );
          else if (state.busy)
            text = t(
              '正在后台处理。可以关闭此窗口；停止后再次更新会跳过已完成的照片。',
              'Processing in the background. You can close this dialog; updating after stopping skips completed photos.',
            );
          else if (state.phase === 'cancelled')
            text = t(
              '索引已停止，已完成的结果已保留。点击「建立 / 更新人脸索引」继续。',
              'Index stopped; completed results retained. Build / update to continue.',
            );
          else if (indexed && peopleCount > 0)
            text = t(
              '索引已就绪，已分组 ' +
                peopleCount +
                ' 位人物。导入新照片后，点「建立 / 更新人脸索引」做增量更新。',
              'Index ready with ' +
                peopleCount +
                ' people. After importing photos, build / update to index the new ones.',
            );
          else if (staleScans > 0)
            // 走在 `indexed` 之前：这份状态的**常见成因**就是「上一代识别器建的索引」，
            // 若落到下面那支（`indexed` 为真时输出空串）引导会整格收起，用户什么都看不到。
            text = t(
              '索引里的 ' +
                staleScans +
                ' 条记录是上一代识别器（' +
                staleNames +
                '）建立的，与当前识别器不兼容 —— 「人物」页因此是空的。点下面的「建立 / 更新人脸索引」重建：旧记录会先被清掉，再按当前识别器重新扫描。',
              'The index holds ' +
                staleScans +
                ' records built by an older recognizer (' +
                staleNames +
                '), incompatible with the current one — that is why the People page is empty. Use “Build / update the face index” below to rebuild: the old records are cleared first, then everything is re-scanned with the current recognizer.',
            );
          else if (indexed)
            // 索引跑完但零人物：不再解释（理由见上方注释），只留下方 stateLine 的计数。
            text = '';
          else
            text = t(
              '模型已就绪，点「建立 / 更新人脸索引」开始。若还没有照片，请先到「媒体库」添加并扫描目录。',
              'Models ready. Build / update the face index to start. If you have no photos yet, add and scan folders under Library first.',
            );
          guide.textContent = text;
          // 空引导不占位：.people-guide 自带 padding / 背景色 / 左边框，留空会在任务行里
          // 显示成一条空色条（people.css 里有对应的 [hidden] 兜底）。
          guide.hidden = !text;
        }
        // 「前往人物页」只在真有可命名的人物时出现：索引跑完但零人脸时点进去只会看到空页面。
        if (goPeopleButton) goPeopleButton.hidden = !(indexed && peopleCount > 0);
        if (progressBar) {
          progressBar.hidden = !state.busy;
          if (state.phase === 'downloading' && state.file) progressBar.value = state.percent || 0;
          else progressBar.removeAttribute('value');
        }
        if (settingsFields) settingsFields.disabled = !!state.busy || !settingsLoaded;
        if (stateLine)
          stateLine.textContent =
            t(...(phaseNames[state.phase] || phaseNames.complete)) +
            ' · ' +
            (state.ready ? t('模型已下载', 'Models ready') : t('模型未下载', 'Models missing')) +
            ' · ' +
            t('已索引 ', 'Indexed ') +
            // 「已索引 / 全库」而不是只报一个数：索引只铺开 1.3% 的库时，光看「已索引 16155」
            // 会以为整库都扫过了。分母来自 photos 表（老 worker 不上报时退回单个数）。
            (state.library
              ? compactCount(state.indexed || 0) + ' / ' + compactCount(state.library)
              : String(state.indexed || 0)) +
            ' · ' +
            t('本轮完成 ', 'Processed ') +
            (state.processed || 0) +
            ' · ' +
            t('失败 ', 'Failed ') +
            (state.failed || 0) +
            ' · ' +
            t('跳过 ', 'Skipped ') +
            (state.skipped || 0) +
            ' · ' +
            t('人物 ', 'People ') +
            (state.people || 0) +
            ' · ' +
            t('人脸 ', 'Faces ') +
            (state.faces || 0) +
            (state.file ? ' · ' + state.file + ' ' + state.percent + '%' : '');
        taskButtons.forEach((item) => {
          item.disabled = state.busy;
        });
        if (buildButton) buildButton.disabled = state.busy || !state.ready;
        if (stopButton) stopButton.disabled = !state.busy;
        if (state.error) errorLine.textContent = explain(state.error);
        if (finished && !detail && !panel) pendingNavigation = () => groups();
        else if (liveChanged && !detail && !panel && !pendingNavigation)
          pendingNavigation = () => groups();
        if (panel && !state.busy && !settingsLoaded && loadPreferences)
          pendingNavigation = loadPreferences;
      });
    }
    function renderSettings() {
      // 2026-10-05：桌面端设置页把索引配置拆成了独立面板「AI 与索引」，这一块不再受
      // 「后台任务清单里的一行」约束。早先折叠的理由正是「展开的表单会比同清单的其它
      // 任务行高出一个量级」——独立成面板后该理由消失，于是去掉 <details>，设置项直接
      // 铺开（用户反馈：不要存在设置项按钮隐藏）。
      // 仍然只在设置页模式（panel）渲染：网页端的人物弹窗不做识别设置。
      settingsPanel = node('section', '', 'people-settings');
      // 这里**不再有任何说明文字**：早先「当前方案：<识别器名>」与一行旧记录归因放在
      // <fieldset> 外面，理由是它们在索引期间最该看得见 —— 但那两句与上方任务行的引导句
      // 讲的是同一件事（库里是什么、为什么人物页为空），同一块面板里读两遍只会把表单推远。
      // 现役识别器与旧记录归因统一由任务行的引导句承担，这里只留可操作的控件。
      settingsFields = node('fieldset');
      settingsFields.disabled = true;
      const groupingLabel = node('label', t('归组方式', 'Grouping method'));
      const grouping = node('select');
      grouping.setAttribute('aria-label', t('归组方式', 'Grouping method'));
      for (const item of [
        {
          value: 'cluster',
          label: ['视觉聚类（按人脸相似度）', 'Visual clustering (face similarity)'],
        },
        {
          value: 'scoped',
          label: [
            '按目录分域聚类（目录内比对特征）',
            'Clustered within folders (compare faces inside each folder)',
          ],
        },
        { value: 'folder', label: ['按文件夹（一个文件夹一个人）', 'By folder (one folder per person)'] },
      ]) {
        const option = node('option', t(item.label[0], item.label[1]));
        option.value = item.value;
        grouping.append(option);
      }
      groupingLabel.append(grouping);
      const modeLabel = node('label', t('分组相似度阈值', 'Grouping similarity threshold'));
      const mode = node('input');
      mode.type = 'number';
      mode.min = String(THRESHOLD_RANGE.min);
      mode.max = String(THRESHOLD_RANGE.max);
      mode.step = String(THRESHOLD_RANGE.step);
      mode.setAttribute('inputmode', 'decimal');
      mode.setAttribute('aria-label', t('分组相似度阈值', 'Grouping similarity threshold'));
      // 开箱即带默认值：读到真值之前框里也不是空的，用户不必先猜这里能填什么。
      mode.value = formatThreshold(THRESHOLD_RANGE.default);
      modeLabel.append(mode);
      const depthLabel = node('label', t('文件夹层级', 'Folder depth'));
      const depth = node('input');
      depth.type = 'number';
      depth.min = String(DEPTH_RANGE.min);
      depth.max = String(DEPTH_RANGE.max);
      depth.step = '1';
      depth.setAttribute('inputmode', 'numeric');
      depth.setAttribute('aria-label', t('文件夹层级', 'Folder depth'));
      depth.value = String(DEPTH_RANGE.default);
      depthLabel.append(depth);
      // 域分组：一行一个域，域内用逗号分隔目录名。只写一个名字 = 自成一域（与不写等价），
      // 所以「想拆开」只要把同行的伙伴删掉，不必去别处改。
      const domainsLabel = node(
        'label',
        t(
          '域分组（一行一个域，用逗号分隔目录名）',
          'Domain groups (one per line, folder names separated by commas)',
        ),
      );
      const domains = node('textarea');
      domains.rows = 3;
      domains.placeholder = '116, 117';
      domains.setAttribute(
        'aria-label',
        t('域分组', 'Domain groups'),
      );
      domainsLabel.append(domains);
      const fallbackLabel = node('label', '', 'people-checkbox');
      const fallback = node('input');
      fallback.type = 'checkbox';
      fallbackLabel.append(
        fallback,
        node('span', t('原图读取失败时尝试缩略图', 'Try thumbnails if originals cannot be read')),
      );
      const hint = node('p');
      const feedback = node('p');
      feedback.setAttribute('role', 'status');
      // 三种归组方式要填的参数不同，切换时把不适用的一项藏起来 —— 否则用户会在阈值上
      // 拧半天才发现「按文件夹」根本不看阈值。
      function syncGrouping() {
        const mode = grouping.value;
        modeLabel.hidden = mode === 'folder';
        depthLabel.hidden = mode === 'cluster';
        domainsLabel.hidden = mode !== 'scoped';
        if (mode === 'folder')
          hint.textContent = t(
            '同一个文件夹里的脸都归为一个人物，人物名取自文件夹名。层级表示「根目录往下数第几层」—— 照片在 K:\\COS\\116\\某图包\\ 里时，层级 1 归到「116」，层级 2 会归到「某图包」。这个模式不比对特征，只认目录；所以一个文件夹里若真有两个人，它也会并成一个。',
            'Every face in one folder becomes one person, named after the folder. Depth counts levels below the root folder. This mode trusts your folder layout and does not compare faces, so two people sharing one folder are merged into one.',
          );
        else if (mode === 'scoped')
          hint.textContent = t(
            '目录只当边界：同一个域里才互相比较特征，跨域绝不合并。目录就是一个人时结果和「按文件夹」一样；一个目录里有多个人时会自动拆开（拆出来的组没有名字，等你命名）。同一个人的照片分散在多个目录时，在上面的「域分组」里把它们写成一行（如 116, 117）就并进同一个域。「层级」决定边界划在根目录往下第几层 —— 边界之下的更深子目录会并回边界这一层，同一层里直接散放的照片也留在这一层，不会被塞进它的某个子目录。代价：同一个人的照片若分别放在两个目录、又没圈进同一个域，会被拆成两个人。',
            'Folders act as boundaries: faces are compared only inside the same domain, never across. If a folder is one person the result matches “By folder”; if a folder holds several people they are split apart automatically (the split groups stay unnamed). To keep one person spread over several folders together, list those folder names on one line above (e.g. 116, 117). “Depth” picks the level below the root the boundary is drawn at — deeper subfolders under it collapse back into it, and photos sitting loose at that level stay there instead of being pushed into a subfolder. Cost: if one person appears in two folders that are not grouped into the same domain, they become two people.',
          );
        else
          hint.textContent = t(
            '越低越容易归到同一人（同一人更少被拆开），越高越保守。默认 ' +
              formatThreshold(THRESHOLD_RANGE.default) +
              '。它现在是**聚类的连边门槛**：两张脸的相似度达到这个值才可能进同一组（全局聚类），不再是与组内平均值的比较，别照搬旧数字。改动只影响后续识别 —— 要让已有分组也用上，点下面的「按当前设置重新归组」。',
            'Lower links more readily (fewer splits of one person); higher is more conservative. Default ' +
              formatThreshold(THRESHOLD_RANGE.default) +
              '. This is now the linking threshold for clustering: two faces can land in the same group only if their similarity reaches it (global clustering) — it is no longer a comparison against a group average, so old values do not carry over. Changes apply to future recognition only — use “Regroup with current settings” below to re-apply.',
          );
      }
      grouping.addEventListener('change', syncGrouping);
      syncGrouping();
      settingsFields.append(
        groupingLabel,
        modeLabel,
        depthLabel,
        domainsLabel,
        fallbackLabel,
        hint,
        button(t('保存识别设置', 'Save recognition settings'), async () => {
          await call(
            'saveSettings',
            {
              grouping: grouping.value,
              matchThreshold: clampThreshold(mode.value),
              groupingDepth: clampDepth(depth.value),
              domainGroups: domains.value,
              thumbnailFallback: fallback.checked,
            },
            () => {
              mode.value = formatThreshold(clampThreshold(mode.value));
              depth.value = String(clampDepth(depth.value));
              feedback.textContent = t(
                '已保存，下次索引生效。',
                'Saved. Applies to the next index run.',
              );
            },
          );
        }),
        button(t('按当前设置重新归组', 'Regroup with current settings'), async () => {
          // 已存的人脸特征直接重算，不重跑模型：秒级完成，命名过的人物原地保留。
          await call('regroup', {}, (result) => {
            feedback.textContent = t(
              '已重新归组：' +
                (result.people || 0) +
                ' 个人物、' +
                (result.faces || 0) +
                ' 张人脸，调整了 ' +
                (result.regrouped || 0) +
                ' 张的归属。',
              'Regrouped into ' +
                (result.people || 0) +
                ' people from ' +
                (result.faces || 0) +
                ' faces; ' +
                (result.regrouped || 0) +
                ' faces changed person.',
            );
          });
        }),
        feedback,
      );
      settingsPanel.append(settingsFields);
      loadPreferences = () => {
        if (settingsLoaded) return;
        const load = () => {
          if (busy) {
            pendingNavigation = load;
            return;
          }
          void call('settings', {}, (value) => {
            // 四项都按「缺字段 → 回落默认」处理：settings 正常会给全，但写死默认值
            // 比让下拉/输入框显示 `undefined` 好收场。
            grouping.value =
              value.grouping === 'folder' || value.grouping === 'scoped'
                ? value.grouping
                : 'cluster';
            mode.value = formatThreshold(value.matchThreshold);
            depth.value = String(clampDepth(value.groupingDepth));
            domains.value = typeof value.domainGroups === 'string' ? value.domainGroups : '';
            fallback.checked = value.thumbnailFallback;
            syncGrouping();
            settingsLoaded = true;
            settingsFields.disabled = !!(lastState && lastState.busy);
          });
        };
        if (!lastState || !lastState.busy) load();
      };
      // 加载时机改由 refresh() 的状态回调负责（panel 模式下「面板可见即加载」），
      // 不再依赖 <details> 的 toggle 事件。
      return settingsPanel;
    }
    function image(data, alt) {
      const img = node('img');
      img.src = data;
      img.alt = alt;
      img.loading = 'lazy';
      return img;
    }
    function personName(person) {
      return person.name || t('未命名人物', 'Unnamed person');
    }
    function renderMessage(message) {
      // content 平时是 people-grid（auto-fill 列），纯文案直接塞进去会被压进一列宽里
      // 逐字换行，所以文案态要切到非网格布局。
      content.className = 'people-message';
      const box = node('div', '', 'people-empty');
      box.append(node('span', '', 'people-empty-icon'), node('p', message, 'people-empty-title'));
      content.replaceChildren(box);
    }
    function groups(after = 0) {
      if (panel) return;
      if (busy) {
        pendingNavigation = () => groups(after);
        return;
      }
      generation++;
      detail = null;
      void call('groups', { after }, (data) => {
        const indexing = !!(lastState && lastState.busy);
        controls.replaceChildren();
        navigation.replaceChildren();
        if (!data.items.length) {
          // 「还没有识别到人物」与「索引是上一代识别器建的」在数据上都是 0 条，但指向的动作
          // 完全不同：前者让人以为从没建过（甚至以为照片有问题），后者才指向「重建索引」。
          const stale = Number(lastState && lastState.staleScans) || 0;
          renderMessage(
            indexing
              ? t('正在识别人脸…', 'Detecting faces…')
              : stale > 0
                ? t(
                    '索引是上一代识别器建立的，与当前识别器不兼容，所以这里没有可显示的人物。请到「设置 → 人脸识别与人物索引」重建索引。',
                    'The index was built by an older recognizer and is incompatible with the current one, so there is nothing to show here. Rebuild it from Settings → Face recognition and indexing.',
                  )
                : t('还没有识别到人物', 'No people detected yet'),
          );
          return;
        }
        content.className = 'people-grid';
        content.replaceChildren();
        if (indexing)
          content.append(
            node(
              'span',
              t('索引中', 'Indexing') +
                ' · ' +
                ((lastState && lastState.people) || data.items.length) +
                t(' 人', ' people'),
              'people-live',
            ),
          );
        data.items.forEach((person) => {
          const card = button('', () => photos(person));
          card.classList.add('people-card');
          const avatar = node('span', '', 'people-avatar');
          avatar.append(image(person.thumbnail, personName(person)));
          card.append(
            avatar,
            node('strong', personName(person), 'people-name'),
            node(
              'span',
              '#' + person.id + ' · ' + person.photoCount + t(' 张', ' photos'),
              'people-meta',
            ),
          );
          content.append(card);
        });
        if (after) navigation.append(button(t('回到第一页', 'First page'), () => groups()));
        if (data.next)
          navigation.append(button(t('下一页人物', 'Next people'), () => groups(data.next)));
      });
    }
    function photos(person, after = 0) {
      if (busy) {
        pendingNavigation = () => photos(person, after);
        return;
      }
      generation++;
      detail = person;
      void call('photos', { personId: person.id, after }, (data) => {
        content.replaceChildren();
        controls.replaceChildren();
        navigation.replaceChildren();
        const back = button(t('全部人物', 'All people'), () => groups());
        back.classList.add('people-back');
        controls.append(
          back,
          node('h3', personName(person) + ' #' + person.id, 'people-detail-title'),
          node('span', data.items.length + t(' 张照片', ' photos'), 'people-detail-count'),
        );
        if (options.manage) {
          const renameRow = node('div', '', 'people-tool-row');
          renameRow.hidden = true;
          const name = node('input');
          name.maxLength = 80;
          name.value = person.name || '';
          name.setAttribute('aria-label', t('人物姓名', 'Person name'));
          renameRow.append(
            name,
            toolButton(t('保存', 'Save'), async () => {
              let done = false;
              await call('rename', { personId: person.id, name: name.value }, () => {
                person.name = name.value.trim();
                done = true;
              });
              if (done) photos(person, after);
            }),
          );
          const mergeRow = node('div', '', 'people-tool-row');
          mergeRow.hidden = true;
          const target = node('input');
          target.type = 'number';
          target.min = '1';
          target.placeholder = t('目标人物编号 #', 'Target person #');
          target.setAttribute('aria-label', target.placeholder);
          mergeRow.append(
            target,
            toolButton(t('确认合并', 'Merge'), async () => {
              if (
                !target.value ||
                !global.confirm(
                  t(
                    '将此组并入人物 #' + target.value + '？照片不会删除。',
                    'Merge this group into person #' + target.value + '? Photos are not deleted.',
                  ),
                )
              )
                return;
              let done = false;
              await call('merge', { from: person.id, to: Number(target.value) }, () => {
                done = true;
              });
              if (done) groups();
            }),
          );
          const tools = node('div', '', 'people-toolbar');
          tools.append(
            toolButton(t('重命名', 'Rename'), () => {
              renameRow.hidden = !renameRow.hidden;
              mergeRow.hidden = true;
              if (!renameRow.hidden) name.focus();
            }),
            toolButton(t('合并到…', 'Merge into…'), () => {
              mergeRow.hidden = !mergeRow.hidden;
              renameRow.hidden = true;
              if (!mergeRow.hidden) target.focus();
            }),
          );
          controls.append(tools, renameRow, mergeRow);
        }
        if (!data.items.length)
          renderMessage(t('这一组已经没有照片了。', 'No current photos in this group.'));
        else content.className = 'people-grid people-photo-grid';
        data.items.forEach((photo) => {
          const card = node('section', '', 'people-card people-photo');
          const view = button('', () => {
            if (!embedded) dialog.close();
            options.preview(photo);
          });
          view.classList.add('people-photo-view');
          view.append(
            image(photo.thumbnail, photo.file_name),
            node('span', photo.file_name, 'people-photo-name'),
          );
          card.append(view);
          if (options.manage) {
            const fixRow = node('div', '', 'people-tool-row');
            fixRow.hidden = true;
            const target = node('input');
            target.type = 'number';
            target.min = '1';
            target.placeholder = t('目标编号', 'Target #');
            target.setAttribute('aria-label', target.placeholder);
            fixRow.append(
              target,
              toolButton(t('确认', 'Apply'), async () => {
                let done = false;
                await call(
                  'move',
                  { faceId: photo.faceId, target: target.value ? Number(target.value) : null },
                  () => {
                    done = true;
                  },
                );
                if (done) photos(person, after);
              }),
            );
            const fix = toolButton(t('纠正', 'Fix'), () => {
              fixRow.hidden = !fixRow.hidden;
              fix.setAttribute('aria-expanded', fixRow.hidden ? 'false' : 'true');
              if (!fixRow.hidden) target.focus();
            });
            fix.setAttribute('aria-expanded', 'false');
            fix.classList.add('people-photo-fix');
            card.append(fix, fixRow);
          }
          content.append(card);
        });
        if (after) navigation.append(button(t('回到第一页', 'First page'), () => photos(person)));
        if (data.next)
          navigation.append(button(t('更多照片', 'More photos'), () => photos(person, data.next)));
      });
    }
    function open() {
      if (isOpen()) return;
      generation++;
      lastState = null;
      settingsLoaded = false;
      detail = null;
      dialog.replaceChildren();
      dialog.setAttribute(
        'aria-label',
        panel ? t('人脸识别', 'Face recognition') : t('人物', 'People'),
      );
      const header = node('header', '', 'ai-header');
      header.append(
        node('h2', panel ? t('人脸识别', 'Face recognition') : t('人物', 'People'), 'people-title'),
      );
      // 整页模式标题右侧放刷新；弹窗模式下刷新在前、关闭收在最右。
      if (!panel)
        header.append(
          toolButton(t('刷新', 'Refresh'), () => {
            if (detail) photos(detail);
            else groups();
          }),
        );
      if (!embedded) header.append(button(t('关闭 · Esc', 'Close · Esc'), () => dialog.close()));
      errorLine = node('p', '', 'ai-error');
      errorLine.setAttribute('role', 'alert');
      controls = node('div', '', 'people-controls');
      content = node('div', '', 'people-grid');
      navigation = node('nav', '', 'ai-controls people-nav');
      // 设置页嵌入式面板不挂 header：命名由设置页的类目标题（「人物」）承担，
      // 否则面板内会再出现一个「人脸识别」标题，与类目标题同义重复且名字不一致。
      const children = panel ? [] : [header];
      if (panel) {
        // 设置面板保留说明、状态引导、前往人物页入口、任务按钮、进度与识别设置。
        stateLine = node('p');
        stateLine.setAttribute('role', 'status');
        guide = node(
          'p',
          t('正在读取模型和索引状态…', 'Reading model and index status…'),
          'people-guide',
        );
        // 命名人物发生在「人物」视图，本面板没有列表与命名入口。跨页的动作由这个按钮承载，
        // 而不是写在引导文案里让用户自己找；没有可命名的人物时整颗隐藏（见 refresh）。
        goPeopleButton = button(t('前往人物页', 'Open the people page'), () => {
          if (typeof options.navigate === 'function') options.navigate();
        });
        goPeopleButton.classList.add('ai-button-primary');
        goPeopleButton.hidden = true;
        progressBar = node('progress');
        progressBar.max = 100;
        progressBar.hidden = true;
        progressBar.setAttribute('aria-label', t('人脸索引进度', 'Face indexing progress'));
        toolbar = node('div', '', 'ai-controls');
        taskButtons = [];
        if (options.manage && !options.browseOnly) {
          const install = button(
            t('下载 / 校验模型（约 39 MB）', 'Download / verify models (~39 MB)'),
            async () => {
              await call('install', {}, (state) => {
                lastState = state;
              });
              void refresh();
            },
          );
          buildButton = button(t('建立 / 更新人脸索引', 'Build / update face index'), async () => {
            await call('index', {}, (state) => {
              lastState = state;
            });
            void refresh();
          });
          stopButton = button(t('停止', 'Stop'), async () => {
            await call('cancel');
            void refresh();
          });
          taskButtons.push(install, buildButton);
          buildButton.disabled = true;
          stopButton.disabled = true;
          toolbar.append(install, buildButton, stopButton);
        }
        // 静态说明（「在本机检测并分组人脸，不上传照片…」）已删除：这一块当时是
        // 「后台任务」清单里的一行，同清单其它行只有一行说明，这里再放一段解释
        // 只会把行撑高；动态状态由 guide（状态引导）与 stateLine 承担。
        children.push(guide, goPeopleButton, toolbar, progressBar, stateLine);
      }
      children.push(errorLine, controls, content, navigation);
      dialog.append(...children);
      if (panel && options.manage && !options.browseOnly) {
        toolbar.insertAdjacentElement('afterend', renderSettings());
        // 设置项直接铺开（2026-10-05 起这一块是独立面板「AI 与索引」的一节）：
        // 早先折在 <summary>识别设置</summary> 里，是因为它挤在「后台任务」清单中，
        // 展开的表单会比同清单其它行高出一个量级；独立成面板后该约束不再存在。
        // 偏好数据由 refresh() 的状态回调按需拉取（loadPreferences 只在未加载时发请求）。
      }
      if (embedded) dialog.hidden = false;
      else dialog.showModal();
      void refresh().then(() => {
        if (isOpen() && !panel) groups();
      });
      timer = setInterval(refresh, 3000);
    }
    dialog.addEventListener('close', () => {
      pendingNavigation = null;
      generation++;
      clearInterval(timer);
      dialog.replaceChildren();
      entry.focus();
    });
    global.addEventListener(
      'keydown',
      (event) => {
        if (!embedded && dialog.open && event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          dialog.close();
        }
      },
      true,
    );
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    new global.MutationObserver(() => {
      entry.textContent = t('人物', 'People');
      if (settingsEntry)
        settingsEntry.textContent = t('人脸识别与人物索引', 'Face recognition and indexing');
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return {
      showGroups() {
        groups();
      },
      showSettings() {
        if (settingsPanel) settingsPanel.scrollIntoView({ block: 'nearest' });
      },
      show() {
        if (!dialog.childElementCount) {
          open();
          return;
        }
        dialog.hidden = false;
        clearInterval(timer);
        timer = setInterval(refresh, 3000);
        void refresh();
      },
      hide() {
        if (!embedded) return;
        dialog.hidden = true;
        clearInterval(timer);
        // Keep the current person, pagination and scroll position across navigation.
      },
    };
  }
  // `clampThreshold` / `clampDepth` 一并导出：两边（主进程 / 浏览器）对「空框回落默认、
  // 越界夹紧」的行为必须一致，导出后回归可以直接对它们下断言，而不是隔着 DOM 猜。
  global.PeopleUI = { mount, clampThreshold, clampDepth };
})(window);
