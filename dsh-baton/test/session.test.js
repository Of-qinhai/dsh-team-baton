import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BatonStartError, LocalState, PHASE, createStarter } from '../session.js'

async function setup(adapterOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'baton-session-'))
  const statePath = join(dir, 'state.json')
  const calls = { respond: 0, create: 0, rename: 0, prompt: 0, workspace: 0, verify: 0 }
  const adapter = {
    async ensureWorkspace() { calls.workspace++; return 'ws-1' },
    async create() { calls.create++; return { sessionId: `session-${calls.create}` } },
    async rename() { calls.rename++; return { title: 'x', seq: 1 } },
    async prompt() { calls.prompt++; return { accepted: true } },
    ...adapterOverrides,
  }
  const state = new LocalState(statePath)
  await state.load()
  return { dir, state, statePath, adapter, calls }
}

test('happy path records every phase and submits once', async () => {
  const { dir, state, adapter, calls } = await setup()
  try {
    const starter = createStarter({ adapter, state })
    const record = await starter.start({
      taskId: 't1', room: 'ABC123', title: '对接接口', brief: 'brief', cwd: '/tmp',
      respond: async () => { calls.respond++ },
    })
    assert.equal(record.phase, PHASE.submitted)
    assert.equal(record.sessionId, 'session-1')
    assert.deepEqual(calls, { respond: 1, create: 1, rename: 1, prompt: 1, workspace: 1, verify: 0 })
    const reloaded = new LocalState(state.path)
    await reloaded.load()
    assert.equal(reloaded.get('t1').sessionId, 'session-1')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('rename failure keeps the session id and resume reuses it', async () => {
  let failRename = true
  const { dir, state, adapter, calls } = await setup({
    async rename(args) { calls.rename++; if (failRename) { failRename = false; throw new Error('rename boom') } return args },
  })
  try {
    const starter = createStarter({ adapter, state })
    await assert.rejects(
      starter.start({ taskId: 't2', room: 'ABC123', title: 't', brief: 'b', cwd: '/tmp', respond: async () => {} }),
      (error) => error instanceof BatonStartError && error.code === 'rename-failed',
    )
    assert.equal(state.get('t2').phase, PHASE.unsubmitted)
    assert.equal(state.get('t2').sessionId, 'session-1')
    const record = await starter.resume({ taskId: 't2', brief: 'b', verify: async () => { calls.verify++ } })
    assert.equal(record.phase, PHASE.submitted)
    assert.equal(calls.create, 1, 'resume must reuse the existing session')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('prompt failure without a not-enqueued proof needs review; proven failure is retryable', async () => {
  for (const [proven, expected] of [[true, PHASE.unsubmitted], [false, PHASE.needsReview]]) {
    const { dir, state, adapter } = await setup({
      async prompt() { throw Object.assign(new Error('prompt boom'), { code: 'X' }) },
    })
    try {
      const starter = createStarter({ adapter, state, isDefinitelyNotEnqueued: (error) => proven && error.code === 'X' })
      await assert.rejects(
        starter.start({ taskId: `t-${proven}`, room: 'ABC123', title: 't', brief: 'b', cwd: '/tmp', respond: async () => {} }),
        (error) => error instanceof BatonStartError,
      )
      assert.equal(state.get(`t-${proven}`).phase, expected)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test('needs-review blocks a silent retry and offers an explicit handled path', async () => {
  const { dir, state, adapter } = await setup({ async prompt() { throw new Error('unknown outcome') } })
  try {
    const starter = createStarter({ adapter, state })
    await assert.rejects(
      starter.start({ taskId: 't3', room: 'ABC123', title: 't', brief: 'b', cwd: '/tmp', respond: async () => {} }),
      (error) => error.code === 'submit-unknown',
    )
    await assert.rejects(starter.resume({ taskId: 't3', brief: 'b', verify: async () => {} }), (error) => error.code === 'not-resumable')
    const handled = await starter.markHandled('t3')
    assert.equal(handled.phase, PHASE.handled)
    await assert.rejects(
      starter.start({ taskId: 't3', room: 'ABC123', title: 't', brief: 'b', cwd: '/tmp', respond: async () => {} }),
      (error) => error.code === 'already-submitted',
    )
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a corrupt state file stops startup instead of resetting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-session-'))
  try {
    const path = join(dir, 'state.json')
    await writeFile(path, '{not json', { mode: 0o600 })
    const state = new LocalState(path)
    await assert.rejects(state.load(), (error) => error.code === 'state-corrupt')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('concurrent acceptance of one task cannot enqueue a second prompt', async () => {
  let releasePrompt
  let notifyPrompt
  const entered = new Promise(resolve => { notifyPrompt = resolve })
  const blocked = new Promise(resolve => { releasePrompt = resolve })
  const { dir, state, adapter, calls } = await setup({
    async prompt() { calls.prompt++; if (calls.prompt === 1) { notifyPrompt(); await blocked } },
  })
  const starter = createStarter({ adapter, state })
  const task = { taskId: 'same', room: 'ABCD23', title: 't', brief: 'b', cwd: '/tmp', respond: async () => {} }
  const first = starter.start(task)
  try {
    await entered
    await assert.rejects(starter.start(task), error => error.code === 'start-in-progress')
    assert.equal(calls.prompt, 1)
  } finally {
    releasePrompt()
    await first
    await rm(dir, { recursive: true, force: true })
  }
})

test('different tasks can checkpoint concurrently without losing records', async () => {
  const { dir, state } = await setup()
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => state.put({ taskId: `task-${index}`, phase: PHASE.unsubmitted })))
    const disk = JSON.parse(await readFile(state.path, 'utf8'))
    assert.equal(Object.keys(disk.tasks).length, 12)
    assert.equal(Object.keys(state.data.tasks).length, 12)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a failed checkpoint does not publish an uncommitted phase in memory', async () => {
  const { dir, state } = await setup()
  try {
    await mkdir(state.path)
    await assert.rejects(state.put({ taskId: 'failed', phase: PHASE.submitting }))
    assert.equal(state.get('failed'), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('restart converts unfinished creation and submission to a durable review state', async () => {
  const { dir, state } = await setup()
  try {
    for (const phase of [PHASE.creating, PHASE.submitting]) {
      const sessionId = phase === PHASE.submitting ? 'existing-session' : undefined
      await state.put({ taskId: 'interrupted', phase, sessionId })
      const recovered = new LocalState(state.path)
      await recovered.load()
      assert.equal(recovered.get('interrupted').phase, PHASE.needsReview)
      assert.equal(recovered.get('interrupted').sessionId, sessionId)
      assert.equal(JSON.parse(await readFile(state.path, 'utf8')).tasks.interrupted.phase, PHASE.needsReview)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an uncertain create result requires review instead of creating another session', async () => {
  const { dir, state, adapter, calls } = await setup({ async create() { calls.create++; throw new Error('create response lost') } })
  try {
    const starter = createStarter({ adapter, state })
    const task = { taskId: 'create-unknown', room: 'ABCD23', title: 't', brief: 'b', cwd: '/tmp', respond: async () => {} }
    await assert.rejects(starter.start(task))
    assert.equal(state.get(task.taskId).phase, PHASE.needsReview)
    await assert.rejects(starter.start(task), error => error.code === 'needs-review')
    assert.equal(calls.create, 1)
    assert.equal(calls.prompt, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a failed final checkpoint is reviewable and never permits another prompt', async () => {
  const { dir, state, adapter, calls } = await setup()
  const save = state.save.bind(state)
  let failFinal = true
  state.save = async next => {
    if (failFinal && next.tasks.final?.phase === PHASE.submitted) { failFinal = false; throw new Error('disk unavailable') }
    return save(next)
  }
  try {
    const starter = createStarter({ adapter, state })
    const task = { taskId: 'final', room: 'ABCD23', title: 't', brief: 'b', cwd: '/tmp', respond: async () => {} }
    await assert.rejects(starter.start(task))
    assert.equal(state.get('final').phase, PHASE.needsReview)
    await assert.rejects(starter.start(task))
    assert.equal(calls.prompt, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a renewed approval before creation uses the newly confirmed cwd', async () => {
  let used
  const { dir, state, adapter } = await setup({ async ensureWorkspace(cwd) { used = cwd; return 'workspace' } })
  try {
    await state.put({ taskId: 'renew', room: 'ABCD23', title: 't', cwd: '/previous', phase: PHASE.unsubmitted })
    const starter = createStarter({ adapter, state })
    await starter.start({ taskId: 'renew', room: 'ABCD23', title: 't', brief: 'b', cwd: '/confirmed', respond: async () => {} })
    assert.equal(used, '/confirmed')
    assert.equal(state.get('renew').cwd, '/confirmed')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('losing the session-id checkpoint cannot permit a second creation', async () => {
  const { dir, state, adapter, calls } = await setup()
  const save = state.save.bind(state)
  let failId = true
  state.save = async next => {
    if (failId && next.tasks.creation?.sessionId && next.tasks.creation.phase === PHASE.unsubmitted) { failId = false; throw new Error('id checkpoint failed') }
    return save(next)
  }
  try {
    const starter = createStarter({ adapter, state })
    const task = { taskId: 'creation', room: 'ABCD23', title: 't', brief: 'b', cwd: '/tmp', respond: async () => {} }
    await assert.rejects(starter.start(task))
    assert.equal(state.get(task.taskId).phase, PHASE.needsReview)
    await assert.rejects(starter.start(task))
    assert.equal(calls.create, 1)
    assert.equal(calls.prompt, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
