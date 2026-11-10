# 公开仓库与首版发布评估

评估日期：2026-11-10。

插件和 socket 服务端可以放在同一个公开仓库。公开源码不等于开放作者的服务器：
用户应自行部署服务端，或使用自己团队的服务地址和密钥。当前版本采用共享密钥信任，
持有密钥的成员可冒充安装身份，因此适合可信团队，不适合作为公众多租户服务。

## 已整理

| 内容 | 处理 |
|---|---|
| `.baton-secret`、环境文件、密钥/证书、ACME 目录 | Git 忽略；Docker 构建上下文也排除 |
| 数据库、WAL/SHM、备份、日志 | 忽略；保留本机文件 |
| `node_modules`、Rust target、Cargo 缓存 | 忽略 |
| `dsh-baton/cordis.patch.yml` | 保留本机配置并忽略；提交 `cordis.patch.example.yml` |
| 公开插件安装包 | 默认不配置服务地址；不打包密钥、本机配置和开发依赖 |
| 插件/服务端源码、测试、部署模板、两份 lock 文件 | 保留在仓库 |
| `dist/` 和压缩包 | 忽略；使用 Release 附件分发 |
| `API-NOTES.md` | 保留在源码作开发记录；已清除测试会话 ID、房间号；不进入发布包 |
| 本地测试数据库、`secrets/server.env`、`.DS_Store` | 已从工作目录删除（`.baton-secret` 仍需本地保留，已忽略） |
| 实际服务器 IP、域名、SSH 别名、端口和部署状态 | `deploy/tencent/` 整目录本机保留并整体忽略，不进入公开仓库 |

发布文件用临时 Git 仓库模拟 `git add -A` 复核，跟踪文件未包含密钥、数据库、
部署状态或本机 patch。插件发布包默认 `serverUrl` 为空，不包含 `API-NOTES.md`。
这个检查不等于完整的凭据或供应链审计。

## 发布前还需决定

1. **许可证**：已采用 MIT，根 `LICENSE`、`dsh-baton/package.json` 和
   `baton-server/Cargo.toml` 均已声明。依赖许可证仍需发布前单独审计。
2. **仓库地址**：确定后填写项目主页、问题反馈地址和安装文档中的下载位置。
3. **分发方式**：首版建议仓库源码 + GitHub Release 插件包；不必同时引入 npm、
   crates.io 和容器仓库发布。`package.json` 仍为 `private: true`，本轮没有启用 npm 发布。

源码开放与许可证的区别见 [OSI 开源定义](https://opensource.org/osd)。

## 推荐首版流程

1. 确定仓库地址，补充 `repository` / `homepage` / `bugs` 链接。
2. 检查待提交列表，只提交源码、示例和文档。这个工作目录目前没有 `.git`，
   本轮仅用临时 Git 仓库验证忽略规则，没有初始化正式仓库或提交任何内容。
3. 运行 `cd dsh-baton && npm ci && npm test`，按 README 运行 Rust 与完整链路测试。
   浏览器回归需要另备 Playwright 和 Chromium。
4. 在仓库根目录执行 `sh scripts/package-plugin.sh`。将生成的
   `dist/dsh-baton-<版本>.tgz` 附到对应版本的 Release，不把 `dist/` 提交进源码。
5. 用户下载插件包，按包内 INSTALL.md 配置自己的服务端、密钥和环境目录。
   从源码安装时，先复制 `dsh-baton/cordis.patch.example.yml` 到
   `dsh-baton/cordis.patch.yml`，填好配置再安装。

私有团队包可以显式预填自己的服务地址：

```sh
BATON_PACKAGE_SERVER_URL=wss://baton.example.com/ws sh scripts/package-plugin.sh
```

正式公共 Release 使用不带这个环境变量的默认构建。当前打包脚本不依赖本机 patch，
所以不会把开发者本机配置混入公开包。不要直接从配置了私人 patch 的开发目录
执行 `npm pack` 后公开分发；使用上面的专用打包脚本。

## 上传方式

只用 `git add` / `git push` 发布。GitHub 网页的“上传文件/拖拽文件夹”不读取 `.gitignore`，
会把工作目录里的 `.baton-secret`、`dsh-baton/cordis.patch.yml`、数据库和本地部署记录
一起传上去。发布前用 `git status` 确认待提交列表。

## 边界与后续

- `.gitignore` 只影响未跟踪文件，无法移除已有提交或远端历史中的内容。
  如果以后发现凭据进入过仓库，需要先撤销/轮换，再处理历史；只增加忽略规则不够。
  参见 [Git 官方说明](https://git-scm.com/docs/gitignore/)。
- 不要把团队共享密钥上传为 Release 附件、写进 README、Issue 或 CI 日志。
- 示例环境文件必须保持占位值；修改示例后也应复查实际内容。
- 本轮没有改动 Rust 服务端或连接协议，没有同步修改正在运行的云端服务。
- 作者本机的腾讯云专用镜像/Podman 记录保存在 `deploy/tencent/`，已整体忽略；
  公开用户使用根 Dockerfile/Compose，并自行配置域名、密钥和持久化目录。
