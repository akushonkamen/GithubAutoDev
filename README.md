# CGAO — Claude GitHub Automation Orchestrator

围绕 Claude Code + GitHub 的 SDLC 自动化编排器。把 issue 创建→分析→规划→开发→测试→PR→审查→合入的全流程自动化，每个模块松耦合、事件驱动、状态权威可审计。

设计文档：`docs/cgao_spec_v3.md`、`docs/cgao_tasklist_v3.md`、`docs/cgao_v3_changelog.md`

## 技术栈

- TypeScript（Node.js 20+）
- pnpm workspaces（monorepo）
- Drizzle ORM + PostgreSQL
- Hono（HTTP / webhook）
- Zod（schema）
- Vitest（测试）
- Biome（lint / format）

## 仓库结构

```
cgao/
├── apps/
│   └── orchestrator/          # 编排服务（核心）
│       ├── src/
│       │   ├── config/        # .cgao.yml 解析与校验
│       │   ├── db/            # Drizzle client
│       │   ├── events/        # 事件总线抽象
│       │   ├── modules/       # MOD-* 各模块
│       │   ├── runners/       # Trusted Control / Untrusted Code Runner
│       │   ├── server.ts      # HTTP 入口（webhook receiver）
│       │   └── index.ts
│       └── package.json
├── packages/
│   ├── db/                    # Drizzle schema + 迁移
│   ├── events/                # 事件类型定义
│   ├── schemas/               # Zod schema（config、Artifact）
│   └── test-utils/            # 共享测试 fixture
├── .github/workflows/         # GitHub Actions（CGAO runner 体系）
├── docs/                      # 设计文档
├── .cgao.yml.example
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
└── README.md
```

## 当前进度

参见 `docs/cgao_tasklist_v3.md`。正在按 M0→M11 + M-INTAKE 顺序推进。

| 里程碑 | 状态 |
|---|---|
| M0 项目骨架与安全基线 | 进行中 |
| M1 Webhook 与事件底座 | 未开始 |
| M2 状态机、Artifact、hash 绑定 | 未开始 |
| M-INTAKE Issue Intake 模块 | 未开始（依赖 M0/M1/M2/M4/M5） |
| M3-M11 | 未开始 |

## 开发

```bash
pnpm install
pnpm dev          # 启动 orchestrator（watch）
pnpm test         # 全量测试
pnpm lint         # Biome
pnpm typecheck    # tsc --noEmit
```
