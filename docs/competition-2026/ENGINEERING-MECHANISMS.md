# 工程机制深挖：10 项可落地的技术实现（v2）

> 来源：对赛道一/二开源项目技术实现细节的二次深挖（超越架构叙事层，聚焦代码级机制）。
> 目的：把「Agent 显式化、Guard 真生效、数据可回滚」落到可复制的代码。
> 检索对象：Temporal / Celery 任务队列、Hystrix / resilience4j 熔断、Avro / Protobuf Schema Registry、DAG 调度（Airflow/Prefect/Dagster）、OpenTelemetry、sOPS/Vault 密钥管理、GitHub Actions 缓存策略、Pinecone / Weaviate / Chroma 向量检索。

---

## 0. 14 站工程现状扫描（事实锚定）

| 维度 | 当前状态 | 证据 |
|------|----------|------|
| Agent 间通信 | **无显式通信协议**，函数直调 | `operations-plan/` 内无 `await agent.xxx` 模式 |
| 源故障降级 | **仅有 fallback URL 列表**，无熔断 | 仅 `pipeline-geo-promotion.js:460` 有 fallbackUrls |
| Schema 演进 | **仅字符串标记** `version: '1.0'` | 各 pipeline 文件硬编码版本号 |
| 性能基准 | **无任何耗时测量** | `build-site.mjs` 无 `console.time` / performance |
| 数据校验 | **后置漂移检测**，无前置校验 | WatchDog 发现漂移但无法阻断 |
| 密钥管理 | **硬编码风险** | 历史泄漏 `ghp_/cfut_/hupijiao` |
| 可观测性 | **CI Issue 是唯一告警** | 无 SLI/SLO/追踪 |
| CI 缓存 | **无增量构建** | 每次全量 build |
| 语义检索 | **keyword-only** | MCP server 用混合检索但无向量索引 |

---

## E1 — Agent 通信总线（Event Bus）

### 开源参考：Temporal / Celery / Redis Streams

**Temporal** 用 `Workflow` 编排 Agent，`Activity` 执行原子操作，Agent 间通过 `Signal` + `Query` 通信。核心机制：状态机驱动的消息流。

**Celery** 用 `broker`（Redis/RabbitMQ）做消息队列，`task.apply_async()` 异步派发，`chain/ chord` 编排串行/并行。

**14 站落地**：不引入外部依赖，用**文件事件总线**（共享 JSONL 文件 + 轮询）解耦 Agent：

```
data/events/
  queue.jsonl           ← 待处理事件队列（生产者 append，消费者 pop）
  dead.jsonl            ← 死信队列（3 次重试后落此）
  processed/
    YYYY-MM-DD.jsonl    ← 已处理（按天轮转）
```

事件结构：
```json
{
  "event_id": "uuid",
  "type": "data_ready|schema_change|drift_alert|proposal_ready",
  "source_agent": "collector_agent",
  "target_agent": "normalizer_agent",
  "payload": { "batch_id": "2026-08-24T103000Z", "entity_count": 615 },
  "retries": 0,
  "max_retries": 3,
  "ts": "2026-08-24T10:30:01Z"
}
```

Producer（Collector Agent 结束时 emit）：
```js
function emitEvent(type, source, target, payload) {
  const event = {
    event_id: crypto.randomUUID(),
    type, source_agent: source, target_agent: target,
    payload, retries: 0, max_retries: 3,
    ts: new Date().toISOString()
  };
  appendFileSync('data/events/queue.jsonl',
    JSON.stringify(event) + '\n', {flag:'a'});
}
```

Consumer（Normalizer Agent 启动时 poll）：
```js
function consumeEvents() {
  const lines = readFileSync('data/events/queue.jsonl', 'utf8').trim().split('\n');
  const events = lines.map(l => JSON.parse(l));
  // process + 移到 processed/
}
```

**差异化叙事**：「14 站的 6 个 Agent 通过事件总线解耦通信，任一 Agent 崩溃不影响其他，死信队列保证零丢失。」

