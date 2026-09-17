/**
 * L5 回滚验证逻辑自测
 * 运行：node operations-plan/_test_rollback.mjs
 */

// --- ROLLBACK_SCHEMA ---
const ROLLBACK_SCHEMA = {
  required: ['trigger', 'action', 'target', 'verification'],
  triggerTypes: ['metric-degradation', 'error-rate-spike', 'manual', 'scheduled-check'],
  actionTypes: ['revert-deploy', 'rollback-pipeline', 'disable-feature-flag', 'revert-config'],
};

// --- verifyRollbackPlan ---
function verifyRollbackPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return { valid: false, reason: 'no-rollback-plan-provided' };
  }
  for (const field of ROLLBACK_SCHEMA.required) {
    if (!plan[field] || typeof plan[field] !== 'string' || !plan[field].trim()) {
      return { valid: false, reason: `missing-required-field:${field}` };
    }
  }
  if (ROLLBACK_SCHEMA.triggerTypes.length && !ROLLBACK_SCHEMA.triggerTypes.includes(plan.triggerType)) {
    return { valid: false, reason: `invalid-trigger-type:${plan.triggerType}` };
  }
  if (ROLLBACK_SCHEMA.actionTypes.length && !ROLLBACK_SCHEMA.actionTypes.includes(plan.actionType)) {
    return { valid: false, reason: `invalid-action-type:${plan.actionType}` };
  }
  if (plan.trigger.length < 5) {
    return { valid: false, reason: 'trigger-description-too-short' };
  }
  if (plan.verification.length < 5) {
    return { valid: false, reason: 'verification-description-too-short' };
  }
  return { valid: true, reason: '' };
}

// --- generateRollbackTemplate ---
function getISOTime() { return '2026-09-17T14:00:00.000Z'; }
function generateRollbackTemplate(candidate) {
  const isL5 = candidate.autonomyLevel === 'L5';
  return {
    trigger: `指标退化超过 ${candidate.autonomyLevel === 'L5' ? 20 : 10}% 或错误率 > 5%`,
    triggerType: 'metric-degradation',
    action: isL5
      ? `回滚到上一个已验证版本（${candidate.pocId || 'previous-stable'}），并冻结后续自迭代`
      : `回滚到 PoC 前状态，撤销 ${candidate.pocId || ''} 的变更`,
    actionType: isL5 ? 'revert-config' : 'revert-deploy',
    target: candidate.id || candidate.title || 'unknown-candidate',
    verification: '回滚后验证：CI 全绿 + 指标恢复至阈值内 + 人工确认无副作用',
    reviewer: isL5 ? 'dual' : 'single',
    createdAt: getISOTime(),
    notes: isL5 ? 'L5 递归候选需双重 reviewer 确认回滚结果' : '',
  };
}

// --- AUTONOMY_GATES + checkAutonomyGate ---
const AUTONOMY_LEVELS = {
  L1: { id: 'L1', name: '执行', description: '仅按预定义规则执行，无决策权', ciGate: 'default', reviewer: 'none' },
  L2: { id: 'L2', name: '策略', description: '在固定规则内选择子路径', ciGate: 'default', reviewer: 'single' },
  L3: { id: 'L3', name: '经验', description: '从历史结果学习、调整自身参数', ciGate: 'STRICT_AUDIT', reviewer: 'single-indep' },
  L4: { id: 'L4', name: '环境', description: '主动感知环境并调整行为边界', ciGate: 'STRICT_AUDIT', reviewer: 'dual' },
  L5: { id: 'L5', name: '递归', description: '可修改自身代码并自主迭代', ciGate: 'STRICT_AUDIT', reviewer: 'dual+rollback' },
};
const AUTONOMY_GATES = {
  L1: { minScore: 0.60, minPassed: 2, needRollback: false },
  L2: { minScore: 0.70, minPassed: 3, needRollback: false },
  L3: { minScore: 0.80, minPassed: 3, needRollback: true },
  L4: { minScore: 0.85, minPassed: 4, needRollback: true },
  L5: { minScore: 0.90, minPassed: 4, needRollback: true },
};
function checkAutonomyGate(autonomyLevel, evaluation, rollbackPlan) {
  const gate = AUTONOMY_GATES[autonomyLevel] || AUTONOMY_GATES.L1;
  const scoreOk = evaluation.score >= gate.minScore;
  const passedOk = evaluation.passedCount >= gate.minPassed;
  let rollbackOk = true;
  let rollbackReason = '';
  if (gate.needRollback) {
    const rv = verifyRollbackPlan(rollbackPlan);
    rollbackOk = rv.valid;
    rollbackReason = rv.reason || '';
  }
  return {
    level: autonomyLevel,
    gate: AUTONOMY_LEVELS[autonomyLevel],
    requiredMinScore: gate.minScore,
    requiredMinPassed: gate.minPassed,
    needRollback: gate.needRollback,
    rollbackPlan: rollbackPlan || null,
    rollbackOk,
    rollbackReason,
    scoreOk,
    passedOk,
    autonomyPassed: scoreOk && passedOk && rollbackOk,
    ciGate: AUTONOMY_LEVELS[autonomyLevel].ciGate,
    reviewer: AUTONOMY_LEVELS[autonomyLevel].reviewer,
  };
}

