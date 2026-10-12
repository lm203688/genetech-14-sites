#!/usr/bin/env node
/**
 * operations-plan/pipeline-citation-gaps-briefing.js
 * ─────────────────────────────────────────────────────────────────────────
 * 跨域研究空白月度简报生成器（B4）。
 *
 * 为什么需要它
 *   v2 报告 §6 B4「把缺口变成可发表资产」的验收判据是：
 *   "每个 gap 配 3–5 条证据 + 假设 + 反驳条件，出月度《跨域研究空白报告》"。
 *   本脚本把 pipeline-citation-gaps.js 产出的 gapPairs 转成**候选假设清单**：
 *   每条 gap 配**假设文本 + 优先级 + 反驳关键词**，交给人工/LLM 去外部数据库复核。
 *
 * 与 §9.1 的关键区别
 *   citation-gaps.json 里 gapPairs 只是"零引用有向站对"的**数学事实**，
 *   本脚本把它转成**语义假设**（"两域尚未打通"）+ **反驳条件**
 *   （"若 Google Scholar 上关键词 <N 篇则假设成立"），让报告可以直接对外发。
 *
 * Diff 机制
 *   首次运行只输出 Top-N；后续运行读上一次产物，输出新增/消失的 gapPair。
 *   这样月度报告可以写成"本月新出现 X 空白，Y 空白已桥接"，而不是重复列出全量 101 条。
 *
 * 用法
 *   node operations-plan/pipeline-citation-gaps-briefing.js                          # 全量 Top 30
 *   node operations-plan/pipeline-citation-gaps-briefing.js --top=50                 # Top 50
 *   node operations-plan/pipeline-citation-gaps-briefing.js --format=json            # 只输出 JSON 摘要
 *   node operations-plan/pipeline-citation-gaps-briefing.js --dry-run                # 只算不写
 *
 * 输出
 *   reports/cross-domain-gaps-<YYYY-MM>.md       # 人类可读报告
 *   reports/cross-domain-gaps-<YYYY-MM>.json     # 机器可读摘要
 *
 * 退出码：0 正常 / 1 数据源缺失或异常
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const REPORTS = path.join(ROOT, 'reports');
const INPUT = path.join(DATA, 'citation-gaps.json');
const INPUT_DEGREES = INPUT; // degrees 在同一文件

const argv = process.argv.slice(2);
const TOP = (() => {
  const hit = argv.find(a => a.startsWith('--top='));
  return hit ? parseInt(hit.slice(6), 10) : 30;
})();
const FORMAT = (() => {
  const hit = argv.find(a => a.startsWith('--format='));
  return hit ? hit.slice(8) : 'md';
})();
const DRY_RUN = argv.includes('--dry-run');

// ---------- 站点活跃度阈值（用于剔除"语料不足"造成的假 gap）----------
const MIN_DEGREE_FOR_PRIORITY_HIGH = 300;  // 两侧度都 ≥ 300 才算"高优先级"
const MIN_COMBINED_FOR_PRIORITY_HIGH = 18000;

// ---------- 语义假设模板（按站点名对做关键词组合）----------
const HYPOTHESIS_TEMPLATES = {
  // key = "siteA|siteB"（按字母序），value = 假设 + 反驳关键词
  'agent-ecosystem|neuromorphic': {
    hypothesis: '神经形态硬件上的多智能体系统尚无系统工作',
    keywords: ['neuromorphic multi-agent', 'spiking neural swarm'],
    refuteThreshold: 50,
  },
  'agent-ecosystem|semiconductor': {
    hypothesis: '面向智能体的定制半导体在两个域内几乎无引用',
    keywords: ['chiplet LLM accelerator agent', 'agent-specific accelerator'],
    refuteThreshold: 30,
  },
  'biomed-ai|exo-science': {
    hypothesis: '生物医学 AI 与地外环境医学尚未打通',
    keywords: ['space medicine AI', 'martian biology machine learning', 'space radiation cancer AI'],
    refuteThreshold: 100,
  },
  'bionic-ai|exo-science': {
    hypothesis: '生物启发 AI 与地外生命探测尚未打通',
    keywords: ['astrobiology bio-inspired search', 'exo-life detection AI'],
    refuteThreshold: 50,
  },
  'brain-science|quantum-computing': {
    hypothesis: '脑科学与量子计算（量子模拟神经网络）尚未打通',
    keywords: ['quantum neural dynamics', 'quantum brain simulation'],
    refuteThreshold: 50,
  },
  'brain-science|sat-6g': {
    hypothesis: '脑机接口与卫星通信（远程 BCI 手术）尚未打通',
    keywords: ['satellite BCI latency', 'space neuro'],
    refuteThreshold: 30,
  },
  'brain-science|semiconductor': {
    hypothesis: '神经形态芯片与脑科学研究尚未打通',
    keywords: ['neurochip BrainGate', 'neuromorphic implant'],
    refuteThreshold: 30,
  },
  'brain-science|synbio-manufacturing': {
    hypothesis: '合成生物学与脑科学（脑机接口生物材料）尚未打通',
    keywords: ['synbio neural interface', 'biofabricated neural probe'],
    refuteThreshold: 30,
  },
  'edge-ai|low-altitude': {
    hypothesis: '边缘 AI 与低空无人机（无云端感知决策）尚未打通',
    keywords: ['edge AI drone low altitude', 'onboard AI UAV'],
    refuteThreshold: 50,
  },
  'embodied-ai|carbon-neutral': {
    hypothesis: '具身智能与碳中和（绿色具身 AI）尚未打通',
    keywords: ['green embodied AI', 'energy efficient robot'],
    refuteThreshold: 30,
  },
  'agent-ecosystem|bionic-ai': {
    hypothesis: '多智能体与仿生智能的融合尚未形成独立研究方向',
    keywords: ['swarm bionic', 'multi-agent bio-inspired'],
    refuteThreshold: 50,
  },
};

// ---------- 通用模板（未列名的对走这个）----------
function genericHypothesis(a, b) {
  const degHint = '尚未打通';
  return {
    hypothesis: `${a} 与 ${b} 之间尚未形成跨域引用工作${degHint}`,
    keywords: [`${a.replace(/-/g, ' ')} ${b.replace(/-/g, ' ')}`,
               `${b.replace(/-/g, ' ')} ${a.replace(/-/g, ' ')}`],
    refuteThreshold: 30,
  };
}

// ---------- 输入加载 ----------
function loadGaps() {
  if (!fs.existsSync(INPUT)) {
    console.error(`[gaps-briefing] 缺少 ${INPUT}，先跑 pipeline-citation-gaps.js`);
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
  if (!Array.isArray(doc.gapPairs) || !doc.gapPairs.length) {
    console.error('[gaps-briefing] gapPairs 为空');
    process.exit(1);
  }
  return doc;
}

// ---------- 优先级判定 ----------
function classify(gap, degrees) {
  const a = degrees[gap.from];
  const b = degrees[gap.to];
  if (!a || !b) return 'low';
  const minDegree = Math.min(a.inDegree, a.outDegree, b.inDegree, b.outDegree);
  const maxDegree = Math.max(a.inDegree, a.outDegree, b.inDegree, b.outDegree);
  // 两侧都活跃（至少各有 300 度的活动量）+ 两站规模都大 → 高优先级
  if (minDegree >= MIN_DEGREE_FOR_PRIORITY_HIGH && gap.combinedSize >= MIN_COMBINED_FOR_PRIORITY_HIGH) return 'high';
  // 一侧活跃一侧边缘（可能是语料不足）→ 中
  if (maxDegree >= 500) return 'medium';
  return 'low';
}

// ---------- Diff 上次产物 ----------
function loadPrevious(period) {
  const prev = fs.readdirSync(REPORTS)
    .filter(f => f.startsWith('cross-domain-gaps-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .find(f => f !== `cross-domain-gaps-${period}.json`);
  if (!prev) return null;
  return JSON.parse(fs.readFileSync(path.join(REPORTS, prev), 'utf-8'));
}

function diffGapPairs(prev, curr) {
  if (!prev || !Array.isArray(prev.gapPairs)) return { new: curr, disappeared: [] };
  const prevSet = new Set(prev.gapPairs.map(p => `${p.from}|${p.to}`));
  const currSet = new Set(curr.map(p => `${p.from}|${p.to}`));
  const newPairs = curr.filter(p => !prevSet.has(`${p.from}|${p.to}`));
  const disappeared = [...prevSet].filter(k => !currSet.has(k))
    .map(k => {
      const [from, to] = k.split('|');
      return prev.gapPairs.find(p => p.from === from && p.to === to);
    });
  return { new: newPairs, disappeared };
}

// ---------- 渲染 Markdown ----------
function renderMarkdown({ topPairs, allPairs, stats, degrees, diff, period }) {
  const lines = [];
  lines.push(`# 跨域研究空白报告 · ${period}`);
  lines.push('');
  lines.push('> 由 `operations-plan/pipeline-citation-gaps-briefing.js` 自动生成。');
  lines.push('> 数据来源：`data/citation-gaps.json`（`pipeline-citation-gaps.js` 产出）。');
  lines.push('> 端点：`GET https://api.swarmlabs.tools/v1/citation/gaps`');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 0. 读前须知');
  lines.push('');
  lines.push('"研究空白"是**有向站对**——A 站没引用过 B 站的任何实体。它**不等于**真实世界级空白，');
  lines.push('因为存在两种可能：');
  lines.push('');
  lines.push('1. **真实空白**：两域在人类知识里真的没打通（我们想卖的资产）');
  lines.push('2. **语料不足**：本项目在这两个域覆盖太浅，抓不到实际存在的引用');
  lines.push('');
  lines.push('每条 gap 附**反驳关键词 + 阈值**——拿去 Google Scholar 复核，若引用 < 阈值则本假设成立。');
  lines.push('**这份报告是候选清单，不是结论。**');
  lines.push('');

  if (diff.new.length || diff.disappeared.length) {
    lines.push('---');
    lines.push('');
    lines.push('## 1. 与上月对比');
    lines.push('');
    lines.push(`- 新增空白：**${diff.new.length}** 条`);
    lines.push(`- 消失空白：**${diff.disappeared.length}** 条（可能已通过补数据桥接）`);
    if (diff.new.length) {
      lines.push('');
      lines.push('### 新增空白');
      for (const p of diff.new.slice(0, 10)) {
        lines.push(`- \`${p.from}\` ⇄ \`${p.to}\` (combinedSize=${p.combinedSize})`);
      }
    }
    if (diff.disappeared.length) {
      lines.push('');
      lines.push('### 消失空白');
      for (const p of diff.disappeared.slice(0, 10)) {
        lines.push(`- \`${p.from}\` ⇄ \`${p.to}\``);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 2. 总体分布');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---:|');
  lines.push(`| 有向站对总数 | ${stats.directedPairs} |`);
  lines.push(`| 有引用边 | ${stats.pairsWithEdges} (${(stats.pairsWithEdges / stats.directedPairs * 100).toFixed(1)}%) |`);
  lines.push(`| **零引用站对** | **${stats.gapPairs}** (${(stats.gapRatio * 100).toFixed(1)}%) |`);
  lines.push(`| 跨域桥 | ${Array.isArray(allPairs.bridges) ? allPairs.bridges.length : 0} |`);
  lines.push('');

  lines.push('## 3. Top ' + TOP + ' 空白假设');
  lines.push('');
  topPairs.forEach((row, i) => {
    lines.push(`### ${i + 1}. \`${row.gap.from}\` ⇄ \`${row.gap.to}\``);
    lines.push('');
    lines.push(`- **优先级**：${priorityLabel(row.priority)}`);
    lines.push(`- **假设**：${row.hypothesis}`);
    lines.push(`- **规模**：combinedSize=${row.gap.combinedSize}`);
    lines.push(`- **两站活跃度**：`);
    const a = degrees[row.gap.from];
    const b = degrees[row.gap.to];
    if (a) lines.push(`  - \`${row.gap.from}\` in=${a.inDegree} out=${a.outDegree}`);
    if (b) lines.push(`  - \`${row.gap.to}\` in=${b.inDegree} out=${b.outDegree}`);
    lines.push(`- **反驳条件**：查 Google Scholar / arXiv，关键词 [${row.keywords.join(' / ')}]，若近 5 年引用 < **${row.refuteThreshold}** 篇则本假设成立`);
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('## 4. 汇总判读');
  lines.push('');
  const counts = { high: 0, medium: 0, low: 0 };
  topPairs.forEach(r => counts[r.priority]++);
  lines.push(`- 🟢 高优先级：**${counts.high}**（两侧都活跃，值得优先复核）`);
  lines.push(`- 🟡 中优先级：**${counts.medium}**（一侧边缘，需先补数据）`);
  lines.push(`- ⚪ 低优先级：**${counts.low}**`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 5. 使用方式');
  lines.push('');
  lines.push('1. 挑一个 🟢 高优先级空白假设');
  lines.push('2. 用「反驳条件」里的关键词去 Google Scholar / arXiv 复核');
  lines.push('3. 若外部引用 < 阈值 → 本假设成立，可发布');
  lines.push('4. 若外部引用 ≥ 阈值 → 本假设不成立，是本项目语料不足');
  lines.push('5. 每月发布一次，累积形成"跨域空白演化史"');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 6. 复现命令');
  lines.push('');
  lines.push('```bash');
  lines.push('node operations-plan/pipeline-citation-gaps.js                    # 重建 gapPairs');
  lines.push('node operations-plan/pipeline-citation-gaps-briefing.js           # 重建本报告');
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`_本报告由 \`operations-plan/pipeline-citation-gaps-briefing.js\` 生成，${new Date().toISOString()}_`);
  lines.push('');
  return lines.join('\n');
}

function priorityLabel(p) {
  return p === 'high' ? '🟢 高' : p === 'medium' ? '🟡 中' : '⚪ 低';
}

// ---------- 主流程 ----------
function main() {
  const doc = loadGaps();
  const stats = doc.stats;
  const degrees = {};
  for (const [k, v] of Object.entries(doc.degrees || {})) degrees[v.site] = v;

  // 分类 + 优先级
  const classified = doc.gapPairs.map(gap => {
    const key = [gap.from, gap.to].sort().join('|');
    const template = HYPOTHESIS_TEMPLATES[key] || genericHypothesis(...[gap.from, gap.to].sort());
    return {
      gap,
      priority: classify(gap, degrees),
      ...template,
    };
  });

  // 高优先 → 中 → 低，同级按 combinedSize 降序
  const prioRank = { high: 0, medium: 1, low: 2 };
  classified.sort((a, b) => {
    if (prioRank[a.priority] !== prioRank[b.priority]) return prioRank[a.priority] - prioRank[b.priority];
    return b.gap.combinedSize - a.gap.combinedSize;
  });

  const topPairs = classified.slice(0, TOP);
  const period = new Date().toISOString().slice(0, 7);

  // Diff
  const prev = loadPrevious(period);
  const diff = diffGapPairs(prev, topPairs.map(r => r.gap));

  // 输出 Markdown
  if (FORMAT === 'md') {
    const md = renderMarkdown({ topPairs, allPairs: doc, stats, degrees, diff, period });
    const mdPath = path.join(REPORTS, `cross-domain-gaps-${period}.md`);
    if (DRY_RUN) {
      console.log(`[dry-run] 将写入 ${mdPath}`);
      console.log(md.slice(0, 500) + '\n...');
    } else {
      fs.writeFileSync(mdPath, md);
      console.log(`[briefing] 写入 ${mdPath}`);
    }
  }

  // 输出 JSON
  const summary = {
    generatedAt: new Date().toISOString(),
    period,
    source: INPUT,
    stats,
    topPairs: topPairs.map(r => ({
      from: r.gap.from,
      to: r.gap.to,
      combinedSize: r.gap.combinedSize,
      priority: r.priority,
      hypothesis: r.hypothesis,
      keywords: r.keywords,
      refuteThreshold: r.refuteThreshold,
    })),
    diff: {
      newCount: diff.new.length,
      disappearedCount: diff.disappeared.length,
      new: diff.new.slice(0, 20),
      disappeared: diff.disappeared.slice(0, 20),
    },
  };
  const jsonPath = path.join(REPORTS, `cross-domain-gaps-${period}.json`);
  if (DRY_RUN) {
    console.log(`[dry-run] 将写入 ${jsonPath}`);
  } else {
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    console.log(`[briefing] 写入 ${jsonPath}`);
  }

  console.log(`[briefing] Top ${topPairs.length} / ${doc.gapPairs.length} 空白假设 · 优先级分布 high=${classified.filter(r => r.priority === 'high').length} medium=${classified.filter(r => r.priority === 'medium').length} low=${classified.filter(r => r.priority === 'low').length}`);
  process.exit(0);
}

main();
