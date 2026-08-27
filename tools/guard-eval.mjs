#!/usr/bin/env node
/**
 * Policy-as-code Guard 引擎
 *
 * 用途：所有 agent 副作用动作先过策略引擎（默认拒绝），再执行。
 * 策略用声明式 JSON 编写，引擎求值返回 allow/deny + 原因 + 策略版本。
 *
 * 与 OPA/Rego 语义对齐（默认拒绝、显式放行），零外部依赖。
 *
 * 用法：
 *   import {evalGuard, loadPolicy} from './tools/guard-eval.mjs';
 *   const policy = loadPolicy('publish');
 *   const decision = evalGuard(policy, {action:'publish', target_site:'swarmlabs', entity_count:421, guards_passed:[...]});
 *   // decision = {decision:'allow'|'deny', reason, policy_version, matched_rule}
 *
 * 策略文件：guards/publish.policy.json / ingest.policy.json / evolve.policy.json
 */

import {readFileSync} from 'fs';
import {resolve, dirname} from 'path';
import {fileURLToPath} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

/**
 * JSON-logic 求值器（轻量版，支持 ==, !=, <, <=, >, >=, in, all, any, not, !, *, +）
 * 参考: https://json-logic.com/
 */
function evalExpr(expr, context) {
  if (expr === null || expr === undefined) return expr;
  if (typeof expr !== 'object') return expr;

  const keys = Object.keys(expr);
  if (keys.length !== 1) return expr;  // 返回原值（可能是 ref 或常量）

  const op = keys[0];
  const operands = expr[op];

  switch (op) {
    case 'var':
      return context[operands] !== undefined ? context[operands] : null;
    case 'ref':
      // 引用策略本身的字段（如 allowed_sites）
      return context.__policy__ ? context.__policy__[operands] : null;
    case '==':
      return evalOp(operands, context, (a, b) =>
        Array.isArray(a) && Array.isArray(b)
          ? a.length === b.length && a.every((v, i) => v === b[i])
          : a === b
      );
    case '!=':
      return evalOp(operands, context, (a, b) => a !== b);
    case '<':
      return evalOp(operands, context, (a, b) => a < b);
    case '<=':
      return evalOp(operands, context, (a, b) => a <= b);
    case '>':
      return evalOp(operands, context, (a, b) => a > b);
    case '>=':
      return evalOp(operands, context, (a, b) => a >= b);
    case 'in':
      return evalOp(operands, context, (a, b) => Array.isArray(b) ? b.includes(a) : false);
    case 'not':
      return !evalExpr(operands, context);
    case '!':
      return !evalExpr(operands, context);
    case 'all':
      return Array.isArray(operands) && operands.every(e => evalExpr(e, context));
    case 'any':
      return Array.isArray(operands) && operands.some(e => evalExpr(e, context));
    case '*':
      return evalOp(operands, context, (a, b) => a * b);
    case '+':
      return evalOp(operands, context, (a, b) => a + b);
    case 'and':
      return evalOp(operands, context, (a, b) => a && b);
    case 'or':
      return evalOp(operands, context, (a, b) => a || b);
    default:
      return expr;
  }
}

function evalOp(operands, context, fn) {
  if (!Array.isArray(operands) || operands.length < 2) return false;
  return fn(evalExpr(operands[0], context), evalExpr(operands[1], context));
}

/**
 * 加载策略文件
 */
export function loadPolicy(policyName) {
  const policyPath = resolve(PROJECT_ROOT, 'guards', `${policyName}.policy.json`);
  return JSON.parse(readFileSync(policyPath, 'utf-8'));
}

/**
 * 评估一个动作是否通过策略
 * @param {Object} policy — 策略定义
 * @param {Object} context — 动作上下文（action, target_site, entity_count 等）
 * @returns {{decision: 'allow'|'deny', reason: string, policy_version: number, matched_rule: string|null}}
 */
export function evalGuard(policy, context) {
  const ctx = {...context, __policy__: policy};
  const defaultDecision = policy.default === 'deny' ? 'deny' : 'allow';
  const defaultReason = `no rule matched, default: ${policy.default}`;

  // 顺序匹配：第一个匹配的规则决定结果
  for (const rule of policy.rules || []) {
    if (!rule.when) continue;
    if (evalExpr(rule.when, ctx)) {
      return {
        decision: rule.allow ? 'allow' : 'deny',
        reason: rule.description || rule.id || (rule.allow ? 'allowed by rule' : 'denied by rule'),
        rule_id: rule.id || null,
        policy_id: policy.id,
        policy_version: policy.version
      };
    }
  }

  // 无规则匹配，返回默认决策
  return {
    decision: defaultDecision,
    reason: defaultReason,
    rule_id: null,
    policy_id: policy.id,
    policy_version: policy.version
  };
}

/**
 * 批量评估 + fallback ladder
 */
export async function guardedAction(policyName, context, actionFn) {
  const policy = loadPolicy(policyName);
  const decision = evalGuard(policy, context);

  if (decision.decision === 'allow') {
    return await actionFn();
  }

  // Fallback ladder: retry → degrade → escalate → hardfail
  throw new Error(
    `[Guard:${policyName}] DENY for action="${context.action}" target="${context.target_site}": ${decision.reason}` +
    `\n  policy=v${decision.policy_version}, rule=${decision.rule_id}`
  );
}

// 冒烟测试
if (process.argv[1] && import.meta.url.includes('guard-eval')) {
  const publishPolicy = loadPolicy('publish');
  const tests = [
    {ctx: {action:'publish', target_site:'swarmlabs', entity_count:421, site_capacity:3000, guards_passed:['SourceGuard','KnowledgeGuard','PublishGuard']}, expect:'allow'},
    {ctx: {action:'publish', target_site:'swarmlabs', entity_count:3000, site_capacity:3000, guards_passed:['SourceGuard','KnowledgeGuard','PublishGuard']}, expect:'deny'},
    {ctx: {action:'publish', target_site:'unknown', entity_count:10, site_capacity:3000}, expect:'deny'},
    {ctx: {action:'publish', target_site:'swarmlabs', entity_count:50, site_capacity:3000}, expect:'allow'},
    {ctx: {action:'publish', target_site:'swarmlabs', entity_count:0}, expect:'deny'},
  ];

  console.log('=== Guard Eval Smoke Test ===');
  let pass = 0;
  for (const t of tests) {
    const d = evalGuard(publishPolicy, t.ctx);
    const ok = d.decision === t.expect;
    console.log(`${ok ? '✅' : '❌'} action=${t.ctx.action} site=${t.ctx.target_site} count=${t.ctx.entity_count} → ${d.decision} (${d.reason})`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${tests.length} passed`);
}
