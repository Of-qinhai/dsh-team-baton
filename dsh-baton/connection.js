/**
 * Host-side WebSocket client for baton-server.
 *
 * One connection per DSH install. Requests are serialized (the plan allows one
 * in-flight request per connection), so a 1 MiB sync response can never stack
 * behind UI actions. Reconnect resends hello and re-syncs; state.changed only
 * triggers a sync, the DB on the server remains authoritative.
 */
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const PROTOCOL_VERSION = 1
const REQUEST_TIMEOUT_MS = 15_000
const HEARTBEAT_MS = 30_000
const IDLE_LIMIT_MS = 60_000
const SYNC_INTERVAL_MS = 60_000
const MAX_REQUEST_BYTES = 32 * 1024
const FATAL_CODES = new Set(['auth_failed', 'protocol_mismatch'])
const connectionClosed = () => new BatonRequestError('connection-closed', 'connection closed')

export class BatonRequestError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BatonRequestError'
    this.code = code
  }
}

export function validateServerUrl(value) {
  const url = new URL(value)
  if (url.username || url.password) throw new Error('serverUrl must not contain credentials')
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]'
  if (url.protocol === 'ws:' && !loopback) throw new Error('serverUrl must use wss:// outside localhost')
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('serverUrl must be ws:// or wss://')
  return url.toString()
}

/** Env wins when non-empty; the file is read only when the env is absent or empty. */
export async function readSecret({ envName = 'BATON_SECRET', filePath } = {}) {
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { secret: fromEnv, source: 'env' }
  const path = filePath ?? join(homedir(), '.config', 'baton', 'secret')
  if (!isAbsolute(path)) throw new Error('secretFile must be absolute')
  const info = await stat(path)
  if ((info.mode & 0o077) !== 0) throw new Error(`secretFile permissions are too open: ${(info.mode & 0o777).toString(8)}`)
  const secret = (await readFile(path, 'utf8')).replace(/\r?\n$/, '')
  if (secret.length === 0) throw new Error('secretFile is empty')
  return { secret, source: 'file' }
}

export class BatonConnection {
  /**
   * @param {object} options
   * @param {string} options.serverUrl
   * @param {string} options.secret
   * @param {string} options.userId
   * @param {string} options.displayName
   * @param {(snapshot: object) => void} [options.onSnapshot]
   * @param {(event: object) => void} [options.onEvent]
   * @param {(status: {state: string, detail?: string}) => void} [options.onStatus]
   */
  constructor({ serverUrl, secret, userId, displayName, onSnapshot, onEvent, onStatus }) {
    this.serverUrl = validateServerUrl(serverUrl)
    if (typeof secret !== 'string' || [...secret].length < 32) throw new Error('secret must be at least 32 characters')
    this.secret = secret
    this.userId = userId
    this.displayName = displayName
    this.onSnapshot = onSnapshot
    this.onEvent = onEvent
    this.onStatus = onStatus ?? (() => {})
    this.socket = undefined
    this.open = false
    this.authenticated = false
    this.stopped = true
    this.attempts = 0
    this.queue = []
    this.inflight = undefined
    this.lastMessageAt = 0
    this.timers = new Set()
    this.reconnectTimer = undefined
    this.heartbeatTimer = undefined
    this.syncTimer = undefined
    this.syncing = undefined
    this.syncAgain = false
    this.generation = 0
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    this.closeSocket(1000, 'client stopped')
    this.onStatus({ state: 'stopped' })
  }

  closeSocket(code = 1001, reason = 'connection closed') {
    // Fence both socket events and promises already resolved before teardown.
    this.generation += 1
    this.open = false
    this.authenticated = false
    this.clearTimers()
    this.syncAgain = false
    this.syncing = undefined
    this.failAll(connectionClosed())
    const socket = this.socket
    this.socket = undefined
    try { socket?.close(code, reason) } catch {}
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    clearInterval(this.heartbeatTimer)
    clearInterval(this.syncTimer)
  }

