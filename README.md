# Baton · 接力

把一件事从一个人的 DSH 递给另一个人：对方面板出现待批准请求，点「接受并启动」才创建会话、提交第一条消息。
服务端只做房间、任务和审批状态，不碰代码、不保存会话 ID。

插件和 socket 服务端均包含在本仓库。公开版本默认不连接任何服务器；使用者自行部署
`baton-server`，或向自己团队的管理员获取服务地址与共享密钥。作者的运行环境不是公共服务。

公开仓库准备和首版发布说明见 [PUBLICATION.md](PUBLICATION.md)。本项目使用 [MIT](LICENSE) 许可证。

## 目录

| 位置 | 内容 |
|---|---|
| `baton-server/` | Rust WebSocket 服务端（tokio + axum + rusqlite） |
| `dsh-baton/` | DSH 插件（Host + Web 面板） |
| `compose.yaml` / `Caddyfile` / `Dockerfile` | 单机容器部署 |
| `scripts/backup.sh` | SQLite 一致性备份 + 七天清理 |
| `plan.md` | 方案与验收规格 |

## 当前状态

- M0：DSH 会话创建/命名/空闲/提交已在本机实机验证，见 `dsh-baton/API-NOTES.md`。
- M1：服务端已有事务、协议及 WebSocket 测试；两客户端 smoke、断线重连与状态恢复已验证。
- M2：插件连接、三个工具、面板路由、接受后启动的完整链路已联调；真实面板点击验收通过（会话执行完毕）。
- M3：容器、Caddy TLS/WSS、每日备份及腾讯云部署已验证；双机真实 DSH 验收仍需使用者完成。

新版面板采用房间导航、任务列表、详情审批三列布局；窄屏切换为列表与详情两步。发送、房间管理和人工核对各有独立弹窗。发送失败保留草稿，结果不明时固定原 taskId，确认成功后才清空。

本轮已修复并发审批、状态文件并发写入、崩溃恢复、真实路径复核、发送幂等、离线请求和加入房间限额。新的界面验证使用下方的示例预览；已安装的 DSH 插件需要重新加载后才能使用新版，重新加载前不会替换运行中的插件。

## 先跑通本机功能

本地调试可先验证「发送 → 接收 → 查看目录 → 人工接受/拒绝 → DSH 会话 → 回执」。
服务器部署使用下方 Docker Compose；作者本机的腾讯云专用部署记录不随仓库发布。

```sh
cd dsh-baton
npm run local:setup
npm run local:start
```

`local:setup` 初始化 `data/`、测试工作区和稳定的 `.baton-secret`，保留已有密钥，并输出要填入 DSH 插件的配置段。`local:start` 启动仅监听本机的 Rust 服务；检测到同端口服务且密钥匹配时直接沿用。服务重启继续使用同一份密钥和本地数据库。

另开终端检查服务：

```sh
cd dsh-baton
npm run local:check
```

该检查用独立诊断身份验证认证与同步，不创建房间、任务或 DSH 会话，也不显示密钥。默认地址为 `ws://127.0.0.1:8080/ws`；需要其他本机端口时，setup、start、check 使用相同的 `BATON_BIND`。环境变量里的密钥与现有文件不一致时明确报错，先统一配置再启动。

完成后重新加载 DSH 中的 Baton 本地插件，并刷新 Client。先确认面板显示已连接，再用一个只需回复文字的任务验收接受与拒绝；确认目录后才允许启动。不要用预览中的示例任务代替实机验收。

## 服务端配置参考

环境变量：

| 变量 | 说明 |
|---|---|
| `BATON_SECRET` | 必填，≥32 字符；插件必须使用同一个值 |
| `BATON_DB` | 数据库绝对路径，默认 `/data/baton.db`，父目录必须存在 |
| `BATON_BIND` | 默认 `127.0.0.1:8080` |
| `TRUSTED_PROXY_CIDRS` | 仅这些对端的 `X-Forwarded-For` 被采信；生产填 Caddy 固定地址 `/32` |
| `BATON_LOG` | `error/warn/info/debug`，默认 `info` |

测试与 smoke：

