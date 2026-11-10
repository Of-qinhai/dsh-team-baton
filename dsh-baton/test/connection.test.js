import assert from 'node:assert/strict'
import test from 'node:test'
import { BatonConnection, BatonRequestError, validateServerUrl } from '../connection.js'

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const hasCode = (code) => (error) => error instanceof BatonRequestError && error.code === code

function setup(t, overrides = {}) {
  let now = 0
  let nextId = 1
  const timers = new Map()
  const installTimer = (fn, delay, interval = false) => {
    const id = nextId++
    timers.set(id, { fn, at: now + delay, interval: interval ? delay : 0 })
    return id
  }
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => installTimer(fn, delay))
  t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id))
  t.mock.method(globalThis, 'setInterval', (fn, delay) => installTimer(fn, delay, true))
  t.mock.method(globalThis, 'clearInterval', (id) => timers.delete(id))
  t.mock.method(Date, 'now', () => now)
  t.mock.method(Math, 'random', () => 0)
  class Socket {
    static instances = []
    constructor() { this.listeners = {}; this.sent = []; this.closes = []; Socket.instances.push(this) }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
    emit(type, event = {}) { for (const listener of this.listeners[type] ?? []) listener(event) }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    close(code, reason) { this.closes.push({ code, reason }) }
    reply(request = this.sent.at(-1), data = {}) { this.emit('message', { data: JSON.stringify({ id: request.id, type: 'ok', data }) }) }
    error(code, request = this.sent.at(-1)) { this.emit('message', { data: JSON.stringify({ id: request.id, type: 'error', code, message: code }) }) }
  }
  t.mock.method(globalThis, 'WebSocket', function () { return new Socket() })
  const statuses = []
  const snapshots = []
  const client = new BatonConnection({
    serverUrl: 'ws://localhost:8921', secret: 's'.repeat(32), userId: 'user', displayName: 'User',
    onStatus: (status) => statuses.push(status), onSnapshot: (value) => snapshots.push(value), ...overrides,
  })
  t.after(() => client.stop())
  const tick = async (ms) => {
    const target = now + ms
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      const [id, timer] = due
      now = timer.at
      if (timer.interval) timer.at += timer.interval
      else timers.delete(id)
      timer.fn()
      await flush()
    }
    now = target
    await flush()
  }
  const online = async () => {
    client.start()
    const socket = Socket.instances.at(-1)
    socket.emit('open')
    assert.equal(socket.sent[0]?.type, 'hello')
    socket.reply()
    await flush()
    assert.equal(socket.sent.at(-1)?.type, 'sync')
    socket.reply()
    await flush()
    return socket
  }
  return { client, Socket, statuses, snapshots, tick, online, timers }
}

test('configuration rejects weak secrets and credentials in server URLs', () => {
  assert.throws(() => new BatonConnection({ serverUrl: 'ws://localhost', secret: 'short' }), /32/)
  assert.throws(() => validateServerUrl('wss://name:password@example.com'), /credentials|username|password/i)
  assert.equal(validateServerUrl('ws://localhost:8921'), 'ws://localhost:8921/')
})

test('offline and pre-authentication business requests reject immediately; hello is first', async (t) => {
  const { client, Socket } = setup(t)
  const stopped = client.roomCreate('room')
  stopped.catch(() => {})
  await flush()
  assert.equal(client.queue.length, 0, 'stopped calls must not enter the queue')
  await assert.rejects(stopped, hasCode('connection-closed'))
  client.start()
  await assert.rejects(client.roomJoin('ABCDEF'), hasCode('connection-closed'))
  const socket = Socket.instances[0]
  socket.emit('open')
  await assert.rejects(client.roomCreate('room'), hasCode('connection-closed'))
  assert.deepEqual(socket.sent.map(({ type }) => type), ['hello'])
  assert.equal(client.authenticated, false)
  socket.reply()
  await flush()
  assert.equal(client.authenticated, true)
  socket.reply()
  await flush()
})

test('queued deadlines start at invocation and late responses cannot settle a later request', async (t) => {
  const { client, online, tick } = setup(t)
  const socket = await online()
  const first = client.taskGet('one')
  const firstRejection = assert.rejects(first, hasCode('timeout'))
  const old = socket.sent.at(-1)
  await tick(1000)
  const second = client.taskGet('two')
  const secondRejection = assert.rejects(second, hasCode('timeout'))
  await tick(14000)
  await firstRejection
  assert.equal(socket.sent.at(-1).data.taskId, 'two')
  socket.reply(old, { stale: true })
  await tick(1000)
  assert.equal(client.inflight, undefined)
  await secondRejection
})

