#!/usr/bin/env node
/**
 * 站点感知数据回填 / 扩充流水线（扩量版 v2）
 * pipeline-data-backfill.js
 *
 * 相比 v1 的核心改进（直接解决"数据不增长"根因）：
 *   1. 单页取数 12 → 100（OpenAlex/Crossref/arXiv/S2/EuropePMC 均支持 ≥100/页），
 *      单轮单站可取数从 ~336 条理论值提升到 ~2800 条原始候选。
 *   2. 数据源从 4 个增至 11 个：新增 Semantic Scholar、Europe PMC、PubMed、DOAJ、DataCite、Zenodo、CORE、预印本专源（bioRxiv/medRxiv）；CNKI/万方在配置 CNKI_TOKEN 后自动启用。
 *   3. 游标从"站点级"改为"站点×检索词"级：每个检索词独立推进 offset，
 *      避免 7 个词共用一个 offset 导致词间进度不同步、深页大面积重复命中。
 *   4. 修复 PubMed 摘要恒为空：esearch → esummary（标题/DOI/日期）→ efetch（AbstractText）。
 *   5. 清洗 Crossref 的 JATS 标签摘要（<jats:p> 等）。
 *   6. 按 DOI / 标题+首作者 做跨源去重合并：同一篇论文在多个源只计一次，且优先保留带摘要的版本。
 *
 * 用法：
 *   node pipeline-data-backfill.js [--dry-run] [--site=quantum-computing]
 *       [--limit=800] [--max-entities=10000] [--per-page=200] [--pages=3] [--max-minutes=45]
 *
 * 设计原则：失败即空数组（不抛停整轮），礼貌限速（源内并发受控、站间 sleep），
 * 去重幂等（重跑安全），容量闸门（达标停抓，避免单文件与仓库无限膨胀）。
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');

// ============================================================
// 自适应熔断器 (Circuit Breaker) — P0 自愈
// 三态: CLOSED(正常) → OPEN(熔断,快速失败) → HALF_OPEN(试探恢复)
// 每个数据源独立熔断，防止单个源故障拖垮全量管线
// 参考: tools/circuit-breaker.mjs (独立实现)
// ============================================================
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failures = 0;
    this.successes = 0;
    this.state = 'CLOSED';
    this.threshold = options.threshold || 3;
    this.cooldownMs = options.cooldownMs || 60_000;
    this.halfOpenLimit = options.halfOpenLimit || 3;
    this.timeoutMs = options.timeoutMs || 15_000;
    this.lastFailure = null;
    this.halfOpenCalls = 0;
  }
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.cooldownMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenCalls = 0;
      } else {
        throw new Error(`[CB:${this.name}] OPEN, cooldown ${Math.round((this.cooldownMs - (Date.now() - this.lastFailure)) / 1000)}s`);
      }
    }
    try {
      let result = await fn();
      this._success();
      return result;
    } catch (e) {
      this._failure(e);
      throw e;
    }
  }
  _success() {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenCalls++;
      if (this.halfOpenCalls >= this.halfOpenLimit) { this.state = 'CLOSED'; this.failures = 0; }
    } else {
      this.failures = 0;
      this.successes++;
    }
  }
  _failure(e) {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.state === 'HALF_OPEN') { this.state = 'OPEN'; }
    else if (this.failures >= this.threshold) { this.state = 'OPEN'; }
  }
  metrics() {
    return {name: this.name, state: this.state, failures: this.failures, successes: this.successes,
      cooldownRemaining: this.state === 'OPEN' ? Math.max(0, this.cooldownMs - (Date.now() - this.lastFailure)) : 0};
  }
  reset() { this.state = 'CLOSED'; this.failures = 0; this.successes = 0; this.halfOpenCalls = 0; }
}

// 6 源独立熔断器（按源特性配置阈值和冷却时间）
const CIRCUIT_BREAKERS = {
  openalex: new CircuitBreaker('openalex', {threshold: 3, cooldownMs: 30_000, timeoutMs: 15_000}),
  arxiv: new CircuitBreaker('arxiv', {threshold: 2, cooldownMs: 60_000, timeoutMs: 20_000}),
  crossref: new CircuitBreaker('crossref', {threshold: 3, cooldownMs: 30_000, timeoutMs: 15_000}),
  semanticscholar: new CircuitBreaker('semanticscholar', {threshold: 3, cooldownMs: 30_000, timeoutMs: 15_000}),
  europepmc: new CircuitBreaker('europepmc', {threshold: 3, cooldownMs: 60_000, timeoutMs: 20_000}),
  pubmed: new CircuitBreaker('pubmed', {threshold: 2, cooldownMs: 60_000, timeoutMs: 25_000}),
  doaj: new CircuitBreaker('doaj', {threshold: 3, cooldownMs: 60_000, timeoutMs: 15_000}),
  datacite: new CircuitBreaker('datacite', {threshold: 4, cooldownMs: 30_000, timeoutMs: 15_000}),
  zenodo: new CircuitBreaker('zenodo', {threshold: 3, cooldownMs: 60_000, timeoutMs: 20_000}),
  core: new CircuitBreaker('core', {threshold: 3, cooldownMs: 60_000, timeoutMs: 20_000}),
  preprints: new CircuitBreaker('preprints', {threshold: 3, cooldownMs: 60_000, timeoutMs: 20_000}),
  cnki: new CircuitBreaker('cnki', {threshold: 2, cooldownMs: 120_000, timeoutMs: 20_000}),
};

// ============================================================
// 数据质量前置校验 (Data Quality Gate) — P0 自愈
// 在写入前强制校验，不通过则批次拒绝（防止漂移写入）
// 参考: tools/data-quality.mjs (独立实现)
// ============================================================
function dataQualityCheck(entities, site) {
  const total = entities.length;
  const failures = [];

  if (total === 0) { failures.push({rule:'entity_count', msg:'empty batch'}); }
  else if (total > 10000) { failures.push({rule:'entity_count', msg:`exceeds 10k cap (${total})`}); }

  const withTitle = entities.filter(e => e && e.title && e.title.trim().length > 0);
  if (withTitle.length / total < 0.95) failures.push({rule:'title_non_null_rate', msg:`only ${Math.round(withTitle.length/total*100)}% have titles (min 95%)`});

  const ids = entities.filter(e => e && e.id).map(e => e.id);
  if (new Set(ids).size !== ids.length) failures.push({rule:'id_unique', msg:`${ids.length - new Set(ids).size} duplicate IDs`});

  const domains = new Set(entities.map(e => e && e.domain).filter(Boolean));
  const allowedDomains = Object.keys(SITE_QUERIES);
  for (const d of domains) { if (!allowedDomains.includes(d)) failures.push({rule:'domain_valid', msg:`unknown domain: ${d}`}); }

  const withAbstract = entities.filter(e => e && e.abstract && typeof e.abstract === 'string' && e.abstract.length > 10);
  if (withAbstract.length / total < 0.1) failures.push({rule:'abstract_rate', msg:`only ${Math.round(withAbstract.length/total*100)}% have abstracts (min 10%)`});

  const withProvenance = entities.filter(e => e && e.provenance);
  if (withProvenance.length / total < 0.5) failures.push({rule:'provenance_rate', msg:`only ${Math.round(withProvenance.length/total*100)}% have provenance (min 50%)`});

  return {
    pass: failures.length === 0,
    total,
    site,
    metrics: {
      title_rate: +(withTitle.length / total).toFixed(3),
      id_unique: new Set(ids).size === ids.length,
      abstract_rate: +(withAbstract.length / total).toFixed(3),
      provenance_rate: +(withProvenance.length / total).toFixed(3),
      domains: [...domains]
    },
    failures
  };
}

// ============================================================
// Policy-as-code Guard 引擎（内联实现） — P0 策略门禁
// 与 tools/guard-eval.mjs 语义对齐，零外部依赖
// 参考: OPA/Rego（默认拒绝、显式放行、可版本化）
// ============================================================
function _evalExpr(expr, context) {
  if (expr === null || expr === undefined) return expr;
  if (typeof expr !== 'object') return expr;
  const keys = Object.keys(expr);
  if (keys.length !== 1) return expr;
  const op = keys[0], operands = expr[op];
  switch (op) {
    case 'var': return context[operands];
    case 'ref': return context.__policy__ ? context.__policy__[operands] : null;
    case '==': return _evalOp(operands, context, (a, b) =>
      Array.isArray(a) && Array.isArray(b)
        ? a.length === b.length && a.every((v, i) => v === b[i])
        : a === b);
    case '!=': return _evalOp(operands, context, (a, b) => a !== b);
    case '<': return _evalOp(operands, context, (a, b) => a < b);
    case '<=': return _evalOp(operands, context, (a, b) => a <= b);
    case '>': return _evalOp(operands, context, (a, b) => a > b);
    case '>=': return _evalOp(operands, context, (a, b) => a >= b);
    case 'in': return _evalOp(operands, context, (a, b) => Array.isArray(b) ? b.includes(a) : false);
    case 'not': case '!': return !_evalExpr(operands, context);
    case 'all': return Array.isArray(operands) && operands.every(e => _evalExpr(e, context));
    case 'any': return Array.isArray(operands) && operands.some(e => _evalExpr(e, context));
    case '*': return _evalOp(operands, context, (a, b) => a * b);
    case '+': return _evalOp(operands, context, (a, b) => a + b);
    default: return expr;
  }
}
function _evalOp(operands, context, fn) {
  if (!Array.isArray(operands) || operands.length < 2) return false;
  return fn(_evalExpr(operands[0], context), _evalExpr(operands[1], context));
}
function _loadPolicy(name) {
  return JSON.parse(require('fs').readFileSync(path.join(PROJECT_ROOT, 'guards', name + '.policy.json'), 'utf-8'));
}
function evalPublishGuard(actionCtx) {
  const policy = _loadPolicy('publish');
  const ctx = {...actionCtx, __policy__: policy};
  const defaultDecision = policy.default === 'deny' ? 'deny' : 'allow';
  for (const rule of policy.rules || []) {
    if (!rule.when) continue;
    if (_evalExpr(rule.when, ctx)) {
      return {decision: rule.allow ? 'allow' : 'deny', reason: rule.description || rule.id};
    }
  }
  return {decision: defaultDecision, reason: 'no rule matched, default: ' + policy.default};
}

// 每个站点抓取的领域检索词（科学语义）
// v3（2026-08-06）：每站从 6-7 个扩到 13-15 个细分子领域词。
// 关键：游标是「站点 × 检索词」级，因此检索词数量 ≈ 可抓取容量上限的线性倍数。
// 139 → 300+ 意味着每站理论可抓容量翻一倍以上，且覆盖更细的长尾主题（利于主题聚合页 SEO）。
const SITE_QUERIES = {
  'quantum-computing': ['quantum computing', 'quantum error correction', 'superconducting qubit', 'quantum algorithm', 'quantum supremacy', 'topological qubit', 'quantum key distribution', 'trapped ion quantum computer', 'quantum machine learning', 'variational quantum eigensolver', 'quantum annealing', 'photonic quantum computing', 'quantum compiler', 'silicon spin qubit'],
  'alien-minerals': ['extraterrestrial minerals', 'meteorite mineralogy', 'lunar regolith', 'asteroid mining', 'space resources', 'lunar ice', 'astrobiology minerals', 'in-situ resource utilization', 'Martian soil composition', 'chondrite petrology', 'cosmochemistry isotopes', 'space weathering', 'planetary geology remote sensing', 'sample return mission'],
  'biocomputing': ['biological computing', 'DNA computing', 'molecular computing', 'synthetic biology circuits', 'living computers', 'microbial computing', 'DNA data storage', 'genetic logic gate', 'biosensor computation', 'neuromorphic biological system', 'protein based computing', 'wetware computing', 'cell-free biocomputing', 'organoid intelligence', 'generative biology', 'DNA data storage', 'biological computing frontier', 'protein based computing design'],
  'bionic-ai': ['brain-computer interface', 'neurorobotics', 'bionic prosthesis', 'neural engineering', 'neuroprosthetics', 'bionic vision', 'neural decoding motor', 'EEG signal classification', 'cochlear implant', 'spinal cord stimulation', 'biohybrid robot', 'artificial muscle actuator', 'closed-loop neuromodulation', 'implantable neural electrode'],
  'deep-sea-tech': ['deep sea technology', 'underwater robotics', 'marine robotics', 'ocean observation', 'autonomous underwater vehicle', 'subsea engineering', 'deep sea mining', 'hydrothermal vent exploration', 'underwater acoustic communication', 'remotely operated vehicle', 'ocean sensor network', 'bathymetry mapping', 'deep sea biodiversity', 'marine geotechnics'],
  'brain-science': ['neuroscience', 'brain imaging', 'neural plasticity', 'connectome', 'neurogenesis', 'cognitive neuroscience', 'functional MRI analysis', 'neurodegenerative disease mechanism', 'single-cell brain atlas', 'synaptic transmission', 'neural circuit optogenetics', 'sleep and memory consolidation', 'computational neuroscience model', 'neuroinflammation', 'MICrONS connectomics', 'whole brain connectome', 'synaptome mapping', 'single neuron reconstruction', 'electron microscopy connectomics', 'neural circuit reconstruction'],
  'life-science': ['life sciences', 'systems biology', 'cell biology', 'genomics', 'proteomics', 'molecular biology', 'single cell RNA sequencing', 'metabolomics', 'immunology mechanism', 'stem cell differentiation', 'microbiome analysis', 'structural biology cryo-EM', 'epigenetics regulation', 'developmental biology', 'generative biology', 'AlphaFold protein structure', 'spatial transcriptomics', 'single cell atlas', 'AI genomics', 'cell state foundation model', 'organoid model'],
  'new-energy': ['renewable energy', 'solid-state battery', 'hydrogen energy', 'perovskite solar cell', 'lithium battery', 'grid energy storage', 'sodium ion battery', 'green hydrogen electrolysis', 'fuel cell catalyst', 'offshore wind power', 'carbon capture utilization', 'battery recycling', 'vehicle to grid', 'thermoelectric materials', 'solid state battery sulfide', 'QuantumScape solid state', 'Toyota solid state battery', 'solid state battery mass production', 'anode free battery', 'lithium metal battery'],
  'nuclear-energy': ['nuclear fusion', 'tokamak', 'small modular reactor', 'nuclear fission', 'fusion energy', 'plasma confinement', 'inertial confinement fusion', 'stellarator', 'molten salt reactor', 'nuclear fuel cycle', 'tritium breeding blanket', 'radiation shielding materials', 'nuclear waste disposal', 'high temperature gas reactor'],
  'robot-parts': ['robot actuator', 'robotic gripper', 'servo motor', 'tactile sensor', 'soft robotics', 'robotics components', 'harmonic drive reducer', 'series elastic actuator', 'force torque sensor', 'robot joint design', 'cable driven mechanism', 'lidar for robotics', 'robot end effector', 'exoskeleton mechanism'],
  'tcm-tools': ['traditional Chinese medicine', 'herbal medicine', 'acupuncture', 'medicinal plant', 'TCM formula', 'pharmacology of herbs', 'network pharmacology', 'Chinese herbal compound mechanism', 'moxibustion therapy', 'TCM syndrome differentiation', 'herbal quality control chromatography', 'natural product isolation', 'ethnopharmacology', 'acupoint stimulation mechanism'],
  'genetech-tools': ['genomics', 'CRISPR gene editing', 'gene therapy', 'DNA sequencing', 'genome engineering', 'gene regulation', 'base editing', 'prime editing', 'AAV vector delivery', 'CAR-T cell engineering', 'long read sequencing', 'gene knockout screening', 'mRNA therapeutics', 'genome wide association study', 'prime editing 2.0', 'prime editing hematopoietic stem cell', 'LNP delivery gene editing', 'multiplexed genome editing', 'Prime Medicine', 'in vivo gene editing', 'base editing therapeutic', 'gene editing clinical trial 2025', 'PERT prime editing', 'AAV gene therapy'],
  'exo-science': ['exoplanet', 'astrobiology', 'biosignature', 'extraterrestrial life', 'SETI', 'planetary habitability', 'transit photometry detection', 'exoplanet atmosphere spectroscopy', 'habitable zone modeling', 'JWST exoplanet observation', 'planetary formation simulation', 'technosignature search', 'extremophile organism', 'ocean world Europa Enceladus'],
  'agent-ecosystem': ['AI agent', 'multi-agent system', 'agent orchestration', 'LLM agent framework', 'autonomous agent', 'agentic workflow', 'tool use language model', 'retrieval augmented generation', 'agent memory architecture', 'agent benchmark evaluation', 'model context protocol', 'agent planning reasoning', 'human agent collaboration', 'agent safety alignment'],
  // ---- 2026-08 扩域：对齐国家「十五五」未来产业六大方向 + 全球 2026 前沿趋势 ----
  'embodied-ai': ['embodied intelligence', 'humanoid robot', 'vision language action model', 'robot learning', 'sim-to-real transfer', 'dexterous manipulation', 'embodied navigation', 'imitation learning robot', 'reinforcement learning locomotion', 'robot foundation model', 'tactile manipulation learning', 'whole body control humanoid', 'embodied question answering', 'robot teleoperation data collection', 'GR00T humanoid foundation model', 'Figure robot Helix', 'vision language action model 2025', 'humanoid robot commercial deployment', 'pi0 robot policy', 'robot RaaS', 'sim to real manipulation'],
  'synbio-manufacturing': ['synthetic biology', 'biomanufacturing', 'metabolic engineering', 'cell factory', 'bio-based materials', 'enzyme engineering', 'biofoundry', 'directed evolution protein', 'precision fermentation', 'CO2 to chemicals biological', 'genetic circuit design', 'microbial chassis strain', 'bioprocess scale-up', 'de novo protein design', 'precision fermentation scale up', 'biofoundry automation', 'AI metabolic engineering', 'cell free synthesis'],
  'semiconductor': ['semiconductor device', 'advanced packaging chiplet', 'wide bandgap semiconductor', 'EUV lithography', 'gate-all-around transistor', 'silicon photonics', 'compound semiconductor', 'gallium nitride power device', 'silicon carbide MOSFET', 'high bandwidth memory', 'ferroelectric memory device', '2D material transistor', 'in-memory computing chip', 'semiconductor thermal management', 'High-NA EUV', '2nm process node', 'ASML EXE High-NA', 'HBM4 memory', 'advanced packaging chiplet 2025', 'backside power delivery'],
  'ai4science': ['AI for science', 'machine learning interatomic potential', 'protein structure prediction', 'AI drug discovery', 'materials discovery machine learning', 'scientific foundation model', 'self-driving laboratory', 'neural network quantum chemistry', 'weather forecasting deep learning', 'symbolic regression physics', 'graph neural network molecules', 'automated experiment optimization', 'physics informed neural network', 'AI mathematical reasoning proof', 'AlphaFold 3', 'RFdiffusion', 'AlphaProteo', 'generative biology', 'AI protein design', 'BioNeMo', 'Isomorphic Engine', 'AI designed drug clinical trial', 'self-driving laboratory autonomous', 'scientific AI agent'],
  'low-altitude': ['eVTOL aircraft', 'urban air mobility', 'unmanned aerial vehicle', 'UAV swarm', 'drone delivery', 'flight control algorithm', 'low altitude airspace', 'UAV traffic management', 'distributed electric propulsion', 'drone obstacle avoidance', 'aerial manipulation', 'BVLOS operation safety', 'tiltrotor aerodynamics', 'drone battery endurance'],
  'sat-6g': ['6G wireless network', 'satellite internet constellation', 'integrated sensing and communication', 'terahertz communication', 'non-terrestrial network', 'LEO satellite communication', 'reconfigurable intelligent surface', 'massive MIMO beamforming', 'inter-satellite laser link', 'network slicing orchestration', 'semantic communication', 'satellite IoT connectivity', 'millimeter wave propagation', 'AI native air interface'],
  'spatial-computing': ['spatial computing', 'augmented reality display', 'mixed reality interaction', 'digital twin', 'neural radiance field', 'visual SLAM', '3D Gaussian splatting', 'waveguide optical display', 'eye tracking foveated rendering', 'hand gesture recognition XR', 'scene understanding 3D reconstruction', 'haptic feedback interface', 'volumetric video capture', 'spatial audio rendering'],
  'privacy-computing': ['federated learning', 'secure multiparty computation', 'homomorphic encryption', 'differential privacy', 'trusted execution environment', 'privacy preserving machine learning', 'zero knowledge proof', 'post quantum cryptography', 'secure aggregation protocol', 'data anonymization technique', 'confidential computing enclave', 'split learning', 'privacy preserving record linkage', 'blockchain data sharing'],
  // ---- 2026-08 第三批扩域：对齐国家「十五五」未来产业 + 全球 2026 科研热点 ----
  'ai-safety': ['ai alignment', 'interpretability neural network', 'mechanistic interpretability', 'rlhf', 'constitutional ai', 'ai safety', 'red teaming language model', 'scalable oversight', 'ai risk assessment', 'value learning', 'deceptive alignment', 'ai governance policy', 'model evaluation safety', 'ai control problem'],
  'quantum-materials': ['quantum material', 'topological insulator', 'topological superconductor', 'quantum spin liquid', 'majorana fermion', 'twisted bilayer graphene', 'magnetic topological material', 'quantum anomalous hall effect', 'correlated electron system', 'kagome superconductor', 'nonlinear optical crystal', '2d quantum material', 'moire material', 'quantum criticality'],
  'carbon-neutral': ['carbon capture utilization storage', 'ccus', 'direct air capture', 'carbon mineralization', 'green ammonia', 'power to gas', 'negative emission technology', 'carbon utilization co2', 'co2 electroreduction', 'biochar carbon sequestration', 'industrial decarbonization', 'climatetech carbon', 'methane pyrolysis', 'co2 to methanol'],
  'digital-twin': ['digital twin', 'digital twin manufacturing', 'city digital twin', 'digital twin engineering', 'twin model predictive control', 'physics based digital twin', 'digital twin industrial iot', 'twin driven simulation', 'digital thread', 'twin synchronization', 'digital twin maintenance', 'virtual commissioning', 'twin enabled optimization', 'digital twin energy'],
  'biomed-ai': ['medical artificial intelligence', 'clinical machine learning', 'healthcare large language model', 'medical image segmentation', 'clinical decision support ai', 'radiology ai', 'electronic health record ml', 'drug target discovery ai', 'pathology deep learning', 'medical foundation model', 'clinical nlp', 'ai diagnostics', 'biomarker discovery machine learning', 'precision medicine ai'],
  'edge-ai': ['edge artificial intelligence', 'tiny machine learning', 'tinyml', 'edge inference', 'on device ai', 'edge computing neural network', 'model quantization', 'neural network pruning', 'edge deployment deep learning', 'federated edge learning', 'low power ai chip', 'edge vision', 'sparse model', 'knowledge distillation edge'],
  'neuromorphic': ['neuromorphic computing', 'spiking neural network', 'neuro-inspired computing', 'memristor neural network', 'brain inspired chip', 'event driven computing', 'neuromorphic hardware', 'synaptic device', 'resistive random access memory computing', 'silicon neuron', 'neuromorphic vision sensor', 'analog in memory computing', 'physical reservoir computing', 'spiking neural network training'],
  'agritech': ['precision agriculture', 'smart farming', 'agricultural robotics', 'crop phenotyping', 'plant phenotyping', 'agricultural ai', 'vertical farming', 'controlled environment agriculture', 'crop disease detection', 'soil sensor network', 'livestock monitoring', 'agricultural drone', 'gene editing crop', 'synthetic fertilizer alternative'],
};

const SOURCE_CONFIDENCE = {
  pubmed: 0.82, arxiv: 0.78, openalex: 0.72, crossref: 0.7,
  semanticscholar: 0.74, europepmc: 0.8, github: 0.6, huggingface: 0.6,
  // v3 新增：DOAJ 为同行评审开放获取期刊，质量较高；DataCite/Zenodo 含大量自主提交的数据集与软件
  doaj: 0.76, datacite: 0.66, zenodo: 0.64,
  // v4 新增：CORE 聚合全球开放获取全文（含预印本/期刊），质量较高
  core: 0.72,
  // v5 新增：preprints 专源（bioRxiv/medRxiv 等经 Europe PMC 检索），cnki 中文权威（需凭证）
  preprints: 0.74,
  cnki: 0.8,
};

// ==================== 工具函数 ====================

function getISOTime() { return new Date().toISOString(); }

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 30000, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (err) {
      if (i === maxRetries) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readJsonSafe(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function ensureDir(d) { try { await fs.mkdir(d, { recursive: true }); } catch {} }

const UA = 'GeneTechBot/2.0 (mailto:ops@genetech.example)';

function stripTags(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// OpenAlex inverted_index -> 文本摘要
function reconstructAbstract(invIndex) {
  if (!invIndex) return '';
  const words = [];
  for (const [word, positions] of Object.entries(invIndex)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.filter(Boolean).join(' ');
}

// 简化 arXiv XML 解析
function parseArxivXml(xml) {
  const entries = [];
  const entryRegex = /<entry>[\s\S]*?<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const ex = m[0];
    const getTag = (t) => { const r = new RegExp(`<${t}[\\s\\S]*?>([\\s\\S]*?)<\\/${t}>`); const mm = ex.match(r); return mm ? mm[1].trim() : ''; };
    const getAttr = (t, a) => { const r = new RegExp(`<${t}[^>]*?${a}="([^"]*)"`); const mm = ex.match(r); return mm ? mm[1] : ''; };
    const authors = []; const ar = /<name>(.*?)<\/name>/g; let am; while ((am = ar.exec(ex)) !== null) authors.push(am[1]);
    const cats = []; const cr = /<category term="([^"]*)"/g; let cm; while ((cm = cr.exec(ex)) !== null) cats.push(cm[1]);
    entries.push({
      id: getTag('id').split('/').pop().replace('abs/', ''),
      title: getTag('title').replace(/\s+/g, ' '),
      summary: getTag('summary').replace(/\s+/g, ' '),
      authors, published: getTag('published'), categories: cats,
      pdfUrl: getAttr('link', 'href'), doi: getTag('doi') || '',
    });
  }
  return entries;
}

// ==================== 去重键 ====================

// 跨源去重：优先用 DOI；否则用「标题(归一)+首作者」；再不行用原始 id。
function dedupeKey(e) {
  const doi = String(e.doi || '').toLowerCase().replace(/^doi:/, '').replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
  if (doi) return 'doi:' + doi;
  const name = String(e.name || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '');
  const firstAuthor = String((e.authors && e.authors[0]) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name) return 'n:' + name.slice(0, 64) + '|' + (firstAuthor.slice(0, 14) || 'x');
  return 'id:' + (e.id || Math.random().toString(36));
}

/**
 * 跨源增量合并：当新抓到的实体与既有实体同键（同 DOI / 同篇）时，
 * 做字段级合并而非整体覆盖——优先保留更长的摘要、并集标签与作者、
 * 取更高置信度、补全缺失的 URL/DOI/日期。这就是「按 DOI 增量更新已有实体」的核心：
 * 重新抓取时，旧实体的高质量字段不会被新源的稀疏字段冲掉。
 */