```sh
cd baton-server && cargo test
BATON_SECRET=... node smoke.mjs
BATON_SECRET=... node peer.mjs create <userId> <name>
BATON_SECRET=... node peer.mjs join <userId> <name> <code> --accept
```

`peer.mjs` 只是联调脚本，不是产品的一部分。

## 插件

安装（在 DSH 里）：

```text
plugin_manager install_bundle target=/绝对路径/dsh-baton
```

从公开仓库直接安装前，先执行 `cp dsh-baton/cordis.patch.example.yml dsh-baton/cordis.patch.yml`，
在生成的本机文件里填写自己的服务地址和目录，再执行安装。
`cordis.patch.yml` 被 Git 忽略，不会公开你的配置；也可以在 profile patch 中完整覆盖配置。

```yaml
serverUrl: wss://baton.example.com/ws
secretEnv: BATON_SECRET
secretFile: /Users/you/.config/baton/secret   # 桌面启动没有 shell env 时使用
displayName: 你的名字
environments:
  - { key: frontend, label: 前端, cwd: /Users/you/workspace/web }
  - { key: backend,  label: 后端, cwd: /Users/you/workspace/api }
```

- `secretFile` 必须是 0600、绝对路径；环境变量非空时优先。认证失败不会偷偷换文件。
- `serverUrl` 非 localhost 必须是 `wss://`。
- 本插件在 DSH Desktop（Electron 44 / Node 24）上验证；DSH 版本差异可能改变 `sessionController` / `workspaceRegistry` / `uiWorkspace` 的接口。
- 每个安装首次启动生成 `userId`，存在 `~/.dsh/baton/identity.json`；本地启动状态在 `~/.dsh/baton/state.json`（0600）。
- 环境 key 由发送方选择、接收方解析成自己的 `cwd`；不传远端路径，不回退默认目录。

面板：侧边栏「接力」打开。左侧切换房间，中间选择任务，右侧查看完整说明与规范化后的本机目录。只有「接受并启动」才建会话；拒绝只回状态。房间管理中可复制房间号及成员 userId；窄屏通过顶部的房间图标进入。
`需核对` 状态只能人工确认后收起，不会自动补发。

Agent 工具只有三个：`team_rooms`、`team_task_send`、`team_tasks`；审批入口不注册为工具，远端标题/brief/名称不进入当前 Agent 上下文。

`team_task_send` 的失败结果会携带原 taskId，重试时应复用它；相同内容的未确认投递也会自动匹配本地保留的请求。界面「已发出的」可确认未完成的投递。未知结果不能靠换一个 taskId 重新发送。

## 分享给队友

```sh
sh scripts/package-plugin.sh
# 产物：dist/dsh-baton-0.1.0/ 和 dist/dsh-baton-0.1.0.tgz
```

公开包内只有运行时代码和安装说明，`serverUrl` 默认为空，不含密钥、本机路径或开发依赖。
内部团队需要预填自己的地址时，可执行：

```sh
BATON_PACKAGE_SERVER_URL=wss://baton.example.com/ws sh scripts/package-plugin.sh
```

把 tarball、你们的服务地址及团队密钥通过安全渠道发给队友，按包内 `INSTALL.md`：

1. 密钥写入 `~/.config/baton/secret`（0600）；
2. 解压后 `plugin_manager install_bundle target=/绝对路径/dsh-baton-0.1.0`；
3. 安装前改包里的 `cordis.patch.yml`，或安装后在 profile patch 加一条**完整**覆盖行（同 id 会替换整个 `config`，要带 `serverUrl`），补 `displayName` 和 `environments`；
4. 重启 DSH、刷新页面。

所有客户端共用同一把服务端密钥；拿到密钥的人可以冒充 userId，只发给信任的人。走 npm 需要先把 `private` 改为 `false` 并发布到可访问的 registry，本地测试用 tarball 更省事。

## 界面预览与插件测试

```sh
cd dsh-baton
npm ci
npm test
npm run preview
```

打开 `http://127.0.0.1:4371`。预览使用实际的 `client.js`，服务端为内存示例数据，可体验房间、发送、审批和深浅色主题；不会连接真实 DSH、读取密钥或执行模型。React、React DOM 和 esbuild 都只用于本地开发预览，插件运行仍复用 DSH 提供的 React，无需构建。

