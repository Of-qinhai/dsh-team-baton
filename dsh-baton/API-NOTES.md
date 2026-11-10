# dsh-baton / API-NOTES

M0 接入验证记录。目标是确认 DSH 能否在指定目录创建会话、命名、保持空闲，并在人工操作后提交首条消息。
验证环境是本机真实 DSH Desktop，不是源码或另一个独立进程。

## 环境

| 项目 | 实测值 |
|---|---|
| DSH Desktop | Electron 44.7.0 |
| Host Node | v24.21.0 |
| Chromium | 152.0.7977.130 |
| 平台 | darwin |
| `WebSocket` | 原生可用（function） |
| `fetch` | 原生可用（function） |

结论：插件 Host 侧不需要 `ws`/`node-fetch` 依赖，可直接用全局 `WebSocket`。

## 插件加载方式

- 目录型 bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入一行 `baton-m0`。
- Host 入口为 `export function apply(ctx)`，`inject = ['tools','sessionController','workspaceRegistry']`。
- `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })` 接受普通对象，**不需要** `defineTool`。
- 重要：从 workspace 目录链接安装的插件不能 import `@deepseek-ai/dsh-tools`（`ERR_MODULE_NOT_FOUND`），因为它按真实路径解析，不经过 profile 的 dsh 依赖。首版插件不 import 任何 dsh 包。
- 修改已经安装的 workspace 插件文件不会热加载；目前每次改动都要 `plugin_manager remove_bundle` + `install_bundle`。M2 前应找到一个更快的重载方式，或把重装写进开发脚本。

## 已验证的会话调用

全部从 Host 插件进程内直接调用（不经 Client / Remote 网关），调用方是一个工具，不是 Agent 会话。

1. 工作区
   ```js
   const workspace = await ctx.workspaceRegistry.create(cwd, 'Baton M0 探针')
   // { id, path, title, sessionIds, attachSession(...), ... }
   ```
   同一 canonical 路径重复调用返回已有工作区。相对路径、不存在的目录、文件路径都会拒绝。

2. 创建会话
   ```js
   const created = await ctx.sessionController.create({ workspaceId: workspace.id })
   // { sessionId, agentPreset? }
   ```
   **不能同时传 `workspaceId` 和 `cwd`**：实测报错 `session.create accepts workspaceId or cwd, not both`。
   只传 `cwd` 也能创建会话，但不会自动挂到工作区（侧边栏可能看不到）。

3. 挂到工作区
   ```js
   if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
   ```
   新会话随后出现在侧边栏的对应工作区。

4. 命名
   ```js
   await ctx.sessionController.rename({ sessionId, title })
   // { title, seq }
   ```
   对刚创建的空会话直接生效，返回 `seq: 3`。

5. 空闲状态
   ```js
   await ctx.sessionController.state({ sessionId }, signal)
   // { cursor: 3, active: true, running: false, queue: [], pendingInput: [] }
   ```
   注意：`state` 的第二个参数 `signal` 是必需的，漏传会得到 `Cannot read properties of undefined (reading 'throwIfAborted')`。
   此状态下没有任何模型请求、没有代码修改；这是「批准前不执行」的结构性证据。

6. 提交首条消息
   ```js
   await ctx.sessionController.prompt({
     requestId: randomUUID(),
     sessionId,
     mode: 'queue',
     content: [{ type: 'text', text: '只回复 OK…' }],
   }, signal)
   // { accepted: true }
   ```
   提交后 state 变为 `running: true`，`cursor` 从 3 变到 6。

7. 等待与结果
   ```js
   const waited = await ctx.sessionController.wait({ sessionId, timeoutMs: 60000, maxMessages: 50 }, signal)
   // reason: 'idle'，state.running: false
   ```
   读取 `waited.output.records`，其中 `assistant/message` 的文本块为 `OK`，证明会话确实执行了模型回合。

8. 列表
   ```js
   const list = await ctx.sessionController.list({}, signal)
   list.items.some(item => item.sessionId === sessionId) // true
   ```

## 密钥读取（桌面启动场景）

- 桌面启动的 DSH Host **没有** `BATON_SECRET` 环境变量：不带参数调用探针时按默认路径 `~/.config/baton/secret` 读取，返回 `ENOENT`。
- 指定一个 0600 文件后读取成功：`{ source: 'file', length: 32 }`，不返回值本身。
- 把同一文件改成 0644 后调用被拒绝：`secret file permissions are too open: 644`。
- 结论：`secretEnv` + `secretFile` 的回退设计是必要的，且不能依赖 shell 环境。

