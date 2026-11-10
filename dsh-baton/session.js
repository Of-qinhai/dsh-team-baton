/**
 * Local start state machine for an accepted Baton task.
 *
 * The server's `accepted` only means the recipient agreed to take the task.
 * Turning that into a Session is a multi-step local operation, and every step
 * can die between "recorded" and "done". This module is the single place that
 * orders those steps and records where they stopped.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export const PHASE = Object.freeze({
  unsubmitted: 'unsubmitted',
  creating: 'creating',
  submitting: 'submitting',
  submitted: 'submitted',
  needsReview: 'needs-review',
  handled: 'handled',
})

export class BatonStartError extends Error {
  constructor(code, message, record) {
    super(message)
    this.name = 'BatonStartError'
    this.code = code
    this.record = record
  }
}

/** Atomic, 0600 JSON state file. A corrupt file stops startup instead of resetting. */
export class LocalState {
  constructor(path) {
    this.path = path
    this.data = { version: 1, tasks: {}, sends: {} }
    this.writing = Promise.resolve()
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed?.version !== 1 || typeof parsed.tasks !== 'object' || parsed.tasks === null || Array.isArray(parsed.tasks)) {
        throw new Error('unsupported local state format')
      }
      if (parsed.sends !== undefined && (typeof parsed.sends !== 'object' || parsed.sends === null || Array.isArray(parsed.sends))) {
        throw new Error('unsupported outgoing state format')
      }
      for (const [taskId, record] of Object.entries(parsed.tasks)) {
        if (record?.taskId !== taskId || !Object.values(PHASE).includes(record.phase)) throw new Error('invalid task checkpoint')
      }
      this.data = { ...parsed, sends: parsed.sends ?? {} }
      if (Object.values(parsed.tasks).some(record => [PHASE.creating, PHASE.submitting].includes(record.phase))) {
        await this.update(data => ({
          ...data,
          tasks: Object.fromEntries(Object.entries(data.tasks).map(([id, record]) => [id, [PHASE.creating, PHASE.submitting].includes(record.phase)
            ? { ...record, phase: PHASE.needsReview, error: '上次启动被中断，请先在 DSH 中核对会话及消息。' }
            : record])),
        }))
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw new BatonStartError('state-corrupt', '本地启动记录无法读取，已停止启动以避免重复执行。请检查记录文件和权限。', undefined)
    }
  }

  get(taskId) {
    return this.data.tasks[taskId]
  }

  put(record) {
    return this.update(data => ({ ...data, tasks: { ...data.tasks, [record.taskId]: { ...record } } }))
  }

  /** Serialize checkpoints and publish memory only after the atomic disk commit. */
  update(change) {
    const operation = this.writing.then(async () => {
      const next = change(this.data)
      await this.save(next)
      this.data = next
    })
    this.writing = operation.catch(() => {})
    return operation
  }

  /** Unique temporary files also isolate interrupted writes from the next process. */
  async save(next) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(next, null, 2))
        await file.sync()
      } finally { await file.close() }
      await rename(temporary, this.path)
    } finally { await rm(temporary, { force: true }) }
  }
}

/**
 * @param {object} deps
 * @param {object} deps.adapter - create/rename/prompt/ensureWorkspace, already bound to DSH.
 * @param {LocalState} deps.state
 * @param {(error: unknown) => boolean} [deps.isDefinitelyNotEnqueued]
 */
