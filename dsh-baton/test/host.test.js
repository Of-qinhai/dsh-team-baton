import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BatonConnection, BatonRequestError } from '../connection.js'
import { LocalState } from '../session.js'

async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'baton-host-test-'))
  const base = join(directory, 'state')
  const project = join(directory, 'project-a')
  const other = join(directory, 'project-b')
  const alias = join(directory, 'project-link')
  await mkdir(project)
  await mkdir(other)
  await symlink(project, alias)
  const cwd = await realpath(project)
  const task = { taskId: randomUUID(), room: 'ABCD23', env: 'frontend', title: 'Review task', status: 'pending', from: { userId: randomUUID(), displayName: 'Teammate' }, to: {}, expiresAt: Date.now() + 86_400_000 }
  const calls = { creates: 0, prompts: 0, responds: 0, sends: [], directories: [] }
  const saved = {}
  const disposers = []
  let client
  let route
  const tools = new Map()
  for (const method of ['start', 'stop', 'sync', 'taskGet', 'taskRespond', 'taskSend']) saved[method] = BatonConnection.prototype[method]
  BatonConnection.prototype.start = function () {
    client = this
    this.authenticated = true
    this.open = true
    task.to.userId = this.userId
    this.onSnapshot({ rooms: [], tasks: [task] })
    this.onStatus({ state: 'online' })
  }
  BatonConnection.prototype.stop = function () { this.authenticated = false }
  BatonConnection.prototype.sync = async function () { this.onSnapshot({ rooms: [], tasks: [task] }); return { rooms: [], tasks: [task] } }
  BatonConnection.prototype.taskGet = async function () { return { task: { ...task }, brief: 'Please review this project.' } }
  BatonConnection.prototype.taskRespond = async function (_taskId, decision) { calls.responds++; task.status = decision; return { task: { ...task } } }
  BatonConnection.prototype.taskSend = async function (request) {
    calls.sends.push({ ...request })
    if (options.send) return options.send(request, calls, join(base, 'state.json'))
    return { task: { ...request, status: 'pending' } }
  }
  const previousHome = process.env.BATON_HOME
  process.env.BATON_HOME = base
  process.env.BATON_HOST_TEST_SECRET = 'test-secret-with-no-real-credentials-1234'
  const ctx = {
    effect(effect) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    connection: { fetch: { register(handler) { route = handler; return () => {} } } },
    workspaceRegistry: { async create(path) {
      const actual = await realpath(path)
      assert.equal((await stat(actual)).isDirectory(), true)
      calls.directories.push(actual)
      return { id: actual, sessionIds: [], async attachSession() {} }
    } },
    sessionController: {
      async create() { calls.creates++; return { sessionId: 'session-test' } },
      async rename() { if (options.rename) return options.rename() },
      async prompt() { calls.prompts++; return { accepted: true } },
    },
  }
  const config = { serverUrl: 'ws://127.0.0.1:8080/ws', secretEnv: 'BATON_HOST_TEST_SECRET', displayName: 'Test', environments: [{ key: 'frontend', cwd: alias }] }
  try {
    const { apply } = await import('../index.js?fixture=' + randomUUID())
    const start = async () => { await apply(ctx, config); await new Promise(resolve => setImmediate(resolve)) }
    await start()
    const panel = async body => {
      const response = await route.fetch(new Request('http://localhost/api/baton', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      return { status: response.status, ...(await response.json()) }
    }
    await run({ directory, base, project, other, alias, cwd, task, calls, tools, panel, start, get client() { return client } })
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    for (const [method, implementation] of Object.entries(saved)) BatonConnection.prototype[method] = implementation
    if (previousHome === undefined) delete process.env.BATON_HOME
    else process.env.BATON_HOME = previousHome
    delete process.env.BATON_HOST_TEST_SECRET
    await rm(directory, { recursive: true, force: true })
  }
}

test('a changed symlink needs renewed approval before any server approval or session', () => fixture(async ({ alias, other, cwd, task, panel, calls }) => {
  const detail = await panel({ action: 'detail', taskId: task.taskId })
  assert.equal(detail.cwd, cwd)
  await unlink(alias)
  await symlink(other, alias)
  const result = await panel({ action: 'accept', taskId: task.taskId, cwd: detail.cwd })
  assert.equal(result.status, 409)
  assert.equal(result.code, 'cwd-changed')
  assert.equal(calls.responds, 0)
  assert.equal(calls.creates, 0)
  assert.equal(calls.prompts, 0)
  const refreshed = await panel({ action: 'detail', taskId: task.taskId })
  const accepted = await panel({ action: 'accept', taskId: task.taskId, cwd: refreshed.cwd })
  assert.equal(accepted.ok, true)
  assert.equal(calls.directories[0], await realpath(other))
}))

test('invalid target directories are rejected before approving the task', () => fixture(async ({ alias, directory, task, panel, calls }) => {
  await unlink(alias)
  const file = join(directory, 'not-a-directory')
  await writeFile(file, 'fixture')
  await symlink(file, alias)
  const detail = await panel({ action: 'detail', taskId: task.taskId })
  assert.equal(detail.cwd, null)
  assert.ok(detail.cwdError)
  const result = await panel({ action: 'accept', taskId: task.taskId, cwd: alias })
  assert.equal(result.ok, false)
  assert.equal(calls.responds, 0)
  assert.equal(calls.creates, 0)
}))

test('resume reuses the approved canonical directory after configuration alias changes', () => {
  let renameAttempts = 0
  return fixture(async ({ alias, other, cwd, task, panel, calls }) => {
    const detail = await panel({ action: 'detail', taskId: task.taskId })
    const first = await panel({ action: 'accept', taskId: task.taskId, cwd: detail.cwd })
    assert.equal(first.ok, false)
    await unlink(alias)
    await symlink(other, alias)
    const resumed = await panel({ action: 'resume', taskId: task.taskId, cwd })
    assert.equal(resumed.ok, true)
    assert.equal(calls.creates, 1)
    assert.deepEqual(calls.directories, [cwd])
    assert.equal(calls.prompts, 1)
  }, { rename() { if (renameAttempts++ === 0) throw new Error('rename unavailable') } })
})

test('unknown send results persist their request and retry with the same taskId', () => fixture(async ({ tools, calls }) => {
  const args = { room: 'ABCD23', to: randomUUID(), env: 'frontend', title: 'A task', brief: 'A brief' }
  const first = JSON.parse(await tools.get('team_task_send').execute(args))
  assert.equal(first.ok, false)
  assert.ok(first.taskId)
  const retried = JSON.parse(await tools.get('team_task_send').execute(args))
  assert.equal(retried.ok, true)
  assert.equal(calls.sends[0].taskId, calls.sends[1].taskId)
}, { async send(request, calls, path) {
  const disk = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(disk.sends[request.taskId].brief, request.brief, 'save the full request before network I/O')
  if (calls.sends.length === 1) throw new BatonRequestError('timeout', 'unknown result')
  return { task: { ...request, status: 'pending' } }
} }))

test('an unresolved send keeps its identity across plugin restarts', () => fixture(async ({ tools, start, calls }) => {
  const args = { room: 'ABCD23', to: randomUUID(), env: 'frontend', title: 'A task', brief: 'A brief' }
  const first = JSON.parse(await tools.get('team_task_send').execute(args))
  await start()
  const second = JSON.parse(await tools.get('team_task_send').execute({ ...args, taskId: first.taskId }))
  assert.equal(second.ok, true)
  assert.equal(calls.sends[0].taskId, calls.sends[1].taskId)
}, { async send(request, calls) {
  if (calls.sends.length === 1) throw new BatonRequestError('timeout', 'unknown result')
  return { task: { ...request, status: 'pending' } }
} }))

test('an existing outgoing id cannot be reused with changed content', () => fixture(async ({ panel, calls }) => {
  const body = { action: 'send', taskId: randomUUID(), room: 'ABCD23', to: randomUUID(), env: 'frontend', title: 'Original', brief: 'A brief' }
  assert.equal((await panel(body)).ok, true)
  const result = await panel({ ...body, title: 'Changed' })
  assert.equal(result.status, 409)
  assert.equal(result.code, 'conflict')
  assert.equal(calls.sends.length, 1)
}))

test('offline panels still show cached data while business actions fail immediately', () => fixture(async fx => {
  fx.client.authenticated = false
  fx.client.onStatus({ state: 'disconnected' })
  const snapshot = await fx.panel({ action: 'snapshot' })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.connection.state, 'disconnected')
  assert.equal(snapshot.tasks.length, 1)
  const result = await fx.panel({ action: 'create', name: 'Room' })
  assert.equal(result.status, 503)
  assert.equal(result.code, 'connection-closed')
}))

