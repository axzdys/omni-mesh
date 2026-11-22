# OmniMesh 架构

## 1. 系统全景

```mermaid
graph TB
    subgraph Browser["浏览器 Dashboard (React 19 + Vite)"]
        UI[控制台 SPA]
        XT[xterm.js 多标签 WebSSH]
        RF[React Flow DAG 画布]
    end

    subgraph CF["Cloudflare 边缘"]
        W["Worker (Hono)<br/>REST API · JWT 鉴权 · Assets 托管"]
        subgraph DOs["Durable Objects"]
            AS["AgentSession<br/>(每节点一个)"]
            TB["TerminalBridge<br/>(每终端一个)"]
            LH["LogHub<br/>(每任务一个)"]
            EH["EventsHub<br/>(全局单例)"]
            SCH["Scheduler<br/>(全局单例·状态机)"]
        end
        D1[("D1 SQLite<br/>nodes/tasks/cron/<br/>workflows/audit/metrics")]
        R2[("R2<br/>大体积执行日志归档")]
    end

    subgraph Nodes["边缘节点 (Go Agent · 单文件 · 零运行时依赖)"]
        A1["pve-node-1<br/>Linux amd64"]
        A2["win-pc-2<br/>Windows ConPTY"]
        A3["任意节点<br/>Linux arm64"]
    end

    UI -->|HTTPS REST + JWT| W
    UI -->|"WSS /api/ws/events"| EH
    UI -->|"WSS /api/ws/task/:id"| LH
    XT -->|"WSS /api/ws/terminal/:nodeId"| TB
    RF -->|REST| W

    W <--> D1
    SCH <--> D1
    AS <--> D1
    AS -.->|大日志| R2
    W -->|Cron Trigger 每分钟| SCH

    A1 <-->|"WSS /agent/ws (出站)"| AS
    A2 <-->|"WSS"| AS
    A3 <-->|"WSS"| AS

    SCH -->|EXEC_REQ 派发| AS
    AS -->|结果/步骤推进| SCH
```

**核心设计原则**

1. **Agent 主动出站**：边缘节点永不监听端口，全部通过 WSS 反向连接控制平面，穿透 NAT/防火墙。
2. **DO 即路由表**：每个节点的 `AgentSession` DO 持有该 agent 的长连接，任何下行动作（EXEC_REQ / PTY_OPEN / FILE_TRANSFER_REQ）都是对相应 DO 的一次内部 fetch，毫秒级直达。
3. **无状态 Worker + 有状态 DO**：REST 层无状态可水平扩展；会话/编排状态收敛在 DO 内保证强一致。
4. **单一事实来源**：Agent ⇄ 平面、平面 ⇄ 浏览器的全部消息类型由 `packages/shared/src/index.ts` 定义，Go/TS 双端各自实现同一契约并有互验测试。

## 2. Agent ⇄ 控制平面协议

### 2.1 传输模型

- **控制消息**：WS **text** 帧，JSON 信封 `{ "t": "<TYPE>", "ts": <ms>, "d": {…} }`
- **流式数据**：WS **binary** 帧（绕过 JSON 解析，PTY 毫秒级延迟）：

```
┌──────────┬──────────┬────────────────────┬──────────────────────────┐
│ kind (1B)│ idLen(1B)│ channelId (0-255B) │ payload (PTY 字节/文件块) │
└──────────┴──────────┴────────────────────┴──────────────────────────┘
  0x01 = PTY 数据            0x02 = 文件传输块
```

### 2.2 连接生命周期

```mermaid
sequenceDiagram
    participant A as Agent (Go)
    participant AS as AgentSession DO
    participant D1 as D1

    A->>AS: GET /agent/ws?token=nd_xxx.HMAC  (HTTP Upgrade)
    AS->>AS: 验签 token → accept WS（若已有旧连接则 close(4002,"superseded")）
    A->>AS: {t:"AUTH", d:{token, version}}
    AS-->>A: {t:"AUTH_OK", d:{nodeId, heartbeatSec:15, metricsSec:10}}
    AS->>D1: UPDATE nodes SET status='online'
    AS->>AS: alarm(75s) 心跳看门狗
    loop 每 15s / 每 10s
        A->>AS: HEARTBEAT / METRICS
        AS->>D1: touchNode / INSERT metrics
        AS->>EH: 广播实时事件（节点状态/指标）
    end
    alt 连接断开
        AS->>D1: status='offline' + alerts 告警行
        AS->>EH: node_status offline
        AS->>TB: 所有 PTY bridge → "agent offline"
        AS->>SCH: 在途任务标记失败并推进
        AS->>TG: Webhook 告警（Telegram/通用，可选）
    end
```

