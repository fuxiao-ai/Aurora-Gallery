#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

// 扫描范围：两端全部页面与脚本（排除 vendor 第三方资源）。
// 原先只扫 web 端两个文件，而乱码/编码事故同样会发生在渲染端，故改为按目录遍历。
function collectTargets() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(projectRoot, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.posix.join(rel, e.name);
      if (/vendor/.test(child)) continue;
      if (e.isDirectory()) walk(child);
      else if (/\.(js|html)$/.test(e.name)) out.push(child);
    }
  };
  walk('src/renderer');
  walk('src/web');
  return out.sort();
}

const targets = collectTargets();

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(text);
}

function isLikelyUiTextLine(line) {
  return /<[^>]+>|aria-label|placeholder|title=|textContent|innerHTML|alert\(/.test(line);
}

function detectIssues(line) {
  const issues = [];
  if (/\uFFFD/.test(line)) {
    issues.push('包含替换字符 �');
  }
  if (/�/.test(line)) {
    issues.push('包含异常字符 �');
  }
  if (/\?{2,}/.test(line) && (hasCjk(line) || isLikelyUiTextLine(line))) {
    issues.push('疑似问号占位乱码 (??...)');
  }
  if (
    (/[\u3400-\u9fff]\?/.test(line) || /\?[\u3400-\u9fff]/.test(line)) &&
    isLikelyUiTextLine(line)
  ) {
    issues.push('中文与问号混杂，疑似缺字');
  }
  if (/(^|[^<])\/(div|span|option|button|label|strong)>/.test(line)) {
    issues.push('疑似丢失 "<" 的闭合标签');
  }
  return issues;
}

function scanFile(relPath) {
  const absPath = path.join(projectRoot, relPath);
  if (!fs.existsSync(absPath)) {
    return { relPath, error: '文件不存在', findings: [] };
  }
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const issues = detectIssues(line);
    if (!issues.length) continue;
    findings.push({
      line: i + 1,
      issues,
      snippet: line.trim().slice(0, 200),
    });
  }
  return { relPath, findings, error: null };
}

function main() {
  let total = 0;
  const results = targets.map(scanFile);

  console.log('=== 文案/注释异常体检 ===');
  console.log(`目标文件: ${targets.length} 个（src/renderer + src/web，已排除 vendor）`);
  console.log('');

  for (const r of results) {
    if (r.error) {
      total += 1;
      console.log(`[${r.relPath}] 读取失败: ${r.error}`);
      console.log('');
      continue;
    }
    if (!r.findings.length) continue;
    console.log(`[${r.relPath}] 发现 ${r.findings.length} 处疑似问题`);
    for (const f of r.findings) {
      total += 1;
      console.log(`  - L${f.line}: ${f.issues.join('；')}`);
      console.log(`    ${f.snippet}`);
    }
    console.log('');
  }

  if (total > 0) {
    console.log(`总计疑似问题: ${total}`);
    process.exitCode = 2;
    return;
  }
  console.log('未发现疑似乱码或缺字问题。');
}

main();