test('an accepted task without a checkpoint has an explicit confirmed manual exit', () => fixture(async ({ task, panel, calls }) => {
  task.status = 'accepted'
  const snapshot = await panel({ action: 'snapshot' })
  assert.equal(snapshot.local[task.taskId].phase, 'needs-review')
  assert.equal((await panel({ action: 'handled', taskId: task.taskId })).ok, false)
  const handled = await panel({ action: 'handled', taskId: task.taskId, confirmed: true })
  assert.equal(handled.ok, true)
  assert.equal(handled.record.phase, 'handled')
  assert.equal(calls.prompts, 0)
  assert.equal(calls.responds, 0)
}))

test('a saved-send checkpoint failure keeps the original id retryable', async () => {
  const save = LocalState.prototype.save
  let failSaved = true
  LocalState.prototype.save = async function (next) {
    if (failSaved && Object.values(next.sends ?? {}).some(item => item.status === 'saved')) { failSaved = false; throw Object.assign(new Error('checkpoint failed'), { code: 'EIO' }) }
    return save.call(this, next)
  }
  try {
    await fixture(async ({ tools, calls }) => {
      const args = { room: 'ABCD23', to: randomUUID(), env: 'frontend', title: 'A task', brief: 'A brief' }
      const first = JSON.parse(await tools.get('team_task_send').execute(args))
      assert.equal(first.ok, false)
      const second = JSON.parse(await tools.get('team_task_send').execute(args))
      assert.equal(second.ok, true)
      assert.equal(calls.sends[0].taskId, calls.sends[1].taskId)
    })
  } finally { LocalState.prototype.save = save }
})

