# OmniMesh

**分布式边缘节点指挥与自动化任务调度中枢** —— 一个自托管的、部署在 Cloudflare Workers 上的个人基础设施管理与自动化平台。

OmniMesh 让你从一块单一的控制台：

- 🖥️ **实时监控**所有边缘节点（CPU / 内存 / 磁盘 / 网络，支持 1 小时 / 24 小时 / 7 天聚合曲线）；
- ⌨️ 通过**浏览器 WebSSH**（xterm.js + PTY）直接操作任意节点，支持多标签并行；
- 📋 向单个节点、标签组或全部在线节点**下发 Shell / Python 脚本**，实时流式回传 stdout/stderr，运行中任务可随时取消（进程树强杀）；
- 📁 节点间**文件传输**（FILE_TRANSFER 协议通道，≤6MB，HMAC 审计）；
- ⏰ 用 **Cron 定时任务**调度脚本执行（超时强杀、失败自动重试、环境变量 AES-GCM 加密存储）；
- 🔗 用拖拽式 **DAG 工作流画布**（React Flow）编排跨节点流水线（例：节点 A 备份打包 → 节点 B 拉取归档 → Webhook 通知）；
- 🚨 节点离线时通过 **Telegram / 通用 Webhook** 收到即时告警（可选 HMAC-SHA256 签名）；
- 🧾 保留完整的**审计日志**（终端会话、命令下发、配置变更）。

受控端 Agent 是一个**纯 Go 标准库实现的单文件二进制**（Linux amd64/arm64 + Windows，运行时零依赖），通过出站 WSS 主动连接控制平面——**无需公网 IP、无需端口映射**。

---

## 目录结构（Monorepo，pnpm workspaces + Go）

```
omni-mesh/
├── packages/
│   ├── control-plane/   # Cloudflare Workers + Hono + D1 + Durable Objects + R2
│   │   ├── migrations/  # D1 schema（nodes/tasks/cron/workflows/audit/metrics）
│   │   ├── src/durable/ # AgentSession · TerminalBridge · LogHub · EventsHub · Scheduler
│   │   ├── src/routes/  # REST + WebSocket 路由
│   │   └── public/      # dashboard 构建产物（Workers Assets 托管）
│   ├── agent/           # Go agent（纯标准库）
│   │   ├── internal/protocol/    # JSON 信封 + 二进制流帧编解码
│   │   ├── internal/wsframe/     # RFC6455 WebSocket 客户端（自实现）
│   │   ├── internal/metrics/     # Linux /proc 与 Windows syscall 采集器
│   │   ├── internal/pty/         # Linux /dev/ptmx + Windows ConPTY（含管道降级）
│   │   ├── internal/runner/      # 超时强杀的任务执行器（进程组粒度）
│   │   └── internal/service/     # systemd / Windows SCM 服务管理
│   ├── dashboard/       # React 19 + Vite + Tailwind + shadcn 风格组件
│   │   └── src/pages/   # 总览 / 节点 / WebSSH / 工作流 / Cron / 审计 / 设置
│   └── shared/          # 前后端共享协议类型（单一事实来源）
├── install.sh / install.ps1   # 受控端一键安装（systemd / Windows 服务）
└── Makefile
```

## 快速开始（本地开发）

```bash
# 1. 依赖安装
pnpm install

# 2. 应用 D1 迁移
pnpm --filter @omni/control-plane exec wrangler d1 migrations apply DB --local

# 3. 启动控制平面（ http://127.0.0.1:8787 ）
pnpm --filter @omni/control-plane run dev

# 4. 构建 dashboard（输出到 control-plane/public，Assets 直接托管）
pnpm --filter @omni/dashboard run build

# 5. 构建并启动两个模拟节点
cd packages/agent && make all
./dist/omni-agent-windows-amd64.exe run -server ws://127.0.0.1:8787 \
  -regkey omni-dev-key-2026 -name node-1 -labels pve-lxc,prod
./dist/omni-agent-windows-amd64.exe run -server ws://127.0.0.1:8787 \
  -regkey omni-dev-key-2026 -name node-2 -labels windows-pc

# 6. 打开 http://127.0.0.1:8787 ，默认账号 admin / admin123
```