客户端浏览器回归：预览启动后运行 `npm run test:client`。需要可用的
`playwright/test` 和 Chromium；可通过 `NODE_PATH` 指向已有 Playwright 依赖目录、
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向已有浏览器。5 组用例覆盖原始预览加载与示例跳转、
工作区服务晚激活、服务不可用/异步跳转失败后的定位重试，以及环境菜单的 Escape/Tab 顺序。
测试使用真实 React 和插件客户端，DSH 服务注册表与导航为模拟适配器，不执行真实模型。

如需验证新版连接层与实际服务的协议兼容，先在 `baton-server` 执行 `cargo build`，再在 `dsh-baton` 执行 `npm run test:integration`。脚本会启动临时服务，使用随机密钥与临时数据库，完成后关闭并清理，不复用正在运行的服务。

完整的本机功能链路测试：`npm run test:flow`。它启动临时 Rust 服务和两个独立的实际插件 Host，覆盖建房加入、接受前零执行、并发接受只提交一次、双向拒绝回执、离线重启恢复和目录变化阻断。只有 DSH 的会话服务及已认证路由分发使用内存适配器；真实 DSH 载入、模型执行仍需上面的实机验收。

安装版 DSH 对目录插件不保证热加载。完成预览后，按当前 DSH 的插件管理流程重新加载该本地 bundle，并刷新页面加载 Client；随后再做真实会话验收。M0 中的探针、旧版面板验收不能替代新版的实机确认。

## 服务端部署

以下使用独立 Linux 主机、Docker Compose 和 Caddy。域名、密钥和证书均由部署者自行配置。
作者本机的腾讯云/Podman 专用记录不随仓库发布。

<details>
<summary>展开容器、腾讯云及备份恢复说明</summary>

1. 创建目录并放密钥：

```sh
mkdir -p /opt/baton/{data,backups,secrets}
cp server.env.example /opt/baton/secrets/server.env
chmod 700 /opt/baton/secrets && chmod 600 /opt/baton/secrets/server.env
# 编辑 BATON_SECRET（openssl rand -hex 32）和 TRUSTED_PROXY_CIDRS=172.28.0.11/32
```

2. 数据目录归 UID 10001，权限 0700：

```sh
chown -R 10001:10001 /opt/baton/data
chmod 700 /opt/baton/data
```

3. 设置域名并启动：

```sh
cd /opt/baton
BATON_DOMAIN=baton.example.com docker compose up -d --build
```

4. 健康检查与日志：

```sh
curl -fsS https://baton.example.com/healthz   # 经 Caddy 也可，或容器内 127.0.0.1
docker compose logs -f baton-server
```

Caddy 终止 TLS，只暴露 80/443；`baton-server` 的 8080 不 publish。`TRUSTED_PROXY_CIDRS` 必须等于 Caddy 的固定内网地址，否则所有客户端会共用 Caddy 的 IP 限流额度。

Caddy 每次 `caddy reload` 会断开现有 WebSocket（默认行为），插件按退避自动重连；`stream_timeout` 默认无超时，不要配短。

## 备份与恢复

- 宿主 root cron：`0 3 * * * /opt/baton/scripts/backup.sh`
- 依赖宿主安装 `sqlite3`；可用 `BATON_DB_PATH`、`BATON_BACKUP_DIR`、`BATON_BACKUP_KEEP_DAYS` 覆盖默认。
- 脚本先写临时文件，成功后才发布为 `baton-YYYYmmdd-HHMMSS.db`，并只清理本应用命名的过期备份。
- 恢复：停容器，用备份替换 `/opt/baton/data/baton.db`（同时删掉旧的 `-wal`/`-shm`），再启动。
- 备份包含任务 brief，按敏感数据管理。

</details>

## 首版限制

- 共享密钥身份信任：拿到密钥的人可以冒充 userId。
- 单机单进程；服务器故障不影响已经启动的本机会话，但接力暂停。
- 断网不能审批；模糊的提交结果需要人工核对。
- 不做群发、聊天、文件传输、执行结果回传、远程查看会话。