---

## E2 — 自适应熔断（Circuit Breaker）

### 开源参考：Hystrix / resilience4j / Istio

**Hystrix** 三态：CLOSED（正常）→ OPEN（熔断，快速失败）→ HALF_OPEN（试探恢复）。

**resilience4j** 增加滑动窗口统计（失败率/响应时间），阈值可配置。

**14 站现状**：backfill 引擎 6 源并发，任一源超时（如 arXiv 30s 超时）会拖慢整个 run。无熔断 = 一个源崩了全部等。

**落地**：`tools/circuit-breaker.mjs`

```js
class CircuitBreaker {
  constructor(options = {}) {
    this.failures = 0;
    this.successes = 0;
    this.state = 'CLOSED';         // CLOSED | OPEN | HALF_OPEN
    this.threshold = options.threshold || 5;  // 连续失败次数
    this.cooldownMs = options.cooldownMs || 60_000;
    this.halfOpenLimit = options.halfOpenLimit || 3;
    this.lastFailure = null;
    this.halfOpenCalls = 0;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.cooldownMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenCalls = 0;
      } else {
        throw new Error(`[CircuitBreaker] OPEN: ${this.failures} failures, backing off`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure(e);
      throw e;
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenCalls++;
      if (this.halfOpenCalls >= this.halfOpenLimit) {
        this.state = 'CLOSED';
        this.failures = 0;
      }
    } else {
      this.failures = 0;
      this.successes++;
    }
  }

  onFailure(e) {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
    }
  }

  get metrics() {
    return {state: this.state, failures: this.failures, successes: this.successes};
  }
}
```

在 backfill 引擎里用：
```js
const arxivBreaker = new CircuitBreaker({threshold: 3, cooldownMs: 30_000});
const pubmedBreaker = new CircuitBreaker({threshold: 5, cooldownMs: 60_000});

const arxivData = await arxivBreaker.execute(() => fetchArxiv(query));
```

**差异化叙事**：「每个数据源独立熔断，arXiv 挂了 30 秒后自动跳过不阻塞，6 源可用性从 1 个拖垮全量变为 1 个降级不影响其余。」

---

## E3 — Schema Registry（实体 schema 版本化）

### 开源参考：Avro Schema Registry / Protobuf / Confluent Schema Registry

**Avro Schema Registry** 核心机制：`Schema` 带版本号，producer/consumer 各自声明兼容性（BACKWARD / FORWARD / FULL），不兼容的 schema 变更被拦截。

**14 站现状**：实体 schema 散落在各 pipeline 文件的 `version: '1.0'` 字符串中，没有 registry 管理，加字段靠改代码 + 祈祷不 break。

**落地**：`data/schema-registry.json` + `tools/schema-check.mjs`

```json
{
  "entity_v1": {
    "version": 1,
    "compatibility": "BACKWARD",
    "fields": {
      "id": {"type": "string", "required": true},
      "title": {"type": "string", "required": true},
      "abstract": {"type": "string", "required": false},
      "authors": {"type": "array", "required": false},
      "domain": {"type": "string", "required": true},
      "provenance": {"type": "object", "required": false}
    }
  },
  "entity_v2": {
    "version": 2,
    "parent": "entity_v1",
    "compatibility": "BACKWARD",
    "fields": {
      "id": {"type": "string", "required": true},
      "title": {"type": "string", "required": true},
      "abstract": {"type": "string", "required": false},
      "authors": {"type": "array", "required": false},
      "domain": {"type": "string", "required": true},
      "provenance": {"type": "object", "required": false},
      "crosslinks": {"type": "array", "required": false}  ← 新增字段
    }
  }
}
```

```js
function validate(entity, schemaName) {
  const schema = registry[schemaName];
  const errors = [];
  for (const [field, spec] of Object.entries(schema.fields)) {
    if (spec.required && entity[field] === undefined) {
      errors.push(`missing required field: ${field}`);
    }
    if (spec.type === 'string' && typeof entity[field] !== 'string') {
      errors.push(`field ${field} should be string`);
    }
  }
  return errors;
}
```