// === TESTS ===
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

console.log('\n=== L5 回滚验证逻辑自测 ===\n');

// Test 1: valid rollback plan
const validPlan = {
  trigger: '指标退化超过 10% 或错误率 > 5%',
  triggerType: 'metric-degradation',
  action: '回滚到 PoC 前状态',
  actionType: 'revert-deploy',
  target: 'test-candidate',
  verification: 'CI 全绿 + 指标恢复至阈值内',
};
const rv1 = verifyRollbackPlan(validPlan);
check('有效回滚方案通过验证', rv1.valid === true);

// Test 2: no plan
const rv2 = verifyRollbackPlan(null);
check('无回滚方案被拒', rv2.valid === false && rv2.reason === 'no-rollback-plan-provided');

// Test 3: missing field
const rv3 = verifyRollbackPlan({ trigger: 'x', action: 'y', target: 'z' });
check('缺 verification 被拒', rv3.valid === false && rv3.reason === 'missing-required-field:verification');

// Test 4: short trigger
const rv4 = verifyRollbackPlan({ trigger: 'ab', triggerType: 'metric-degradation', action: 'revert', actionType: 'revert-deploy', target: 'test', verification: 'check ok' });
check('trigger 过短被拒', rv4.valid === false && rv4.reason === 'trigger-description-too-short');

// Test 5a: L5 gate without rollback → fail
const eval5 = { score: 0.95, passedCount: 5, overall: true };
const gate5a = checkAutonomyGate('L5', eval5, null);
check('L5 无回滚方案 → autonomyPassed=false', gate5a.autonomyPassed === false);
check('L5 无回滚方案 → rollbackOk=false', gate5a.rollbackOk === false);

// Test 5b: L5 gate with rollback → pass
const gate5b = checkAutonomyGate('L5', eval5, validPlan);
check('L5 有回滚方案 → autonomyPassed=true', gate5b.autonomyPassed === true);
check('L5 有回滚方案 → rollbackOk=true', gate5b.rollbackOk === true);

// Test 6: L1 should not need rollback
const eval1 = { score: 0.65, passedCount: 2, overall: true };
const gate1 = checkAutonomyGate('L1', eval1, null);
check('L1 不要求回滚 → autonomyPassed=true', gate1.autonomyPassed === true);
check('L1 → needRollback=false', gate1.needRollback === false);

// Test 7: generateRollbackTemplate L3
const candidateL3 = { id: 'cand-l3', title: 'L3 Test', autonomyLevel: 'L3', pocId: 'poc-1' };
const tmplL3 = generateRollbackTemplate(candidateL3);
check('L3 模板生成有效方案', verifyRollbackPlan(tmplL3).valid === true);

// Test 8: generateRollbackTemplate L5
const candidateL5 = { id: 'cand-l5', title: 'L5 Test', autonomyLevel: 'L5', pocId: 'poc-2' };
const tmplL5 = generateRollbackTemplate(candidateL5);
check('L5 模板生成有效方案', verifyRollbackPlan(tmplL5).valid === true);
check('L5 模板 → reviewer=dual', tmplL5.reviewer === 'dual');
check('L5 模板 → actionType=revert-config', tmplL5.actionType === 'revert-config');

// Test 9: L3 gate with rollback
const eval3 = { score: 0.85, passedCount: 3, overall: true };
const gate3 = checkAutonomyGate('L3', eval3, tmplL3);
check('L3 有回滚方案 → autonomyPassed=true', gate3.autonomyPassed === true);

// Test 10: invalid trigger type
const rvInvalid = verifyRollbackPlan({ ...validPlan, triggerType: 'invalid-type' });
check('无效 triggerType 被拒', rvInvalid.valid === false);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