function mergeEntity(oldE, newE) {
  const merged = { ...oldE };
  if (newE.abstract && (!oldE.abstract || newE.abstract.length > oldE.abstract.length)) merged.abstract = newE.abstract;
  merged.tags = Array.from(new Set([...(oldE.tags || []), ...(newE.tags || [])])).slice(0, 10);
  merged.authors = Array.from(new Set([...(oldE.authors || []), ...(newE.authors || [])])).slice(0, 12);
  merged.confidence = Math.max(oldE.confidence || 0, newE.confidence || 0);
  if (!oldE.url && newE.url) merged.url = newE.url;
  if (!oldE.doi && newE.doi) merged.doi = newE.doi;
  if (newE.publishedDate && (!oldE.publishedDate || newE.publishedDate < oldE.publishedDate)) merged.publishedDate = newE.publishedDate;
  // 取置信度更高的源作为主来源标注（避免产生逗号拼接的多值）
  merged.source = (newE.confidence >= (oldE.confidence || 0)) ? newE.source : oldE.source;
  merged.sites = Array.from(new Set([...(oldE.sites || []), ...(newE.sites || [])]));
  if (newE.addedAt && (!oldE.addedAt || newE.addedAt < oldE.addedAt)) merged.addedAt = newE.addedAt;
  // 标记最近一次字段级合并时间（使「按 DOI 增量刷新」可量化、可监控）
  merged.updatedAt = newE.updatedAt || getISOTime();
  return merged;
}