CI 里加一步：
```yaml
- name: Validate entity schema
  run: node tools/schema-check.mjs
```

**差异化叙事**：「14 站实体 schema 版本化管理，新增字段走 BACKWARD 兼容检查，不再靠『改代码+祈祷不 break』。」

---

## E4 — DAG 编排引擎

### 开源参考：Airflow / Prefect / Dagster

**Airflow** 用 DAG（有向无环图）编排任务，`@task` 装饰器声明依赖，支持 `trigger_rule`（所有成功/任一失败等）。

**14 站现状**：pipeline 是**顺序函数调用**，没有 DAG 语义。新增一个 agent 需要改多处调用链。

**落地**：`tools/dag-runner.mjs`

```js
class DAG {
  constructor() {
    this.nodes = new Map();
  }

  task(name, deps = [], fn) {
    this.nodes.set(name, {deps, fn, status: 'pending', result: null, error: null});
  }

  async run() {
    const completed = new Set();
    let progress = true;

    while (progress) {
      progress = false;
      for (const [name, node] of this.nodes) {
        if (completed.has(name)) continue;
        const allDepsDone = node.deps.every(d => completed.has(d) && this.nodes.get(d).status === 'done');
        if (!allDepsDone) continue;

        try {
          node.result = await node.fn(
            Object.fromEntries(node.deps.map(d => [d, this.nodes.get(d).result]))
          );
          node.status = 'done';
          completed.add(name);
          progress = true;
        } catch (e) {
          node.status = 'failed';
          node.error = e.message;
        }
      }
    }

    return Object.fromEntries(
      [...this.nodes].map(([name, n]) => [name, {status: n.status, error: n.error}])
    );
  }
}
```

使用（替换 backfill 引擎的顺序调用）：
```js
const dag = new DAG();

dag.task('fetch', [], async () => { /* 6 源并发采集 */ });
dag.task('normalize', ['fetch'], async (inputs) => { /* 归一化 */ });
dag.task('validate', ['normalize'], async (inputs) => { /* 审查 */ });
dag.task('enrich', ['validate'], async (inputs) => { /* 跨域桥接 */ });
dag.task('publish', ['enrich'], async (inputs) => { /* 发布 */ });

const result = await dag.run();
// {fetch:{status:'done'}, normalize:{status:'done'}, ...}
```

**差异化叙事**：「14 站 pipeline 升级为 DAG 编排，新增 agent = 加一个 node + 声明 deps，零改动既有链路。」

---

## E5 — 性能基准框架

### 开源参考：Google Perftools / py-spy / node --prof

**14 站现状**：build-site.mjs 运行耗时完全靠猜（CI log 里看起止时间），无阶段级耗时测量。

**落地**：`tools/benchmark.mjs` + 在 build-site 关键节点插点

```js
class Benchmark {
  constructor(name) {
    this.name = name;
    this.start = performance.now();
    this.events = [];
  }

  checkpoint(label) {
    const now = performance.now();
    this.events.push({label, elapsed_ms: +(now - this.start).toFixed(1)});
    return this;
  }

  get report() {
    const total = +(performance.now() - this.start).toFixed(1);
    return {pipeline: this.name, total_ms: total, checkpoints: this.events};
  }
}
```

在 build-site.mjs 里：
```js
const bm = new Benchmark('build-site');
// ... fetch data
bm.checkpoint('data_fetch');
// ... normalize
bm.checkpoint('normalize');
// ... render
bm.checkpoint('render');
// ... write
bm.checkpoint('write');
console.log(JSON.stringify(bm.report));
```

CI 输出：
```json
{"pipeline":"build-site","total_ms":4230,
 "checkpoints":[
   {"label":"data_fetch","elapsed_ms":120},
   {"label":"normalize","elapsed_ms":890},
   {"label":"render","elapsed_ms":3120},
   {"label":"write","elapsed_ms":100}
 ]}
```