test('simultaneous queued deadlines expire without sending already expired work', async (t) => {
  const { client, online, tick } = setup(t)
  const socket = await online()
  const before = socket.sent.length
  const first = assert.rejects(client.taskGet('one'), hasCode('timeout'))
  const second = assert.rejects(client.taskGet('two'), hasCode('timeout'))
  await tick(15000)
  await Promise.all([first, second])
  assert.equal(socket.sent.length, before + 1)
  assert.equal(client.queue.length, 0)
})

test('disconnect immediately rejects inflight and queued work and stale socket events do nothing', async (t) => {
  const { client, Socket, online, tick } = setup(t)
  const old = await online()
  const first = assert.rejects(client.taskSend({ taskId: 'one' }), hasCode('connection-closed'))
  const second = assert.rejects(client.roomJoin('ABCDEF'), hasCode('connection-closed'))
  old.emit('close', { code: 1006 })
  await Promise.all([first, second])
  assert.equal(client.authenticated, false)
  await assert.rejects(client.taskGet('one'), hasCode('connection-closed'))
  await tick(1000)
  const replacement = Socket.instances.at(-1)
  replacement.emit('open')
  old.emit('close', { code: 1006 })
  old.emit('open')
  old.emit('message', { data: '{"type":"state.changed"}' })
  assert.equal(client.socket, replacement)
  assert.equal(replacement.sent.length, 1)
})

test('stop fences late opens and resolved authentication continuations', async (t) => {
  const { client, Socket, statuses, tick } = setup(t)
  client.start()
  const socket = Socket.instances[0]
  socket.emit('open')
  socket.reply()
  client.stop()
  await flush()
  socket.emit('open')
  socket.emit('error')
  socket.emit('close', { code: 1006 })
  await tick(120000)
  assert.equal(Socket.instances.length, 1)
  assert.equal(socket.sent.length, 1)
  assert.equal(client.authenticated, false)
  assert.equal(statuses.at(-1).state, 'stopped')
})

test('failed hello send leaves only one reconnect timer', async (t) => {
  const { client, Socket, tick, timers } = setup(t)
  client.start()
  const socket = Socket.instances[0]
  socket.send = () => { throw new Error('transport failure') }
  socket.emit('open')
  await flush()
  assert.equal(client.authenticated, false)
  assert.equal(timers.size, 1, 'teardown must not leave an interval after send failed')
  await tick(1000)
  assert.equal(Socket.instances.length, 2)
})

test('an online callback can stop without leaving authentication timers behind', async (t) => {
  const { client, Socket, timers } = setup(t)
  client.onStatus = ({ state }) => { if (state === 'online') client.stop() }
  client.start()
  const socket = Socket.instances[0]
  socket.emit('open')
  socket.reply()
  await flush()
  assert.equal(client.stopped, true)
  assert.equal(timers.size, 0)
})

test('status callbacks can stop a connection attempt or scheduled reconnect', async (t) => {
  const { client, Socket, timers, online } = setup(t)
  client.onStatus = ({ state }) => { if (state === 'connecting') client.stop() }
  client.start()
  assert.equal(Socket.instances.length, 0)
  assert.equal(timers.size, 0)
  client.onStatus = () => {}
  const socket = await online()
  client.onStatus = ({ state }) => { if (state === 'reconnecting') client.stop() }
  socket.emit('close', { code: 1006 })
  assert.equal(client.stopped, true)
  assert.equal(timers.size, 0)
})

test('background sync runs after 60 seconds and coalesces dirty notifications', async (t) => {
  const { client, online, tick, snapshots } = setup(t)
  const socket = await online()
  await tick(30000)
  assert.equal(socket.sent.at(-1).type, 'ping')
  socket.reply()
  await flush()
  await tick(30000)
  if (socket.sent.at(-1).type === 'ping') { socket.reply(); await flush() }
  assert.equal(socket.sent.at(-1).type, 'sync')
  socket.emit('message', { data: '{"type":"state.changed"}' })
  socket.emit('message', { data: '{"type":"state.changed"}' })
  socket.reply(undefined, { revision: 1 })
  await flush()
  assert.equal(socket.sent.at(-1).type, 'sync')
  socket.reply(undefined, { revision: 2 })
  await flush()
  assert.equal(socket.sent.filter(({ type }) => type === 'sync').length, 3)
  assert.equal(snapshots.at(-1).revision, 2)
  assert.equal(client.syncing, undefined)
})

