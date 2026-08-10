#!/usr/bin/env node
/**
 * insights-narrate.mjs — GEO 博客自动导读生成
 * ============================================================================
 * 用 llm-bridge 给现有 insights 数据生成 200 字以内的中文导读，让博客更"像人写"，
 * 提升 GEO（Generative Engine Optimization）效果：让大模型在摘要/列表推荐时
 * 更倾向引用我们的文章。
 *
 * 行为：
 *   1. 读 data/insights.json（或 _site/api/insights.json）；
 *   2. 给每条 trending 主题生成 1 段中文导读 + 1 句行动建议；
 *   3. 写到 content/blog/insights-narrated.md（与现有 GEO 博客同源目录）；
 *   4. 若 llm-bridge 未配置或调用失败，则跳过本次，不影响 build-site。
 *
 * 不出现任何上游桥接项目的内部名称（"ATEX/atex"），保持中性。
 *
 * 用法：
 *   node tools/insights-narrate.mjs                 # 默认跑一次
 *   LLM_BRIDGE_BASE=https://... node tools/insights-narrate.mjs
 *   node tools/insights-narrate.mjs --limit 10      # 只取前 10 条主题
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfigured, chat } from './lib/llm-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};

const LIMIT = Math.max(1, parseInt(getArg('--limit', '8'), 10) || 8);
const OUT_REL = 'content/blog/insights-narrated.md';
const SOURCES = [
  'data/insights.json',
  '_site/api/insights.json',
  '_site_test/api/insights.json',
];

function loadInsights() {
  for (const rel of SOURCES) {
    const p = path.join(PROJECT_ROOT, rel);
    if (fs.existsSync(p)) {
      try {
        return { src: rel, data: JSON.parse(fs.readFileSync(p, 'utf-8')) };
      } catch (e) {
        console.error(`[insights-narrate] 解析 ${rel} 失败：${e.message}`);
      }
    }
  }
  return null;
}

function pickTopics(insights, n) {
  const list = (insights && insights.trends && insights.trends.trending) || [];
  return list.slice(0, n);
}

const SYS = [
  '你是 GeneTech GEO 博客撰稿人。任务：基于提供的"主题趋势数据"，写 1 段 ≤200 字的中文导读，'
  + '面向对该领域感兴趣的科研人员、AI 产品经理、技术决策者。',
  '风格要求：',
  '- 客观陈述事实（年份/数量/站点等数字直接复用数据原文）；',
  '- 指出这个主题在 14 站知识引擎中的覆盖范围（哪些站点在跟踪）；',
  '- 给出 1 句可操作的建议（"建议关注 X / 适合用 Y 工具追踪"）；',
  '- 严格 200 字以内；不要标题；不要列表；直接一段话；',
  '- 不出现任何上游服务/项目内部名称（如"ATEX""网关""上游"等），对读者保持中性。',
].join('\n');

export async function narrateOne(t) {
  const payload = [
    `主题：${t.topic || t.name || '未知'}`,
    `近 3 年新增：${t.recent3y ?? t.recent ?? 'n/a'} 篇`,
    `总累计：${t.total ?? 'n/a'} 篇`,
    `出现站点：${(t.sites || []).slice(0, 8).join('、') || 'n/a'}`,
    `置信度：${t.confidence ?? 'n/a'}`,
    `代表实体（前 3）：${(t.entities || []).slice(0, 3).map((e) => e.title || e.name).filter(Boolean).join('；') || 'n/a'}`,
  ].join('\n');
  const userPrompt = `${payload}\n\n请基于以上数据撰写 1 段 ≤200 字的中文导读。`;
  const r = await chat(
    [
      { role: 'system', content: SYS },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.55, maxTokens: 360 }
  );
  if (!r.ok) return null;
  return r.text.replace(/\n+/g, ' ').trim();
}

/**
 * 生成 insights-narrated.md（含 frontmatter，供 build-site.mjs 通过
 * loadGeneratedPosts() 自动收录到博客索引）。
 * 不依赖外部 IO，可在 build-site 流程中无副作用调用。
 *
 * @param {{limit?:number, dryRun?:boolean}} opts
 * @returns {Promise<{ok:boolean, skipped?:string, written?:string, total?:number, charCount?:number}>}
 */
