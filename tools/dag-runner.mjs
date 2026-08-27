#!/usr/bin/env node
/**
 * DAG Runner — 有向无环图任务编排器
 *
 * 用途：将 pipeline 的顺序函数调用升级为声明式 DAG 编排。
 * 新增 agent = 加一个 node + 声明 deps，零改动既有链路。
 *
 * 与 Airflow / Prefect / Dagster 语义对齐，零外部依赖。
 *
 * 用法:
 *   const dag = new DAG();
 *   dag.task('fetch', [], async () => { return data; });
 *   dag.task('normalize', ['fetch'], async (inputs) => { return inputs.fetch; });
 *   dag.task('publish', ['normalize'], async (inputs) => { return {ok:true}; });
 *   const result = await dag.run();
 *   result.fetch -> {status:'done', result:..., duration_ms:...}
 */

export class DAG {
  constructor() {
    this.nodes = new Map();
  }

  task(name, deps = [], fn) {
    this.nodes.set(name, {deps, fn, status: 'pending', result: null, error: null, startedAt: null, finishedAt: null});
    return this;
  }

  async run() {
    const completed = new Set();
    const results = {};
    let progress = true;
    const maxIterations = this.nodes.size * this.nodes.size; // 防止死循环
    let iterations = 0;

    while (progress && iterations < maxIterations) {
      progress = false;
      iterations++;
      for (const [name, node] of this.nodes) {
        if (completed.has(name)) continue;
        const allDepsDone = node.deps.every(d => completed.has(d) && results[d]?.status === 'done');
        if (!allDepsDone) continue;

        node.startedAt = Date.now();
        try {
          const depsResult = Object.fromEntries(node.deps.map(d => [d, results[d]?.result]));
          node.result = await node.fn(depsResult);
          node.status = 'done';
          node.finishedAt = Date.now();
          results[name] = {status: 'done', result: node.result, duration_ms: node.finishedAt - node.startedAt};
          completed.add(name);
          progress = true;
        } catch (e) {
          node.status = 'failed';
          node.error = e.message;
          node.finishedAt = Date.now();
          results[name] = {status: 'failed', error: e.message, duration_ms: node.finishedAt - node.startedAt};
          // 失败不阻塞无关节点，但标记为 failed
          completed.add(name);
          progress = true;
        }
      }
    }

    if (iterations >= maxIterations) {
      console.warn('[DAG] max iterations reached, possible circular dependency');
    }

    return results;
  }

  summary() {
    return Object.fromEntries([...this.nodes].map(([name, node]) => [name, {status: node.status, deps: node.deps}]));
  }
}

// 冒烟测试
if (process.argv[1] && import.meta.url.includes('dag-runner')) {
  const dag = new DAG();
  dag.task('fetch_arxiv', [], async () => ({source:'arxiv', count:182}));
  dag.task('fetch_pubmed', [], async () => ({source:'pubmed', count:34}));
  dag.task('merge', ['fetch_arxiv', 'fetch_pubmed'], async (inputs) => ({
    total: inputs.fetch_arxiv.count + inputs.fetch_pubmed.count,
    sources: [inputs.fetch_arxiv.source, inputs.fetch_pubmed.source]
  }));
  dag.task('normalize', ['merge'], async (inputs) => ({entities: inputs.merge.total, dedup: Math.round(inputs.merge.total * 0.87)}));
  dag.task('publish', ['normalize'], async (inputs) => ({published: inputs.normalize.entities, ok: true}));

  console.log('DAG:');
  console.log(dag.summary());
  const result = await dag.run();
  for (const [name, r] of Object.entries(result)) {
    console.log(`  ${name}: ${r.status} ${r.duration_ms}ms`);
  }
  console.log('Final:', JSON.stringify(result.publish.result));
}