/**
 * 存量 DOI 自愈回填：早期管线未把 doi 写入实体，导致「溯源率」长期为 0。
 * 这里按 id 前缀（doi:10.xxxx）或 url 中的 doi.org 反推补全——
 * 纯函数、幂等，仅对缺失 doi 的实体补全，不动其它字段。
 * 由下一轮 CI 落库时自动生效（CI 拥有推送凭据），无需手动改远端实体文件，
 * 也避免本地直推覆盖 CI 已推进的游标/实体。
 */
function backfillDoi(list) {
  let changed = 0;
  const norm = list.map((e) => {
    if (e.doi) return e;
    let doi = '';
    if (typeof e.id === 'string' && e.id.startsWith('doi:')) doi = e.id.slice(4);
    if (!doi) {
      const m = /doi\.org\/(10\.[^\s)]+)/.exec(e.url || '');
      if (m) doi = m[1];
    }
    if (!doi) return e;
    changed++;
    return { ...e, doi, updatedAt: e.updatedAt || getISOTime() };
  });
  return { norm, changed };
}

// ==================== 各数据源抓取（带领域检索词） ====================

async function fetchOpenAlex(query, max, offset = 0) {
  // OpenAlex 用 page 分页（page 从 1 开始）；page*per-page 上限 10000
  const page = Math.floor(offset / max) + 1;
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${max}&page=${page}&sort=relevance_score:desc&mailto=ops@genetech.example`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.results || []).map(w => ({
      id: 'oa:' + String(w.id || '').split('/').pop(),
      source: 'openalex',
      name: w.display_name || '',
      abstract: reconstructAbstract(w.abstract_inverted_index),
      url: w.doi || w.id || '',
      authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
      tags: (w.concepts || []).slice(0, 5).map(c => c.display_name),
      publishedDate: w.publication_date || '',
      doi: w.doi || '',
    }));
  } catch { return []; }
}

async function fetchArxiv(query, max, offset = 0) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=${offset}&max_results=${max}&sortBy=relevance`;
  try {
    const res = await withRetry(() => httpGet(url), 3, 1500);
    if (res.statusCode !== 200) return [];
    return parseArxivXml(res.body).map(e => ({
      id: 'arxiv:' + e.id, source: 'arxiv', name: e.title, abstract: e.summary,
      url: e.pdfUrl || '', authors: e.authors, tags: e.categories,
      publishedDate: e.published, doi: e.doi,
    }));
  } catch { return []; }
}