  later(fn, delay) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn() }, delay)
    this.timers.add(timer)
    return timer
  }

  connect() {
    if (this.stopped) return
    const generation = ++this.generation
    this.onStatus({ state: this.attempts === 0 ? 'connecting' : 'reconnecting' })
    if (this.stopped || generation !== this.generation) return
    let socket
    try {
      socket = new WebSocket(this.serverUrl)
    } catch (error) {
      this.onStatus({ state: 'error', detail: error.message })
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    const alive = () => !this.stopped && generation === this.generation
    const down = (code) => {
      if (!alive()) return
      this.closeSocket()
      this.onStatus({ state: 'disconnected', detail: `code ${code}` })
      this.scheduleReconnect()
    }
    socket.addEventListener('open', () => {
      if (!alive() || this.open) return
      this.open = true
      this.lastMessageAt = Date.now()
      this.onStatus({ state: 'authenticating' })
      if (!alive()) return
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
      this.authenticate(generation).catch((error) => { if (alive()) this.handleFatal(error) })
    })
    socket.addEventListener('message', (event) => {
      if (!alive()) return
      this.receive(event.data)
    })
    socket.addEventListener('error', () => {
      if (!alive()) return
      this.onStatus({ state: 'error', detail: 'socket error' })
      // Some runtimes fire error without close; force the state machine forward.
      down('error')
    })
    socket.addEventListener('close', (event) => down(event.code))
    // A connect attempt that neither opens nor closes must not hang the client.
    this.later(() => {
      if (!alive() || this.open) return
      down('timeout')
    }, 10_000)
  }

  async authenticate(generation = this.generation) {
    await this.request('hello', {
      protocolVersion: PROTOCOL_VERSION,
      secret: this.secret,
      userId: this.userId,
      displayName: this.displayName,
    })
    if (this.stopped || generation !== this.generation || !this.open) return
    this.authenticated = true
    this.attempts = 0
    this.syncTimer = setInterval(() => {
      this.sync().catch((error) => {
        if (!this.stopped && generation === this.generation) this.handleFatal(error)
      })
    }, SYNC_INTERVAL_MS)
    this.onStatus({ state: 'online' })
    if (this.stopped || generation !== this.generation) return
    await this.sync()
  }

  scheduleReconnect(delay) {
    if (this.stopped || this.reconnectTimer) return
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts, 5))
    const wait = delay ?? base + Math.floor(Math.random() * 500)
    this.attempts += 1
    this.onStatus({ state: 'reconnecting', detail: `${Math.round(wait / 1000)}s` })
    if (this.stopped) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, wait)
  }

  handleFatal(error) {
    if (this.stopped) return
    if (FATAL_CODES.has(error.code)) {
      this.stop()
      this.onStatus({ state: 'fatal', detail: error.message })
      return
    }
    this.closeSocket()
    if (error.code === 'rate_limited') {
      this.onStatus({ state: 'rate-limited', detail: 'retry in 60s' })
      this.scheduleReconnect(60_000)
      return
    }
    this.onStatus({ state: 'reconnecting', detail: error.message })
    this.scheduleReconnect()
  }

  heartbeat() {
    if (!this.authenticated || this.stopped) return
    if (Date.now() - this.lastMessageAt >= IDLE_LIMIT_MS) {
      this.closeSocket(1001, 'idle')
      this.onStatus({ state: 'idle-timeout' })
      this.scheduleReconnect()
      return
    }
    this.request('ping', {}).catch(() => {})
  }

  receive(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    this.lastMessageAt = Date.now()
    if (message?.type === 'state.changed') {
      if (!this.authenticated) return
      this.onEvent?.(message)
      const generation = this.generation
      this.sync().catch((error) => {
        if (!this.stopped && generation === this.generation) this.handleFatal(error)
      })
      return
    }
    if (message?.id === undefined) return
    const pending = this.inflight
    if (!pending || pending.id !== message.id) return // late response after timeout
    this.inflight = undefined
    clearTimeout(pending.timer)
    if (message.type === 'ok') pending.resolve(message.data ?? {})
    else {
      const error = new BatonRequestError(message.code ?? 'internal', message.message ?? 'request failed')
      pending.reject(error)
      if (FATAL_CODES.has(error.code) || error.code === 'rate_limited') {
        this.handleFatal(error)
        return
      }
    }
    this.pump()
  }

  request(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (this.stopped || !this.open || (!this.authenticated && type !== 'hello')) {
        reject(connectionClosed())
        return
      }
      const id = randomUUID()
      let encoded
      try {
        encoded = JSON.stringify({ id, type, data })
        if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) throw new Error('too large')
      } catch {
        reject(new BatonRequestError('invalid_request', 'request must be valid JSON within 32 KiB'))
        return
      }
      const pending = { id, type, encoded, resolve, reject, deadline: Date.now() + REQUEST_TIMEOUT_MS }
      pending.timer = setTimeout(() => this.expire(pending), REQUEST_TIMEOUT_MS)
      this.queue.push(pending)
      this.pump()
    })
  }

  expire(pending) {
    if (this.inflight === pending) this.inflight = undefined
    else {
      const index = this.queue.indexOf(pending)
      if (index === -1) return
      this.queue.splice(index, 1)
    }
    clearTimeout(pending.timer)
    pending.reject(new BatonRequestError('timeout', `${pending.type} timed out`))
    this.pump()
  }

  pump() {
    if (this.stopped || this.inflight || !this.open || this.queue.length === 0) return
    const next = this.queue[0]
    if (!this.authenticated && next.type !== 'hello') return
    if (Date.now() >= next.deadline) { this.expire(next); return }
    const pending = this.queue.shift()
    this.inflight = pending
    try {
      this.socket.send(pending.encoded)
    } catch {
      this.closeSocket()
      this.onStatus({ state: 'disconnected' })
      this.scheduleReconnect()
    }
  }

  failAll(error) {
    if (this.inflight) {
      clearTimeout(this.inflight.timer)
      this.inflight.reject(error)
      this.inflight = undefined
    }
    for (const pending of this.queue.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  async sync() {
    if (this.stopped || !this.authenticated || !this.open) throw connectionClosed()
    if (this.syncing) {
      this.syncAgain = true
      return this.syncing
    }
    const generation = this.generation
    const syncing = this.request('sync', {}).then((snapshot) => {
      if (this.stopped || generation !== this.generation) throw connectionClosed()
      this.onSnapshot?.(snapshot)
      return snapshot
    }).finally(() => {
      if (this.syncing !== syncing) return
      this.syncing = undefined
      if (this.syncAgain) {
        this.syncAgain = false
        this.sync().catch((error) => {
          if (!this.stopped && generation === this.generation) this.handleFatal(error)
        })
      }
    })
    this.syncing = syncing
    return syncing
  }

  async retryTask(type, data) {
    const payload = { ...data }
    const generation = this.generation
    try { return await this.request(type, payload) } catch (error) {
      if (!['timeout', 'internal'].includes(error.code)) throw error
      if (this.stopped || !this.authenticated || generation !== this.generation) throw connectionClosed()
      return this.request(type, payload)
    }
  }

  roomCreate(name) { return this.request('room.create', { name }) }
  roomJoin(code) { return this.request('room.join', { code }) }
  roomLeave(code) { return this.request('room.leave', { code }) }
  roomDisband(code) { return this.request('room.disband', { code }) }
  taskSend(task) { return this.retryTask('task.send', task) }
  taskGet(taskId) { return this.request('task.get', { taskId }) }
  taskRespond(taskId, decision) { return this.retryTask('task.respond', { taskId, decision }) }
}
