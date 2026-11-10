#!/bin/sh
# Build a shareable plugin package: no local secret, no machine-specific paths.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/dsh-baton/package.json" | head -1)"
OUT="$ROOT/dist/dsh-baton-$VERSION"

rm -rf "$OUT"
mkdir -p "$OUT/locale"
cp "$ROOT/dsh-baton/index.js" "$ROOT/dsh-baton/client.js" "$ROOT/dsh-baton/connection.js" "$ROOT/dsh-baton/session.js" "$OUT/"
cp "$ROOT/dsh-baton/package.json" "$ROOT/dsh-baton/icon.svg" "$OUT/"
cp "$ROOT/LICENSE" "$OUT/LICENSE"
cp "$ROOT/dsh-baton/locale/"*.json "$OUT/locale/"

# Strip dev-only scripts/dependencies so a teammate install pulls nothing extra.
node - "$OUT/package.json" <<'NODE'
const fs = require('fs')
const path = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
delete pkg.scripts
delete pkg.devDependencies
pkg.files = ['index.js', 'client.js', 'connection.js', 'session.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'INSTALL.md', 'LICENSE']
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
NODE

# Public releases have no server by default. A private team build can opt in.
node --input-type=module - "$OUT/cordis.patch.yml" "$ROOT/dsh-baton/connection.js" <<'NODE'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const { validateServerUrl } = await import(pathToFileURL(process.argv[3]))
const value = process.env.BATON_PACKAGE_SERVER_URL ?? ''
const serverUrl = value ? validateServerUrl(value) : ''
writeFileSync(process.argv[2], '- insert:\n    - id: baton\n      name: \'@token-team/dsh-baton\'\n      config:\n        serverUrl: ' + JSON.stringify(serverUrl) + '\n')
NODE

cat > "$OUT/INSTALL.md" <<'MD'
# Baton 插件安装

## 0. 前提

- DSH Desktop 已安装。建议与发起人使用同一版本（本插件在 Electron 44 / Node 24 上验证）。
- 管理员通过安全渠道提供：
  1. 对应版本的插件目录（或 Release 中 `dsh-baton-<版本>.tgz` 解压后的目录）
  2. 你们自建的 Baton 服务地址和对应共享密钥

公开版本默认没有服务器地址。它不会自动加入作者的团队或连接作者的服务器。
Socket 服务端源码也在仓库内，可按根目录 README 自行部署。

## 1. 放密钥

```sh
mkdir -p ~/.config/baton
printf '%s\n' '<团队密钥>' > ~/.config/baton/secret
chmod 700 ~/.config/baton
chmod 600 ~/.config/baton/secret
```

不给 `secretFile` 配置时，插件默认读这个路径。环境变量 `BATON_SECRET` 非空时优先。

## 2. 安装 bundle

在 DSH 里让 agent 执行：

```text
plugin_manager install_bundle target=/绝对路径/dsh-baton-<版本>
```

需要批准；安装前先按下一节配置你们自己的服务地址。

## 3. 配名字和环境目录（二选一）

插件的配置来自 bundle 自己的 `cordis.patch.yml`，**安装器不会把它抄进 profile 的 `cordis.patch.yml`**。所以你有两种改法：

### A. 安装前改包里的 patch（最简单）

解压后编辑包内的 `cordis.patch.yml`，把 `config` 补全：

```yaml
      config:
        serverUrl: wss://baton.example.com/ws
        displayName: 你的名字
        environments:
          - { key: frontend, label: 前端, cwd: /你的/前端/目录 }
          - { key: backend,  label: 后端, cwd: /你的/后端/目录 }
```

然后再安装。

### B. 安装后在 profile patch 覆盖

打开：

- macOS/Linux：`~/.dsh/profiles/<profile>/cordis.patch.yml`
- Windows：`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`

加一条 **完整** 覆盖行（同 id 的覆盖会替换整个 `config`，所以 `serverUrl` 必须再写一遍）：

```yaml
- id: baton
  name: '@token-team/dsh-baton'
  config:
    serverUrl: wss://baton.example.com/ws
    displayName: 你的名字
    environments:
      - { key: frontend, label: 前端, cwd: /你的/前端/目录 }
```

不配 `displayName` 时用系统用户名；不配环境目录时，接受任务会被禁用并提示环境未配置（这是故意的，不会回退到别的目录）。
将示例域名替换为你们的实际服务地址；使用非默认端口时保留 `:端口` 和 `/ws`。

## 4. 生效

- 改 profile patch 后重启 DSH，或等 loader 重载。
- 刷新页面；侧边栏底部「接力」打开面板。

## 5. 验收

1. 发起人建房，把六位房间号发给你；你在面板里加入。
2. 发起人指定你发一条任务；你点「查看详情」→「接受并启动」。
3. 插件会在你配置的 cwd 建会话，把 brief 作为第一条消息。
4. 接受前不会创建会话、不会调用模型。
MD

TAR="$ROOT/dist/dsh-baton-$VERSION.tgz"
rm -f "$TAR"
tar -czf "$TAR" -C "$ROOT/dist" "dsh-baton-$VERSION"
echo "wrote $OUT"
echo "wrote $TAR"