### 2.3 任务执行

```mermaid
sequenceDiagram
    participant U as 用户/DAG/Cron
    participant W as Worker API
    participant SCH as Scheduler DO
    participant AS as AgentSession DO
    participant A as Agent
    participant LH as LogHub DO

    U->>W: POST /api/exec（或 Cron 触发 / DAG 步骤派发）
    W->>W: 解析目标（node/tag/all）→ 逐节点建 exec_tasks 行
    W->>AS: 内部 fetch /dispatch {EXEC_REQ}
    AS->>D1: markTaskRunning（attempts+1）
    AS->>A: EXEC_REQ {taskId, script, env(AES解密), timeoutMs}
    A->>A: runner：进程组 + 超时强杀 + 环境注入
    loop stdout/stderr 流式
        A-->>AS: EXEC_STREAM {dataB64}
        AS-->>LH: 转发 → 浏览器实时显示
        AS->>AS: 内存累计（>10MB 截断）
    end
    A-->>AS: EXEC_RESULT {exitCode, durationMs}
    AS->>R2: 日志 >64KB → R2 归档；≤64KB → D1 log_tail
    AS->>LH: result 帧 → 浏览器收尾
    AS->>SCH: on-task-result（DAG 推进 / Cron 重试）
    AS->>EH: task 事件
```

失败重试：Cron 任务失败/超时且 `attempts ≤ retries` 时，Scheduler 以 30s 递增的 `retry_at` 重新排队；离线派发同样进入该队列。

### 2.4 WebSSH（浏览器 ⇄ PTY）

```mermaid
sequenceDiagram
    participant X as xterm.js (浏览器)
    participant TB as TerminalBridge DO
    participant AS as AgentSession DO
    participant A as Agent PTY

    X->>TB: WSS /api/ws/terminal/:nodeId (JWT via ?token)
    TB->>AS: 内部 fetch /pty-attach {ptyId, cols, rows}
    AS->>A: PTY_OPEN（Linux: /dev/ptmx + setsid/ctty；Windows: ConPTY→失败降级管道 shell）
    AS-->>TB: ok → 浏览器 {type:"open", ok:true}
    X->>TB: binary 帧（键入字节）
    TB->>AS: 内部 fetch /pty-input (binary body)
    AS->>A: binary PTY_DATA 帧
    A-->>AS: binary PTY_DATA（shell 输出）
    AS->>TB: 内部 fetch /agent-data (binary)
    TB-->>X: binary 帧 → term.write()
    X->>TB: {type:"resize",cols,rows} → PTY_RESIZE（TIOCSWINSZ / ResizePseudoConsole）
    X->>TB: 关闭 → PTY_CLOSED + 审计 terminal.close
```

断线自愈：agent 断开时向所有 bridge 广播 `agent offline`；agent 重连成功后 AgentSession 自动对每个存活 bridge 重新发送 `PTY_OPEN`，终端无需用户干预即可恢复。

### 2.5 文件传输（FILE_TRANSFER）

- **上传**（平面→节点）：`FILE_TRANSFER_REQ{direction:"upload", size}` 后跟 binary `0x02` 块；agent 收满 `size` 字节落盘并回 `FILE_TRANSFER_ACK{done}`。
- **下载**（节点→平面）：agent 收到 `direction:"download"` 后流式发送块并最终回 `ACK{done}`；平面聚合后经 REST 返回给浏览器（≤6MB）。全程写审计日志。

## 3. 调度引擎

### 3.1 Scheduler DO（全局单例）

- **alarm 循环**：每 15s `tick()`（Workers Cron 触发器每分钟也调用 `/tick`，两者幂等）。
- **Cron 触发**：5 段表达式（UTC）由纯函数解析器计算 `next_run`；到期即对匹配目标（node/tag/all 在线节点）逐个建任务并派发，Vixie 语义（dom/dow 皆受限时 OR）。
- **重试队列**：`status='queued' AND retry_at<=now` 的任务重新派发。
- **保留策略**：每小时清理 8 天前的 metrics 明细（1h/24h/7d 查询按 30s/5m/1h 分桶聚合）。

### 3.2 DAG 状态机

```mermaid
stateDiagram-v2
    [*] --> dispatch_roots: run-workflow
    dispatch_roots --> running: 根步骤建任务并派发
    running --> advance: on-task-result（步骤内全部任务终态）
    advance --> dispatch: 后继全部就绪（或 onFailure=continue）
    advance --> skip: 后继被阻断（上游失败/超时，默认 stop）→ 传递性跳过
    dispatch --> running: 后继派发（script→多节点任务 / webhook→内联 fetch）
    advance --> success: 所有步骤终态且无失败
    advance --> failed: 存在失败/超时步骤
    success --> [*]
    failed --> [*]
```

