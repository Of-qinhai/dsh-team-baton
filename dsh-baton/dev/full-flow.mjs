/** Real Rust server + real Host/connection/state; DSH services are memory mocks. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { LocalState, PHASE } from '../session.js'

const binary = fileURLToPath(new URL('../../baton-server/target/debug/baton-server' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url))
await access(binary)
const directory = await mkdtemp(join(tmpdir(), 'baton-full-flow-'))
const secret = randomBytes(32).toString('hex')
const actors = []
const cases = []
const reserve = createServer()
let server
let exited
let diagnostic = ''

async function until(check, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await check()
    if (result) return result
    if (server && server.exitCode !== null) throw new Error('Temporary server stopped: ' + diagnostic)
    await delay(25)
  }
  throw new Error('Timed out: ' + description + '\n' + diagnostic)
}

async function check(name, run) {
  try {
    const detail = await run()
    const result = { case: name, ok: true, ...detail }
    cases.push(result)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.log(JSON.stringify({ case: name, ok: false, error: error.message }))
    throw error
  }
}

async function createActor(label, serverUrl) {
  const home = join(directory, label, 'state')
  const project = join(directory, label, 'project')
  const alternate = join(directory, label, 'alternate-project')
  const alias = join(directory, label, 'project-link')
  await mkdir(project, { recursive: true })
  await mkdir(alternate)
  await symlink(project, alias)
  const canonicalCwd = await realpath(project)
  const secretEnv = 'BATON_FLOW_' + randomBytes(12).toString('hex').toUpperCase()
  const calls = { workspaces: [], creates: [], renames: [], prompts: [] }
  const sessions = new Map()
  let current
  let createGate
  const actor = {
    label, home, alias, alternate, canonicalCwd, calls, sessions,
    async start() {
      assert.equal(current, undefined, 'stop the installation before restarting it')
      const run = { disposers: [], tools: new Map(), route: undefined }
      current = run
      const context = {
        effect(effect) {
          const dispose = effect()
          if (typeof dispose === 'function') run.disposers.push(dispose)
        },
        tools: { register(tool) { run.tools.set(tool.name, tool); return () => run.tools.delete(tool.name) } },
        // DSH normally authenticates this transport before dispatching its route.
        connection: { fetch: { register(route) {
          assert.equal(route.path, '/api/baton')
          assert.deepEqual(route.methods, ['POST'])
          assert.equal(route.requestBody, 'buffered')
          run.route = route
          return () => { run.route = undefined }
        } } },
        workspaceRegistry: { async create(cwd, name) {
          assert.equal(cwd, await realpath(cwd), 'Host must pass the approved canonical directory')
          const workspace = {
            id: randomUUID(), cwd, name, sessionIds: [],
            async attachSession(sessionId) { this.sessionIds.push(sessionId) },
          }
          calls.workspaces.push(workspace)
          return workspace
        } },
        sessionController: {
          async create({ workspaceId }) {
            const workspace = calls.workspaces.find(item => item.id === workspaceId)
            assert.ok(workspace, 'session must belong to a real mock workspace')
            const session = { sessionId: randomUUID(), workspaceId, cwd: workspace.cwd }
            calls.creates.push(session)
            const gate = createGate
            if (gate) { createGate = undefined; gate.entered = true; await gate.wait }
            sessions.set(session.sessionId, session)
            return { sessionId: session.sessionId }
          },
          async rename({ sessionId, title }) {
            assert.ok(sessions.has(sessionId))
            sessions.get(sessionId).title = title
            calls.renames.push({ sessionId, title })
          },
          async prompt(request, signal) {
            assert.ok(sessions.has(request.sessionId))
            assert.equal(signal.aborted, false)
            assert.equal(request.mode, 'queue')
            assert.equal(request.content[0].type, 'text')
            calls.prompts.push(structuredClone(request))
            return { accepted: true }
          },
        },
      }
      const previousHome = process.env.BATON_HOME
      process.env.BATON_HOME = home
      process.env[secretEnv] = secret
      try {
        await apply(context, {
          serverUrl, secretEnv, displayName: 'Flow ' + label,
          environments: [{ key: 'frontend', label: 'Flow project', cwd: alias }],
        })
      } finally {
        if (previousHome === undefined) delete process.env.BATON_HOME
        else process.env.BATON_HOME = previousHome
        delete process.env[secretEnv]
      }
      assert.ok(run.route, 'actual Host must register its panel route')
      const snapshot = await until(async () => {
        const value = await actor.panel({ action: 'snapshot' })
        if (value.connection.state === 'fatal') throw new Error('Host startup failed: ' + value.connection.detail)
        return value.connection.state === 'online' ? value : false
      }, label + ' authentication')
      actor.userId = snapshot.userId
      return snapshot
    },
    stop() {
      createGate?.release()
      createGate = undefined
      if (!current) return
      for (const dispose of current.disposers.reverse()) dispose()
      current = undefined
    },
    holdNextCreate() {
      assert.equal(createGate, undefined)
      const gate = { entered: false }
      gate.wait = new Promise(resolve => { gate.release = resolve })
      createGate = gate
      return gate
    },
    async panel(body) {
      assert.ok(current?.route, label + ' plugin must be running')
      const response = await current.route.fetch(new Request('http://baton-flow.invalid/api/baton', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
      return { httpStatus: response.status, ...(await response.json()) }
    },
    async tool(name, args = {}) {
      const tool = current?.tools.get(name)
      assert.ok(tool, 'actual Host must register ' + name)
      return JSON.parse(await tool.execute(args))
    },
    async state() {
      const state = new LocalState(join(home, 'state.json'))
      await state.load()
      return state.data
    },
  }
  actors.push(actor)
  return actor
}

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  if ('httpStatus' in result) assert.equal(result.httpStatus, 200)
  return result
}

async function waitTask(actor, taskId, status) {
  return until(async () => {
    const snapshot = ok(await actor.panel({ action: 'snapshot' }))
    return snapshot.tasks.find(task => task.taskId === taskId && task.status === status)
  }, actor.label + ' sees task ' + status)
}

try {
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  assert.notEqual(port, 8080, 'never use the existing local service')
  await new Promise(resolve => reserve.close(resolve))
  server = spawn(binary, [], {
    env: {
      BATON_SECRET: secret, BATON_DB: join(directory, 'baton.db'),
      BATON_BIND: '127.0.0.1:' + port, TRUSTED_PROXY_CIDRS: '', RUST_LOG: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000) }
  server.stdout.on('data', capture)
  server.stderr.on('data', capture)
  exited = once(server, 'exit')
  await until(async () => {
    try { return (await fetch('http://127.0.0.1:' + port + '/healthz')).ok } catch { return false }
  }, 'temporary Rust server startup')

  console.log(JSON.stringify({
    setup: 'full-flow', server: 'real Rust process with temporary SQLite', host: 'real index.js/connection.js/LocalState',
    dshAdapter: 'MOCK: in-memory sessionController/workspaceRegistry and authenticated DSH route dispatch',
    realDshOrModelCalled: false, usesExistingServiceOrDatabase: false,
  }))
  const serverUrl = 'ws://127.0.0.1:' + port + '/ws'
  const a = await createActor('A', serverUrl)
  const b = await createActor('B', serverUrl)
  await a.start()
  await b.start()
  assert.notEqual(a.userId, b.userId)
  assert.notEqual(a.canonicalCwd, b.canonicalCwd)
  let room
  let acceptedId
  let offlineId

  await check('A creates room and B joins with distinct installation identities', async () => {
    room = ok(await a.panel({ action: 'create', name: 'Full flow room' })).code
    ok(await b.panel({ action: 'join', code: room.toLowerCase() }))
    const snapshot = await until(async () => {
      const value = ok(await a.panel({ action: 'snapshot' }))
      return value.rooms.find(item => item.code === room && item.members.length === 2 && item.members.every(member => member.online))
    }, 'both members online')
    const tools = ok(await a.tool('team_rooms'))
    assert.equal(tools.rooms[0].members.length, 2)
    assert.deepEqual(new Set(snapshot.members.map(member => member.userId)), new Set([a.userId, b.userId]))
    return { members: 2, distinctIdentities: true }
  })

  await check('A sends to B; inspection cannot create or prompt a session', async () => {
    const brief = 'Fixture task only. The DSH adapter is mocked; no model will run.'
    const sent = ok(await a.tool('team_task_send', {
      room, to: b.userId, env: 'frontend', title: 'Accept fixture', brief,
    }))
    acceptedId = sent.taskId
    await waitTask(b, acceptedId, 'pending')
    const detail = ok(await b.panel({ action: 'detail', taskId: acceptedId }))
    assert.equal(detail.cwd, b.canonicalCwd)
    assert.notEqual(detail.cwd, a.canonicalCwd)
    assert.equal(detail.brief, brief)
    assert.equal(b.calls.creates.length, 0)
    assert.equal(b.calls.prompts.length, 0)
    assert.equal(Object.hasOwn((await b.panel({ action: 'snapshot' })).tasks[0], 'brief'), false)
    return { recipientCanonicalDirectory: true, createsBeforeAccept: 0, promptsBeforeAccept: 0 }
  })

  await check('B accepts once even with concurrent accept; A sees accepted receipt', async () => {
    const detail = ok(await b.panel({ action: 'detail', taskId: acceptedId }))
    const gate = b.holdNextCreate()
    const pending = b.panel({ action: 'accept', taskId: acceptedId, cwd: detail.cwd })
    try {
      await until(() => gate.entered, 'first acceptance reaches mock session creation')
      const duplicate = await b.panel({ action: 'accept', taskId: acceptedId, cwd: detail.cwd })
      assert.equal(duplicate.httpStatus, 409)
      assert.equal(duplicate.code, 'start-in-progress')
    } finally { gate.release() }
    const accepted = ok(await pending)
    await waitTask(a, acceptedId, 'accepted')
    assert.equal(b.calls.creates.length, 1)
    assert.equal(b.calls.prompts.length, 1)
    assert.equal(b.calls.workspaces[0].cwd, b.canonicalCwd)
    assert.deepEqual(b.calls.workspaces[0].sessionIds, [accepted.sessionId])
    assert.equal(b.calls.renames[0].title, '[' + room + '] Accept fixture')
    assert.equal(b.calls.prompts[0].content[0].text, detail.brief)
    const saved = (await b.state()).tasks[acceptedId]
    assert.equal(saved.phase, PHASE.submitted)
    assert.equal(saved.sessionId, accepted.sessionId)
    assert.equal(saved.cwd, b.canonicalCwd)
    return { creates: 1, prompts: 1, concurrentDuplicateStatus: 409, senderReceipt: 'accepted', checkpoint: saved.phase }
  })

  await check('B sends to A; decline creates no session and B sees declined receipt', async () => {
    const sent = ok(await b.panel({ action: 'send', room, to: a.userId, env: 'frontend', title: 'Decline fixture', brief: 'Decline without executing this fixture.' }))
    await waitTask(a, sent.task.taskId, 'pending')
    const detail = ok(await a.panel({ action: 'detail', taskId: sent.task.taskId }))
    assert.equal(detail.cwd, a.canonicalCwd)
    ok(await a.panel({ action: 'decline', taskId: sent.task.taskId }))
    await waitTask(b, sent.task.taskId, 'declined')
    assert.equal(a.calls.creates.length, 0)
    assert.equal(a.calls.prompts.length, 0)
    return { creates: 0, prompts: 0, senderReceipt: 'declined' }
  })

  await check('offline delivery survives B restart without executing earlier accepted work', async () => {
    const originalIdentity = b.userId
    const originalRecord = (await b.state()).tasks[acceptedId]
    b.stop()
    await until(async () => (await a.panel({ action: 'snapshot' })).rooms[0].members.some(member => member.userId === originalIdentity && !member.online), 'B offline presence')
    const sent = ok(await a.panel({ action: 'send', room, to: originalIdentity, env: 'frontend', title: 'Offline fixture', brief: 'Wait for explicit human approval after reconnect.' }))
    offlineId = sent.task.taskId
    await b.start()
    assert.equal(b.userId, originalIdentity)
    await waitTask(b, offlineId, 'pending')
    const snapshot = ok(await b.panel({ action: 'snapshot' }))
    assert.equal(snapshot.tasks.find(task => task.taskId === acceptedId).status, 'accepted')
    assert.equal(snapshot.local[acceptedId].phase, PHASE.submitted)
    assert.equal(snapshot.local[acceptedId].sessionId, originalRecord.sessionId)
    assert.equal(b.calls.creates.length, 1)
    assert.equal(b.calls.prompts.length, 1)
    const identityOnDisk = JSON.parse(await readFile(join(b.home, 'identity.json'), 'utf8'))
    assert.equal(identityOnDisk.userId, originalIdentity)
    assert.equal((await b.state()).tasks[acceptedId].sessionId, originalRecord.sessionId)
    const replay = await b.panel({ action: 'accept', taskId: acceptedId, cwd: originalRecord.cwd })
    assert.equal(replay.httpStatus, 409)
    assert.equal(replay.code, 'already-submitted')
    assert.equal(b.calls.creates.length, 1)
    assert.equal(b.calls.prompts.length, 1)
    return { identityRestored: true, offlineTaskStatus: 'pending', previousCheckpoint: 'submitted', previousTaskReexecuted: false, explicitReplayStatus: 409 }
  })

  await check('directory symlink change between detail and acceptance leaves remote task pending', async () => {
    const detail = ok(await b.panel({ action: 'detail', taskId: offlineId }))
    assert.equal(detail.cwd, b.canonicalCwd)
    await unlink(b.alias)
    await symlink(b.alternate, b.alias)
    const rejected = await b.panel({ action: 'accept', taskId: offlineId, cwd: detail.cwd })
    assert.equal(rejected.httpStatus, 409)
    assert.equal(rejected.code, 'cwd-changed')
    assert.equal(ok(await a.panel({ action: 'detail', taskId: offlineId })).task.status, 'pending')
    assert.equal(ok(await b.panel({ action: 'detail', taskId: offlineId })).task.status, 'pending')
    assert.equal(b.calls.creates.length, 1)
    assert.equal(b.calls.prompts.length, 1)
    assert.equal((await b.state()).tasks[offlineId], undefined)
    return { httpStatus: 409, code: 'cwd-changed', remoteStatus: 'pending', additionalCreates: 0, additionalPrompts: 0 }
  })

  console.log(JSON.stringify({ ok: true, passed: cases.length, dshAdapter: 'MOCK', realDshOrModelCalled: false, realComponents: ['Rust server', 'WebSocket', 'Host apply', 'LocalState', 'installation identity'], cleanup: 'temporary process and files removed in finally' }))
} finally {
  for (const actor of actors) actor.stop()
  if (reserve.listening) await new Promise(resolve => reserve.close(resolve))
  if (server) {
    if (server.exitCode === null) server.kill('SIGTERM')
    const stopped = await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })])
    if (!stopped) { server.kill('SIGKILL'); await exited }
  }
  await rm(directory, { recursive: true, force: true })
}
