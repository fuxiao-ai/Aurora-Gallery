const fs = require('fs');

const path = 'src/web/js/app.js';
const vm = require('vm');
const original = fs.readFileSync(path, 'utf8');
const lines = original.split(/\r?\n/);

let fixed = 0;
for (let i = 0; i < 500; i++) {
  try {
    new vm.Script(lines.join('\n'), { filename: 'app.js' });
    break;
  } catch (err) {
    const stack = String((err && err.stack) || err);
    const m = stack.match(/app\.js:(\d+)/);
    if (!m) {
      console.error(stack);
      throw err;
    }
    const lineNo = Number(m[1]);
    const idx = lineNo - 1;
    if (idx < 0 || idx >= lines.length) throw err;
    const line = lines[idx];

    const singleCount = (line.match(/'/g) || []).length;
    const doubleCount = (line.match(/"/g) || []).length;
    let next = line;

    if (singleCount % 2 === 1 && /;\s*$/.test(line)) {
      next = line.replace(/;\s*$/, "';");
    } else if (doubleCount % 2 === 1 && /;\s*$/.test(line)) {
      next = line.replace(/;\s*$/, '";');
    } else {
      throw new Error(`cannot auto-fix line ${lineNo}: ${line}`);
    }

    if (next === line) {
      throw new Error(`no change for line ${lineNo}`);
    }
    lines[idx] = next;
    fixed++;
  }
}

new vm.Script(lines.join('\n'), { filename: 'app.js' });
fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log(`auto-fixed lines: ${fixed}`);