- 图校验（Kahn 环检测、目标合法性、重复 id）在创建/更新时与每次派发前执行。
- 推进逻辑为**纯函数** `advance()`（`src/dag.ts`），配 11 个单元测试覆盖：根派发、汇合等待、失败阻断、continue 分支、传递性跳过、成功收敛。

## 4. 数据模型（D1）

| 表 | 用途 |
|---|---|
| `users` | 控制台账号（PBKDF2） |
| `nodes` | 节点注册表（labels JSON、status、last_seen） |
| `reg_keys` | 注册密钥（SHA-256 哈希 + prefix 展示） |
| `metrics` | 指标明细（PK node_id+ts，8 天保留） |
| `cron_jobs` | 定时任务（expr、target、env_enc、next_run） |
| `exec_tasks` | 任务全生命周期（含 retry_of/retry_at/log_path） |
| `workflow_defs` / `workflow_runs` / `run_steps` | DAG 定义 / 运行快照 / 步骤状态机 |
| `audit_logs` | 全操作审计（登录/派发/终端/配置变更） |
| `alerts` | 告警记录（Webhook 推送标记） |
| `settings` | KV 配置（Webhook 配置，secrets 加密） |
| `terminal_sessions` | WebSSH 会话开闭时间审计 |

## 5. Agent 内部结构（纯 Go 标准库）

```
cmd/omni-agent          入口：flags → config → client.Run；service install/uninstall/--service-run
internal/config         JSON 配置文件 + OMNI_* 环境变量 + flag 三级合并，原子保存
internal/protocol       信封/载荷结构 + 二进制帧编解码（与 TS 共享契约，互验测试）
internal/wsframe        RFC6455 客户端：握手(Sec-WebSocket-Accept 校验)、掩码流式写、
                        自动 ping→pong、close 处理、TLS(wss) 与 InsecureSkipVerify
internal/backoff        指数退避 + full jitter（1s→60s），成功即重置
internal/metrics        Linux: /proc/stat|meminfo|net|diskstats|loadavg + statfs
                        Windows: GlobalMemoryStatusEx / GetSystemTimes / GetIfTable /
                        GetDiskFreeSpaceExW（纯 syscall，IF_OPERATIONAL=5）
internal/runner         shell/python 执行器：32KB 流式块、超时强杀（进程组/taskkill /T）、
                        环境注入、取消
internal/pty            Linux: /dev/ptmx(TIOCGPTN/TIOCSPTLCK/TIOCSWINSZ/TIOCSCTTY)
                        Windows: ConPTY(CreatePseudoConsole+属性列表) + 2.5s 探针
                        → 静默自动降级管道会话（兼容 24H2+ 0xC0000142 回归）
internal/service        Linux: systemd 单元写入 + enable --now；信号转停机
                        Windows: advapi32 SCM(CreateService/StartServiceCtrlDispatcher)
internal/client         会话编排：注册→AUTH→读写泵→心跳/指标→任务/PTY/文件分发→断线自愈
```

## 6. 前端结构（React 19）

- **Shell**：可折叠侧栏 + 移动端抽屉 + 全局实时事件（EventsHub）+ Toast。
- **页面**：Overview（聚合仪表 + 15 分钟集群 CPU 多线曲线）、Nodes/NodeDetail（1h/24h/7d 四联图）、Terminal（多标签、字号缩放、断线提示）、Workflows（列表/编辑器/运行视图三页，React Flow 双向绑定步骤状态色）、CronJobs（预览下次执行、启停、立即运行、历史）、AuditLogs（动作分类 + 搜索 + 分页）、Settings（密钥签发/吊销、Telegram/通用 Webhook、文件传输、改密）。
- **实时层**：`useEvents()` 维护到 EventsHub 的常驻 WS（自动重连）；任务日志经 LogHub WS 流式 append；xterm 二进制直通。

## 7. 部署拓扑

```mermaid
graph LR
    subgraph CF["Cloudflare 全球边缘"]
        W2[Worker + Assets]
        D12[(D1)]
        R22[(R2)]
    end
    subgraph Home["家庭/机房（无公网 IP）"]
        N1[Linux 主机]
        N2[Windows 主机]
    end
    N1 -.->|WSS 出站| W2
    N2 -.->|WSS 出站| W2
    W2 --> D12
    W2 --> R22
```

生产部署只需 Cloudflare 免费套餐即可承载个人规模（D1 免费额度 5GB、DO 请求数按量、Cron 每分钟触发）。
