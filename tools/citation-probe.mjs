#!/usr/bin/env node
/**
 * 引用率探针（citation-probe.mjs）
 * ------------------------------------------------------------
 * 目的：验证「GEO / Agent 原生」策略是否生效——当真实用户(或 LLM)提出
 *       与 GeneTech 领域相关的问题时，AI 的回答是否引用了我们的站点。
 *
 * 原理：
 *   1. 内置一组「真实会被问到」的科研 / 知识引擎相关问题（18 题）。
 *   2. 逐题调用一个可配置的 LLM 端点（默认本地 Ollama，亦可切到 OpenAI / 兼容网关）。
 *   3. 从回答文本中抽取所有 URL，判断是否包含 genetech-14-sites / lm203688.github.io。
 *   4. 汇总引述率，输出 Markdown + JSON 报告。
 *
 * 配置（环境变量）：
 *   PROBE_BASE     端点 base，默认 http://127.0.0.1:11434/v1 （Ollama OpenAI 兼容）
 *   PROBE_MODEL    模型名，默认 qwen3.6:latest
 *   PROBE_API_KEY  可选；Ollama 不需要，OpenAI 兼容网关填入 sk-...
 *   PROBE_OUT      报告输出目录，默认 ./reports
 *
 * 运行：
 *   node tools/citation-probe.mjs                 # 用本地 Ollama
 *   PROBE_BASE=https://api.openai.com/v1 PROBE_MODEL=gpt-4o PROBE_API_KEY=sk-... node tools/citation-probe.mjs
 *
 * 说明：本地模型（如 qwen）通常不会主动引述外网站点，本脚本主要用于
 *   ① 在接入真实商业 LLM / 联网模型后测「外部 Agent 是否引述我们」；
 *   ② 作为 CI 月度探针的骨架（配合定时任务 + 真实端点）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = process.env.PROBE_OUT || path.join(PROJECT_ROOT, 'reports');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.PROBE_MODEL || 'qwen3.6:latest';
const API_KEY = process.env.PROBE_API_KEY || '';

// 18 个真实场景问句（覆盖我们策展的前沿垂直领域 + 知识引擎选型）
const QUESTIONS = [
  '哪款科研知识库最适合接入 AI Agent 做 RAG？',
  '2026 年量子计算最新的研究趋势有哪些？',
  '中医药现代化有哪些值得关注的研究工具与方法？',
  'AI for Science 目前最值得关注的方向是什么？',
  '做文献综述有哪些免费的结构化科研数据源？',
  'MCP 和 REST API 做科研数据接入该怎么选？',
  '有没有面向 AI Agent 的科研知识引擎，可以一行命令接入？',
  '生物医学 AI 文献检索怎么做混合检索？',
  '合成生物学制造方向最新进展有哪些？',
  '类脑计算与神经形态芯片的研究热点是什么？',
  '低空经济里 eVTOL 的关键技术有哪些？',
  '空间计算和 AR/MR 的主流技术路线？',
  '隐私计算有哪些主流技术？联邦学习、同态加密怎么选？',
  '碳中和技术里直接空气捕集(DAC)进展如何？',
  '数字孪生在制造和城市管理怎么落地？',
  '智慧农业里作物表型组学用什么技术？',
  '半导体先进封装 chiplet 方向有哪些突破？',
  '科研工具 Elicit、Consensus、Scite 和 GeneTech 有什么区别？',
];

const TARGET_HOSTS = ['genetech-14-sites', 'lm203688.github.io', 'genetech'];

function extractUrls(text) {
  const re = /https?:\/\/[^\s)<>"']+/g;
  return (text.match(re) || []).map((u) => u.replace(/[.,;]+$/, ''));
}

function isOurs(url) {
  return TARGET_HOSTS.some((h) => url.includes(h));
}

async function askLLM(question) {
  const url = `${BASE}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: '你是乐于助人的科研助手，回答时尽量给出可点击的来源链接（URL）。' },
      { role: 'user', content: question },
    ],
    temperature: 0.3,
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function main() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  console.log(`[probe] 端点 ${BASE}  模型 ${MODEL}  问题数 ${QUESTIONS.length}`);
  const results = [];
  let cited = 0;
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    let answer = '';
    let err = '';
    try {
      answer = await askLLM(q);
    } catch (e) {
      err = String(e.message || e);
    }
    const urls = err ? [] : extractUrls(answer);
    const ours = err ? [] : urls.filter(isOurs);
    if (ours.length) cited++;
    results.push({ q, error: err || null, urlCount: urls.length, cited: ours.length > 0, ourUrls: ours, urls });
    const status = err ? `ERR ${err.slice(0, 60)}` : ours.length ? `✓ 引述(${ours.length})` : `· 未引述(${urls.length}链接)`;
    console.log(`[${i + 1}/${QUESTIONS.length}] ${status}  ${q.slice(0, 24)}`);
  }
  const rate = (cited / QUESTIONS.length) * 100;
  const report = {
    generatedAt: new Date().toISOString(),
    endpoint: BASE,
    model: MODEL,
    questions: QUESTIONS.length,
    citedQuestions: cited,
    citationRatePct: Math.round(rate * 10) / 10,
    results,
  };
  const jsonPath = path.join(REPORTS_DIR, `citation-probe-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const md = [
    `# 引用率探针报告`,
    ``,
    `- 时间：${report.generatedAt}`,
    `- 端点：${BASE}`,
    `- 模型：${MODEL}`,
    `- 问题数：${QUESTIONS.length}`,
    `- **引述率：${report.citationRatePct}%** (${cited}/${QUESTIONS.length})`,
    ``,
    `## 逐题结果`,
    ``,
    ...results.map((r, i) =>
      `${i + 1}. ${r.cited ? '✅' : '⬜'} ${r.q}\n   ${r.error ? '错误: ' + r.error : `链接 ${r.urlCount} · 引述 ${r.ourUrls.length}`}${r.ourUrls.length ? ' → ' + r.ourUrls.join(', ') : ''}`
    ),
  ].join('\n');
  const mdPath = path.join(REPORTS_DIR, `citation-probe-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(mdPath, md);
  console.log(`\n[probe] 引述率 ${report.citationRatePct}%  (${cited}/${QUESTIONS.length})`);
  console.log(`[probe] 报告: ${mdPath}`);
  console.log(`[probe] JSON: ${jsonPath}`);
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