test('an accepted task without a session still displays its recorded directory for resume', () => fixture(async ({ task, base, start, alias, other, cwd, panel, calls }) => {
  task.status = 'accepted'
  await writeFile(join(base, 'state.json'), JSON.stringify({ version: 1, tasks: { [task.taskId]: { taskId: task.taskId, room: task.room, title: task.title, phase: 'unsubmitted', cwd } }, sends: {} }), { mode: 0o600 })
  await unlink(alias)
  await symlink(other, alias)
  await start()
  const detail = await panel({ action: 'detail', taskId: task.taskId })
  assert.equal(detail.cwd, cwd)
  const result = await panel({ action: 'resume', taskId: task.taskId, cwd: detail.cwd })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.directories, [cwd])
}))

test('a final rate limit after an uncertain attempt cannot discard the original id', () => fixture(async ({ tools, calls, start }) => {
  const args = { room: 'ABCD23', to: randomUUID(), env: 'frontend', title: 'A task', brief: 'A brief' }
  assert.equal(JSON.parse(await tools.get('team_task_send').execute(args)).ok, false)
  await start()
  assert.equal(JSON.parse(await tools.get('team_task_send').execute(args)).code, 'rate_limited')
  assert.equal(JSON.parse(await tools.get('team_task_send').execute(args)).ok, true)
  assert.equal(new Set(calls.sends.map(request => request.taskId)).size, 1)
}, { async send(request, calls) {
  if (calls.sends.length === 1) throw new BatonRequestError('timeout', 'unknown result')
  if (calls.sends.length === 2) throw new BatonRequestError('rate_limited', 'a later attempt was rate limited')
  return { task: { ...request, status: 'pending' } }
} }))

