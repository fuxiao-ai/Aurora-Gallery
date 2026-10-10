'use strict';
/**
 * 任务进度百分比的**唯一来源**。
 *
 * 🔴 为什么要收成一处（2026-10-08 盘点发现）：「已处理 / 总数」这个除法在本工程里被
 *    **渲染端各算一遍** —— 扫描 2 处 + 无效清理 + 查重 + 人脸 + 搜图，而边界行为还不一致：
 *    无效清理那节在 `total === 0` 时把进度条画成 **100%**，另外五处画 **0%**。
 *    那一处不是风格差异，是**真会让进度条倒退**：清理起手先 `total = 0`，
 *    再异步取全库行数（`db.getStartupDiagnostics().photoCount`），于是那段时间条子是满的，
 *    `total` 到位后 `checked / total` = 0 ⇒ 条子**从 100% 掉回 0%**。
 *
 * 约定（见 `docs/contracts/background-tasks.md` §1.1）：
 *   · `total <= 0`（未知）⇒ 返回 `0`。界面按「未知」态另行表达（说「已处理 N」而不是画百分比），
 *     **不许拿 100 表示完成** —— 那会让「刚开始」和「已结束」长得一样；
 *   · 分子反超分母（扫描期间持续往库里塞新图）⇒ **夹到 100**，而不是把分子压下来：
 *     分子是「真的做了多少」，压它等于对用户少报工作量；
 *   · 一律取整 —— 界面上只画整数百分比。
 *
 * ⚠️ 只给**任务状态对象**用。渲染端那两个「把 (current, total) 画成条」的通用小工具
 *    （`scan-flow.js#updateProgress`、`app.js#updateProgress`）自己算这一格也行，
 *    但它们**必须与这里同一条边界规则**（`total = 0` ⇒ 0%、上限 100%）。
 */
function computePct(done, total) {
  var d = Number(done) || 0;
  var t = Number(total) || 0;
  if (!(t > 0)) return 0;
  var pct = Math.round((d / t) * 100);
  if (!isFinite(pct) || pct < 0) return 0;
  return pct > 100 ? 100 : pct;
}

module.exports = { computePct: computePct };