test('heartbeat closes and reconnects at 60 seconds without messages', async (t) => {
  const { client, Socket, online, tick } = setup(t)
  const socket = await online()
  await tick(30000)
  assert.equal(socket.sent.at(-1).type, 'ping')
  await tick(30000)
  assert.ok(socket.closes.length > 0)
  assert.equal(client.authenticated, false)
  await tick(1000)
  assert.equal(Socket.instances.length, 2)
})

test('task writes retry internal and timeout only once with the same payload and fresh RPC IDs', async (t) => {
  const { client, online, tick } = setup(t)
  const socket = await online()
  const task = { taskId: 'stable-task', title: 'Title', brief: 'Brief' }
  const send = client.taskSend(task)
  send.catch(() => {})
  const first = socket.sent.at(-1)
  socket.error('internal')
  await flush()
  const retry = socket.sent.at(-1)
  assert.notEqual(retry.id, first.id)
  assert.deepEqual(retry.data, task)
  socket.reply(undefined, { taskId: task.taskId })
  assert.deepEqual(await send, { taskId: task.taskId })
  const respond = client.taskRespond(task.taskId, 'accepted')
  const exhausted = assert.rejects(respond, hasCode('timeout'))
  const responseFirst = socket.sent.at(-1)
  await tick(15000)
  const responseRetry = socket.sent.at(-1)
  assert.notEqual(responseFirst.id, responseRetry.id)
  assert.deepEqual(responseRetry.data, { taskId: task.taskId, decision: 'accepted' })
  socket.reply(responseFirst)
  await tick(15000)
  await exhausted
  assert.equal(socket.sent.filter(({ type }) => type === 'task.respond').length, 2)
})

test('room writes and nonretryable task failures do not retry', async (t) => {
  const { client, online } = setup(t)
  const socket = await online()
  for (const [operation, code] of [[() => client.roomCreate('room'), 'internal'], [() => client.taskSend({ taskId: 't' }), 'task_conflict']]) {
    const before = socket.sent.length
    const failed = assert.rejects(operation(), hasCode(code))
    socket.error(code)
    await failed
    assert.equal(socket.sent.length, before + 1)
  }
})

test('32KiB limit measures the complete UTF-8 JSON envelope and preserves the queue', async (t) => {
  const { client, online } = setup(t)
  const socket = await online()
  const before = socket.sent.length
  const oversized = client.request('task.send', { brief: '中'.repeat(11000) })
  oversized.catch(() => {})
  await flush()
  assert.equal(socket.sent.length, before, 'oversized message must never be sent')
  await assert.rejects(oversized, hasCode('invalid_request'))
  const overhead = Buffer.byteLength(JSON.stringify({ id: '0'.repeat(36), type: 'task.send', data: { brief: '' } }))
  const exact = client.request('task.send', { brief: 'a'.repeat(32768 - overhead) })
  assert.equal(Buffer.byteLength(JSON.stringify(socket.sent.at(-1))), 32768)
  socket.reply()
  await exact
  await assert.rejects(client.request('task.send', { brief: 'a'.repeat(32769 - overhead) }), hasCode('invalid_request'))
})

for (const code of ['auth_failed', 'protocol_mismatch']) {
  test(`${code} stops retries and leaves fatal as the visible status`, async (t) => {
    const { client, Socket, statuses, tick } = setup(t)
    client.start()
    const socket = Socket.instances[0]
    socket.emit('open')
    socket.error(code)
    await flush()
    await tick(120000)
    assert.equal(Socket.instances.length, 1)
    assert.equal(client.authenticated, false)
    assert.equal(client.stopped, true)
    assert.equal(statuses.at(-1).state, 'fatal')
  })
}

test('rate limits wait the full 60 seconds even if close arrives immediately', async (t) => {
  const { client, Socket, tick } = setup(t)
  client.start()
  const socket = Socket.instances[0]
  socket.emit('open')
  socket.error('rate_limited')
  await flush()
  socket.emit('close', { code: 1008 })
  await tick(59999)
  assert.equal(Socket.instances.length, 1)
  await tick(1)
  assert.equal(Socket.instances.length, 2)
})

test('rate limiting business work fails queued work and prevents early reconnect', async (t) => {
  const { client, Socket, online, tick } = setup(t)
  const socket = await online()
  const limited = assert.rejects(client.roomCreate('room'), hasCode('rate_limited'))
  const queued = assert.rejects(client.taskSend({ taskId: 'task' }), hasCode('connection-closed'))
  socket.error('rate_limited')
  socket.emit('close', { code: 1008 })
  await Promise.all([limited, queued])
  assert.equal(client.authenticated, false)
  await tick(59999)
  assert.equal(Socket.instances.length, 1)
  await tick(1)
  assert.equal(Socket.instances.length, 2)
})