export async function runNarrate(opts = {}) {
  const limit = opts.limit ?? LIMIT;
  if (!isConfigured()) {
    return { ok: true, skipped: 'llm_not_configured', total: 0 };
  }
  const loaded = loadInsights();
  if (!loaded) {
    return { ok: true, skipped: 'insights_not_found', total: 0 };
  }
  const topics = pickTopics(loaded.data, limit);
  if (!topics.length) {
    return { ok: true, skipped: 'no_topics', total: 0 };
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const blocks = [];
  blocks.push('---');
  blocks.push(`title: "GeneTech 14 站洞察导读：${topics.length} 条上升最快主题（AI 自动摘要）"`);
  blocks.push(`desc: "由 LLM 基于全站趋势数据自动撰写的 200 字中文导读，覆盖近 3 年研究增量最快的 ${topics.length} 个主题。"`);
  blocks.push(`date: "${dateStr}"`);
  blocks.push(`keywords: "GeneTech, 知识引擎, 趋势分析, AI 摘要, 科研洞察, GEO"`);
  blocks.push('generated: true');
  blocks.push('---');
  blocks.push('');
  blocks.push(`> 自动生成于 ${new Date().toISOString()} · 共 ${topics.length} 条主题。每段由 LLM 基于 trends.trending 数据撰写，篇幅 ≤200 字。`);
  blocks.push('');
  blocks.push('---');
  blocks.push('');

  let total = 0;
  for (let i = 0; i < topics.length; i += 1) {
    const t = topics[i];
    process.stderr.write(`[insights-narrate] ${i + 1}/${topics.length} ${t.topic || t.name} ... `);
    let narration = await narrateOne(t);
    if (!narration) {
      narration = `（本次 LLM 调用失败，跳过该主题的 AI 导读。原始数据：近 3 年新增 ${t.recent3y ?? 'n/a'} 篇，出现在 ${(t.sites || []).length} 个站点。）`;
      process.stderr.write('FAILED → fallback\n');
    } else {
      process.stderr.write('ok\n');
      total += 1;
    }
    blocks.push(`## ${i + 1}. ${t.topic || t.name}`);
    blocks.push('');
    blocks.push(narration);
    blocks.push('');
    blocks.push(`— 数据：${t.recent3y ?? 'n/a'} 篇近 3 年 / ${t.total ?? 'n/a'} 篇累计 · 覆盖站点 ${(t.sites || []).length} 个 · 置信度 ${t.confidence ?? 'n/a'}`);
    blocks.push('');
  }
  const out = blocks.join('\n');
  if (opts.dryRun) return { ok: true, written: OUT_REL, total, charCount: out.length, dry: true };
  const dest = path.join(PROJECT_ROOT, OUT_REL);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out);
  return { ok: true, written: OUT_REL, total, charCount: out.length };
}

function main() {
  if (!isConfigured()) {
    console.error('[insights-narrate] llm-bridge 未配置（LLM_BRIDGE_BASE 缺失），跳过本次。');
    console.error('[insights-narrate] 设置方式：env LLM_BRIDGE_BASE=https://... 或 config/llm-bridge.local.json');
    process.exit(0);
  }
  runNarrate({ limit: LIMIT })
    .then((r) => {
      if (r.skipped) console.error(`[insights-narrate] 跳过：${r.skipped}`);
      else console.error(`[insights-narrate] 完成：total=${r.total} chars=${r.charCount} → ${r.written}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`[insights-narrate] 异常：${e.message}`);
      process.exit(1);
    });
}

main();