async function fetchCrossref(query, max, offset = 0) {
  // Crossref offset 深分页上限 10000，超出需 cursor=*（v2 暂不深翻）
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${max}&offset=${offset}&sort=relevance`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.message?.items || []).map(it => {
      const rawAbs = it.abstract || '';
      const abs = rawAbs.startsWith('<') || rawAbs.includes('<jats') ? stripTags(rawAbs) : rawAbs;
      return {
        id: it.DOI ? 'doi:' + it.DOI : 'cr:' + (it.URL || Math.random().toString(36)),
        source: 'crossref', name: (it.title || [''])[0] || '', abstract: abs.slice(0, 4000),
        url: it.URL || '', authors: (it.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean),
        tags: it.subject || [], publishedDate: (it.publishedPrint?.dateParts?.[0]?.join('-')) || it.created?.['date-time'] || '',
        doi: it.DOI || '',
      };
    });
  } catch { return []; }
}

async function fetchSemanticScholar(query, max, offset = 0) {
  // 免费、无需 key（速率受限，失败即空）。字段含 paperId / DOI / abstract。
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${max}&offset=${offset}&fields=paperId,title,abstract,url,year,venue,publicationDate,authors.name,externalIds`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.data || []).map(p => {
      const doi = p.externalIds?.DOI || '';
      return {
        id: doi ? 'doi:' + doi : 'ss:' + (p.paperId || Math.random().toString(36)),
        source: 'semanticscholar', name: p.title || '', abstract: (p.abstract || '').slice(0, 4000),
        url: p.url || (doi ? `https://doi.org/${doi}` : ''),
        authors: (p.authors || []).map(a => a.name).filter(Boolean),
        tags: p.venue ? [p.venue] : [], publishedDate: p.publicationDate || (p.year ? String(p.year) : ''),
        doi,
      };
    });
  } catch { return []; }
}

