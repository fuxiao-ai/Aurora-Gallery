'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'web', 'js', 'app.js');
let s = fs.readFileSync(file, 'utf8');

function ra(from, to) {
  s = s.split(from).join(to);
}

ra("'????'", "'\\u6240\\u6709\\u76EE\\u5F55'");
ra("'???: ' + (name || '??')", "'\\u6587\\u4EF6\\u5939: ' + (name || '\\u76EE\\u5F55')");
ra(
  "'??: ' + formatDateLabel(state.currentDate || '')",
  "'\\u65E5\\u671F: ' + formatDateLabel(state.currentDate || '')",
);
ra(
  "'???: ' + (rootName || '???')",
  "'\\u6839\\u76EE\\u5F55: ' + (rootName || '\\u6839\\u76EE\\u5F55')",
);
ra("'??: ' + state.searchQuery", "'\\u641C\\u7D22: ' + state.searchQuery");
ra(
  "if (btn) btn.textContent = state.subtitleEnabled ? '??:?' : '??:?';",
  "if (btn) btn.textContent = state.subtitleEnabled ? '\\u5B57\\u5E55:\\u5F00' : '\\u5B57\\u5E55:\\u5173';",
);
ra(
  "buildPreviewInfoText(photo, index) + ' ? ????...'",
  "buildPreviewInfoText(photo, index) + ' \\u00B7 \\u51C6\\u5907\\u64AD\\u653E...'",
);
ra(
  "buildPreviewInfoText(photo, index) + ' ? ?????'",
  "buildPreviewInfoText(photo, index) + ' \\u00B7 \\u5A92\\u4F53\\u4E0D\\u5B58\\u5728'",
);
ra(
  "buildPreviewInfoText(photo, index) + ' ? ????'",
  "buildPreviewInfoText(photo, index) + ' \\u00B7 \\u65E0\\u6CD5\\u64AD\\u653E'",
);
ra(
  "buildPreviewInfoText(photo, index) + ' ? ????'",
  "buildPreviewInfoText(photo, index) + ' \\u00B7 \\u7F51\\u7EDC\\u9519\\u8BEF'",
);
ra(
  "'??????????????? Web ???????' +",
  "'\\u76EE\\u5F55\\u52A0\\u8F7D\\u5931\\u8D25\\uFF1A\\u8BF7\\u786E\\u8BA4\\u5DF2\\u767B\\u5F55\\uFF0C\\u6216 Web \\u670D\\u52A1\\u6B63\\u5E38\\u8FD0\\u884C\\u3002' +",
);
ra('<div class="title">????</div>', '<div class="title">\\u52A0\\u8F7D\\u5931\\u8D25</div>');
ra(
  "alert('??????????????????');",
  "alert('\\u5DF2\\u5B89\\u88C5\\u5230\\u684C\\u9762\\uFF0C\\u53EF\\u76F4\\u63A5\\u5728\\u624B\\u673A\\u684C\\u9762\\u6253\\u5F00\\u3002');",
);
ra(
  "alert('??? Safari ??????????????????????');",
  "alert('\\u8BF7\\u70B9\\u51FB Safari \\u5E95\\u90E8\\u201C\\u5206\\u4EAB\\u201D\\u6309\\u94AE\\uFF0C\\u7136\\u540E\\u9009\\u62E9\\u201C\\u6DFB\\u52A0\\u5230\\u4E3B\\u5C4F\\u5E55\\u201D\\u3002');",
);
ra(
  "alert('??????????????????????????????');",
  "alert('\\u8BF7\\u70B9\\u51FB\\u6D4F\\u89C8\\u5668\\u53F3\\u4E0A\\u89D2\\u83DC\\u5355\\uFF0C\\u9009\\u62E9\\u201C\\u5B89\\u88C5\\u5E94\\u7528\\u201D\\u6216\\u201C\\u6DFB\\u52A0\\u5230\\u4E3B\\u5C4F\\u5E55\\u201D\\u3002');",
);
ra(
  "formatNumber(stats.totalPhotos) + ' ??? | ' + formatSize(stats.totalSize);",
  "formatNumber(stats.totalPhotos) + ' \\u5F20\\u7167\\u7247 | ' + formatSize(stats.totalSize);",
);
ra(
  '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">?????</div>',
  '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">\\u6682\\u65E0\\u6587\\u4EF6\\u5939</div>',
);
ra(
  '<span class="icon">P</span><span class="name">????</span>',
  '<span class="icon">\\uD83D\\uDDBC\\uFE0F</span><span class="name">\\u6240\\u6709\\u7167\\u7247</span>',
);
ra(
  '<span class="icon">D</span><span class="name">????</span>',
  '<span class="icon">\\uD83D\\uDDC2\\uFE0F</span><span class="name">\\u6240\\u6709\\u76EE\\u5F55</span>',
);
ra("(hasChildren ? '??' : '??')", "(hasChildren ? '\\uD83D\\uDCC1' : '\\uD83D\\uDCC2')");
ra(
  "$('#toolbarPath').textContent = '???: ' + rootName;",
  "$('#toolbarPath').textContent = '\\u6839\\u76EE\\u5F55: ' + rootName;",
);
ra(
  '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">????</div>',
  '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">\\u6682\\u65E0\\u6570\\u636E</div>',
);
ra(
  '<span class="icon">A</span><span class="name">????</span>',
  '<span class="icon">\\uD83D\\uDCC5</span><span class="name">\\u6240\\u6709\\u65E5\\u671F</span>',
);
ra("'???: ' + name", "'\\u6587\\u4EF6\\u5939: ' + name");
ra("'??: ' + formatDateLabel(dateStr)", "'\\u65E5\\u671F: ' + formatDateLabel(dateStr)");
ra(
  '<div class="ext">!</div><div>??????</div>',
  '<div class="ext">\\u26A0\\uFE0F</div><div>\\u5C01\\u9762\\u52A0\\u8F7D\\u5931\\u8D25</div>',
);
ra(
  '<div class="ext">!</div><div>???????</div>',
  '<div class="ext">\\u26A0\\uFE0F</div><div>\\u7F29\\u7565\\u56FE\\u52A0\\u8F7D\\u5931\\u8D25</div>',
);
ra(
  '<div class="empty-state"><div class="icon">!</div><div class="title">??????</div></div>',
  '<div class="empty-state"><div class="icon">\\u26A0\\uFE0F</div><div class="title">\\u76EE\\u5F55\\u52A0\\u8F7D\\u5931\\u8D25</div></div>',
);
ra(
  '<div class="empty-state"><div class="icon">D</div><div class="title">????</div></div>',
  '<div class="empty-state"><div class="icon">\\uD83D\\uDDC2\\uFE0F</div><div class="title">\\u6682\\u65E0\\u76EE\\u5F55</div></div>',
);
ra("var emptyTitle = '??????';", "var emptyTitle = '\\u6CA1\\u6709\\u627E\\u5230\\u7167\\u7247';");
ra(
  "if (state.mediaFilter === 'video') emptyTitle = '??????';",
  "if (state.mediaFilter === 'video') emptyTitle = '\\u6CA1\\u6709\\u627E\\u5230\\u89C6\\u9891';",
);
ra(
  "else if (state.mediaFilter === 'image') emptyTitle = '??????';",
  "else if (state.mediaFilter === 'image') emptyTitle = '\\u6CA1\\u6709\\u627E\\u5230\\u56FE\\u7247';",
);
ra(
  '<span class="media-type-badge media-type-badge-video">??</span>',
  '<span class="media-type-badge media-type-badge-video">\\u89C6\\u9891</span>',
);
ra(
  '<div class="photo-info"><div class="photo-name">D ',
  '<div class="photo-info"><div class="photo-name">\\uD83D\\uDCC1 ',
);
ra(' items</div></div></div>', ' \\u5F20</div></div></div>');
ra(
  "$('#pageInfo').textContent = result.total + ' ?';",
  "$('#pageInfo').textContent = result.total + ' \\u5F20';",
);
ra("if (btn) btn.textContent = '??';", "if (btn) btn.textContent = '\\u6682\\u505C';");
ra("if (btn) btn.textContent = '? Play';", "if (btn) btn.textContent = '\\u64AD\\u653E';");
ra(
  "btn.textContent = state.slideshowRandom ? '???' : '??';",
  "btn.textContent = state.slideshowRandom ? '\\u968F\\u673A\\u5F00' : '\\u968F\\u673A';",
);
ra(
  "btn.textContent = document.fullscreenElement ? '????' : '??';",
  "btn.textContent = document.fullscreenElement ? '\\u9000\\u51FA\\u5168\\u5C4F' : '\\u5168\\u5C4F';",
);
ra("subtitleTrack.label = 'Subtitle';", "subtitleTrack.label = '\\u5B57\\u5E55';");
ra("if (!folderPath) return 'Folder';", "if (!folderPath) return '\\u76EE\\u5F55';");
ra(
  "return parts[1] + '?' + parseInt(parts[2], 10) + '?';",
  "return parts[1] + '\\u6708' + parseInt(parts[2], 10) + '\\u65E5';",
);
ra(
  '<strong style="color:#ff9a9a;">Web ??????</strong>',
  '<strong style="color:#ff9a9a;">Web \\u9519\\u8BEF\\uFF08\\u5F00\\u53D1\\uFF09</strong>',
);
ra(">??</button>' +", ">\\u6E05\\u7A7A</button>' +");

// tree arrow symbols
ra("toggle.textContent = '?';", "toggle.textContent = '\\u25BC';");
ra(
  "toggle.textContent = '\\u25BC';\n        } else {\n          children.classList.add('collapsed');\n          toggle.textContent = '\\u25BC';",
  "toggle.textContent = '\\u25BC';\n        } else {\n          children.classList.add('collapsed');\n          toggle.textContent = '\\u25B6';",
);
ra("')\">?</span>'", "')\">\\u25B6</span>'");

fs.writeFileSync(file, s, 'utf8');
console.log('fixed app.js text');