**差异化叙事**：「14 站每个构建阶段有精确耗时，reviewer 能看清『render 占 74%』，而不是『整个 build 花了 4 秒』。」

---

## E6 — 数据质量前置校验

### 开源参考：Great Expectations / dbt tests

**Great Expectations** 用 `Expectation Suite` 声明数据校验规则（非空率、值域、分布），pipeline 跑之前跑校验，不通过则拒绝写入。

**14 站现状**：WatchDog 是**后置漂移检测**（数据已写入才发现异常）。评审「飞轮漂移你怎么发现」答得上，「怎么防止漂移写入」答不上。

**落地**：`tools/data-quality.mjs`

```js
const expectations = {
  'entity_count': {min: 10, max: 5000},
  'title_non_null': {rate: 1.0},
  'id_unique': true,
  'domain_valid': {allowed: ['swarmlabs','genetech','healthlens','...']},
  'abstract_ratio': {min: 0.5},  // 50% 有摘要
  'author_count': {min: 1, max: 200}
};

function check(batch, expectations) {
  const results = {};
  const total = batch.length;

  // entity_count
  results.entity_count = {
    pass: expectations.entity_count.min <= total <= expectations.entity_count.max,
    value: total
  };

  // title_non_null
  const nonNull = batch.filter(e => e.title).length;
  results.title_non_null = {
    pass: nonNull / total >= expectations.title_non_null.rate,
    value: nonNull / total
  };

  // id_unique
  const ids = new Set(batch.map(e => e.id));
  results.id_unique = {pass: ids.size === total, value: ids.size};

  // 更多检查...

  return results;
}
```

在 backfill 引擎里（publish 之前）：
```js
const quality = await check(readyEntities, expectations);
const failures = Object.entries(quality).filter(([_,r]) => !r.pass);
if (failures.length > 0) {
  log.warn(`data quality failed: ${JSON.stringify(failures)}`);
  throw new Error('data quality check failed, batch rejected');
}
```

**差异化叙事**：「14 站数据写入前强制过质量校验，不通过则批次拒绝——漂移不再是『发现后修复』，而是『阻止写入』。」

---

## E7 — Secret 热轮换

### 开源参考：sOPS / HashiCorp Vault / AWS Secrets Manager

**sOPS** 用 Age/PGP 加密 secret 到 git，轮换时只需改 key 重新加密。

**Vault** 支持 TTL 自动轮换，租约到期后自动申请新凭据。

**14 站现状**：历史泄漏过 `ghp_/cfut_/hupijiao/CORE_API_KEY`，当前 api-guard `PRO_SECRET` 是静态 GitHub Secret，无轮换机制。

**落地**：`tools/secret-rotation.mjs` + workflow

```yaml
# .github/workflows/secret-rotation.yml
name: Secret Rotation
on:
  schedule:
    - cron: '0 0 1 * *'  # 每月 1 号
  workflow_dispatch:

jobs:
  rotate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Generate new secrets
        run: node tools/secret-rotation.mjs
        env:
          OLD_PRO_SECRET: ${{ secrets.PRO_SECRET }}
      - name: Update secrets
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OLD: ${{ secrets.PRO_SECRET }}
          NEW: ${{ steps.rotate.outputs.new_secret }}
        run: |
          # 通过 API 更新 GitHub Actions secrets（需 repo 权限）
```

```js
// tools/secret-rotation.mjs
function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

async function rotate(oldSecret, newSecret) {
  // 双写期：24h 内两个 key 都有效
  // 双写期结束后禁用 oldSecret
  await writeDoubleKey(oldSecret, newSecret);
  await sleep(24 * 3600 * 1000);
  await revokeKey(oldSecret);
}
```

**差异化叙事**：「14 站密钥每月自动轮换，双写期保证零停机，不再依赖『想起来再改』。」

---

## E8 — SLI/SLO 可观测性栈

### 开源参考：OpenTelemetry / Prometheus / Grafana

