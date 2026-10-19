// 批量替换 content/coze/*.md 中的 workers.dev 端点为 genetech.tools
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'content/coze');
const FROM = 'genetech-license.61960005.workers.dev';
const TO = 'license.genetech.tools';

let files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md'));
let total = 0;
for (const f of files) {
  const p = path.join(DIR, f);
  const s = fs.readFileSync(p, 'utf8');
  if (s.includes(FROM)) {
    const n = s.split(FROM).length - 1;
    fs.writeFileSync(p, s.replaceAll(FROM, TO));
    total += n;
    console.log(`  ${f}: ${n} 处替换`);
  }
}
console.log(`\n完成：共 ${files.length} 个文件，替换 ${total} 处。`);