async function fetchEuropePMC(query, max, offset = 0) {
  // Europe PMC：免费、无需 key，覆盖 PubMed + PMC + Agricola 等，含摘要。
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${max}&resultStart=${offset}`;
  try {
    const res = await withRetry(() => httpGet(url), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.resultList?.result || []).map(it => {
      const doi = it.doi || '';
      return {
        id: doi ? 'doi:' + doi : `epmc:${it.source || 'x'}${it.id || Math.random().toString(36)}`,
        source: 'europepmc', name: it.title || '', abstract: stripTags(it.abstractText || '').slice(0, 4000),
        url: doi ? `https://doi.org/${doi}` : (it.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/` : ''),
        authors: (it.authorList?.author || []).map(a => a.fullName || a.collectedFrom || '').filter(Boolean),
        tags: it.keywordList?.keyword || [], publishedDate: it.pubYear || '',
        doi,
      };
    });
  } catch { return []; }
}

async function fetchPubMedAbstracts(idlist) {
  if (!idlist.length) return {};
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${idlist.join(',')}&rettype=abstract&retmode=xml`;
  try {
    const res = await withRetry(() => httpGet(url), 3, 1500);
    const map = {};
    const artRegex = /<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g;
    let m;
    while ((m = artRegex.exec(res.body)) !== null) {
      const a = m[0];
      const pmidMatch = a.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      const pmid = pmidMatch ? pmidMatch[1] : '';
      const absMatch = a.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
      if (pmid && absMatch) map[pmid] = stripTags(absMatch[1]).replace(/\s+/g, ' ').trim();
    }
    return map;
  } catch { return {}; }
}

async function fetchPubMed(query, max, offset = 0) {
  // PubMed esearch retstart 上限约 9998
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${max}&retstart=${offset}&retmode=json&sort=date`;
  try {
    const sres = await withRetry(() => httpGet(searchUrl), 3, 1500);
    const idlist = JSON.parse(sres.body).esearchresult?.idlist || [];
    if (!idlist.length) return [];
    const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${idlist.join(',')}&retmode=json`;
    const res = await withRetry(() => httpGet(sumUrl), 3, 1500);
    const resultMap = JSON.parse(res.body).result || {};
    // 第二跳：efetch 取摘要（修复 v1 摘要恒为空）
    const absMap = await fetchPubMedAbstracts(idlist);
    return idlist.map(pmid => {
      const info = resultMap[pmid]; if (!info) return null;
      const doi = info.articleids?.find(a => a.idtype === 'doi')?.value || '';
      return {
        id: 'pmid:' + pmid, source: 'pubmed', name: info.title || '', abstract: absMap[pmid] || '',
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        authors: (info.authors || []).map(a => a.name),
        tags: [], publishedDate: info.pubdate || '', doi,
      };
    }).filter(Boolean);
  } catch { return []; }
}

async function fetchDOAJ(query, max, offset = 0) {
  // DOAJ：开放获取期刊论文，免费无 key。page 从 1 开始，pageSize 上限 100。
  const page = Math.floor(offset / max) + 1;
  const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?pageSize=${Math.min(max, 100)}&page=${page}`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.results || []).map(r => {
      const b = r.bibjson || {};
      const doi = (b.identifier || []).find(i => i.type === 'doi')?.id || '';
      const link = (b.link || []).find(l => l.type === 'fulltext')?.url || '';
      const ym = b.year ? `${b.year}${b.month ? '-' + String(b.month).padStart(2, '0') : ''}` : '';
      return {
        id: doi ? 'doi:' + doi : 'doaj:' + (r.id || Math.random().toString(36)),
        source: 'doaj',
        name: b.title || '',
        abstract: stripTags(b.abstract || '').slice(0, 4000),
        url: doi ? `https://doi.org/${doi}` : link,
        authors: (b.author || []).map(a => a.name).filter(Boolean),
        tags: (b.keywords || []).slice(0, 8),
        publishedDate: ym,
        doi,
      };
    });
  } catch { return []; }
}

