# CGAO v3 变更记录

日期：2026-07-03  
对应文件：`cgao_spec_v3.md`、`cgao_tasklist_v3.md`  
关联访谈 spec：`.omc/specs/deep-interview-cgao-intake-extension.md`（ambiguity 14.55%，PASSED，7 轮）  
关联实施 plan：`.omc/plans/cgao-intake-extension.md`（RALPLAN-DR consensus，Architect + Critic APPROVED round 3）  
上一版本：`cgao_v2_changelog.md`

## 1. 修改原则

v3 在 v2 完整安全基线之上，新增 **MOD-INTAKE：Issue Intake 模块**，作为 v2 SDLC pipeline 的**前置松耦合入口**。v3 不修改 v2 任何既有模块的行为，只新增入口路径：

```text
飞书 / WeCom IM 群消息
   ↓
MOD-INTAKE（v3 新增，§12.0）
   ├─ 显式 @bot 触发          → intake.decision.explicit
   ├─ LLM 高 confidence      → intake.decision.llm_high_confidence
   └─ LLM 低 confidence      → intake.decision.llm_low_confidence
                                ↓
                       IM 内多轮反问（≤5 轮，类 OMC deep-interview）
                                ↓
                       intake.decision.explicit (澄清完成)
                       或 intake.decision.dropped (失败/超时/放弃)
   ↓
intake.issue.create_requested（advisory 事件）
   ↓
Trusted Control Runner 创建 GitHub issue
  - 仅设 cgao:new + intake:im label
  - body 内嵌 classification_hint（advisory）
  - 不设 bug/feature/security 等权威 label
   ↓
issue.created（既有事件，未修改）
   ↓
MOD-ISSUE（authoritative triage，未修改）
   ↓
既有 v2 pipeline（READY_FOR_ANALYSIS → ...）
```

v3 把 v2 红蓝军挑战沉淀下来的安全基线（untrusted envelope、SHA-bound gates、Trusted Control Runner / Untrusted Code Runner 拆分、protected file policy、final evaluator、reconciler 等）**完整保留**——MOD-INTAKE 全部复用，不引入新的安全原语。

## 2. 规格文档主要变化

### 2.1 新增 §12.0 MOD-INTAKE

`cgao_spec_v3.md` 新增 §12.0，作为 v3 的核心增量。模块职责：

1. 接入飞书 / WeCom IM webhook。
2. 三层触发：显式 / LLM 高 confidence / LLM 低 confidence（IM 内多轮反问）。
3. dedup（`source_type|external_id|content_hash`，24h 窗口）。
4. IM 消息按 untrusted envelope 进入 LLM。
5. Advisory classification（不 bypass MOD-ISSUE）。
6. 建 issue 动作委托 Trusted Control Runner。
7. `intake_messages` 仅 PostgreSQL，不写 Artifact（与 §4.9 一致）。

### 2.2 §6 威胁模型新增 IM 攻击面

`cgao_spec_v3.md` §6.2 信任边界表新增 4 行（IM 消息正文、IM display_name、IM webhook payload、Intake `classification_hint`）；§6.3 攻击面新增 10 类 IM 攻击；§6.4 蓝军控制新增 IM 强制控制项（签名验证位置、token 隔离、advisory 限制、24h dedup、mode=confirm 默认等）。

### 2.3 §9.1 状态机前置 INTAKE_* 状态

`cgao_spec_v3.md` §9.1 主状态列表新增三个前置状态（仅 IM 来源 run 走）：

```text
INTAKE_RECEIVED → INTAKE_CONFIRMING → INTAKE_READY → NEW
```

GitHub 直接创建的 issue 跳过 INTAKE_*，直接进入 `NEW`。

### 2.4 §10 事件契约新增 intake.* topic

新增 8 个 topic：

```text
intake.webhook.lark
intake.webhook.wecom
intake.decision.explicit
intake.decision.llm_high_confidence
intake.decision.llm_low_confidence
intake.decision.rejected
intake.decision.dropped
intake.issue.create_requested
```

明确**不引入** `issue.triage_requested` 事件类型——权威分类始终由 MOD-ISSUE 在既有 `issue.created` 事件后给出。