## 未验证 / 阻塞

- **Client 面板按钮调用 Host 尚未打通。** 动态 Client 半可以拿到内置 `host.call(method, args)`（inspect 的 Builtin 已列出），但 Host 侧如何注册这个方法还没有找到文档或样例；下一步需要从官方动态 bundle 的 Host/Client 成对实现里确认，或改用已验证的 Host 入口（命令 / Remote 服务）。
- **审批入口未做。** M0 阶段只有探针工具，没有接受/启动按钮；这不影响会话接口结论。
- 探针工具本身不是审批入口，也没有把远端文本送进 Agent 上下文。

## 本次产生的测试会话

- `<session-id>`：工作区「Baton M0 探针」，标题「[M0] 空闲会话验证」，先空闲后执行，回复 `OK`。
- `<session-id>`：早期用 `cwd` 创建，未挂工作区；已执行并回复 `OK`。

两条都可以在 DSH 里手动归档或删除。

## 对后续实现的约束

- `create` 的入参要么 `workspaceId`，要么 `cwd`，不能并存；插件必须先确保工作区存在。
- `state` / `list` / `prompt` / `wait` 都要传 `AbortSignal`。
- 创建和命名是两个独立调用，中间会话是可见且空闲的；这正是 Baton「批准后才执行」需要的形状。
- 插件不能依赖 workspace 目录里不存在的 dsh 包；要么只用 `ctx` 服务，要么把依赖声明成真实包并在安装时解析。

## Client → Host 桥接（M0 补齐）

不是 `host.call`：动态 bundle 的正确做法是 Host 注册一条 **connection fetch 路由**，Client 用同源 `fetch` 调用。

Host：

```js
ctx.effect(() => ctx.connection.fetch.register({
  path: '/api/baton',
  methods: ['POST'],
  requestBody: 'buffered',
  async fetch(request) {
    const body = await request.json()
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  },
}), 'baton: route')
```

Client：

```js
await fetch('/api/baton', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'snapshot' }),
})
```

实测：

- `POST /api/baton/m0` 不带连接凭据返回 `401 unauthorized`，说明路由已注册且受连接认证保护，不是裸 HTTP 端口。
- 同源带凭据（页面内）才会进入 handler。
- 这条路径取代了未解决的 `host.call` 问题；`host.call` 的 Host 注册方式仍未确认，但不再需要。
- 参考实现：本机 `@local/youth-mode` bundle（Host `connection.fetch.register` + Client 同源 fetch），是官方机制的实际样例。

## M0 面板

已实现并安装一个 composer dock 栏：`创建空闲会话` → `提交测试消息`，走上面的 `/api/baton/m0` 路由。
Host 侧创建/命名/提交逻辑与会话工具一致。页面需要刷新以加载新的 Client 模块。

## M1 / M2 联调结果

服务端（`cargo test`）：36 个测试通过，覆盖三表事务、并发加入、满员、房主解散、任务逐字段幂等、审批反向冲突、过期清理、通知名单、认证限流、双客户端流程。

两客户端 smoke（`baton-server/smoke.mjs`）：

```json
{ "ok": true, "room": "HHLT8W", "taskId": "1a948755-...", "bSaw": "pending", "respond": "accepted", "aSaw": "accepted" }
```

插件与服务端联调：

- 插件以自身 `userId` 连接，`team_rooms` 返回房间 `ABC123` 与两名成员（在线状态正确）。
- 脚本客户端加入房间后，插件 `team_task_send` 发出任务，对方接受；插件 `team_tasks` 看到 `status: accepted`。
- 反向发一条 pending 任务给插件后，面板路由 `snapshot` 返回 `incoming` 一条。
- 调用面板路由 `accept`：服务端转 accepted → 插件建工作区/会话、挂载、命名、提交 brief；返回 `phase: submitted`、`sessionId: session-…`。
- 该会话随后 `{cursor: 18, running: false}`，说明首条消息真的被执行并结束。

这条 accept 路径是用一个临时的 in-process 路由探针验证的（`createSharedFetchHandler('/api')` + `browserPeer`），探针已在最终版本移除。正式入口只有面板的「接受并启动」，不注册为 Agent 工具。

