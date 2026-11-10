/** Exercise the actual plugin connection against an isolated Rust server. No DSH or real secrets. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BatonConnection } from '../connection.js'

const binary = fileURLToPath(new URL('../../baton-server/target/debug/baton-server' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url))
await access(binary)
const directory = await mkdtemp(join(tmpdir(), 'baton-integration-'))
const reserve = createServer()
reserve.listen(0, '127.0.0.1')
await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const secret = randomBytes(32).toString('hex')
const server = spawn(binary, [], { env: { ...process.env, BATON_SECRET: secret, BATON_DB: join(directory, 'baton.db'), BATON_BIND: '127.0.0.1:' + port, TRUSTED_PROXY_CIDRS: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
let diagnostic = ''
server.stdout.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000) })
server.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000) })
const exited = once(server, 'exit')
const clients = []

async function until(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    if (server.exitCode !== null) throw new Error('Server stopped: ' + diagnostic)
    await delay(50)
  }
  throw new Error('Timed out: ' + description + '\n' + diagnostic)
}

try {
  await until(async () => {
    try { return (await fetch('http://127.0.0.1:' + port + '/healthz')).ok } catch { return false }
  }, 'server startup')
  const options = { serverUrl: 'ws://127.0.0.1:' + port + '/ws', secret }
  const a = new BatonConnection({ ...options, userId: randomUUID(), displayName: 'Sender' })
  const b = new BatonConnection({ ...options, userId: randomUUID(), displayName: 'Recipient' })
  clients.push(a, b)
  a.start()
  b.start()
  await until(() => a.authenticated && b.authenticated, 'both clients authenticate')
  await Promise.all([a.sync(), b.sync()])
  const room = await a.roomCreate('Integration room')
  await b.roomJoin(room.code)
  const members = (await a.sync()).rooms[0].members
  assert.equal(members.length, 2)
  assert.ok(members.every(member => member.online))
  const taskId = randomUUID()
  const payload = { taskId, room: room.code, to: b.userId, env: 'frontend', title: 'Integration task', brief: 'This fixture must never execute a model.' }
  await a.taskSend(payload)
  await a.taskSend(payload)
  const detail = await b.taskGet(taskId)
  assert.equal(detail.brief, payload.brief)
  await b.taskRespond(taskId, 'accepted')
  const snapshot = await a.sync()
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.tasks[0].status, 'accepted')
  assert.equal('brief' in snapshot.tasks[0], false)
  b.stop()
  b.start()
  await until(() => b.authenticated, 'recipient reconnects')
  assert.equal((await b.sync()).tasks[0].status, 'accepted')
  console.log(JSON.stringify({ ok: true, members: members.length, duplicateSendRows: snapshot.tasks.length, finalStatus: snapshot.tasks[0].status, reconnectRestored: true }))
} finally {
  for (const client of clients) client.stop()
  if (server.exitCode === null) server.kill('SIGTERM')
  const shutdown = await Promise.race([exited.then(() => true), delay(5000).then(() => false)])
  if (!shutdown) { server.kill('SIGKILL'); await exited }
  await rm(directory, { recursive: true, force: true })
}
