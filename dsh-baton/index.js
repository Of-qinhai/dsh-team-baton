/**
 * Host half of Baton: one WebSocket to baton-server, the agent tools, and the
 * authenticated route the panel uses. Session creation lives in session.js so
 * the start state machine stays testable without DSH.
 */
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { BatonConnection, readSecret, validateServerUrl } from './connection.js'
import { BatonStartError, LocalState, PHASE, createStarter } from './session.js'

export const name = 'baton'
export const inject = ['tools', 'sessionController', 'workspaceRegistry', 'connection']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEND_FIELDS = ['room', 'to', 'env', 'title', 'brief']
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function text(value) {
  return [{ type: 'text', text: value }]
}

async function loadIdentity(base) {
  await mkdir(base, { recursive: true, mode: 0o700 })
  const path = join(base, 'identity.json')
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (!UUID.test(parsed?.userId)) throw new Error('invalid installation identity')
    return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`identity file is unreadable: ${error.message}`)
  }
  const identity = { userId: randomUUID() }
  await writeFile(path, JSON.stringify(identity), { mode: 0o600 })
  return identity
}

function normalizeConfig(config) {
  const environments = Array.isArray(config?.environments) ? config.environments : []
  const keys = new Set()
  for (const entry of environments) {
    if (typeof entry?.key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.key)) throw new Error(`invalid environment key: ${entry?.key}`)
    if (keys.has(entry.key)) throw new Error(`duplicate environment key: ${entry.key}`)
    keys.add(entry.key)
    if (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd)) throw new Error(`environment ${entry.key} needs an absolute cwd`)
  }
  const displayName = config?.displayName?.trim() || (userInfo().username || '未命名').slice(0, 40)
  if (Array.from(displayName).length > 40) throw new Error('displayName must be 1–40 characters')
  return {
    serverUrl: config?.serverUrl,
    secretEnv: config?.secretEnv ?? 'BATON_SECRET',
    secretFile: config?.secretFile,
    displayName,
    environments,
  }
}

