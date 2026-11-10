/**
 * Two-client smoke test for a running baton-server. Usage:
 *   BATON_SECRET=... node baton-server/smoke.mjs
 */
const url = process.env.BATON_URL ?? 'ws://127.0.0.1:8080/ws'
const secret = process.env.BATON_SECRET
if (!secret) throw new Error('BATON_SECRET is required')

const uuid = () => crypto.randomUUID()

function connect(userId, displayName) {
  const socket = new WebSocket(url)
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.type === 'ok') entry.resolve(message.data ?? {})
    else entry.reject(Object.assign(new Error(message.message), { code: message.code }))
  })
  const request = (type, data = {}) => new Promise((resolve, reject) => {
    const id = uuid()
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, type, data }))
  })
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', async () => {
      try {
        await request('hello', { protocolVersion: 1, secret, userId, displayName })
        resolve({ socket, request, userId })
      } catch (error) { reject(error) }
    })
    socket.addEventListener('error', () => reject(new Error('socket error')))
  })
}

const a = await connect(uuid(), 'Alice')
const b = await connect(uuid(), 'Bob')

const created = await a.request('room.create', { name: 'smoke' })
await b.request('room.join', { code: created.code })
const task = await a.request('task.send', {
  taskId: uuid(), room: created.code, to: b.userId, env: 'frontend', title: 'smoke task', brief: '只回复 OK',
})
const bSync = await b.request('sync', {})
const incoming = bSync.tasks.find((item) => item.taskId === task.task.taskId)
if (!incoming || incoming.status !== 'pending') throw new Error('B did not receive the pending task')
const accepted = await b.request('task.respond', { taskId: task.task.taskId, decision: 'accepted' })
const aSync = await a.request('sync', {})
const outgoing = aSync.tasks.find((item) => item.taskId === task.task.taskId)
if (outgoing?.status !== 'accepted') throw new Error('A did not see accepted')

console.log(JSON.stringify({
  ok: true,
  room: created.code,
  taskId: task.task.taskId,
  bSaw: incoming.status,
  respond: accepted.task.status,
  aSaw: outgoing.status,
}, null, 2))

a.socket.close()
b.socket.close()