async function fetchDataCite(query, max, offset = 0) {
  // DataCite：数据集 / 预印本 / 软件的 DOI 注册库，免费无 key。补齐 dataset 类型实体。
  const page = Math.floor(offset / max) + 1;
  const url = `https://api.datacite.org/dois?query=${encodeURIComponent(query)}&page[size]=${Math.min(max, 100)}&page[number]=${page}`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.data || []).map(d => {
      const a = d.attributes || {};
      const doi = a.doi || '';
      const abs = (a.descriptions || []).find(x => x.descriptionType === 'Abstract')?.description
        || (a.descriptions || [])[0]?.description || '';
      return {
        id: doi ? 'doi:' + doi : 'datacite:' + (d.id || Math.random().toString(36)),
        source: 'datacite',
        name: (a.titles || [])[0]?.title || '',
        abstract: stripTags(String(abs)).slice(0, 4000),
        url: doi ? `https://doi.org/${doi}` : (a.url || ''),
        authors: (a.creators || []).map(c => c.name || `${c.givenName || ''} ${c.familyName || ''}`.trim()).filter(Boolean),
        tags: (a.subjects || []).map(s => s.subject).filter(Boolean).slice(0, 8),
        publishedDate: a.publicationYear ? String(a.publicationYear) : '',
        doi,
        resourceType: a.types?.resourceTypeGeneral || '',
      };
    });
  } catch { return []; }
}

async function fetchZenodo(query, max, offset = 0) {
  // Zenodo：科研软件 / 数据集 / 报告，免费无 key。对"工具类"站点价值高。
  const page = Math.floor(offset / max) + 1;
  // Zenodo 限制 size*page <= 10000
  if (page * max > 10000) return [];
  const url = `https://zenodo.org/api/records?q=${encodeURIComponent(query)}&size=${Math.min(max, 100)}&page=${page}`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.hits?.hits || []).map(h => {
      const md = h.metadata || {};
      const doi = h.doi || md.doi || '';
      return {
        id: doi ? 'doi:' + doi : 'zenodo:' + (h.id || Math.random().toString(36)),
        source: 'zenodo',
        name: md.title || '',
        abstract: stripTags(md.description || '').slice(0, 4000),
        url: h.links?.self_html || (doi ? `https://doi.org/${doi}` : ''),
        authors: (md.creators || []).map(c => c.name).filter(Boolean),
        tags: (md.keywords || []).slice(0, 8),
        publishedDate: md.publication_date || '',
        doi,
        resourceType: md.resource_type?.type || '',
      };
    });
  } catch { return []; }
}

async function fetchCORE(query, max, offset = 0) {
  // CORE：全球开放获取聚合（预印本+期刊全文）。KEY 必须经环境变量 CORE_API_KEY 注入，
  // 严禁硬编码（旧 key 已泄露，须在 CORE 后台 rotate 后设为 GitHub Actions secret）。
  const key = process.env.CORE_API_KEY || '';
  if (!key) { console.warn('[CORE] 未配置 CORE_API_KEY，跳过该数据源'); return []; }
  const url = `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${Math.min(max, 100)}&offset=${offset}`;
  try {
    const res = await withRetry(
      () => httpGet(url, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA } }),
      2, 1500,
    );
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.results || []).map((r) => {
      const doi = r.doi || '';
      return {
        id: doi ? 'doi:' + doi : 'core:' + (r.id || Math.random().toString(36)),
        source: 'core',
        name: r.title || '',
        abstract: stripTags(r.abstract || '').slice(0, 4000),
        url: r.downloadUrl || (doi ? `https://doi.org/${doi}` : (r.url || '')),
        authors: (r.authors || []).map((a) => a.name).filter(Boolean),
        tags: (r.subjects || []).map((s) => (typeof s === 'string' ? s : s.name)).filter(Boolean).slice(0, 8),
        publishedDate: r.year ? String(r.year) : '',
        doi,
      };
    });
  } catch { return []; }
}

async function fetchPreprints(query, max, offset = 0) {
  // 预印本专源：bioRxiv / medRxiv / Research Square 等，经 Europe PMC 的 SRC:PPR 检索。
  // 与 fetchEuropePMC 的区别：仅取预印本，覆盖最新、未同行评审的活跃研究（趋势发现价值高）。
  const q = `${encodeURIComponent(query)} AND SRC:PPR`;
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q}&format=json&pageSize=${max}&resultStart=${offset}`;
  try {
    const res = await withRetry(() => httpGet(url), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.resultList?.result || []).map((it) => {
      const doi = it.doi || '';
      return {
        id: doi ? 'doi:' + doi : `pp:${it.source || 'x'}${it.id || Math.random().toString(36)}`,
        source: 'preprints',
        name: it.title || '',
        abstract: stripTags(it.abstractText || '').slice(0, 4000),
        url: doi ? `https://doi.org/${doi}` : (it.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/` : ''),
        authors: (it.authorList?.author || []).map((a) => a.fullName || '').filter(Boolean),
        tags: it.keywordList?.keyword || [],
        publishedDate: it.pubYear || '',
        doi,
      };
    });
  } catch { return []; }
}

async function fetchCNKI(query, max, offset = 0) {
  // 中文文献源（CNKI / 万方）：需机构订阅凭证，默认无 CNKI_TOKEN 时直接返回空，
  // 避免无意义外呼。配置 CNKI_TOKEN 后，按机构网关填入对应 endpoint 即可启用中文覆盖。
  if (!process.env.CNKI_TOKEN) return [];
  // 真实实现骨架依赖具体机构网关协议，此处保留钩子；启用时在此拼装请求。
  return [];
}

// 11 个数据源的统一入口（DOAJ/DataCite/Zenodo 于 v3、CORE/preprints 于 v4/v5 加入；
// CNKI 仅在配置了 CNKI_TOKEN 时动态加入，避免无凭证空跑）
const SOURCE_FETCHERS = [
  (q, n, o) => fetchOpenAlex(q, n, o),
  (q, n, o) => fetchArxiv(q, n, o),
  (q, n, o) => fetchCrossref(q, n, o),
  (q, n, o) => fetchSemanticScholar(q, n, o),
  (q, n, o) => fetchEuropePMC(q, n, o),
  (q, n, o) => fetchPubMed(q, n, o),
  (q, n, o) => fetchDOAJ(q, n, o),
  (q, n, o) => fetchDataCite(q, n, o),
  (q, n, o) => fetchZenodo(q, n, o),
  (q, n, o) => fetchCORE(q, n, o),
  (q, n, o) => fetchPreprints(q, n, o),
];
// 中文文献源：机构凭证就绪后自动加入（默认不启用）
if (process.env.CNKI_TOKEN) {
  SOURCE_FETCHERS.push((q, n, o) => fetchCNKI(q, n, o));
}

// ==================== 归一化 + 合并 ====================

function normalize(raw, site) {
  const id = raw.id || ('t:' + Buffer.from(String(raw.name || '')).toString('base64').slice(0, 12));
  return {
    id,
    name: raw.name || '',
    source: raw.source || '',
    abstract: (raw.abstract || '').slice(0, 4000),
    url: raw.url || '',
    authors: raw.authors || [],
    tags: raw.tags || [],
    confidence: typeof raw.confidence === 'number' ? raw.confidence : (SOURCE_CONFIDENCE[raw.source] || 0.6),
    sites: [site],
    publishedDate: raw.publishedDate || '',
    // 溯源补全：doi 优先取源字段；若源未给但 id 以 doi: 开头则回退（跨源可溯源关键字段）
    doi: raw.doi || (String(id).startsWith('doi:') ? id.slice(4) : ''),
    addedAt: getISOTime(),
    updatedAt: getISOTime(),
  };
}

/**
 * 处理单个（站点, 检索词）：抓 6 源 → 去重合并进 map（map 已含既有实体）。
 * 返回 { fetched, added, nextOffset }。
 */
