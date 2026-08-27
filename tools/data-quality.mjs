#!/usr/bin/env node
/**
 * Data Quality Checker — 前置数据质量校验
 *
 * 用途：backfill 引擎 publish 前强制校验，不通过则批次拒绝写入。
 * 与 Great Expectations / dbt tests 语义对齐，零外部依赖。
 *
 * 与 TECH-DEEP-DIVE v2 E6 对应。
 */

/** 默认校验规则（各站可覆盖） */
const DEFAULT_EXPECTATIONS = {
  'entity_count': { min: 10, max: 5000 },
  'title_non_null_rate': { min: 1.0 },
  'id_unique': true,
  'domain_valid': { allowed: ['swarmlabs','genetech','healthlens','materials','policies','aivision','quantum','bio','climate','finance','law','security','ai4science','edtech'] },
  'abstract_rate': { min: 0.4 },           // 40% 有摘要
  'author_count': { min: 1, max: 200 },
  'provenance_rate': { min: 0.8 },          // 80% 有溯源
  'title_length': { min: 5, max: 500 },
  'no_empty_entities': true                 // 不允许空对象
};

/**
 * 校验一批实体
 * @param {Array} batch — 待校验实体数组
 * @param {Object} expectations — 校验规则（可选，默认用 DEFAULT_EXPECTATIONS）
 * @returns {{pass: boolean, results: Object, failures: Array}}
 */
export function check(batch, expectations = DEFAULT_EXPECTATIONS) {
  const total = batch.length;
  const results = {};
  const failures = [];

  // 1. entity_count
  results.entity_count = {
    pass: expectations.entity_count.min <= total && total <= expectations.entity_count.max,
    value: total,
    min: expectations.entity_count.min,
    max: expectations.entity_count.max
  };
  if (!results.entity_count.pass) failures.push({rule:'entity_count', ...results.entity_count});

  // 2. no_empty_entities
  if (expectations.no_empty_entities) {
    const empty = batch.filter(e => !e || Object.keys(e).length === 0).length;
    results.no_empty_entities = {pass: empty === 0, empty_count: empty};
    if (!results.no_empty_entities.pass) failures.push({rule:'no_empty_entities', ...results.no_empty_entities});
  }

  // 3. title_non_null_rate
  const withTitle = batch.filter(e => e && e.title && typeof e.title === 'string' && e.title.trim().length > 0).length;
  const titleRate = total > 0 ? withTitle / total : 0;
  results.title_non_null_rate = {
    pass: titleRate >= expectations.title_non_null_rate.min,
    value: +titleRate.toFixed(4),
    min: expectations.title_non_null_rate.min
  };
  if (!results.title_non_null_rate.pass) failures.push({rule:'title_non_null_rate', ...results.title_non_null_rate});

  // 4. id_unique
  const ids = batch.filter(e => e && e.id).map(e => e.id);
  const unique = new Set(ids).size;
  results.id_unique = {
    pass: unique === ids.length,
    unique_count: unique,
    total_count: ids.length,
    duplicates: ids.length - unique
  };
  if (!results.id_unique.pass) failures.push({rule:'id_unique', ...results.id_unique});

  // 5. domain_valid
  if (expectations.domain_valid) {
    const invalid = batch.filter(e =>
      e && e.domain && !expectations.domain_valid.allowed.includes(e.domain)
    );
    results.domain_valid = {
      pass: invalid.length === 0,
      invalid_count: invalid.length,
      invalid_domains: [...new Set(invalid.map(e => e.domain))]
    };
    if (!results.domain_valid.pass) failures.push({rule:'domain_valid', ...results.domain_valid});
  }

  // 6. abstract_rate
  const withAbstract = batch.filter(e => e && e.abstract && typeof e.abstract === 'string').length;
  const abstractRate = total > 0 ? withAbstract / total : 0;
  results.abstract_rate = {
    pass: abstractRate >= expectations.abstract_rate.min,
    value: +abstractRate.toFixed(4),
    min: expectations.abstract_rate.min
  };
  if (!results.abstract_rate.pass) failures.push({rule:'abstract_rate', ...results.abstract_rate});

  // 7. author_count
  const badAuthorCount = batch.filter(e => {
    if (!e || !Array.isArray(e.authors)) return false;
    return e.authors.length < expectations.author_count.min || e.authors.length > expectations.author_count.max;
  });
  results.author_count = {
    pass: badAuthorCount.length === 0,
    bad_count: badAuthorCount.length,
    min: expectations.author_count.min,
    max: expectations.author_count.max
  };
  if (!results.author_count.pass) failures.push({rule:'author_count', ...results.author_count});

  // 8. provenance_rate
  const withProvenance = batch.filter(e => e && e.provenance).length;
  const provRate = total > 0 ? withProvenance / total : 0;
  results.provenance_rate = {
    pass: provRate >= expectations.provenance_rate.min,
    value: +provRate.toFixed(4),
    min: expectations.provenance_rate.min
  };
  if (!results.provenance_rate.pass) failures.push({rule:'provenance_rate', ...results.provenance_rate});

  // 9. title_length
  const badTitleLen = batch.filter(e => {
    if (!e || !e.title) return false;
    const len = e.title.length;
    return len < expectations.title_length.min || len > expectations.title_length.max;
  });
  results.title_length = {
    pass: badTitleLen.length === 0,
    bad_count: badTitleLen.length,
    min: expectations.title_length.min,
    max: expectations.title_length.max
  };
  if (!results.title_length.pass) failures.push({rule:'title_length', ...results.title_length});

  return {
    pass: failures.length === 0,
    total,
    results,
    failures,
    timestamp: new Date().toISOString()
  };
}

/** 快速摘要输出（日志友好） */
export function summary(result) {
  const lines = [
    `Data Quality ${result.pass ? '✅ PASS' : '❌ FAIL'} | batch: ${result.total} entities`,
    `  ${result.failures.length} failures:`
  ];
  for (const f of result.failures) {
    lines.push(`    ❌ ${f.rule}: value=${f.value || f.empty_count || f.bad_count || f.invalid_count}, expected ≥${f.min || 'unique'}`);
  }
  return lines.join('\n');
}

// 冒烟测试
if (import.meta.url === `file://${process.argv[1]}`) {
  const good = [
    {id:'a', title:'Good Title', domain:'swarmlabs', abstract:'x', authors:['Alice'], provenance:{source_url:'http://x'}},
    {id:'b', title:'Another', domain:'genetech', authors:['Bob'], provenance:{source_url:'http://y'}}
  ];
  const bad = [
    {id:'a', title:'', domain:'unknown', authors:[], provenance:{}},
    {id:'a', title:'x'.repeat(600), domain:'swarmlabs', authors:['A']}
  ];

  console.log('=== Good batch ===');
  console.log(summary(check(good)));
  console.log();
  console.log('=== Bad batch ===');
  console.log(summary(check(bad)));
  console.log();

  // 空数组
  console.log('=== Empty batch ===');
  console.log(summary(check([])));
}