export function createStarter({ adapter, state, isDefinitelyNotEnqueued = () => false }) {
  const active = new Set()
  async function locked(taskId, action) {
    if (active.has(taskId)) throw new BatonStartError('start-in-progress', '这条任务正在处理，请勿重复操作。', state.get(taskId))
    active.add(taskId)
    try { return await action() } finally { active.delete(taskId) }
  }

  async function saveRecord(record) {
    await state.put(record)
    return record
  }

  /** Create (or reuse) the Session, name it, and keep the record honest at every step. */
  async function prepareSession(record, { title }) {
    let sessionId = record.sessionId
    if (!sessionId) {
      const workspaceId = await adapter.ensureWorkspace(record.cwd)
      record = await saveRecord({ ...record, phase: PHASE.creating })
      let created
      try {
        created = await adapter.create({ workspaceId })
        sessionId = created.sessionId
        record = await saveRecord({ ...record, sessionId, phase: PHASE.unsubmitted })
      } catch (error) {
        const review = { ...record, ...(created?.sessionId ? { sessionId: created.sessionId } : {}), phase: PHASE.needsReview, error: '会话创建结果不明，请先在 DSH 会话列表中核对。' }
        try { await saveRecord(review) } catch {
          // The earlier creating checkpoint still blocks another creation after restart.
        }
        throw new BatonStartError('create-unknown', review.error, review)
      }
    }
    try {
      await adapter.rename({ sessionId, title })
    } catch (error) {
      record = await saveRecord({ ...record, phase: PHASE.unsubmitted, error: '会话已创建，但标题设置未完成，尚未提交消息。' })
      throw new BatonStartError('rename-failed', '会话已保留，标题设置暂未完成。重试会沿用同一会话。', record)
    }
    return { record, sessionId }
  }

  async function submit(record, sessionId, brief) {
    record = await saveRecord({ ...record, phase: PHASE.submitting, error: undefined })
    let promptSucceeded = false
    try {
      await adapter.prompt({ sessionId, text: brief })
      promptSucceeded = true
      return await saveRecord({ ...record, phase: PHASE.submitted, error: undefined })
    } catch (error) {
      // Only a failure the adapter can prove "not enqueued" may be retried.
      const phase = !promptSucceeded && isDefinitelyNotEnqueued(error) ? PHASE.unsubmitted : PHASE.needsReview
      record = await saveRecord({ ...record, phase, error: error.message })
      throw new BatonStartError(phase === PHASE.unsubmitted ? 'submit-retryable' : 'submit-unknown', error.message, record)
    }
  }

  return {
    isActive(taskId) { return active.has(taskId) },
    /** First start after the server accepted the task. */
    async start({ taskId, room, title, brief, cwd, respond }) {
      return locked(taskId, async () => {
        const existing = state.get(taskId)
        if (existing?.phase === PHASE.submitted || existing?.phase === PHASE.handled) {
          throw new BatonStartError('already-submitted', '这条任务已提交或已自行处理，不会再次启动。', existing)
        }
        if ([PHASE.needsReview, PHASE.creating, PHASE.submitting].includes(existing?.phase)) {
          throw new BatonStartError('needs-review', '上次启动结果不明，请先在 DSH 中核对。', existing)
        }

        let record = existing ?? await saveRecord({
          taskId,
          room,
          title,
          cwd,
          phase: PHASE.unsubmitted,
          sessionId: undefined,
          startedAt: Date.now(),
        })

        if (record.cwd !== cwd) {
          if (record.sessionId) throw new BatonStartError('cwd-changed', '已有会话必须沿用原执行目录。', record)
          record = await saveRecord({ ...record, cwd })
        }

        await respond()
        const prepared = await prepareSession(record, { title: `[${room}] ${title}` })
        return submit(prepared.record, prepared.sessionId, brief)
      })
    },

    /** Continue an accepted task whose local phase is still `unsubmitted`. */
    async resume({ taskId, brief, verify }) {
      return locked(taskId, async () => {
        const existing = state.get(taskId)
        if (!existing) throw new BatonStartError('missing-record', '没有找到本地启动记录，请先在 DSH 中核对。', undefined)
        if (existing.phase !== PHASE.unsubmitted) {
          throw new BatonStartError('not-resumable', '这条任务当前不能继续启动，请先查看并核对状态。', existing)
        }
        await verify(existing)
        const prepared = await prepareSession(existing, { title: `[${existing.room}] ${existing.title}` })
        return submit(prepared.record, prepared.sessionId, brief)
      })
    },

    /** The user confirmed they handled an unknown outcome outside the plugin. */
    async markHandled(taskId) {
      return locked(taskId, async () => {
        const existing = state.get(taskId)
        if (!existing) throw new BatonStartError('missing-record', '没有找到本地启动记录，请先在 DSH 中核对。', undefined)
        if (![PHASE.needsReview, PHASE.creating, PHASE.submitting].includes(existing.phase)) throw new BatonStartError('not-reviewable', '这条任务不需要人工核对。', existing)
        return saveRecord({ ...existing, phase: PHASE.handled, error: undefined })
      })
    },
  }
}