export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const base = process.env.BATON_HOME ?? join(homedir(), '.dsh', 'baton')
  const identity = await loadIdentity(base)
  const state = new LocalState(join(base, 'state.json'))
  await state.load()

  let snapshot = { rooms: [], tasks: [] }
  let status = { state: cfg.serverUrl ? 'idle' : 'unconfigured' }
  let connection
  let disposed = false
  let preparingSend = Promise.resolve()
  const details = new Map()

  const adapter = {
    workspaces: new Map(),
    async ensureWorkspace(cwd) {
      const workspace = await ctx.workspaceRegistry.create(cwd, 'Baton')
      this.workspaces.set(workspace.id, workspace)
      return workspace.id
    },
    async create({ workspaceId }) {
      const created = await ctx.sessionController.create({ workspaceId })
      const workspace = this.workspaces.get(workspaceId)
      if (workspace && !workspace.sessionIds.includes(created.sessionId)) await workspace.attachSession(created.sessionId)
      return { sessionId: created.sessionId }
    },
    rename({ sessionId, title }) {
      return ctx.sessionController.rename({ sessionId, title })
    },
    prompt({ sessionId, text: content }) {
      return ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: content }],
      }, new AbortController().signal)
    },
  }
  const starter = createStarter({ adapter, state })

  const normalizeCode = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '')

  function environmentCwd(key) {
    const entry = cfg.environments.find((item) => item.key === key)
    if (!entry) return undefined
    return entry.cwd
  }

  async function canonicalDirectory(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new BatonStartError('invalid-cwd', '请为该环境配置绝对路径。')
    try {
      const canonical = await realpath(path)
      if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory')
      await access(canonical, constants.R_OK | constants.X_OK)
      return canonical
    } catch { throw new BatonStartError('invalid-cwd', '执行目录不存在或不可访问，请先修正环境配置。') }
  }

  function requireConnection() {
    if (!connection) throw new BatonStartError('unconfigured', 'Baton 尚未配置 serverUrl')
    if (!connection.authenticated) throw new BatonStartError('connection-closed', '接力服务暂未连接，请连接后重试。')
    return connection
  }

  function requireRecipient(task) {
    if (task.to.userId !== identity.userId) throw new BatonStartError('forbidden', '只有收件人可以处理这条任务。')
  }

  async function sendTask(input) {
    const client = requireConnection()
    const payload = Object.fromEntries(SEND_FIELDS.map(field => [field, input[field]]))
    payload.room = normalizeCode(payload.room)
    if (!UUID.test(payload.to) || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.env ?? '') || typeof payload.title !== 'string' || Array.from(payload.title).length < 1 || Array.from(payload.title).length > 120 || typeof payload.brief !== 'string' || !payload.brief || Buffer.byteLength(payload.brief) > 8192) {
      throw new BatonStartError('invalid_request', '请检查收件人、环境、标题及任务说明。')
    }
    if (input.taskId !== undefined && !UUID.test(input.taskId)) throw new BatonStartError('invalid_request', '任务标识无效。')
    let request
    const preparation = preparingSend.then(async () => {
      const original = input.taskId ? state.data.sends[input.taskId] : Object.values(state.data.sends).find(item => item.status === 'unconfirmed' && item.expiresAt > Date.now() && !snapshot.tasks.some(task => task.taskId === item.taskId && task.from.userId === identity.userId) && SEND_FIELDS.every(field => item[field] === payload[field]))
      if (original && !SEND_FIELDS.every(field => original[field] === payload[field])) throw new BatonStartError('conflict', '请先确认原投递结果，再创建新的任务。')
      if (original && original.expiresAt <= Date.now()) throw new BatonStartError('not_found', '这次投递已过期，请新建任务。')
      request = original ?? { ...payload, taskId: input.taskId ?? randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + RETENTION_MS, status: 'unconfirmed' }
      await state.update(data => ({ ...data, sends: { ...data.sends, [request.taskId]: request } }))
    })
    preparingSend = preparation.catch(() => {})
    await preparation
    let result
    try {
      result = await client.taskSend(Object.fromEntries(['taskId', ...SEND_FIELDS].map(field => [field, request[field]])))
    } catch (error) {
      error.taskId = request.taskId
      // A later rejection cannot disprove an earlier commit whose response was lost.
      throw error
    }
    try {
      await state.update(data => ({ ...data, sends: { ...data.sends, [request.taskId]: { ...request, status: 'saved' } } }))
    } catch {
      const error = new BatonStartError('internal', '任务已送出，但本地确认保存失败。重试会使用同一个任务标识。')
      error.taskId = request.taskId
      throw error
    }
    return result
  }

  function localRecords() {
    const records = { ...state.data.tasks }
    for (const [id, record] of Object.entries(records)) {
      if ([PHASE.creating, PHASE.submitting].includes(record.phase) && !starter.isActive(id)) records[id] = { ...record, phase: PHASE.needsReview, error: '本地记录保存失败，请先核对会话和消息。' }
    }
    for (const task of snapshot.tasks) {
      if (task.to.userId === identity.userId && task.status === 'accepted' && !records[task.taskId]) {
        records[task.taskId] = { taskId: task.taskId, phase: PHASE.needsReview, error: '本机没有这次启动的记录，请先在 DSH 中核对后自行处理。' }
      }
    }
    return records
  }

  function panelSnapshot() {
    return {
      ok: true, userId: identity.userId, displayName: cfg.displayName, connection: status,
      rooms: snapshot.rooms, tasks: snapshot.tasks, local: localRecords(),
      outbox: Object.values(state.data.sends).filter(item => item.status === 'unconfirmed' && item.expiresAt > Date.now() && !snapshot.tasks.some(task => task.taskId === item.taskId)),
      environments: cfg.environments.map(({ key, label }) => ({ key, label: label ?? key })),
    }
  }

  async function connect() {
    if (!cfg.serverUrl || connection) return
    const { secret } = await readSecret({ envName: cfg.secretEnv, filePath: cfg.secretFile })
    if (disposed) return
    validateServerUrl(cfg.serverUrl)
    connection = new BatonConnection({
      serverUrl: cfg.serverUrl,
      secret,
      userId: identity.userId,
      displayName: cfg.displayName,
      onSnapshot: (next) => {
        snapshot = next
        const active = new Set(next.tasks.map(task => task.taskId))
        for (const id of details.keys()) if (!active.has(id)) details.delete(id)
        const confirmed = new Set(next.tasks.filter(task => task.from.userId === identity.userId).map(task => task.taskId))
        if (Object.values(state.data.sends).some(item => item.status === 'unconfirmed' && confirmed.has(item.taskId))) {
          preparingSend = preparingSend.then(() => state.update(data => ({
            ...data,
            sends: Object.fromEntries(Object.entries(data.sends).map(([id, item]) => [id, confirmed.has(id) ? { ...item, status: 'saved' } : item])),
          }))).catch(() => {}) // The snapshot still prevents reuse if the checkpoint fails.
        }
        return preparingSend
      },
      onStatus: (next) => { status = next },
    })
    connection.start()
  }

  ctx.effect(() => {
    connect().catch((error) => { status = { state: 'fatal', detail: error.message } })
    return () => { disposed = true; connection?.stop() }
  }, 'baton: connection')

  function toolError(error) {
    return JSON.stringify({ ok: false, code: error.code ?? 'internal', ...(error.taskId ? { taskId: error.taskId } : {}), error: '接力操作未完成，请在面板检查连接或投递状态；重试请复用 taskId。' })
  }

  ctx.effect(() => ctx.tools.register({
    name: 'team_rooms',
    description: 'List Baton rooms this install belongs to. Returns room codes, owner ids, member ids, and online flags; names stay in the panel.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      try {
        await requireConnection()
        const rooms = snapshot.rooms.map((room) => ({
          code: room.code,
          ownerId: room.ownerId,
          members: room.members.map((member) => ({ userId: member.userId, online: Boolean(member.online) })),
        }))
        return JSON.stringify({ ok: true, rooms }, null, 2)
      } catch (error) {
        return toolError(error)
      }
    },
  }), 'baton: rooms tool')

  ctx.effect(() => ctx.tools.register({
    name: 'team_task_send',
    description: 'Send one Baton task to one member of a room. Use a userId from team_rooms; the panel selects people by name. Returns only taskId and status.',
    parameters: {
      taskId: { type: 'string', description: 'For retrying an uncertain send, reuse the taskId returned with the error; omit for a new task.' },
      room: { type: 'string', required: true, description: 'Room code.' },
      to: { type: 'string', required: true, description: 'Recipient userId.' },
      env: { type: 'string', required: true, description: 'Environment key as configured by the recipient.' },
      title: { type: 'string', required: true, description: 'Short task title, at most 120 characters.' },
      brief: { type: 'string', required: true, description: 'Task brief, at most 8 KiB UTF-8.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const result = await sendTask(args)
        return JSON.stringify({ ok: true, taskId: result.task.taskId, status: result.task.status }, null, 2)
      } catch (error) {
        return toolError(error)
      }
    },
  }), 'baton: send tool')

  ctx.effect(() => ctx.tools.register({
    name: 'team_tasks',
    description: 'List Baton tasks related to this install with ids and status only. Remote titles, briefs, display names, and room names never enter the current agent context.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      try {
        await requireConnection()
        const tasks = snapshot.tasks.map((task) => ({
          taskId: task.taskId,
          status: task.status,
          fromUserId: task.from.userId,
          direction: task.to.userId === identity.userId ? 'incoming' : 'outgoing',
        }))
        return JSON.stringify({ ok: true, tasks }, null, 2)
      } catch (error) {
        return toolError(error)
      }
    },
  }), 'baton: tasks tool')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/baton',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await request.json()
        const action = body?.action
        if (action === 'snapshot') return json(panelSnapshot())
        if (action === 'session') {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (!sessionId) return json({ ok: false, error: 'sessionId is required' }, 400)
          const persistence = ctx.get('sessionPersistence')
          const stored = persistence ? await persistence.stat(sessionId) : undefined
          let exists = Boolean(stored)
          if (exists) {
            try {
              const list = await ctx.sessionController.list({}, new AbortController().signal)
              exists = list.items.some(item => item.sessionId === sessionId)
            } catch {}
          }
          return json({ ok: true, exists })
        }
        if (action === 'counts') {
          const records = localRecords()
          const mine = snapshot.tasks.filter(task => task.to.userId === identity.userId)
          const attention = mine.filter(task => task.status === 'pending' || (task.status === 'accepted' && ['unsubmitted', 'needs-review'].includes(records[task.taskId]?.phase ?? 'needs-review'))).length
          return json({ ok: true, attention, pending: mine.filter(task => task.status === 'pending').length })
        }
        const client = requireConnection()
        if (action === 'create') return json({ ok: true, ...(await client.roomCreate(body.name)) })
        if (action === 'join') return json({ ok: true, ...(await client.roomJoin(normalizeCode(body.code))) })
        if (action === 'leave') return json({ ok: true, ...(await client.roomLeave(normalizeCode(body.code))) })
        if (action === 'disband') return json({ ok: true, ...(await client.roomDisband(normalizeCode(body.code))) })
        if (action === 'send') {
          const result = await sendTask(body)
          return json({ ok: true, task: result.task })
        }
        if (action === 'retry-send') {
          const saved = state.data.sends[body.taskId]
          if (!saved) throw new BatonStartError('not_found', '没有找到这次投递记录。')
          return json({ ok: true, ...(await sendTask(saved)) })
        }
        if (action === 'detail') {
          const task = snapshot.tasks.find(item => item.taskId === body.taskId)
          let result = task && details.has(body.taskId) && task.expiresAt > Date.now() ? { task, brief: details.get(body.taskId) } : await client.taskGet(body.taskId)
          details.set(body.taskId, result.brief)
          let record = localRecords()[body.taskId]
          let cwd = null
          let cwdError = null
          if (result.task.to.userId === identity.userId) {
            try { cwd = await canonicalDirectory(record?.cwd && result.task.status === 'accepted' ? record.cwd : environmentCwd(result.task.env)) } catch (error) {
              cwdError = error.message
              if (result.task.status === 'accepted' && record?.phase === PHASE.unsubmitted) {
                await state.update(data => {
                  const current = data.tasks[body.taskId]
                  // A slow detail request must never overwrite an active start.
                  if (current?.phase !== PHASE.unsubmitted || starter.isActive(body.taskId)) return data
                  return { ...data, tasks: { ...data.tasks, [body.taskId]: { ...current, phase: PHASE.needsReview, error: '原执行目录无法确认，请先在 DSH 核对并自行处理。' } } }
                })
                record = localRecords()[body.taskId]
              }
            }
          }
          return json({ ok: true, task: result.task, brief: result.brief, local: record, cwd, cwdError })
        }
        if (action === 'decline') {
          const result = await client.taskRespond(body.taskId, 'declined')
          return json({ ok: true, task: result.task })
        }
        if (action === 'accept') {
          const result = await client.taskGet(body.taskId)
          const task = result.task
          requireRecipient(task)
          if (task.status === 'declined') throw new BatonStartError('conflict', '这条任务已经拒绝。')
          if (task.status === 'accepted' && !state.get(task.taskId)) throw new BatonStartError('needs-review', '任务已接受但缺少本地记录，请先核对。')
          const cwd = await canonicalDirectory(environmentCwd(task.env))
          if (body.cwd !== cwd) throw new BatonStartError('cwd-changed', '执行目录已变化，请重新查看并确认目录后再接受。')
          const record = await starter.start({
            taskId: task.taskId,
            room: task.room,
            title: task.title,
            brief: result.brief,
            cwd,
            respond: () => client.taskRespond(task.taskId, 'accepted'),
          })
          return json({ ok: true, record, sessionId: record.sessionId })
        }
        if (action === 'resume') {
          const record = state.get(body.taskId)
          if (!record) return json({ ok: false, error: 'no local record' }, 404)
          const result = await client.taskGet(record.taskId)
          requireRecipient(result.task)
          if (result.task.status !== 'accepted') throw new BatonStartError('conflict', '任务尚未被接受。')
          const resumed = await starter.resume({
            taskId: record.taskId,
            brief: result.brief,
            verify: async existing => {
              let actual
              try { actual = await canonicalDirectory(existing.cwd) } catch (error) {
                if (error.code !== 'invalid-cwd') throw error
              }
              if (!actual || actual !== existing.cwd) {
                await state.put({ ...existing, phase: PHASE.needsReview, error: '原执行目录无法确认，请先在 DSH 核对并自行处理。' })
                throw new BatonStartError('needs-review', '原执行目录无法确认，请先在 DSH 核对并自行处理。')
              }
              if (body.cwd !== actual) throw new BatonStartError('cwd-changed', '请先查看并确认已有会话的执行目录。')
            },
          })
          return json({ ok: true, record: resumed })
        }
        if (action === 'handled') {
          if (body.confirmed !== true) throw new BatonStartError('invalid_request', '请确认已经核对并自行处理这条任务。')
          const result = await client.taskGet(body.taskId)
          requireRecipient(result.task)
          if (result.task.status !== 'accepted') throw new BatonStartError('conflict', '任务尚未被接受。')
          if (!state.get(body.taskId)) await state.put({ taskId: body.taskId, phase: PHASE.needsReview })
          return json({ ok: true, record: await starter.markHandled(body.taskId) })
        }
        return json({ ok: false, error: 'unknown action' }, 400)
      } catch (error) {
        const code = error.code ?? 'internal'
        const statusCode = ['connection-closed', 'unconfigured'].includes(code) ? 503
          : ['cwd-changed', 'conflict', 'needs-review', 'start-in-progress', 'already-submitted', 'not-resumable', 'not-reviewable'].includes(code) ? 409
            : code === 'not_found' ? 404 : code === 'forbidden' ? 403 : ['invalid_request', 'invalid-cwd'].includes(code) ? 400 : 500
        return json({ ok: false, code, error: error.message, ...(error.taskId ? { taskId: error.taskId } : {}) }, statusCode)
      }
    },
  }), 'baton: panel route')
}
