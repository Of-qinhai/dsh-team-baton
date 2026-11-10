/**
 * Scripted peer for integration checks. Usage:
 *   BATON_SECRET=... node baton-server/peer.mjs create <userId> <displayName>
 *   BATON_SECRET=... node baton-server/peer.mjs join <userId> <displayName> <code> [--accept]
 */
const url = process.env.BATON_URL ?? 'ws://127.0.0.1:8080/ws'
const secret = process.env.BATON_SECRET
if (!secret) throw new Error('BATON_SECRET is required')

const [mode, userId, displayName, code] = process.argv.slice(2)
const accept = process.argv.includes('--accept')

function connect(userId, displayName) {
  const socket = new WebSocket(url)
  const pending = new Map()
  const events = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.type === 'state.changed') { events.push(message); return }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.type === 'ok') entry.resolve(message.data ?? {})
    else entry.reject(Object.assign(new Error(message.message), { code: message.code }))
  })
  const request = (type, data = {}) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, type, data }))
  })
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', async () => {
      try {
        await request('hello', { protocolVersion: 1, secret, userId, displayName })
        resolve({ socket, request })
      } catch (error) { reject(error) }
    })
    socket.addEventListener('error', () => reject(new Error('socket error')))
  })
}

const peer = await connect(userId, displayName)
if (mode === 'sync') {
  const snapshot = await peer.request('sync', {})
  console.log(JSON.stringify({ ok: true, rooms: snapshot.rooms.map((room) => room.code), tasks: snapshot.tasks.length }))
  peer.socket.close()
  process.exit(0)
}

if (mode === 'send') {
  const [toUserId, title, brief, env = 'frontend'] = process.argv.slice(6)
  const sent = await peer.request('task.send', {
    taskId: crypto.randomUUID(), room: code, to: toUserId, env, title, brief,
  })
  console.log(JSON.stringify({ ok: true, taskId: sent.task.taskId, status: sent.task.status }))
  await new Promise((resolve) => setTimeout(resolve, 500))
  peer.socket.close()
  process.exit(0)
}

if (mode === 'create') {
  const created = await peer.request('room.create', { name: '插件联调' })
  console.log(JSON.stringify({ ok: true, code: created.code, owner: userId }))
  await new Promise((resolve) => setTimeout(resolve, 800))
  peer.socket.close()
  process.exit(0)
}

if (mode === 'join') {
  await peer.request('room.join', { code })
  console.log(JSON.stringify({ ok: true, joined: code, user: userId }))
  let cursor = 0
  const tick = async () => {
    const snapshot = await peer.request('sync', {})
    for (const task of snapshot.tasks) {
      if (task.to.userId !== userId || task.status !== 'pending') continue
      if (!accept) continue
      const result = await peer.request('task.respond', { taskId: task.taskId, decision: 'accepted' })
      console.log(JSON.stringify({ ok: true, accepted: result.task.taskId, status: result.task.status }))
    }
    cursor = snapshot.tasks.length
  }
  await tick()
  setInterval(() => { tick().catch((error) => console.error(JSON.stringify({ ok: false, error: error.message }))) }, 1500)
  setTimeout(() => { peer.socket.close(); process.exit(0) }, 90000)
}
