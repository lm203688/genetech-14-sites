import fs from 'fs';
import path from 'path';

const root = 'C:\\Users\\xing\\Desktop\\知识引擎14站';
const SKIP = new Set(['_site', '_site_test', 'node_modules', '.git', '.workbuddy', 'tools', 'docs', 'content', 'state', 'config', 'logs', 'mcp-server', 'operations-plan', 'api-guard', 'payment-template', 'genetech14-fixes', 'genetech14-audit-report', 'command-center', 'external-projects']);

// Discover top-level sites with website/api/entities.json
const entries = fs.readdirSync(root, { withFileTypes: true });
const perSite = {};
let total = 0;
let sites = 0;
for (const e of entries) {
  if (!e.isDirectory() || SKIP.has(e.name)) continue;
  const p = path.join(root, e.name, 'website', 'api', 'entities.json');
  if (fs.existsSync(p)) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      const n = Array.isArray(arr) ? arr.length : (arr.entities && Array.isArray(arr.entities) ? arr.entities.length : 0);
      perSite[e.name] = n;
      total += n;
      sites++;
    } catch (err) {
      perSite[e.name] = 'ERR:' + err.message;
    }
  }
}

let cursor = null;
try {
  cursor = JSON.parse(fs.readFileSync(path.join(root, 'state', 'backfill-cursor.json'), 'utf8'));
} catch (err) {
  cursor = 'ERR:' + err.message;
}

console.log(JSON.stringify({ total, sites, perSite, cursor }, null, 2));