### 2.5 §14.1 Labels 新增 intake:*

```text
intake:im                  IM intake 路径创建的 issue
intake:unverified-sender   sender_github_login 未链接
```

CGAO `cgao:*` 前缀 labels 保持 v2 不变。

### 2.6 §14.3 Commands：IM 非命令源

明确 IM 消息不作为 CGAO 命令源；所有命令（`/approve-plan`、`/cancel` 等）只接受 `issue_comment.created` 事件。IM 内"放弃"等指令仅作用于当前 Intake 会话，不影响 workflow run 状态机。

### 2.7 §15 数据库新增三张 intake_* 表

```text
intake_sessions    (id, source_type, external_id, content_hash, dedup_key, status, ...)
intake_messages    (id, session_id, role, content, ...)
intake_decisions   (id, session_id, decision, confidence, reason, ...)
```

`dedup_key` 设 `unique` 约束。

### 2.8 §17 GitHub Actions 新增 Intake Receivers

新增 §17.4（Lark）和 §17.5（WeCom），均 `runs-on: cgao-trusted-runner`。签名验证**只在 Trusted Control Runner 内执行**；Bot token / App secret 不离开该 runner。MOD-INTAKE 业务逻辑（dedup / classify / clarify / emit）订阅 `intake.webhook.*` 事件，**零** 平台凭据。

### 2.9 §18 .cgao.yml 新增 intake 配置块

```yaml
intake:
  enabled: true
  mode: confirm                      # auto | confirm | off
  sources:
    lark: { enabled, app_id, triggers, llm }
    wecom: { enabled, corp_id, triggers, llm }
  dedup: { window_minutes, key }
  rate_limit: { max_llm_calls_per_repo_per_hour }
  security: { redact_before_llm, untrusted_envelope, reject_external_links }
```

### 2.10 §22 MVP 范围扩展

MVP must-do 列表新增 "Issue Intake Module（飞书 + WeCom）" 子项。

## 3. 任务清单主要变化

### 3.1 新增 M-INTAKE 里程碑

`cgao_tasklist_v3.md` 在 M2 与 M3 之间插入 §6.5 M-INTAKE 里程碑（P0），共 11 个任务：

```text
T-INTAKE-001  飞书 Bot 接入（webhook + @bot + 线程读取）           P0
T-INTAKE-002  WeCom Bot 接入（同上）                                P0
T-INTAKE-003  显式触发关键词词典 + LLM 兜底                         P0
T-INTAKE-004  LLM 软判定 pipeline（confidence 评分）                P0
T-INTAKE-005  IM 内多轮反问状态机（≤5 轮，类 deep-interview）       P0
T-INTAKE-006  去重幂等（dedup_key 三元组）                          P0
T-INTAKE-007  Untrusted content envelope 集成                       P0
T-INTAKE-008  Trusted Control Runner 调用 GitHub API 建 issue       P0
              （advisory，不 bypass MOD-ISSUE）
T-INTAKE-009  .cgao.yml intake 配置 schema                          P1
T-INTAKE-010  Intake prompt injection 回归测试                      P0
T-INTAKE-011  Intake dedup 重放回归测试                             P0
```

M-INTAKE 插入位置选择 **M3 之前**，因为 Intake 是 issue 入口前置；但 T-INTAKE-001..011 的依赖仍落在 M0/M2/M4/M5 的基础上（事件总线、Artifact Store、untrusted envelope、Trusted Control Runner 拆分等），实际交付顺序仍需配合 M5 runner 拆分完成。

### 3.2 §16 跨模块安全测试计划新增 7 个 intake 行

P0 安全测试表新增：

```text
intake prompt injection         → T-INTAKE-010
intake sender spoofing          → T-INTAKE-010
intake llm hallucination        → T-INTAKE-010
intake webhook replay           → T-INTAKE-011
intake rate/cost DoS            → T-INTAKE-011
intake cross-platform identity  → T-INTAKE-011
intake token leak               → T-INTAKE-011
```

## 4. 与 deep-interview spec 的对应