## 服务端实现要点（给后续维护）

- 40 条连接、200 条摘要、1 MiB 响应边界由 `protocol.rs` 的测试覆盖。
- 每连接有界出站队列 8 条、独立 writer；`state.changed` 满队列可丢，响应入队失败断连。
- SQLite 单工作线程串行；通知名单在事务内返回，提交后才扇出。
- `TRUSTED_PROXY_CIDRS` 为空时忽略转发头（curl 直连得到对端 IP）；生产必须填 Caddy 固定地址。
- 本地构建用 `baton-server/.cargo/config.toml` 指向 rsproxy（原全局 ustc 镜像已 404）；这只影响开发机，镜像构建用默认 crates.io。

## 重连修复（实测）

Electron/Node 的全局 WebSocket 在「服务端已关闭、客户端发起新连接」时出现过只触发 `error`、不触发 `close` 的情况，导致客户端停在 `open=false` 且不再重试。修复：

- 每次连接分配 generation，旧 socket 的迟到事件全部忽略。
- `error` 且尚未 open 时主动 `close()` 并推进断开状态。
- 连接看门狗：10 秒内既未 open 也未 close，强制关闭并重连。

实测：杀掉服务端 → 客户端按 1/2/4/8… 退避持续重试；服务端重启约 30 秒内恢复 online，`sync` 补齐了停机期间的新任务。

## 容器与 Caddy 本地验证

- `docker build` 成功；注意 Dockerfile 的 dummy 构建会留下比 COPY 源码更新的产物，必须 `touch` 源码后再 build，否则镜像里是空 main。
- 运行镜像：`/healthz` 200；SQLite 及 WAL/SHM 均为 0600（entrypoint `umask 077`）。
- 容器 smoke 通过。
- `docker compose up` + Caddy：`https://localhost/healthz` 200；`wss://localhost/ws` 两客户端 smoke 通过。
- 服务端日志中的 client IP 是 Caddy 看到的直连地址（172.28.0.1），不是 Caddy 自己的 172.28.0.11，说明 `X-Forwarded-For` 采信规则生效。
- 未验证：真实域名证书、腾讯云实机、两机人工验收。

## 面板槽位实机确认

`cordis_inspect_query` Client `Slots` 确认：

- `sidebar.footer.action` 的 occupants 含 `baton-trigger`，active。
- `shell.overlay` 的 occupants 含 `baton-panel`，active。

同时发现并修掉一个会让人误判成「按钮没反应」的问题：`shell.overlay` 层本身是 click-through，条目必须自己声明 `pointerEvents: 'auto'`，否则面板可见但不可点。已在面板容器上补上。

## 备份恢复验证

- `scripts/backup.sh` 对运行中的 `m1-smoke.db` 导出一致性快照（0600）。
- 用该快照启动第二个服务端（127.0.0.1:8081），以插件 userId 执行 `sync`，返回房间 `ABC123` 和 3 条任务，说明恢复后的库可直接服务。
- 服务端慢客户端队列补充了单元测试：队列满时 `state.changed` 丢弃、响应入队失败返回 true（调用方断连）；测试总数 37。

## 验收补充（M2）

- 未配置环境：对 `env: midware` 的待批任务调用面板 `accept`，返回 400 `environment midware is not configured`，未产生本地启动记录，也未创建会话。
- 拒绝：对一条 pending 任务调用面板 `decline`，服务端状态变为 `declined`；本地记录表没有新增，说明拒绝路径不会建会话。
- 正常接受路径此前已验证到 `phase: submitted` 并实际执行。
- 以上 accept/decline 调用使用临时 in-process 路由探针完成，探针已移除；面板按钮是唯一正式入口。

## 真实面板点击验收（人工）

- 刷新 GUI 后，浮层面板自动出现（临时 auto-open 仅用于验证，已恢复为手动打开）。
- 用户在面板点击「接受并启动」后：
  - 服务端任务转 accepted；
  - 本地记录 `78a27e95…` 为 `phase: submitted`；
  - 新会话 `session-…`，随后查询状态为 `{cursor: 18, running: false}`，说明首条消息已执行完毕。
- 中间曾删除 `m0-probe` 目录：路径校验阻止了后续启动（符合「目录不存在不能启动」）；目录恢复后可用。
- 面板自动打开、`uiPing` 等验证用代码已全部移除，最终版本通过侧边栏「接力」手动打开。
