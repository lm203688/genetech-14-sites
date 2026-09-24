"""
执行证据签名 — 三阶段 tamper-evident 执行审计
====================================================================
参考：VEA (Verified Execution Agent, Ed25519)、AgentSign (ECDSA-P256)、ASQAV
      三阶段模式：INTENT → EXECUTION → RESULT，每阶段独立签名，篡改可检测。

设计要点：
  1. 对称 HMAC-SHA256（不依赖 pyca/cryptography，纯 stdlib），签名密钥用 swarm_audit_key。
  2. 三阶段独立签名：sign_intent / sign_execution / sign_result。
  3. 拒绝/失败也产生签名——"denied intents tell you as much about your agents
     as the approved ones do" (ASQAV)。
  4. verify() 恒定时间比较，防 timing 攻击。
  5. 无外部依赖，纯 stdlib，可在任何 Python 3.8+ 环境运行。

用法：
    from bees.execution_audit import ExecutionAuditor
    auditor = ExecutionAuditor(secret="my-audit-secret")
    with auditor.run(experiment_id="exp_001", agent="analyze_bee", intent={"target": "MAPbI3"}):
        result = run_the_experiment()
    evidence = auditor.last_evidence
    print(auditor.verify(evidence))  # {'ok': True, 'chain': ['intent', 'execution', 'result']}

或直接单阶段签名（用于 wrap 已有代码，无需 context manager）：
    signed = auditor.sign_action(action="retrosynthesis", agent="analyze", payload={...})
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


# ---------- 常量 ----------
SCHEMA_VERSION = "1.0"
ALGORITHM = "HMAC-SHA256"
KEY_ENV = "SWARM_AUDIT_KEY"
DEFAULT_SECRET = "dev-only-do-not-use-in-prod"


def _hmac_hex(message: str, secret: str) -> str:
    """HMAC-SHA256 → hex 字符串（定长 64 字符）"""
    return hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def _stable_json(payload: Any) -> str:
    """稳定 JSON：键排序 + 无空格 + utf-8，保证跨平台/跨调用签名一致"""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _verify_constant_time(a: str, b: str) -> bool:
    """恒定时间字符串比较（防 timing 攻击，等价 JS constantTimeEqual）"""
    if not isinstance(a, str) or not isinstance(b, str) or len(a) != len(b):
        return False
    d = 0
    for x, y in zip(a, b):
        d |= ord(x) ^ ord(y)
    return d == 0


# ---------- 数据模型 ----------
@dataclass
class SignedStage:
    """单个阶段的签名记录"""
    stage: str                     # 'intent' | 'execution' | 'result'
    ts: str                        # ISO 8601 UTC
    payload_hash: str              # sha256(payload_json).hexdigest()
    signature: str                 # hmac_hex(payload_json + '|' + stage + '|' + run_id + '|' + ts)
    payload: Dict[str, Any] = field(default_factory=dict, repr=False)
    meta: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        # 深拷贝 payload/meta，防外部修改污染原始 evidence
        return {
            "stage": self.stage,
            "ts": self.ts,
            "payload_hash": self.payload_hash,
            "signature": self.signature,
            "payload": copy.deepcopy(self.payload),
            "meta": copy.deepcopy(self.meta),
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SignedStage":
        return cls(
            stage=d["stage"],
            ts=d["ts"],
            payload_hash=d["payload_hash"],
            signature=d["signature"],
            payload=d.get("payload", {}),
            meta=d.get("meta", {}),
        )


@dataclass
class ExecutionEvidence:
    """完整三阶段执行证据（tamper-evident）"""
    run_id: str
    agent: str
    schema_version: str = SCHEMA_VERSION
    algorithm: str = ALGORITHM
    stages: List[SignedStage] = field(default_factory=list)
    status: str = "unknown"       # 'success' | 'failure' | 'denied' | 'partial'

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "agent": self.agent,
            "schema_version": self.schema_version,
            "algorithm": self.algorithm,
            "status": self.status,
            "stages": [s.to_dict() for s in self.stages],
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ExecutionEvidence":
        return cls(
            run_id=d["run_id"],
            agent=d["agent"],
            schema_version=d.get("schema_version", SCHEMA_VERSION),
            algorithm=d.get("algorithm", ALGORITHM),
            status=d.get("status", "unknown"),
            stages=[SignedStage.from_dict(s) for s in d.get("stages", [])],
        )


# ---------- Auditor 核心 ----------
class ExecutionAuditor:
    """
    三阶段执行审计器。
    secret 从环境变量 SWARM_AUDIT_KEY 读，缺失时使用 dev 默认值（仅测试）。
    """

    STAGES_ORDER = ["intent", "execution", "result"]

    def __init__(self, secret: Optional[str] = None, run_id_prefix: str = "run"):
        self.secret = secret or os.environ.get(KEY_ENV) or DEFAULT_SECRET
        self.run_id_prefix = run_id_prefix
        self.last_evidence: Optional[ExecutionEvidence] = None

    # ---- 内部签名原语 ----
    def _sign(self, stage: str, run_id: str, ts: str, payload: Dict[str, Any]) -> SignedStage:
        p_json = _stable_json(payload)
        payload_hash = hashlib.sha256(p_json.encode("utf-8")).hexdigest()
        # 签名覆盖 payload + stage + run_id + ts（防跨 run 复用签名）
        message = f"{p_json}|{stage}|{run_id}|{ts}"
        sig = _hmac_hex(message, self.secret)
        return SignedStage(
            stage=stage,
            ts=ts,
            payload_hash=payload_hash,
            signature=sig,
            payload=payload,
        )

    def _verify_stage(self, stage: SignedStage, run_id: str) -> Tuple[bool, Optional[str]]:
        p_json = _stable_json(stage.payload)
        # 检查 payload_hash
        expected_hash = hashlib.sha256(p_json.encode("utf-8")).hexdigest()
        if not _verify_constant_time(expected_hash, stage.payload_hash):
            return False, "payload_hash_mismatch"
        # 检查签名
        message = f"{p_json}|{stage.stage}|{run_id}|{stage.ts}"
        expected_sig = _hmac_hex(message, self.secret)
        if not _verify_constant_time(expected_sig, stage.signature):
            return False, "signature_mismatch"
        return True, None

    # ---- 三阶段 API ----
    def sign_intent(self, run_id: str, intent: Dict[str, Any],
                    reason: Optional[str] = None) -> SignedStage:
        """阶段 1：意图签名（Agent 决定做什么之前）"""
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload = {"intent": intent, "reason": reason or ""}
        return self._sign("intent", run_id, ts, payload)

    def sign_execution(self, run_id: str, action: str,
                       params: Dict[str, Any], tool: Optional[str] = None) -> SignedStage:
        """阶段 2：执行签名（真正调用工具/引擎时）"""
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload = {"action": action, "params": params, "tool": tool or "direct"}
        return self._sign("execution", run_id, ts, payload)

    def sign_result(self, run_id: str, result: Dict[str, Any],
                    status: str = "success",
                    deviations: Optional[List[str]] = None) -> SignedStage:
        """阶段 3：结果签名（工具返回后）。denied/failure 也签。"""
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload = {
            "result": result,
            "status": status,
            "deviations": deviations or [],
        }
        return self._sign("result", run_id, ts, payload)

    def sign_denial(self, run_id: str, intent: Dict[str, Any],
                    reason: str) -> SignedStage:
        """拒绝执行也产生签名（ASQAV 模式：denied intents 也有价值）"""
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload = {"intent": intent, "denial_reason": reason, "denied": True}
        return self._sign("result", run_id, ts, payload)

    # ---- 完整 evidence 组装 ----
    def build_evidence(self, run_id: str, agent: str,
                       intent: SignedStage,
                       execution: Optional[SignedStage],
                       result: SignedStage,
                       status: str = "success") -> ExecutionEvidence:
        """组装三阶段证据；execution 可空（拒绝场景）"""
        stages = [intent]
        if execution:
            stages.append(execution)
        stages.append(result)
        return ExecutionEvidence(
            run_id=run_id, agent=agent, stages=stages, status=status,
        )

    # ---- 验证 API ----
    def verify(self, evidence: ExecutionEvidence) -> Dict[str, Any]:
        """
        验证整个证据链。
        返回：{ok, chain, failures, elapsed_ms}
        chain = 签名通过的所有阶段名（如 ['intent', 'execution', 'result']）
        """
        started = time.time()
        chain = []
        failures = []
        for stage in evidence.stages:
            ok, err = self._verify_stage(stage, evidence.run_id)
            if ok:
                chain.append(stage.stage)
            else:
                failures.append({"stage": stage.stage, "error": err})
        return {
            "ok": len(failures) == 0,
            "chain": chain,
            "failures": failures,
            "run_id": evidence.run_id,
            "agent": evidence.agent,
            "status": evidence.status,
            "elapsed_ms": int((time.time() - started) * 1000),
        }

    def verify_dict(self, d: Dict[str, Any]) -> Dict[str, Any]:
        """从 dict 验证（对外部 JSON 数据）"""
        return self.verify(ExecutionEvidence.from_dict(d))

    # ---- 便捷 API ----
    def new_run_id(self) -> str:
        return f"{self.run_id_prefix}_{int(time.time() * 1000):x}_{uuid.uuid4().hex[:6]}"

    # ---- 上下文管理器（最方便的用法）----
    class RunContext:
        def __init__(self, auditor: "ExecutionAuditor", run_id: str,
                     agent: str, intent: Dict[str, Any]):
            self.auditor = auditor
            self.run_id = run_id
            self.agent = agent
            self.intent = intent
            self.intent_stage = None
            self.execution_stage = None
            self.result_stage = None
            self.error: Optional[BaseException] = None
            self.result_payload: Optional[Dict[str, Any]] = None

        def __enter__(self) -> "ExecutionAuditor.RunContext":
            self.intent_stage = self.auditor.sign_intent(self.run_id, self.intent)
            return self

        def mark_execution(self, action: str, params: Dict[str, Any],
                           tool: Optional[str] = None):
            self.execution_stage = self.auditor.sign_execution(
                self.run_id, action, params, tool=tool)

        def commit_result(self, result: Dict[str, Any],
                          status: str = "success",
                          deviations: Optional[List[str]] = None):
            self.result_payload = result
            self.result_stage = self.auditor.sign_result(
                self.run_id, result, status=status, deviations=deviations)

        def __exit__(self, exc_type, exc_val, exc_tb):
            self.error = exc_val
            if exc_val is not None and self.result_stage is None:
                # 异常路径：签一个 failure result，保留证据链
                self.result_stage = self.auditor.sign_result(
                    self.run_id,
                    {"error": str(exc_val)[:500], "type": exc_type.__name__ if exc_type else "?"},
                    status="failure",
                )
            elif self.result_stage is None:
                # 无异常但也没 commit——签一个 unknown 状态
                self.result_stage = self.auditor.sign_result(
                    self.run_id, {"note": "no explicit commit"}, status="unknown")

            evidence = self.auditor.build_evidence(
                self.run_id, self.agent,
                self.intent_stage, self.execution_stage, self.result_stage,
                status="failure" if exc_val else ("success" if self.result_stage.payload.get("result", {}).get("status") == "success" else "partial"),
            )
            self.auditor.last_evidence = evidence
            return False  # 不吞异常


    def run(self, run_id: str, agent: str, intent: Dict[str, Any]):
        """
        开启一个运行上下文：with auditor.run(...) as ctx: ctx.mark_execution(...); ctx.commit_result(...)
        """
        return self.RunContext(self, run_id, agent, intent)

    def run_auto(self, agent: str, intent: Dict[str, Any]) -> "ExecutionAuditor.RunContext":
        """自动分配 run_id 的便捷入口"""
        return self.run(self.new_run_id(), agent, intent)


# ---------- 便捷函数（不依赖实例） ----------
def default_auditor() -> ExecutionAuditor:
    return ExecutionAuditor()


def sign_action(action: str, agent: str, payload: Dict[str, Any],
                secret: Optional[str] = None) -> Dict[str, Any]:
    """单点签名（wrap 现有代码最省事的方式）"""
    a = ExecutionAuditor(secret=secret)
    rid = a.new_run_id()
    intent = a.sign_intent(rid, {"action": action, "agent": agent})
    execution = a.sign_execution(rid, action, payload)
    result = a.sign_result(rid, {"signed_at": intent.ts}, status="success")
    ev = a.build_evidence(rid, agent, intent, execution, result, status="success")
    return ev.to_dict()


def verify_action(d: Dict[str, Any], secret: Optional[str] = None) -> Dict[str, Any]:
    """单点验证"""
    return ExecutionAuditor(secret=secret).verify_dict(d)


# ---------- CLI 自检 ----------
if __name__ == "__main__":
    import sys

    a = ExecutionAuditor(secret="test-secret-for-cli")
    rid = a.new_run_id()
    with a.run(rid, "analyze_bee", intent={"target": "MAPbI3", "task": "predict_properties"}) as ctx:
        ctx.mark_execution("predict_properties", {"molecule": "MAPbI3"})
        ctx.commit_result({"mw": 469.2, "efficiency": 0.22}, status="success")

    evidence = a.last_evidence
    print(json.dumps(evidence.to_dict(), indent=2, ensure_ascii=False))
    print()
    print("verify:", json.dumps(a.verify(evidence), indent=2))

    # 篡改测试
    tampered = evidence.to_dict()
    tampered["stages"][2]["payload"]["result"]["mw"] = 999.9
    tampered_auditor = ExecutionAuditor(secret="test-secret-for-cli")
    print("tampered verify:", json.dumps(tampered_auditor.verify_dict(tampered), indent=2))

    # 密钥不匹配测试
    wrong_secret = ExecutionAuditor(secret="wrong-secret")
    print("wrong-secret verify:", json.dumps(wrong_secret.verify(evidence), indent=2))