首次启动会自动引导（bootstrap）：创建 `admin` 账号（密码取 `ADMIN_PASSWORD` 变量，默认 `admin123`）与默认注册密钥（`DEFAULT_REG_KEY`，本地默认 `omni-dev-key-2026`）。**部署后请立即在「系统设置」中修改密码并吊销默认密钥。**

## 部署到 Cloudflare

```bash
# 资源创建
wrangler d1 create omni-mesh          # 把返回的 database_id 填入 wrangler.toml
wrangler r2 bucket create omni-mesh-logs

# 生产密钥（本地 vars 里的占位值仅用于开发）
wrangler secret put AUTH_SECRET       # ≥32 字节随机串（JWT/节点令牌/AES 派生源）
wrangler secret put ADMIN_PASSWORD
wrangler secret put DEFAULT_REG_KEY

# 迁移 + 部署
pnpm --filter @omni/control-plane exec wrangler d1 migrations apply DB --remote
pnpm --filter @omni/control-plane run deploy
```

`wrangler.toml` 已包含：D1 / R2 / 5 个 Durable Object 绑定与 SQLite 类迁移、每分钟 Cron 触发器、SPA 静态资源绑定。

## 受控端安装

在任意 Linux (amd64/arm64) / Windows 机器上：

**Linux：**
```bash
sudo ./install.sh --server wss://mesh.example.com \
  --token <注册密钥> --name my-server --labels prod,backup
# → /usr/local/bin/omni-agent + /etc/omni-agent/config.json + systemd 自启
```

**Windows（管理员 PowerShell）：**
```powershell
.\install.ps1 -Server "wss://mesh.example.com" `
  -Token "<注册密钥>" -Name "my-pc" -Labels "windows-pc"
# → %ProgramData%\omni-agent + SCM 服务 OmniMeshAgent 自启
```

Agent 首次注册后会将控制平面签发的**专属节点令牌**持久化到本地配置；之后即使注册密钥被吊销/轮换也不影响已注册节点。支持的环境变量：`OMNI_SERVER` / `OMNI_TOKEN` / `OMNI_REG_KEY` / `OMNI_LABELS` / `OMNI_INSECURE` / `OMNI_PROXY` / `OMNI_SHELL` / `OMNI_METRICS_SEC` / `OMNI_FORCE_PIPE_PTY=1`（强制管道终端模式）。

当控制平面部署在 `*.workers.dev` 且所在网络无法直连时，用 `-proxy http://host:port`（或 `OMNI_PROXY`）让 WSS 与注册请求经 HTTP CONNECT 代理隧道转发（支持 Basic 认证），例如 `-proxy http://127.0.0.1:7897`。绑定自定义域名后通常无需代理。

## 单元测试

```bash
# 控制平面（Vitest：Cron 解析 / DAG 状态机 / 密码与 JWT / AES / 协议编解码）
pnpm --filter @omni/control-plane run test     # 41 tests

# Agent（Go：协议 / 退避 / RFC6455 帧与握手 / 执行器 / 指标解析 / PTY 会话）
cd packages/agent && go test ./...
```

## 安全模型

- **控制台**：PBKDF2-SHA256（120k 迭代）口令哈希 + HS256 JWT（12 小时）；WebSocket 通过 `?token=` 携带同一 JWT。
- **节点**：注册密钥（SHA-256 哈希存储）换取 `nodeId.HMAC` 形式的节点令牌；令牌无过期、随节点删除而吊销。
- **静态敏感数据**：Cron / 工作流的环境变量、Telegram Bot Token 均以 **AES-256-GCM**（HKDF 自 `AUTH_SECRET` 派生密钥）加密后入库，永不回传明文。
- **执行隔离**：脚本以 agent 进程环境执行；超时强杀按**进程组**（Linux `kill -pgid` / Windows `taskkill /T`）终止；取消的任务以 `cancelled` 状态落档；Cron 失败按指数间隔自动重试。

## 自动化桥接（供测试/CI 驱动）

控制台内置两个无害的自动化桥，便于外部脚本驱动真实 UI 流程：

- `window.__omniSend(text)` — 向当前激活的 WebSSH 标签注入键盘输入（走与 `term.onData` 完全相同的上行管道）；
- `window.__omniImport(name, json)` — 向工作流编辑器画布程序化加载 `{name, graph}`（与「JSON 导入」按钮等效）。

