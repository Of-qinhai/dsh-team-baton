/** Local setup/start/check. Reuses one private key and never changes a DSH profile. */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BatonConnection } from '../dsh-baton/connection.js'

async function paths(root, bind = '127.0.0.1:8080') {
  const match = /^(127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(bind)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('本地启动只允许回环地址，例如 127.0.0.1:8080。')
  const project = await realpath(root)
  await access(join(project, 'baton-server', 'Cargo.toml'))
  return {
    root: project, bind, host: match[1].replaceAll('[', '').replaceAll(']', ''), port: Number(match[2]),
    secretFile: join(project, '.baton-secret'), dataDir: join(project, 'data'),
    database: join(project, 'data', 'baton.db'), workspace: join(project, 'm0-probe'),
    serverUrl: 'ws://' + bind + '/ws',
  }
}

function validateSecret(secret) {
  if (Array.from(secret).length < 32) throw new Error('本地密钥至少需要 32 个字符，请修正现有文件；不会自动替换密钥。')
}

/** Read existing credentials without initializing files or displaying their value. */
export async function loadLocal(root, options = {}) {
  const config = await paths(root, options.bind)
  let info
  try { info = await stat(config.secretFile) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('尚未初始化本地密钥，请先运行 npm run local:setup。')
    throw error
  }
  if (!info.isFile()) throw new Error('本地密钥路径必须是文件。')
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) throw new Error('本地密钥权限必须为 0600，请检查 .baton-secret。')
  const secret = (await readFile(config.secretFile, 'utf8')).replace(/\r?\n$/, '')
  validateSecret(secret)
  if (options.secret && options.secret !== secret) throw new Error('BATON_SECRET 与本地密钥文件不一致，请统一后再启动。')
  const quoted = value => JSON.stringify(value)
  return {
    ...config, secret,
    pluginConfig: [
      'serverUrl: ' + quoted(config.serverUrl),
      'secretEnv: BATON_SECRET',
      'secretFile: ' + quoted(config.secretFile),
      'displayName: 本机用户',
      'environments:',
      '  - { key: frontend, label: 前端, cwd: ' + quoted(config.workspace) + ' }',
      '  - { key: backend, label: 后端, cwd: ' + quoted(join(config.root, 'baton-server')) + ' }',
    ].join('\n'),
  }
}

/** Initialize missing local files; an existing key is always preserved. */
export async function prepareLocal(root, options = {}) {
  const config = await paths(root, options.bind)
  const proposed = options.secret || randomBytes(32).toString('hex')
  validateSecret(proposed)
  try { await writeFile(config.secretFile, proposed + '\n', { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const loaded = await loadLocal(root, options)
  await mkdir(loaded.dataDir, { recursive: true, mode: 0o700 })
  await mkdir(loaded.workspace, { recursive: true, mode: 0o700 })
  return loaded
}

/** Authenticate a separate diagnostic identity; no rooms, tasks or sessions are created. */
export function checkService(config, timeoutMs = 5000) {
  return new Promise((resolveCheck, rejectCheck) => {
    let finished = false
    let timer
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      client.stop()
      if (error) rejectCheck(error)
      else resolveCheck({ ok: true, serverUrl: config.serverUrl })
    }
    const client = new BatonConnection({
      serverUrl: config.serverUrl, secret: config.secret, userId: randomUUID(), displayName: '本地功能检查',
      onSnapshot: () => finish(),
      onStatus: status => {
        if (status.state === 'fatal') finish(new Error('当前端口的服务无法认证，请检查本地密钥和服务端是否一致。'))
      },
    })
    timer = setTimeout(() => finish(new Error('本地接力服务未就绪，请先运行 npm run local:start。')), timeoutMs)
    client.start()
  })
}

async function occupied(config) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ host: config.host, port: config.port })
    const finish = result => { socket.destroy(); resolveProbe(result) }
    socket.setTimeout(750, () => finish(true))
    socket.once('connect', () => finish(true))
    socket.once('error', error => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolveProbe(false)
      else rejectProbe(new Error('无法检查本机端口：' + error.code))
    })
  })
}

async function startLocal(config) {
  if (await occupied(config)) {
    await checkService(config)
    console.log('本机接力服务已运行：' + config.serverUrl)
    console.log('沿用现有服务及其数据库；如需加载新的服务端代码，请在原终端重启。')
    return
  }
  const env = { ...process.env, BATON_SECRET: config.secret, BATON_DB: config.database, BATON_BIND: config.bind, TRUSTED_PROXY_CIDRS: '' }
  if (!env.CARGO_HOME) {
    try { await access(join(config.root, '.cargo-home')); env.CARGO_HOME = join(config.root, '.cargo-home') } catch {
      // Fresh checkouts use Cargo's normal cache when no project cache exists.
    }
  }
  console.log('本机服务：' + config.serverUrl + '\n数据库：' + config.database + '\n密钥文件：' + config.secretFile)
  const child = spawn('cargo', ['run', '--locked'], { cwd: join(config.root, 'baton-server'), env, stdio: 'inherit' })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const [code, signal] = await once(child, 'exit')
    if (code && !signal) throw new Error('本地服务退出，状态码：' + code)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

async function main() {
  const command = process.argv[2] ?? 'help'
  if (command === 'help' || command === '--help') {
    console.log('本机功能开发\n  npm run local:setup  初始化稳定密钥/目录，输出 DSH 配置\n  npm run local:start  启动本机服务，或检查并沿用现有服务\n  npm run local:check  检查现有服务与本地密钥能否完成认证\n可用 BATON_BIND 指定其他回环端口。')
    return
  }
  if (!['setup', 'start', 'check'].includes(command)) throw new Error('未知命令，请运行 node scripts/local.mjs --help。')
  if (process.platform !== 'win32') process.umask(0o077)
  const root = fileURLToPath(new URL('../', import.meta.url))
  const options = { bind: process.env.BATON_BIND, secret: process.env.BATON_SECRET }
  const config = command === 'check' ? await loadLocal(root, options) : await prepareLocal(root, options)
  if (command === 'setup') console.log('本地密钥与目录已就绪。请在 DSH 的 Baton 插件配置中使用：\n\n' + config.pluginConfig)
  if (command === 'start') await startLocal(config)
  if (command === 'check') { await checkService(config); console.log('本机服务认证与同步通过：' + config.serverUrl) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('Baton: ' + error.message); process.exitCode = 1 })
}