async function backfillQuery(site, query, offset, perPage, limit, map) {
  // 6 源并发抓取（失败即空数组），每个源独立熔断器保护；
  // 一个源连续失败 3 次自动熔断 60s，不阻塞其余源
  const settled = await Promise.allSettled(SOURCE_FETCHERS.map(f => {
    const breakerName = f.name.toLowerCase().replace('fetch', '');
    const breaker = CIRCUIT_BREAKERS[breakerName] || new CircuitBreaker(breakerName);
    return breaker.execute(() => f(query, perPage, offset));
  }));
  const breakerMetrics = Object.fromEntries(Object.entries(CIRCUIT_BREAKERS).map(([k, b]) => [k, b.metrics()]));
  let fetched = 0;
  const collected = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') {
      const src = r.reason?.message?.split(':')[1]?.split(',')[0]?.trim() || 'unknown';
      console.log(`[Backfill][CB] 源 ${src} 熔断/超时跳过: ${r.reason.message.slice(0, 80)}`);
      continue;
    }
    for (const it of r.value) { collected.push(it); fetched++; }
  }
  let added = 0;
  for (const raw of collected) {
    if (added >= limit) break;
    const n = normalize(raw, site);
    const dk = dedupeKey(n);
    if (map.has(dk)) {
      // 跨源 / 再次抓取到同篇：字段级增量合并（摘要取更长、标签作者并集、置信度取高）
      map.set(dk, mergeEntity(map.get(dk), n));
      continue;
    }
    map.set(dk, n);
    added++;
  }
  // 游标推进：按 perPage 前进；到达深分页上限则回绕重扫补漏
  const MAX_OFFSET = 9000;
  const nextOffset = (offset + perPage) > MAX_OFFSET ? 0 : (offset + perPage);
  return { fetched, added, nextOffset };
}