test('sync confirmation releases an uncertain id for a new identical task, including after restart', () => fixture(async ({ tools, calls, client, base, start }) => {
  const args = { room: 'ABCD23', to: randomUUID(), env: 'frontend', title: 'A task', brief: 'A brief' }
  const first = JSON.parse(await tools.get('team_task_send').execute(args))
  assert.equal(first.ok, false)
  await client.onSnapshot({ rooms: [], tasks: [{ ...calls.sends[0], from: { userId: client.userId }, to: { userId: args.to }, status: 'pending' }] })
  assert.equal(JSON.parse(await readFile(join(base, 'state.json'), 'utf8')).sends[first.taskId].status, 'saved')
  await start()
  const next = JSON.parse(await tools.get('team_task_send').execute(args))
  assert.equal(next.ok, true)
  assert.notEqual(next.taskId, first.taskId)
}, { async send(request, calls) {
  if (calls.sends.length === 1) throw new BatonRequestError('timeout', 'response lost after commit')
  return { task: { ...request, status: 'pending' } }
} }))

for (const inspectFirst of [true, false]) {
  test(`an accepted task with an unavailable directory has a durable manual exit (${inspectFirst ? 'detail' : 'resume'})`, () => fixture(async ({ project, cwd, task, panel, calls, base }) => {
    const first = await panel({ action: 'accept', taskId: task.taskId, cwd })
    assert.equal(first.code, 'rename-failed')
    await rename(project, `${project}-moved`)
    if (inspectFirst) {
      const detail = await panel({ action: 'detail', taskId: task.taskId })
      assert.equal(detail.cwd, null)
      assert.equal(detail.local.phase, 'needs-review')
      assert.equal(detail.local.sessionId, 'session-test')
      assert.equal(detail.local.cwd, cwd)
    } else {
      assert.equal((await panel({ action: 'resume', taskId: task.taskId, cwd })).code, 'needs-review')
    }
    const disk = JSON.parse(await readFile(join(base, 'state.json'), 'utf8'))
    assert.equal(disk.tasks[task.taskId].phase, 'needs-review')
    assert.equal((await panel({ action: 'handled', taskId: task.taskId, confirmed: true })).record.phase, 'handled')
    assert.equal(calls.creates, 1)
    assert.equal(calls.prompts, 0)
  }, { rename() { throw new Error('rename unavailable') } }))
}

test('unloading during secret-file initialization prevents a late connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-unload-test-'))
  const previousHome = process.env.BATON_HOME
  const start = BatonConnection.prototype.start
  const stop = BatonConnection.prototype.stop
  let starts = 0
  const disposers = []
  try {
    process.env.BATON_HOME = join(directory, 'state')
    const secretFile = join(directory, 'dummy-secret')
    await writeFile(secretFile, 'test-only-not-real-credentials-1234567890', { mode: 0o600 })
    BatonConnection.prototype.start = function () { starts++ }
    BatonConnection.prototype.stop = function () {}
    const { apply } = await import('../index.js?unload=' + randomUUID())
    await apply({
      effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
      tools: { register() { return () => {} } },
      connection: { fetch: { register() { return () => {} } } },
    }, { serverUrl: 'ws://127.0.0.1:8080/ws', secretEnv: 'BATON_UNUSED_UNLOAD_TEST_SECRET', secretFile })
    for (const dispose of disposers.reverse()) dispose()
    // Drain the stat/read work that was already dispatched by connect().
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(starts, 0)
  } finally {
    BatonConnection.prototype.start = start
    BatonConnection.prototype.stop = stop
    if (previousHome === undefined) delete process.env.BATON_HOME
    else process.env.BATON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
