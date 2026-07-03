# Attack Scenario: Stale Approval / TOCTOU Merge

> 对应威胁模型：AS-07（workflow run SHA drift）、AS-IM-* 中涉及权威动作的衍生风险
> 对应 spec：§4.5（SHA-bound gate）、§12.10（final evaluator）、§19（audit hash chain）
> 对应 tasklist：T-M0-004、T-M2-007（audit chain）、T-M10-001（reconciler drift）

## 1. 攻击描述

CGAO 的合入决策依赖一组 SHA-bound gate：`spec_sha / plan_sha / approval_sha / head_sha / base_sha` 五元组必须互相一致（spec §4.5）。攻击者在 approval 给出后、merge 执行前，悄悄改动 PR 内容或目标分支：

- **Stale approval**：用早期 commit 取得 human approval，然后 force-push 新内容（含恶意改动）
- **TOCTOU on base**：approval 期间目标分支被攻击者另开 PR 合入受保护文件，使本 PR 的 base 漂移
- **Plan/review 替换**：在合入前替换 implementation_plan artifact，但保留旧 plan_sha
- **Workflow run 复用**：用旧 run_id 的成功结果作为新 commit 的合入凭据

## 2. 受影响资产

| 资产 | 损失路径 |
|---|---|
| PR merge 决策 | 旧 approval 复用 → 错误合入 |
| 受保护文件（spec §12.11） | base 漂移期被改 |
| audit_records 完整性 | 旧 hash 仍被引用，链断裂 |

## 3. 控制点（CGAO 强制）

引用 spec §4.5（SHA-bound gate 五件套）：

| 控制 | 实现位置 |
|---|---|
| **gate 五元组绑定** | orchestrator policy 模块 (`@cgao/policy`) |
| **final evaluator**（spec §12.10） | merge 前重新读 GitHub 当前状态 + 重新计算 gate |
| **approval 即时失效** | `approval_sha` 与当前 `head_sha` 不一致即 approval 失效，需重新 approval |
| **audit_records hash chain**（spec §19） | 每 authoritative action append，链断即 reconciler 报告 RECON_DRIFT |
| **protected files policy**（spec §12.11） | 任一受保护文件改动即自动 high risk，强制人工 review |

## 4. 攻击示例（脱敏）

```text
T0  attacker opens PR #100 base=main@A head=feature@B  → plan_sha=P1
T1  reviewer approves at head=B                          → approval_sha=B
T2  attacker force-pushes feature to B' (contains .github/workflows/evil.yml)
T3  attacker requests merge

EXPECTED: orchestrator reads GitHub head, sees B' ≠ approval_sha=B
          → SHA_GATE_MISMATCH error, merge blocked
          → audit_records append `merge.blocked` with reason=stale_approval
```

```text
T0  PR #100 base=main@A  → plan_sha=P1 (built against main@A)
T1  malicious PR #101 merges to main → main now at A'
T2  PR #100 reviewer approves at base=A (recorded)
T3  PR #100 attempts merge with base_sha=A, but actual main=A'

EXPECTED: orchestrator reads GitHub main, sees A' ≠ base_sha=A
          → SHA_GATE_MISMATCH, merge blocked, must rebase
```

## 5. 检测与响应

| 检测点 | 实现 |
|---|---|
| SHA mismatch on merge | `SHA_GATE_MISMATCH` 错误码（`docs/standards/errors.md`） |
| Force-push 事件 | GitHub webhook `pull_request.synchronize` → MOD-PR 重置 approval |
| audit_records hash 链断裂 | reconciler 周期校验（T-M10-001），不一致即 `RECON_DRIFT` |
| protected files diff | final evaluator 计算差异，触发即升级 risk |

## 6. 测试任务映射

| Fixture / 测试 | tasklist |
|---|---|
| `tests/fixtures/webhook-replay/synchronize-after-approve.json` | T-M0-004 |
| `tests/security/sha-bound-gate.test.ts` | T-M0-004 |
| `tests/security/audit-chain-break.test.ts` | T-M0-004 / T-M2-007 |
| reconciler drift detection | T-M10-001 |

## 7. 蓝军演练清单

- [ ] force-push 后 stale approval 复用
- [ ] base 漂移期合入（无 rebase）
- [ ] workflow run 复用（旧 run_id 用作新 commit 凭据）
- [ ] plan artifact 偷换（plan_sha 不变但内容变化）
- [ ] audit_records 历史篡改（hash 链断裂）
- [ ] review_comment 删除后复用 approval
- [ ] status check 重命名绕过 required check
