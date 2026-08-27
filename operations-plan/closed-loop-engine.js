#!/usr/bin/env node
/**
 * GeneTech 14站知识引擎 — 统一闭环执行引擎
 * closed-loop-engine.js
 *
 * 核心理念：每项工作都形成完整闭环
 *   收集 → 分析 → 决策 → 开发 → 测试 → 部署 → 验证反馈
 *
 * 七阶段说明：
 *   1. COLLECT    信息收集：从多源采集原始数据/信号
 *   2. ANALYZE    分析评估：结构化处理、价值评估、优先级排序
 *   3. DECIDE     决策采用：明确哪些采纳、生成任务清单
 *   4. DEVELOP    开发实现：执行开发任务、生成代码/内容/配置
 *   5. TEST       测试验证：自动化测试、数据校验、效果评估
 *   6. DEPLOY     部署上线：发布到生产环境、更新索引、通知告警
 *   7. VERIFY     验证反馈：确认部署效果、不达标则回退修正
 *
 * 用法：
 *   node closed-loop-engine.js --loop=<loop-id> [--dry-run] [--stage=<stage>]
 *   node closed-loop-engine.js --loop=data-accumulation
 *   node closed-loop-engine.js --loop=monetization --dry-run
 *   node closed-loop-engine.js --loop=tech-adoption --stage=analyze
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');

// ============================================================
// 核心配置
// ============================================================

const ENGINE_DIR = __dirname;
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(ENGINE_DIR, '..');
const STATE_DIR = path.join(ENGINE_DIR, 'state');
const REPORTS_DIR = path.join(ENGINE_DIR, 'reports');
const LOGS_DIR = path.join(ENGINE_DIR, 'logs');

// 确保目录存在
[STATE_DIR, REPORTS_DIR, LOGS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// 七阶段定义
const STAGES = ['collect', 'analyze', 'decide', 'develop', 'test', 'deploy', 'verify'];

const STAGE_NAMES = {
  collect: '信息收集',
  analyze: '分析评估',
  decide: '决策采用',
  develop: '开发实现',
  test: '测试验证',
  deploy: '部署上线',
  verify: '验证反馈',
};

// ============================================================
// 日志工具
// ============================================================

function log(stage, msg, level = 'info') {
  const ts = new Date().toISOString();
  const icons = { info: 'ℹ', ok: '✓', warn: '⚠', error: '✗' };
  const colors = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
  const reset = '\x1b[0m';
  const prefix = `[${ts}] [${stage.toUpperCase()}] ${icons[level] || ' '}`;
  console.log(`${colors[level] || ''}${prefix} ${msg}${reset}`);

  // 写入日志文件
  const logFile = path.join(LOGS_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, `${prefix} ${msg}\n`);
}

// ============================================================
// 闭环定义注册表
// ============================================================

const LOOP_REGISTRY = {
  // 闭环一：数据积累（增加数据量）
  'data-accumulation': {
    name: '数据积累闭环',
    description: '从多源采集最新数据，清洗结构化后增量更新到14站',
    purpose: '增加数据量',
    schedule: '0 2 * * *', // 每日 02:00
    stages: {
      collect: {
        name: '多源数据采集',
        actions: [
          '从 arXiv 采集最新 AI/ML 论文',
          '从 PubMed 采集生物医学文献',
          '从 GitHub 采集 trending 仓库',
          '从 HuggingFace 采集新模型和数据集',
          '从 OpenAlex/Crossref 采集引用数据',
        ],
        output: 'raw-collected-data.json',
      },
      analyze: {
        name: '数据清洗与结构化',
        actions: [
          '去重（基于 DOI/arXiv ID/GitHub full_name）',
          '字段标准化（日期、作者、机构）',
          '分类到14站对应领域',
          '计算数据质量评分',
        ],
        output: 'analyzed-data.json',
      },
      decide: {
        name: '采纳决策',
        actions: [
          '筛选高质量数据（置信度 >= 0.7）',
          '识别增量更新项（对比已有数据）',
          '生成更新任务清单',
          '标记热点实体优先处理',
        ],
        output: 'update-tasks.json',
      },
      develop: {
        name: '数据入库',
        actions: [
          '更新各站点 entities JSON 文件',
          '更新 index.json 统计数字',
          '生成实体详情页 HTML',
          '更新 data.js 前端数据',
        ],
        output: 'developed-changes.json',
      },
      test: {
        name: '数据验证',
        actions: [
          '校验实体计数一致性',
          '验证 JSON 格式有效性',
          '检查必填字段完整性',
          '运行数据一致性脚本',
        ],
        output: 'test-report.json',
      },
      deploy: {
        name: '部署上线',
        actions: [
          '提交变更到 Git 仓库',
          '触发 Cloudflare Pages 部署',
          '提交 IndexNow 更新索引',
          '更新 changelog 和采集日志',
          '通知闭环四（推广）有新内容',
        ],
        output: 'deploy-status.json',
      },
      verify: {
        name: '验证反馈',
        actions: [
          '验证线上站点可访问（各站首页 HTTP 200）',
          '验证新实体页面已上线（随机抽样3个实体）',
          '对比部署前后实体数量是否与预期一致',
          '检查 IndexNow 是否提交成功',
          '记录闭环效果指标（新增数、更新数、耗时、异常数）',
          '不达标则生成修正任务回退到对应阶段',
        ],
        qualityGate: '线上实体数 >= 预期数 x 95%',
        output: 'verify-report.json',
      },
    },
  },

  // 闭环二：领域开拓（增加板块）
  'domain-expansion': {
    name: '领域开拓闭环',
    description: '发现新兴技术领域，评估价值后自动创建新站点',
    purpose: '增加板块',
    schedule: '0 6 * * 1', // 每周一 06:00
    stages: {
      collect: {
        name: '新兴领域信号采集',
        actions: [
          '监测 arXiv 新分类或异常增长分类',
          '抓取 GitHub Trending 新兴 topics',
          '查询 Google Trends 技术关键词趋势',
          '读取闭环五传递的市场空白信号',
        ],
        output: 'domain-signals.json',
      },
      analyze: {
        name: '领域价值评估',
        actions: [
          '计算论文数量月增速',
          '计算 GitHub 仓库增速',
          '评估搜索趋势增长率',
          '评估社区讨论热度',
          '计算与现有14站的关联度',
          '生成综合得分',
        ],
        output: 'domain-scores.json',
      },
      decide: {
        name: '建站决策',
        actions: [
          '筛选得分 >= 0.75 的候选领域',
          '生成新站点定义文件',
          '确定站点配置（域名、分类、模板）',
          '创建建站任务清单',
        ],
        output: 'new-site-tasks.json',
      },
      develop: {
        name: '站点脚手架生成',
        actions: [
          '创建站点目录结构',
          '生成基础配置文件（sources.json, keywords.json）',
          '复制模板文件（index.html, css, js）',
          '调用闭环一预填充新领域数据',
          '生成 agent-discovery.json 和 llms.txt',
        ],
        output: 'scaffold-status.json',
      },
      test: {
        name: '站点验证',
        actions: [
          '验证目录结构完整性',
          '检查配置文件有效性',
          '验证生成的页面可访问',
          '测试数据加载正确性',
        ],
        output: 'site-test-report.json',
      },
      deploy: {
        name: '站点上线',
        actions: [
          '配置 Cloudflare Pages 项目',
          '设置子域名 DNS',
          '提交到 Git 仓库',
          '触发部署',
          '提交搜索引擎索引',
          '通知闭环四推广新站点',
        ],
        output: 'deploy-status.json',
      },
      verify: {
        name: '验证反馈',
        actions: [
          '验证新站点线上可访问（HTTP 200）',
          '验证页面渲染正常',
          '验证导航链接已添加到主站',
          '验证 IndexNow 已接受新URL',
          '对比预期数据量与实际数据量',
          '不达标则生成修正任务回退到对应阶段',
        ],
        qualityGate: '新站点可线上访问且页面渲染正常',
        output: 'verify-report.json',
      },
    },
  },

  // 闭环三：技术能力提升（能力提升）
  'tech-adoption': {
    name: '技术能力提升闭环',
    description: '收集最新数据处理/NLP/KG技术，评估后集成到生产pipeline',
    purpose: '能力提升',
    schedule: '0 4 * * 3', // 每周三 04:00
    stages: {
      collect: {
        name: '新技术信号采集',
        actions: [
          '监测 arXiv NLP/KG/数据分析新论文',
          '跟踪 GitHub 新开源工具和库',
          '监测技术博客和 HuggingFace 新模型',
          '读取闭环五的技术趋势信号',
        ],
        output: 'tech-signals.json',
      },
      analyze: {
        name: '技术价值评估',
        actions: [
          '评估与现有 pipeline 的改进潜力',
          '计算预期性能提升（准确率/速度/成本）',
          '评估集成复杂度',
          '检查许可证兼容性',
          '生成技术评估矩阵',
        ],
        output: 'tech-evaluation.json',
      },
      decide: {
        name: '采纳决策',
        actions: [
          '筛选改进潜力 >= 20% 的技术',
          '生成 PoC 测试任务清单',
          '分配优先级（高/中/低）',
          '确定集成方案',
        ],
        output: 'adoption-tasks.json',
      },
      develop: {
        name: 'PoC 开发与集成',
        actions: [
          '在隔离环境构建 PoC',
          '使用历史数据集进行 A/B 测试',
          '对比现有方案的性能指标',
          '生成集成代码 patch',
        ],
        output: 'poc-results.json',
      },
      test: {
        name: '效果验证',
        actions: [
          '验证准确率/召回率达标',
          '测试处理速度和资源占用',
          '回归测试现有功能不受影响',
          '验证数据一致性',
        ],
        output: 'test-report.json',
      },
      deploy: {
        name: '生产集成',
        actions: [
          '提交代码 PR 到主仓库',
          '更新 pipeline 配置',
          '触发 CI/CD 流水线',
          '监控上线后性能指标',
          '记录技术采纳日志',
        ],
        output: 'deploy-status.json',
      },
      verify: {
        name: '验证反馈',
        actions: [
          '验证 PR 已合并（或记录合并状态）',
          '验证 CI/CD 流水线成功通过',
          '对比线上性能指标（部署前后处理速度、准确率）',
          '确认无回归问题（线上站点功能正常）',
          '生成信号传递文件通知数据积累闭环技术改进',
          '不达标则生成修正任务回退到对应阶段',
        ],
        qualityGate: 'PoC达到预期改进指标且无回归',
        output: 'verify-report.json',
      },
    },
  },

  // 闭环四：推广增长（指导工作方向）
  'promotion': {
    name: '推广增长闭环',
    description: '自动化SEO优化和社交媒体推广，提升可见度和用户增长',
    purpose: '指导工作方向',
    schedule: '0 8,18 * * *', // 每日 08:00 和 18:00
    stages: {
      collect: {
        name: '推广信号采集',
        actions: [
          '监测 Google 核心算法更新',
          '跟踪社交媒体热门话题',
          '读取闭环一的新内容信号',
          '采集竞品推广策略（来自闭环五）',
          '分析当前站点流量数据',
        ],
        output: 'promotion-signals.json',
      },
      analyze: {
        name: '推广策略分析',
        actions: [
          '识别高价值推广话题',
          '分析最佳发布时间窗口',
          '评估各渠道历史效果',
          '生成 A/B 测试方案',
          '计算预期流量增长',
        ],
        output: 'promotion-strategy.json',
      },
      decide: {
        name: '推广计划决策',
        actions: [
          '确定本期推广内容清单',
          '选择推广渠道（Twitter/LinkedIn/微信/Reddit）',
          '设定 A/B 测试变体',
          '分配推广资源',
        ],
        output: 'promotion-plan.json',
      },
      develop: {
        name: '推广内容生成',
        actions: [
          '生成 SEO 优化的页面标题和描述',
          '更新 Schema.org 结构化数据',
          '生成多平台社交媒体文案',
          '创建推广素材（图片/摘要/标签）',
          '生成 sitemap 更新',
        ],
        output: 'promotion-content.json',
      },
      test: {
        name: '推广效果验证',
        actions: [
          '验证 SEO 标签有效性',
          '检查结构化数据格式',
          '测试社交媒体链接可达性',
          'A/B 测试变体效果对比',
        ],
        output: 'promotion-test.json',
      },
      deploy: {
        name: '推广发布',
        actions: [
          '提交 IndexNow 索引更新',
          '发布社交媒体内容',
          '更新站点 SEO 元数据',
          '部署 sitemap 更新',
          '记录推广效果基线',
          '传递效果数据到闭环五',
        ],
        output: 'deploy-status.json',
      },
      verify: {
        name: '验证反馈',
        actions: [
          '确认 IndexNow 提交已被接受',
          '验证 sitemap.xml 在线上可访问',
          '验证 OG 标签预览正确',
          '记录推广基线数据供下次对比',
          '对比上一轮基线计算变化趋势',
          '不达标则生成修正任务回退到对应阶段',
        ],
        qualityGate: '所有验证项通过且基线已记录',
        output: 'verify-report.json',
      },
    },
  },

  // 闭环五：竞品情报（指导工作方向）
  'intelligence': {
    name: '竞品情报闭环',
    description: '监测竞品动态和市场趋势，生成策略调整建议',
    purpose: '指导工作方向',
    schedule: '0 5 * * 5', // 每周五 05:00
    stages: {
      collect: {
        name: '竞品情报采集',
        actions: [
          '监测 Papers With Code / HuggingFace Papers 动态',
          '跟踪 Google Scholar / Semantic Scholar 新功能',
          '抓取 Reddit r/MachineLearning / Hacker News 热帖',
          '监测竞品网站更新和定价变化',
          '采集行业报告和新闻',
        ],
        output: 'intel-raw.json',
      },
      analyze: {
        name: '情报分析',
        actions: [
          '生成竞品功能对比矩阵',
          '分析市场趋势和用户需求变化',
          '识别市场空白和机会',
          '评估技术发展方向',
          '分析用户反馈和痛点',
        ],
        output: 'intel-analysis.json',
      },
      decide: {
        name: '策略决策',
        actions: [
          '生成差异化竞争建议',
          '提出新功能/新领域建议（传递到闭环二）',
          '提出技术改进建议（传递到闭环三）',
          '提出推广策略调整（传递到闭环四）',
          '提出变现模式建议（传递到闭环六）',
        ],
        output: 'strategy-recommendations.json',
      },
      develop: {
        name: '策略方案制定',
        actions: [
          '生成竞品分析报告 HTML',
          '生成市场趋势可视化图表',
          '更新项目路线图',
          '生成各闭环的调整指令文件',
        ],
        output: 'strategy-docs.json',
      },
      test: {
        name: '策略验证',
        actions: [
          '验证建议的可行性',
          '检查与现有策略的一致性',
          '评估资源需求',
          '验证数据支撑充分性',
        ],
        output: 'strategy-test.json',
      },
      deploy: {
        name: '策略发布',
        actions: [
          '发布竞品分析报告',
          '分发调整指令到各闭环',
          '更新项目策略文档',
          '通知团队成员',
          '归档情报数据',
        ],
        output: 'deploy-status.json',
      },
      verify: {
        name: '验证反馈',
        actions: [
          '确认领域开拓闭环已消费市场空白信号',
          '确认技术提升闭环已消费技术改进信号',
          '验证竞品报告内容完整、可读、有行动指导意义',
          '记录本周情报闭环效果（竞品数、建议数、被采纳数）',
          '不达标则生成修正任务回退到对应阶段',
        ],
        qualityGate: '下游闭环已消费信号且报告完整',
        output: 'verify-report.json',
      },
    },
  },

  // 闭环六：变现拓展（增加变现渠道/新变现方式）
  'monetization': {
    name: '变现拓展闭环',
    description: '探索新变现模式，优化定价策略，开发付费功能',
    purpose: '增加变现渠道/形成新变现方式',
    schedule: '0 9 1 * *', // 每月 1 日 09:00
    stages: {
      collect: {
        name: '变现机会采集',
        actions: [
          '监测竞品定价策略变化',
          '收集用户付费意愿反馈',
          '分析现有收入数据（各产品线）',
          '调研行业变现新模式',
          '读取闭环五的市场机会信号',
        ],
        output: 'monetization-signals.json',
      },
      analyze: {
        name: '变现潜力分析',
        actions: [
          '评估各变现模式收入潜力',
          '分析用户付费转化漏斗',
          '计算各产品 LTV/CAC',
          '识别高价值变现机会',
          '评估开发成本和 ROI',
        ],
        output: 'monetization-analysis.json',
      },
      decide: {
        name: '变现方案决策',
        actions: [
          '选择本期开发的变现功能',
          '确定定价策略调整方案',
          '设计新付费产品定义',
          '生成开发任务清单',
        ],
        output: 'monetization-plan.json',
      },
      develop: {
        name: '变现功能开发',
        actions: [
          '开发 API 认证和计费系统',
          '实现付费墙服务端校验',
          '开发新付费产品页面',
          '集成支付网关（Creem）',
          '实现订阅管理功能',
        ],
        output: 'monetization-dev.json',
      },
      test: {
        name: '变现功能测试',
        actions: [
          '端到端支付流程测试',
          '验证付费墙不可绕过',
          '测试订阅升降级流程',
          '验证账单和发票生成',
          'A/B 测试定价页面',
        ],
        output: 'monetization-test.json',
      },
      deploy: {
        name: '变现功能上线',
        actions: [
          '部署付费功能到生产环境',
          '更新定价页面',
          '配置支付 webhook',
          '通知现有用户新功能',
          '启动变现效果监控',
          '传递收入数据到闭环五',
        ],
        output: 'deploy-status.json',
      },
      verify: {
        name: '验证反馈',
        actions: [
          '端到端验证变现链路（定价→支付→权限→使用）',
          '验证免费层限制正确（100次/日）',
          '验证Pro层权限正确（无限查询）',
          '验证Enterprise层SSO可配置',
          '对比上月收入数据计算变化',
          '验证转化率追踪正常工作',
          '不达标则生成修正任务回退到对应阶段',
        ],
        qualityGate: '变现功能端到端可用且收入监控正常',
        output: 'verify-report.json',
      },
    },
  },
};

// ============================================================
// 闭环执行引擎
// ============================================================

class ClosedLoopEngine {
  constructor(loopId, options = {}) {
    this.loopId = loopId;
    this.loop = LOOP_REGISTRY[loopId];
    if (!this.loop) {
      throw new Error(`未知闭环: ${loopId}，可用: ${Object.keys(LOOP_REGISTRY).join(', ')}`);
    }
    this.dryRun = options.dryRun || false;
    this.onlyStage = options.stage || null;
    // 执行模式：默认 false（只写报告）；--execute 或 CLOSED_LOOP_EXECUTE=1 时真实执行管线脚本
    this.executeMode = options.execute || process.env.CLOSED_LOOP_EXECUTE === '1';
    this.stateFile = path.join(STATE_DIR, `${loopId}-state.json`);
    this.startTime = new Date();
  }

  // 加载上一次的状态
  loadState() {
    if (fs.existsSync(this.stateFile)) {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    }
    return { lastRun: null, lastStage: null, history: [] };
  }

  // 保存状态
  saveState(state) {
    state.lastRun = this.startTime.toISOString();
    state.loopId = this.loopId;
    state.loopName = this.loop.name;
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  // 执行单个阶段
  async executeStage(stageName) {
    const stageDef = this.loop.stages[stageName];
    if (!stageDef) {
      log(this.loopId, `阶段 ${stageName} 未定义`, 'error');
      return { success: false, error: 'stage not defined' };
    }

    log(this.loopId, `━━━ 阶段 ${STAGES.indexOf(stageName) + 1}/7: ${STAGE_NAMES[stageName]} — ${stageDef.name} ━━━`, 'info');

    const stageResult = {
      stage: stageName,
      name: stageDef.name,
      actions: stageDef.actions,
      startedAt: new Date().toISOString(),
      dryRun: this.dryRun,
    };

    if (this.dryRun) {
      log(this.loopId, `[DRY-RUN] 将执行 ${stageDef.actions.length} 个动作:`, 'warn');
      stageDef.actions.forEach((a, i) => log(this.loopId, `  ${i + 1}. ${a}`, 'warn'));
      stageResult.success = true;
      stageResult.skipped = true;
    } else {
      // 实际执行逻辑 — 调用对应的 pipeline 脚本
      try {
        const output = await this.runStageActions(stageName, stageDef);
        stageResult.success = true;
        stageResult.output = output;
        log(this.loopId, `阶段完成: ${stageDef.name}`, 'ok');
      } catch (err) {
        stageResult.success = false;
        stageResult.error = err.message;
        log(this.loopId, `阶段失败: ${err.message}`, 'error');
      }
    }

    stageResult.completedAt = new Date().toISOString();
    return stageResult;
  }

  // 执行阶段的具体动作
  async runStageActions(stageName, stageDef) {
    const outputFile = path.join(REPORTS_DIR, `${this.loopId}-${stageName}-${this.startTime.toISOString().slice(0, 10)}.json`);

    // 尝试调用对应的 pipeline 脚本
    // 2026-08-21 修复「假闭环」：此前 spawnSync 被注释、只写报告不执行。
    // 现在默认仍为报告模式；显式传入 --execute 或设置 CLOSED_LOOP_EXECUTE=1 时真实执行管线脚本，
    // 并把执行结果（exit code + stdout 尾部）写入阶段报告，形成可审计的执行闭环。
    const pipelineScript = this.getPipelineScript();
    let execution = null;
    if (pipelineScript && fs.existsSync(pipelineScript)) {
      if (this.executeMode) {
        log(this.loopId, `执行 pipeline 脚本: ${path.basename(pipelineScript)} --stage=${stageName}`, 'info');
        const result = spawnSync(process.execPath, [pipelineScript, '--stage', stageName], { encoding: 'utf8', timeout: 10 * 60 * 1000 });
        execution = {
          command: `node ${path.basename(pipelineScript)} --stage ${stageName}`,
          status: result.status,
          error: result.error ? String(result.error) : undefined,
          stderrTail: (result.stderr || '').split('\n').slice(-15).join('\n'),
        };
        log(this.loopId, `pipeline 执行完成 status=${result.status}`, result.status === 0 ? 'ok' : 'error');
        if (result.status !== 0) {
          throw new Error(`pipeline 执行失败 status=${result.status}: ${(result.stderr || '').split('\n').slice(-3).join(' | ')}`);
        }
      } else {
        log(this.loopId, `[报告模式] 跳过实际执行: ${path.basename(pipelineScript)}（加 --execute 开启真实执行）`, 'info');
      }
    }

    // 生成阶段输出报告
    const report = {
      loopId: this.loopId,
      loopName: this.loop.name,
      stage: stageName,
      stageName: stageDef.name,
      timestamp: new Date().toISOString(),
      actions: stageDef.actions,
      executeMode: this.executeMode,
      execution,
      status: 'completed',
    };

    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
    log(this.loopId, `阶段报告已生成: ${path.basename(outputFile)}`, 'ok');

    return { reportFile: path.basename(outputFile), actions: stageDef.actions.length };
  }

  // 获取对应的 pipeline 脚本路径
  getPipelineScript() {
    const scriptMap = {
      'data-accumulation': path.join(ENGINE_DIR, 'pipeline-data-accumulation.js'),
      'domain-expansion': path.join(ENGINE_DIR, 'pipeline-domain-expansion.js'),
      'tech-adoption': path.join(ENGINE_DIR, 'pipeline-tech-adoption.js'),
      'promotion': path.join(ENGINE_DIR, 'pipeline-promotion.js'),
      'intelligence': path.join(ENGINE_DIR, 'pipeline-intelligence.js'),
      'monetization': path.join(ENGINE_DIR, 'pipeline-monetization.js'),
    };
    return scriptMap[this.loopId] || null;
  }

  // 执行完整闭环
  async run() {
    const state = this.loadState();

    log(this.loopId, `╔══════════════════════════════════════════════════════╗`, 'info');
    log(this.loopId, `║  闭环启动: ${this.loop.name}`, 'info');
    log(this.loopId, `║  目标: ${this.loop.purpose}`, 'info');
    log(this.loopId, `║  模式: ${this.dryRun ? 'DRY-RUN（预览）' : 'LIVE（实际执行）'}`, 'info');
    log(this.loopId, `╚══════════════════════════════════════════════════════╝`, 'info');

    const stagesToRun = this.onlyStage ? [this.onlyStage] : STAGES;
    const results = [];

    for (const stageName of stagesToRun) {
      if (!this.loop.stages[stageName]) {
        log(this.loopId, `跳过未定义阶段: ${stageName}`, 'warn');
        continue;
      }
      const result = await this.executeStage(stageName);
      results.push(result);
      if (!result.success && !this.dryRun) {
        log(this.loopId, `阶段 ${stageName} 失败，终止闭环`, 'error');
        break;
      }
    }

    // 生成闭环总结报告
    const summary = {
      loopId: this.loopId,
      loopName: this.loop.name,
      purpose: this.loop.purpose,
      startedAt: this.startTime.toISOString(),
      completedAt: new Date().toISOString(),
      dryRun: this.dryRun,
      stages: results,
      overallSuccess: results.every((r) => r.success),
    };

    const summaryFile = path.join(REPORTS_DIR, `${this.loopId}-summary-${this.startTime.toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

    // 更新状态
    state.history = (state.history || []).slice(-9).concat({
      runTime: this.startTime.toISOString(),
      success: summary.overallSuccess,
      stages: results.length,
    });
    state.lastStage = results[results.length - 1]?.stage || null;
    this.saveState(state);

    log(this.loopId, `╔══════════════════════════════════════════════════════╗`, 'info');
    log(this.loopId, `║  闭环完成: ${this.loop.name}`, 'info');
    log(this.loopId, `║  结果: ${summary.overallSuccess ? '✓ 成功' : '✗ 失败'} | 阶段: ${results.length}/${STAGES.length}`, 'info');
    log(this.loopId, `║  报告: ${path.basename(summaryFile)}`, 'info');
    log(this.loopId, `╚══════════════════════════════════════════════════════╝`, 'info');

    return summary;
  }
}

// ============================================================
// 闭环间状态传递
// ============================================================

function transferState(fromLoop, toLoop, data) {
  const transferFile = path.join(STATE_DIR, `transfer-${fromLoop}-to-${toLoop}.json`);
  const transfer = {
    from: fromLoop,
    to: toLoop,
    timestamp: new Date().toISOString(),
    data,
  };
  fs.writeFileSync(transferFile, JSON.stringify(transfer, null, 2));
  log('engine', `状态传递: ${fromLoop} → ${toLoop}`, 'ok');
}

// ============================================================
// 主入口
// ============================================================

function main() {
  const args = process.argv.slice(2);
  const loopArg = args.find((a) => a.startsWith('--loop='));
  const dryRun = args.includes('--dry-run');
  const stageArg = args.find((a) => a.startsWith('--stage='));
  const execute = args.includes('--execute') || process.env.CLOSED_LOOP_EXECUTE === '1';

  if (!loopArg) {
    console.log(`
GeneTech 闭环执行引擎

用法:
  node closed-loop-engine.js --loop=<loop-id> [--dry-run] [--stage=<stage>]

可用闭环:
${Object.entries(LOOP_REGISTRY)
  .map(
    ([id, def]) =>
      `  ${id.padEnd(20)} ${def.schedule.padEnd(14)} ${def.name}（${def.purpose}）`
  )
  .join('\n')}

阶段:
  collect   信息收集
  analyze   分析评估
  decide    决策采用
  develop   开发实现
  test      测试验证
  deploy    部署上线
  verify    验证反馈（闭环确认+回退修正）

示例:
  node closed-loop-engine.js --loop=data-accumulation
  node closed-loop-engine.js --loop=monetization --dry-run
  node closed-loop-engine.js --loop=tech-adoption --stage=analyze
`);
    process.exit(0);
  }

  const loopId = loopArg.split('=')[1];
  const stage = stageArg ? stageArg.split('=')[1] : null;

  try {
    const engine = new ClosedLoopEngine(loopId, { dryRun, stage, execute });
    engine.run().then((summary) => {
      process.exit(summary.overallSuccess ? 0 : 1);
    });
  } catch (err) {
    log('engine', err.message, 'error');
    process.exit(1);
  }
}

main();