| 维度 | 访谈结论 | v3 落地 |
|---|---|---|
| Codex 角色 | 本轮 defer，不引入 | v3 不出现 Codex；后续若引入再开新访谈 |
| "自动提 issue" 含义 | 系统从外部源自动创建 issue | §12.0 MOD-INTAKE |
| 外部源范围 | MVP 仅飞书 + WeCom；其余 phase 2 | §12.0 + §17.4/5 仅两个 IM 适配器 |
| 触发策略 | 显式 + LLM 高 conf + LLM 低 conf 多轮 | §12.0 Tier 1/2/3 |
| 多轮反问完整度 | 类 OMC deep-interview，≤5 轮 | §12.0 Tier 3 + T-INTAKE-005 |
| Intake 与 Analysis 关系 | Intake 只澄清到能建 issue | §12.0 边界：advisory hint → MOD-ISSUE → 既有 MOD-ANALYSIS |

访谈 ambiguity 14.55%（threshold 20%），Round 0 topology 6 组件（Codex / Issue Intake / SDLC pipeline / 松耦合 / GitHub 协作 / 安全基线），其中 Codex deferred，Issue Intake 为新增 active 组件，其余 4 个为既有 active 组件。

## 5. 安全基线（unchanged）

v3 **完全复用** v2 安全基线，不引入任何新安全原语：

```text
所有用户内容（含 IM）均为不可信输入              ← v2 §6
untrusted content envelope                       ← v2 §12.4，MOD-INTAKE 复用
Trusted Control Runner / Untrusted Code Runner   ← v2 §13.1，签名验证 + 建 issue 走前者
no-secret test execution                         ← v2 §13.1
SHA-bound gates（spec/plan/approval/head/base）  ← v2 §4.5
protected file policy                            ← v2 §12.11
audit hash chain                                 ← v2 §19
final evaluator                                  ← v2 §12.10
reconciler                                       ← v2 §12.2
```

## 6. 未引入 / 暂缓（phase 2）

下列 deep-interview 中提及但 v3 MVP 不做的能力，归 phase 2，将来通过新的访谈/plan 推进：

```text
Codex 作为执行 agent
监控告警源适配器（Sentry / Grafana / Datadog）
外部工单系统适配器（Jira / Linear / Asana / Notion）
CI/安全扫描适配器（Dependabot / code scanning / Snyk）
邮件源 intake
issue 状态变化双向同步回 IM
跨平台 identity 自动合并（admin UI）
sender_github_login 自动链接（OAuth 流程）
复杂成本分析 dashboard
```

## 7. v2 → v3 执行建议

如果已按 v2 开始实现，按以下顺序补齐 v3：

```text
1. 先确认 v2 M0..M5 安全基线已落地（事件总线、Artifact Store、untrusted envelope、Trusted Control Runner 拆分）。
2. 完成 T-INTAKE-001/002（飞书 + WeCom 适配器 + Trusted Control Runner 签名验证 workflow）。
3. 完成 T-INTAKE-006（dedup）+ T-INTAKE-009（.cgao.yml intake 块）。
4. 完成 T-INTAKE-007（envelope 复用）+ T-INTAKE-003/004（显式触发 + LLM 软判定）。
5. 完成 T-INTAKE-005（多轮反问）。
6. 完成 T-INTAKE-008（advisory issue creation → Trusted Control Runner）。
7. 完成 T-INTAKE-010/011（安全回归测试），确保 P0 攻击面全部覆盖。
8. 验收：Intake-created issue 在 MOD-ISSUE 完成权威分类后，下游与普通 issue 走完全相同的 pipeline（spec v2 既有路径）。
```

这些改动是追加性的，对 v2 既有模块零回归压力。

## 8. 关联工件

```text
cgao_spec_v3.md                                  ← 完整规格（v2 + v3 增量合并）
cgao_tasklist_v3.md                              ← 完整任务清单（M-INTAKE 插入）
cgao_v3_changelog.md                             ← 本文件
cgao_v2_changelog.md                             ← v1→v2 变更（保留）
.omc/specs/deep-interview-cgao-intake-extension.md   ← 访谈 spec（ambiguity 14.55%）
.omc/plans/cgao-intake-extension.md              ← 实施计划（consensus APPROVED round 3）
```