后续用户/CI 操作（保存、运行、查看日志）均通过真实 UI 交互完成。

## 已知限制（本地 dev 环境）

- `wrangler dev`（workerd）会周期性回收长连接（本地开发特性；生产 Cloudflare 稳定）。Agent 以指数退避自动重连，WebSSH 会话在 agent 重连后自动重建。
- 本地并发下 D1（SQLite）偶发 `SQLITE_BUSY`——所有事件路径已做吞并处理，不影响连接稳定。
- Windows 11 24H2+ 部分构建上 ConPTY 客户端初始化失败（`0xC0000142`）——agent 自动降级为**管道终端**（`cmd /Q /K PROMPT`），并输出提示行。管道模式无 PTY 行编辑：**打字时字符不回显、退格无效**——请在 WebSSH 工具栏开启「行模式」（本地行编辑缓冲，回车整行发送，支持退格）；Linux 完整支持 PTY。可用 `OMNI_FORCE_PIPE_PTY=1` 强制。
- Windows 磁盘 I/O 速率与 load 指标不支持（无 PDH），曲线显示为空态；Linux 完整。
- **Workers 免费版 CPU 限制（10ms/请求）**：管理员口令哈希采用 PBKDF2-SHA256 **10k 迭代**（哈希串内嵌迭代数，升级迭代只影响新口令）；本地 dev（无 CPU 限制）此前用 120k 会在生产 bootstrap 时静默失败——已修复并在 bootstrap 失败时自动重试。
- **R2 未激活时**：日志归档自动降级为 D1 内联存储（>64KB 截断保留尾部）；在仪表盘激活 R2、恢复 `wrangler.toml` 中 R2 绑定并重新 `wrangler deploy` 即启用完整归档。
- **部署注意**：`wrangler.toml` 不要把 `AUTH_SECRET`/`ADMIN_PASSWORD`/`DEFAULT_REG_KEY` 写进 `[vars]`——vars 会在每次部署时遮蔽同名 Secrets（本地开发请用 `.dev.vars` 文件）。写 Secret 时避免 `echo | wrangler secret put`（`echo` 的尾部换行会污染值），用 `printf '%s' "$VALUE" |`。

## D1 免费额度友好设计（50,000 rows read/天以内）

Workers 免费版 D1 每日限 500 万 rows read。OmniMesh 通过以下设计将稳态消耗控制在每天约 30–50 万行（含仪表盘全天开着的最坏情况）：

- **热路径全部索引化**：alerts/exec_tasks(status,retry_at)/workflow_runs/terminal_sessions 均有覆盖索引，轮询端点只读 LIMIT 范围内的行
- **集群曲线查询逐节点走 (node_id, ts) 主键前缀**——只读 15 分钟窗口内的行，绝不全表扫描 metrics
- **保留策略自动清理**（每小时、全部 PK/索引有界删除）：metrics 8 天、alerts 7 天、audit 30 天、workflow runs+steps 60 天——表大小有上界，扫描成本不随时间增长
- **Scheduler alarm 15s→60s**（Cron 粒度为分钟，60s tick 足够）
- **前端轮询降频**（15–30s）并在 `document.hidden` 时自动暂停；审计页无自动轮询（手动刷新），其计数查询有 10k 行上限
- **Agent 指标默认 30s** 上报（`OMNI_METRICS_SEC` 可调）

运维自检：`GET /api/debug/r2`（R2 归档自检，需登录）、`GET /api/debug/env`（Secret 指纹核对，需登录）。

## 协议速览

完整定义见 [`packages/shared/src/index.ts`](packages/shared/src/index.ts)（前后端单一事实来源）与 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

- **控制消息**（WS text 帧）：`{"t":"AUTH|HEARTBEAT|METRICS|EXEC_REQ|EXEC_STREAM|EXEC_RESULT|EXEC_CANCEL|PTY_OPEN|PTY_RESIZE|PTY_CLOSED|FILE_TRANSFER_REQ|FILE_TRANSFER_ACK","ts":…,"d":{…}}`
- **流式数据**（WS binary 帧）：`[kind:1B][idLen:1B][channelId][payload]`，kind：`0x01` PTY 数据 / `0x02` 文件块。
test