**OpenTelemetry** 用 `Span` 追踪每个请求的链路，`Metric` 采集指标，`Log` 关联 trace_id。

**14 站现状**：CI Issue 是唯一告警，无 SLI（延迟/吞吐量）/SLO（可用性目标）/ 告警规则。

**落地**：`tools/observability.mjs`

```js
const SLO = {
  'backfill_pipeline': {
    'availability': {target: 0.99, window: '30d'},      // 99% 可用性
    'freshness': {target_ms: 24*3600*1000, window: '7d'},  // 数据 < 24h 新鲜
    'latency': {target_ms: 300_000, window: '7d', p99: true}  // p99 延迟 < 5min
  },
  'mcp_server': {
    'availability': {target: 0.999, window: '7d'},
    'latency': {target_ms: 5000, window: '7d', p99: true}
  },
  'license_worker': {
    'availability': {target: 0.995, window: '30d'}
  }
};

function computeSLO(service, metric, windowMs) {
  const events = loadEvents(service, windowMs);
  const total = events.length;
  const failures = events.filter(e => e.status === 'error').length;
  const availability = (total - failures) / total;
  const slo = SLO[service][metric];

  return {
    service, metric,
    current: availability,
    target: slo.target,
    health: availability >= slo.target ? 'PASS' : 'BURNING',
    burn_rate: (1 - availability) / (1 - slo.target),
    remaining_budget_pct: +((1 - slo.target) * (1 - (1 - availability) / (1 - slo.target))).toFixed(4) * 100
  };
}
```

每日报告：
```
📊 14 站 SLI/SLO 健康报告 2026-08-24
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
backfill_pipeline:
  可用性: 99.7% (目标 99%)   ✅ PASS  预算剩余 78%
  数据鲜度: 8h (目标 <24h)   ✅ PASS
  p99 延迟: 2.3min (目标 <5min) ✅ PASS

mcp_server:
  可用性: 99.95% (目标 99.9%)  ✅ PASS  预算剩余 83%
  p99 延迟: 1.2s (目标 <5s)   ✅ PASS

license_worker:
  可用性: 99.8% (目标 99.5%)  ✅ PASS  预算剩余 67%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**差异化叙事**：「14 站每个服务有明确 SLO 目标 + 烧水速率告警，评审人看一眼就知道『你们知不知道自己在几号线』。」

---

## E9 — CI 增量构建 + 依赖缓存

### 开源参考：GitHub Actions cache / Turborepo / Nx

**14 站现状**：`tools/build-site.mjs` 每次 CI 全量跑，不管 14 站里哪个站的数据变了。

**落地**：
1. **文件级 diff**：CI 先算 `git diff --name-only HEAD~1 HEAD`，只 build 变化的站点
2. **依赖缓存**：`actions/cache@v4` 缓存 node_modules + 数据 JSON

```yaml
# .github/workflows/pages-deploy.yml
- name: Cache node modules
  uses: actions/cache@v4
  with:
    path: |
      node_modules
      data/entities/
    key: ${{ runner.os }}-build-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-build-

- name: Determine changed sites
  id: changed
  run: |
    CHANGED=$(git diff --name-only HEAD~1 HEAD | grep -oP '(?<=^<site>/)[^/]+' | sort -u)
    echo "sites=$CHANGED" >> $GITHUB_OUTPUT

- name: Build changed sites only
  if: steps.changed.outputs.sites != ''
  run: |
    for site in ${{ steps.changed.outputs.sites }}; do
      node tools/build-site.mjs --site $site
    done
  else:
    run: node tools/build-site.mjs --all
```

**差异化叙事**：「14 站 CI 改为增量构建，单站数据更新只 build 该站，构建时间从 X 分钟降至 Y 秒。」

---

## E10 — 语义索引 + 向量检索升级

### 开源参考：Pinecone / Weaviate / Chroma / Milvus

**14 站现状**：MCP server 用混合检索（keyword + 相似度），但**实体本身没有向量嵌入**，相似度靠字符串距离。评审「你的检索跟普通搜索引擎有什么差别」答不上。

**落地**：

方案 A（零成本，本地向量）：`tools/embed.mjs` + `data/vectors/`
```js
// 用本地 embedding 模型（如 BGE-small，128MB，CPU 可跑）
import {embed} from './tools/embed.mjs';

