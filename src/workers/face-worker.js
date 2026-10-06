'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const model = require('../ai/face-model');
const settings = require('../ai/face-settings');
const { FaceStore, AUTO_REGROUP_LIMIT } = require('../ai/face-store');
sharp.concurrency(1);
let cancelled = false,
  busy = false,
  controller;
const root = workerData.aiPath;
const models = path.join(root, 'models');
const progress = (state) => parentPort.postMessage({ progress: state });
const check = () => {
  if (cancelled) throw new Error('AI_CANCELLED');
};
const imageTypes = new Set(
  'jpg jpeg png webp gif bmp tif tiff heic heif avif cr2 cr3 nef nrw arw dng orf rw2 raw raf pef srw'.split(
    ' ',
  ),
);

async function execute(operation, args = {}) {
  fs.mkdirSync(root, { recursive: true });
  if (operation === 'settings') return settings.read(root);
  if (operation === 'saveSettings') return settings.save(root, args);
  if (operation === 'install') {
    controller = new AbortController();
    progress({ phase: 'downloading' });
    await model.install(models, controller.signal, progress);
    check();
    const encoder = await model.load(models);
    try {
      await encoder.detect(
        await sharp({ create: { width: 320, height: 320, channels: 3, background: '#888' } })
          .png()
          .toBuffer(),
        () => cancelled,
      );
      check();
      return { ready: true };
    } finally {
      await encoder.dispose();
      controller = null;
    }
  }
  const store = new FaceStore(workerData.dbPath, path.join(root, 'faces.sqlite'));
  let encoder;
  try {
    if (operation === 'status') return { ready: await model.verify(models), ...store.summary() };
    if (operation === 'groups') return store.groups(args.after);
    if (operation === 'photos') return store.photos(args.personId, args.after);
    if (operation === 'rename') return store.rename(args.personId, args.name);
    if (operation === 'merge') return store.merge(args.from, args.to);
    if (operation === 'move') return store.move(args.faceId, args.target);
    // 重新归组：用已落库的特征重跑分组，不重跑模型。归组方式与阈值都取当前设置
    // （按文件夹归组时阈值不参与，但一起传过去省得判断）。
    //
    // 🔴 返回值必须显式带上 `clustered: true`：手动归组正是对 `index` 那次「收尾全局聚类
    //    被 `AUTO_REGROUP_LIMIT` 跳过」的补偿，界面据此撤掉「当前分组只是增量近似」的提示
    //    （`semantic-search.js` 的结果白名单会把它写进 `status()`）。少了这一句，用户点完
    //    按钮提示仍然挂着，读起来就是「操作没生效」。
    if (operation === 'regroup')
      return { ...store.regroup(settings.read(root)), clustered: true };
    if (operation !== 'index') throw new Error('AI_BAD_OPERATION');
    const preferences = settings.read(root);
    progress({ phase: 'loading' });
    // 换识别器后 VERSION 变了，上一代的行既不可能是当前维度、也不会被任何读路径采纳。
    // 趁索引还没开始（没有别的写者）清掉，否则「已扫描 / 检出人脸 / 人物」的实时读数
    // 会带着上一代模型的数字虚高。
    store.purgeStale();
    encoder = await model.load(models);
    check();
    const representatives = store.representatives();
    // 倒序游标：起手「域内最大 id + 1」，之后每批续接「本批最后一行的 id」（倒序下那是**最小** id）。
    // ⚠️ 起手写成 0 会让 `p.id < 0` 恒空 —— 任务瞬间「完成」却一张没扫、一条日志都不报。
    let beforeId = store.maxPhotoId() + 1,
      processed = 0,
      failed = 0,
      skipped = 0,
      countsAt = 0;
    progress({ phase: 'indexing', ...store.counts() });
    const startedAt = Date.now();
    const report = (photo) =>
      progress({
        processed,
        failed,
        skipped,
        currentFile: photo.file_name,
        ratePerMinute: Math.round(
          ((processed + failed) * 60000) / Math.max(1000, Date.now() - startedAt),
        ),
      });
    while (true) {
      check();
      const rows = store.batch(beforeId);
      if (!rows.length) break;
      for (const photo of rows) {
        check();
        beforeId = photo.id;
        if (!imageTypes.has(path.extname(photo.file_name).slice(1).toLowerCase())) {
          skipped++;
          report(photo);
          await new Promise((resolve) => setImmediate(resolve));
          continue;
        }
        try {
          progress({ currentFile: photo.file_name });
          let detections;
          try {
            detections = await encoder.detect(photo.file_path, () => cancelled);
          } catch (error) {
            check();
            if (!preferences.thumbnailFallback || !photo.thumbnail) throw error;
            detections = await encoder.detect(photo.thumbnail, () => cancelled);
          }
          check();
          store.put(photo, detections, representatives, preferences);
          processed++;
        } catch (error) {
          check();
          failed++;
          progress({ lastFailedId: photo.id });
        }
        report(photo);
        await new Promise((resolve) => setImmediate(resolve));
      }
      // 每批上报一次「已扫描 / 已检出人脸 / 已识别人物」（节流 1.5s），让「人物」页在索引
      // 未结束时就能按人数变化增量刷新已识别结果，并显示「检出 N 张脸」的实时进度。
      const now = Date.now();
      if (now - countsAt >= 1500) {
        countsAt = now;
        progress(store.counts());
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    /**
     * 收尾：跑一次**全局聚类**（Chinese Whispers），让人物划分与本轮设置一致。
     *
     * 索引过程中 `put()` 给的是**增量近似** —— 边扫边并入最像的一组，顺序相关、
     * 也看不到全局结构（同一份真库数据：增量近似的阈值必须拧到 0.16 才有 0.880 的
     * F1，而全局聚类在 0.20 就是 0.879，且「同一个人被切成几块」从 23 降到 12）。
     * 所以真正的人物划分以这一次为准 —— 与 LAP「先扫脸、最后整体聚类」的流程一致。
     *
     * 规模超过 AUTO_REGROUP_LIMIT 时跳过（O(n²) 建图不适合塞在收尾里），
     * 用户仍可手动点「按当前设置重新归组」。
     */
    let clustered = false;
    if (store.counts().faces <= AUTO_REGROUP_LIMIT) {
      store.regroup(preferences);
      clustered = true;
    }
    return { ...store.summary(), processed, failed, skipped, clustered };
  } finally {
    store.close();
    if (encoder) await encoder.dispose();
  }
}
parentPort.on('message', async (message) => {
  if (message.cancel) {
    cancelled = true;
    if (controller) controller.abort();
    return;
  }
  if (busy) return;
  busy = true;
  cancelled = false;
  try {
    parentPort.postMessage({ done: true, result: await execute(message.operation, message.query) });
  } catch (error) {
    parentPort.postMessage({ done: true, error: cancelled ? 'AI_CANCELLED' : error.message });
  } finally {
    busy = false;
  }
});