// ==================== 主流程 ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const siteArg = args.find(a => a.startsWith('--site='));
  const perPageArg = args.find(a => a.startsWith('--per-page='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 600 : 600;
  const perPage = Math.min(perPageArg ? parseInt(perPageArg.split('=')[1], 10) || 100 : 100, 200);
  const pagesArg = args.find(a => a.startsWith('--pages='));
  const PAGES_PER_QUERY = pagesArg ? Math.min(parseInt(pagesArg.split('=')[1], 10) || 3, 8) : 3;
  // 每站目标容量：单条约 1.1KB，4000 条 ≈ 4.4MB；30 站全满 ≈ 132MB（entities.json 合计），
  // 加结构化索引后总产物仍安全低于 GitHub Pages 1GB 上限（实测 22 站/3k 时为 184MB）
  const maxArg = args.find(a => a.startsWith('--max-entities='));
  const maxEntities = maxArg ? parseInt(maxArg.split('=')[1], 10) || 10000 : 10000;
  // 时间预算：CI 的 job timeout-minutes 是硬杀，一旦触发，末尾的「提交数据」步骤不会执行，
  // 整轮抓取全部作废。这里主动在预算内收尾，保证已抓数据必被提交。默认 35 分钟（CI 上限 50）。
  const minutesArg = args.find(a => a.startsWith('--max-minutes='));
  const parsedMinutes = minutesArg ? parseInt(minutesArg.split('=')[1], 10) : NaN;
  const maxMinutes = Number.isFinite(parsedMinutes) && parsedMinutes >= 0 ? parsedMinutes : 35;
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  // --site 支持逗号分隔多站（如 --site=a,b,c）；缺省则遍历全部站点
  const explicitSites = siteArg
    ? siteArg.split('=').slice(1).join('=').split(',').map(s => s.trim()).filter(Boolean)
    : null;

  // ===== 游标：站点×检索词 级 =====
  const cursorPath = path.join(STATE_DIR, 'backfill-cursor.json');
  const rawCursor = (await readJsonSafe(cursorPath)) || {};
  // 兼容 v1 的「站点→数字」旧格式：遇到数字重置为 {}，让各检索词从 0 重新开始
  const cursor = {};
  let rotate = 0;
  for (const [s, v] of Object.entries(rawCursor)) {
    if (s === '__rotate') { rotate = Number(v) || 0; continue; }
    if (v && typeof v === 'object') {
      cursor[s] = v; // 已是「检索词→offset」对象格式，直接沿用，分页继续推进
    } else {
      // 旧 flat「站点→数字」格式：视为 page1 已抓，跳过已抓页，直接从 offset 100 起步，
      // 让下一轮立刻开始抓 page2，避免永远停在第 1 页（这正是此前扩张停滞的根因）
      cursor[s] = {};
      const qs = SITE_QUERIES[s];
      if (Array.isArray(qs)) for (const q of qs) cursor[s][q] = 100;
    }
  }

  // ===== 站点轮转 =====
  // 站点数增长后（22 站）单轮跑不完全部，若每次都从第一个站开始，
  // 排在后面的站将永远抓不到数据。用持久化的 rotate 偏移轮流做起点，保证公平覆盖。
  const allSites = Object.keys(SITE_QUERIES);
  const sites = explicitSites
    ? explicitSites
    : [...allSites.slice(rotate % allSites.length), ...allSites.slice(0, rotate % allSites.length)];

  console.log(`[Backfill v2] ${dryRun ? '[DRY-RUN] ' : ''}站点 ${sites.length} 个, 单轮每站上限 ${limit}, 单页 ${perPage}, 每站目标容量 ${maxEntities}, 数据源 ${SOURCE_FETCHERS.length} 个`);
  const results = [];
  const QUERY_CONCURRENCY = 3; // 检索词并发；站间另有 sleep，整体礼貌限速

  let processedSites = 0;
  for (const site of sites) {
    if (Date.now() > deadline) {
      console.log(`[Backfill] 已达时间预算 ${maxMinutes} 分钟，本轮在第 ${processedSites} 站收尾（剩余站点下轮由轮转起点优先处理）`);
      break;
    }
    let queries = SITE_QUERIES[site];
    if (!Array.isArray(queries) || queries.length === 0) {
      console.warn(`[Backfill] 未知站点 ${site}, 跳过`);
      continue;
    }
    // 扩量（2026-08-21）：检索词空间饱和是本轮停摆根因之一——每词只追加过 "2025" 一年变体，
    // 各源深页翻尽后新增归零。现扩展为 基础词 × 年份(2024/2025/2026) × 综述(review) 变体。
    // 游标是「站点×检索词」级，新变体即新分页空间；"2026" 随新文献持续增长，可长期续命；
    // 跨源重复由 dedupeKey 兜底，无重复入库风险。查询数 ×4 由时间预算与每站 limit 上限自然约束。
    const YEAR_VARIANTS = ['2024', '2025', '2026'];
    queries = queries.flatMap(q => [q, ...YEAR_VARIANTS.map(y => `${q} ${y}`), `${q} review`]);
    processedSites++;
    if (!cursor[site]) cursor[site] = {};

    const siteDir = path.join(PROJECT_ROOT, site, 'website', 'api');
    const livePath = path.join(siteDir, 'entities.json');
    const indexPath = path.join(siteDir, 'index.json');
    const existing = (await readJsonSafe(livePath)) || [];
    // 存量 DOI 自愈回填：下一轮落库即对全部存量生效（含已饱和站点）
    const { norm: existingNorm, changed: doiChanged } = backfillDoi(existing);

    if (existing.length >= maxEntities) {
      // 已饱和站点：即便不抓取，也把回溯到的 doi 落库，抬升溯源率
      if (doiChanged && !dryRun) {
        await ensureDir(siteDir);
        await fs.writeFile(livePath, JSON.stringify(existingNorm, null, 2), 'utf-8');
      }
      console.log(`[Backfill] ${site}: 已达目标容量 ${existingNorm.length}/${maxEntities}${doiChanged ? `，回溯 DOI ${doiChanged} 条` : ''}，跳过抓取`);
      results.push({ site, fetched: 0, added: 0, total: existingNorm.length, capped: true, doiBackfilled: doiChanged, dryRun });
      await sleep(150);
      continue;
    }

    // 既有实体预装入 map（键=去重键），保证幂等 + 跨源去重
    const map = new Map();
    for (const e of existingNorm) map.set(dedupeKey(e), e);

    let siteFetched = 0;
    let siteAdded = 0;
    // 多页抓取：每个检索词每轮连翻 PAGES_PER_QUERY 页，游标逐页持久化；
    // 即便被时间预算截断，已翻页的偏移也已写入 cursor，下轮无缝续抓（修复「永远停在第 1 页」）
    async function runQuery(q) {
      let off = Number(cursor[site][q]) || 0;
      let f = 0, a = 0;
      for (let p = 0; p < PAGES_PER_QUERY; p++) {
        if (map.size >= maxEntities) break;
        const r = await backfillQuery(site, q, off, perPage, limit, map);
        f += r.fetched; a += r.added;
        off = r.nextOffset;
        cursor[site][q] = off; // 逐页落盘（站点循环结束后统一写文件）
        if (r.fetched === 0) break; // 该页已无新结果，停止翻页
      }
      return { q, fetched: f, added: a };
    }

    for (let i = 0; i < queries.length; i += QUERY_CONCURRENCY) {
      if (map.size >= maxEntities) break;
      // 时间预算必须在「站点内」也生效：此前只在站点循环入口检查，单站检索词扩容后
      // 会拖穿 CI timeout-minutes 硬杀线，导致整轮已抓数据因无法进入提交步骤而全部作废。
      if (Date.now() > deadline) {
        console.log(`[Backfill] ${site}: 达时间预算，站点内提前收尾（已处理 ${i}/${queries.length} 个检索词，下轮游标续抓）`);
        break;
      }
      const chunk = queries.slice(i, i + QUERY_CONCURRENCY);
      const chunkRes = await Promise.all(chunk.map(runQuery));
      for (const r of chunkRes) { siteFetched += r.fetched; siteAdded += r.added; }
      await sleep(150); // 检索词批次间礼貌限速
    }

    const all = Array.from(map.values());
    const cats = [...new Set(all.flatMap(x => x.tags || []))].slice(0, 20).filter(Boolean);

    if (dryRun) {
      console.log(`[DRY-RUN] ${site}: 抓取 ${siteFetched} 条, 可新增 ${siteAdded}, 现有 ${existing.length}, 合计将达 ${all.length}`);
      results.push({ site, fetched: siteFetched, added: siteAdded, total: all.length, dryRun: true });
      await sleep(150);
      continue;
    }

    await ensureDir(siteDir);

    // Policy-as-code Guard 门禁（P0）：写入前强制策略评估，默认拒绝
    // 与 OPA/Rego 语义对齐：策略可版本化、可单测、可审计
    const guardDecision = evalPublishGuard({
      action: 'publish',
      target_site: site,
      entity_count: all.length,
      site_capacity: 3000,
      guards_passed: ['SourceGuard', 'KnowledgeGuard', 'PublishGuard']
    });
    if (guardDecision.decision !== 'allow') {
      console.log(`[Backfill][GUARD] ${site}: ❌ 策略拒绝 (count=${all.length}): ${guardDecision.reason}`);
      results.push({ site, fetched: siteFetched, added: siteAdded, total: all.length, guard_deny: true, guard_reason: guardDecision.reason, dryRun: false });
      await sleep(200);
      continue;
    }
    console.log(`[Backfill][GUARD] ${site}: ✅ 策略放行 (count=${all.length}, rule=${guardDecision.reason})`);

    // 数据质量前置校验（P0 自愈）：写入前强制 gate，不通过则拒绝批次
    // 防止漂移数据写入污染站点，替代仅靠 WatchDog 后置检测
    const quality = dataQualityCheck(all, site);
    if (!quality.pass) {
      console.log(`[Backfill][QUALITY] ${site}: ❌ 质量校验失败，拒绝写入`);
      for (const f of quality.failures) console.log(`    ${f.rule}: ${f.msg}`);
      results.push({ site, fetched: siteFetched, added: siteAdded, total: all.length, quality_fail: true, dryRun: false });
      await sleep(200);
      continue;
    }
    console.log(`[Backfill][QUALITY] ${site}: ✅ 质量通过 (title=${quality.metrics.title_rate}, prov=${quality.metrics.provenance_rate}, abs=${quality.metrics.abstract_rate})`);

    await fs.writeFile(livePath, JSON.stringify(all, null, 2), 'utf-8');
    await fs.writeFile(indexPath, JSON.stringify({ site, totalEntities: all.length, lastUpdated: getISOTime(), categories: cats }, null, 2), 'utf-8');
    console.log(`[Backfill] ${site}: 抓取 ${siteFetched}, 新增 ${siteAdded}, 现有合计 ${all.length}`);
    results.push({ site, fetched: siteFetched, added: siteAdded, total: all.length, dryRun: false });
    await sleep(200);
  }

  const report = { pipeline: 'data-backfill-v2', timestamp: getISOTime(), dryRun, limit, perPage, results };
  if (!dryRun) {
    await ensureDir(STATE_DIR);
    // 仅全站遍历时推进轮转起点；显式 --site 是定点补数，不应打乱全局轮转节奏
    if (!explicitSites) cursor.__rotate = (rotate + processedSites) % allSites.length;
    await fs.writeFile(cursorPath, JSON.stringify(cursor, null, 2), 'utf-8');
    console.log(`[Backfill] 游标已保存 ${cursorPath}（下轮起点偏移 ${cursor.__rotate ?? rotate}）`);
    await ensureDir(REPORTS_DIR);
    const rp = path.join(REPORTS_DIR, `report-data-backfill-${getISOTime().slice(0, 10)}.json`);
    await fs.writeFile(rp, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`[Backfill] 报告已写入 ${rp}`);
  }
  const totalAdded = results.reduce((s, r) => s + (r.added || 0), 0);
  const totalNow = results.reduce((s, r) => s + (r.total || 0), 0);
  const cappedN = results.filter(r => r.capped).length;
  console.log(`[Backfill] 完成. 新增实体合计 ${totalAdded}, 现有合计 ${totalNow}, 涉及站点 ${results.length}, 已达容量站点 ${cappedN}/${results.length}`);

  // ============================================================
  // 可观测性 SLI 采集 + SLO 评估（P1）
  // 每次 backfill 完成后采集全量 SLI，输出 SLA 状态。
  // 若 BREACH 则输出推荐修复操作（后续可集成 GitHub Issue 自动创建）。
  // ============================================================
  if (!dryRun) {
    try {
      const {SLIMonitor, report: slaReport} = await import(path.join(PROJECT_ROOT, 'tools', 'observability.mjs'));
      const mon = new SLIMonitor({root: PROJECT_ROOT});
      const snap = await mon.collect();
      const evalResult = mon.eval(snap);
      console.log(`\n[Backfill][SLI] SLA=${evalResult.status}  BREACH=${evalResult.breaches.length}  DEGRADED=${evalResult.degraded.length}`);
      for (const rec of evalResult.recommendations) {
        console.log(`[Backfill][SLI][${rec.priority}] ${rec.action}`);
      }
      // 写入 SLA 报告（审计用）
      await ensureDir(REPORTS_DIR);
      const slaPath = path.join(REPORTS_DIR, `sla-report-${getISOTime().slice(0, 10)}.json`);
      await fs.writeFile(slaPath, JSON.stringify(evalResult, null, 2), 'utf-8');
    } catch (err) {
      console.log(`[Backfill][SLI] 采集跳过（非阻塞）: ${err.message}`);
    }
  }
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