for (const entity of entities) {
  entity.embedding = await embed(entity.title + ' ' + (entity.abstract || ''));
}

// 存为 JSONL
for (const entity of entities) {
  appendFileSync(`data/vectors/${entity.domain}.jsonl`,
    JSON.stringify({id: entity.id, vector: entity.embedding, ts: Date.now()}) + '\n');
}
```

方案 B（低成本，云端 API）：用 ATEX AI Gateway（已有 ECS 150.158.119.19）做 embedding 后端，零额外成本。

```js
// 通过 ATEX Gateway 调用 embedding 模型
async function embedCloud(text) {
  const resp = await fetch('https://gateway.swarmlabs.tools/v1/embeddings', {
    method: 'POST',
    headers: {'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.EMBED_KEY}`},
    body: JSON.stringify({model:'bge-large', input:text})
  });
  return (await resp.json()).data[0].embedding;
}
```

检索时 hybrid search：
```js
function hybridSearch(query, entities, vectors, k=10) {
  // 1. keyword BM25
  const keywordScores = entities.map(e => bm25(query, e.title + ' ' + (e.abstract||'')));

  // 2. vector cosine
  const qVec = queryVector;
  const vectorScores = vectors.map(v => cosine(qVec, v.vector));

  // 3. reciprocal rank fusion
  const combined = entities.map((_, i) =>
    1 / (60 + keywordRanks[i]) + 1 / (60 + vectorRanks[i])
  );

  return entities.slice(0, k);
}
```

**差异化叙事**：「14 站实体已做向量化 + hybrid search（BM25 + cosine + RRF 融合），检索准确率从『只能匹配关键词』升级到『语义理解 + 关键词兜底』。」

---

## 落地路线图（v2）

| 阶段 | 机制 | 产出 | 工时 |
|------|------|------|------|
| **P0（本周）** | E2 + E5 | `tools/circuit-breaker.mjs` + `tools/benchmark.mjs` + backfill 引擎接入 | 1 天 |
| **P0（本周）** | E6 | `tools/data-quality.mjs` + publish 前校验 | 0.5 天 |
| **P1（2 周）** | E1 + E4 | `data/events/` 事件总线 + `tools/dag-runner.mjs` | 2-3 天 |
| **P1（2 周）** | E3 | `data/schema-registry.json` + `tools/schema-check.mjs` | 1 天 |
| **P1（2 周）** | E8 | `tools/observability.mjs` + 每日 SLI 报告 | 1 天 |
| **P2（1 月+）** | E7 + E9 + E10 | Secret 轮换 workflow + CI 缓存 + 向量索引 | 1-2 周 |

**评审决胜点**：E2（熔断）让『一个源崩了不拖垮全量』成为事实；E5（基准）让『每个阶段耗时』可展示；E6（数据质量）让『漂移写入被阻止』成为事实。这三项是『工程深度』评审的第一印象。

---

## 与 v1 的互补关系

| v1 (TECH-DEEP-DIVE.md) | v2 (ENGINEERING-MECHANISMS.md) |
|-------------------------|-------------------------------|
| 架构/数据/Agent 设计层 | 代码级工程实现层 |
| Policy-as-code Guard | Circuit Breaker + 数据质量校验 |
| 数据版本化 | Schema Registry + 向量索引 |
| 声明式 Agent Team | Agent 事件总线 + DAG 编排 |
| 时间机器 | SLI/SLO 可观测性 |
| 工具注册表 | CI 增量构建 + Secret 轮换 |

v1 回答「架构是什么样」，v2 回答「代码怎么写」。两者合起来构成完整的「工程深度」叙事。
