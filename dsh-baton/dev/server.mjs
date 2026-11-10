/** Standalone visual preview. Its API uses fixtures and never connects to DSH or Baton. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

async function compile() {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./bootstrap.jsx', import.meta.url))], bundle: true, write: false, format: 'esm', target: 'es2022', jsx: 'automatic', sourcemap: 'inline' })
  return result.outputFiles[0].text
}
const now = Date.now()
const me = { userId: '11111111-1111-4111-8111-111111111111', displayName: '海钦', online: true }
const lin = { userId: '22222222-2222-4222-8222-222222222222', displayName: '林予安', online: true }
const chen = { userId: '33333333-3333-4333-8333-333333333333', displayName: '陈知行', online: true }
const xu = { userId: '44444444-4444-4444-8444-444444444444', displayName: '许棠', online: false }
const task = (id, title, from, to, env, status, minutes) => ({ taskId: '00000000-0000-4000-8000-' + String(id).padStart(12, '0'), room: 'GREEN8', title, from, to, env, status, createdAt: now - minutes * 60_000, expiresAt: now + 6 * 86_400_000 })
const state = {
  ok: true, userId: me.userId, displayName: me.displayName, connection: { state: 'online' },
  rooms: [
    { code: 'GREEN8', name: '产品研发组', ownerId: me.userId, members: [me, lin, chen, xu] },
    { code: 'DESGN6', name: '体验与设计', ownerId: lin.userId, members: [me, lin, xu] },
    { code: 'STACK7', name: '基础设施', ownerId: chen.userId, members: [me, chen] },
  ],
  tasks: [
    task(1, '登录页接口联调与异常状态补齐', lin, me, 'frontend', 'pending', 8),
    task(2, '确认新版工作台的交互细节', xu, me, 'frontend', 'pending', 35),
    task(3, '整理 API 文档与错误码说明', chen, me, 'backend', 'pending', 72),
    task(4, '核对支付回调的重试逻辑', chen, me, 'backend', 'accepted', 160),
    task(5, '完善自动化部署检查清单', me, chen, 'backend', 'accepted', 45),
    task(6, '评审消息中心的设计方案', me, xu, 'design', 'pending', 130),
  ],
  local: {}, outbox: [], environments: [{ key: 'frontend', label: '前端工作区' }, { key: 'backend', label: '后端工作区' }],
}
state.local[state.tasks[3].taskId] = { taskId: state.tasks[3].taskId, phase: 'needs-review', sessionId: 'session-preview-existing', cwd: '/example/workspace/api' }
const initialState = structuredClone(state)
const brief = '请对接登录页的认证接口，并补齐关键异常状态。\n\n完成标准\n1. 登录成功后正确跳转至工作台。\n2. 密码错误、网络中断和会话过期都有明确提示。\n3. 提交前检查桌面和移动端布局。\n\n接口说明已放在项目 docs/auth.md，遇到字段不一致的地方请先记录，再和我确认。'
let directory = '/example/workspace/web'
const controls = { failNextSend: false, dropNextSend: false, nonJsonNextSend: false, changeNextCwd: false, requests: [] }

function send(response, data, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(data))
}
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/app.js') {
      const script = await compile()
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(script); return
    }
    if (request.method === 'GET' && request.url === '/__preview/state') return send(response, { ...state, controls })
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baton · 团队收件箱预览</title><style>*{box-sizing:border-box}body{margin:0;background:#f1f3f0;color:#34453b;font-family:"Avenir Next","PingFang SC",sans-serif}.preview-bar{height:54px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dfe5de;font-size:12px}.preview-bar small{font-size:9px;letter-spacing:2px;margin-left:10px;opacity:.45}.preview-bar button{border:1px solid #d8dfd7;border-radius:6px;background:transparent;color:inherit;margin-left:14px;padding:5px 9px;cursor:pointer}.preview-workbench{display:flex;height:calc(100vh - 54px)}.preview-workbench>aside{width:230px;padding:30px 24px;border-right:1px solid #dfe5de;font-size:12px}.preview-workbench>aside p{color:#8a978e;margin-top:24px}.preview-workbench>aside>button{position:absolute;bottom:25px}.preview-workbench>main{padding:85px 70px}.preview-workbench>main>span{font-size:11px;color:#829084}.preview-workbench h1{font-size:28px;font-weight:500;letter-spacing:-1px;margin-top:24px}.preview-workbench p{font-size:12px;color:#859187}.preview-lines{margin-top:70px;width:460px;display:grid;gap:16px}.preview-lines i{height:8px;border-radius:3px;background:#e6ebe4}.preview-lines i:nth-child(even){width:70%}.dark{--dsw-alias-bg-elevated:#202724;--dsw-alias-fg:#d8e3dc;color-scheme:dark}.dark body{background:#161d19;color:#d8e3dc}.dark .preview-bar,.dark .preview-workbench>aside{border-color:#344039}.dark .preview-lines i{background:#29352d}@media(max-width:650px){.preview-workbench>aside{width:130px;padding:20px 10px}.preview-workbench>main{padding:40px 20px}.preview-lines{width:150px}.preview-bar{padding:0 16px}.preview-bar small{display:none}}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
      return
    }
    const chunks = []
    let length = 0
    for await (const chunk of request) { length += chunk.length; if (length > 32768) throw new Error('preview request too large'); chunks.push(chunk) }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (request.url === '/__preview') {
      if (body.reset) {
        Object.assign(state, structuredClone(initialState))
        const elapsed = Date.now() - now
        for (const task of state.tasks) { task.createdAt += elapsed; task.expiresAt += elapsed }
        directory = '/example/workspace/web'
        Object.assign(controls, { failNextSend: false, dropNextSend: false, nonJsonNextSend: false, changeNextCwd: false, requests: [] })
      }
      if (body.connection) state.connection.state = body.connection
      if (body.failNextSend !== undefined) controls.failNextSend = body.failNextSend
      if (body.dropNextSend !== undefined) controls.dropNextSend = body.dropNextSend
      if (body.nonJsonNextSend !== undefined) controls.nonJsonNextSend = body.nonJsonNextSend
      if (body.changeNextCwd !== undefined) controls.changeNextCwd = body.changeNextCwd
      return send(response, { ok: true })
    }
    if (request.url !== '/api/baton') return send(response, { ok: false }, 404)
    if (body.action === 'snapshot') return send(response, state)
    if (body.action === 'counts') {
      const records = state.local ?? {}
      const mine = state.tasks.filter(task => task.to.userId === state.userId)
      return send(response, {
        ok: true,
        attention: mine.filter(task => task.status === 'pending' || (task.status === 'accepted' && ['unsubmitted', 'needs-review'].includes(records[task.taskId]?.phase ?? 'needs-review'))).length,
        pending: mine.filter(task => task.status === 'pending').length,
      })
    }
    if (state.connection.state !== 'online') return send(response, { ok: false, code: 'connection-closed', error: '接力服务暂未连接，请连接后重试。' }, 503)
    const current = state.tasks.find(item => item.taskId === body.taskId)
    if (body.action === 'detail') return send(response, { ok: true, task: current, brief, cwd: current?.env === 'backend' ? '/example/workspace/api' : directory, local: state.local[body.taskId] })
    if (body.action === 'accept' || body.action === 'resume') {
      if (controls.changeNextCwd) { controls.changeNextCwd = false; directory = '/example/workspace/new-web'; return send(response, { ok: false, code: 'cwd-changed', error: '执行目录已变化，请重新查看并确认目录后再接受。' }, 409) }
      current.status = 'accepted'
      const record = { taskId: body.taskId, phase: 'submitted', sessionId: 'session-preview-' + randomUUID(), cwd: body.cwd }
      state.local[body.taskId] = record
      return send(response, { ok: true, record })
    }
    if (body.action === 'decline') { current.status = 'declined'; return send(response, { ok: true, task: current }) }
    if (body.action === 'handled') { state.local[body.taskId] = { ...state.local[body.taskId], phase: 'handled' }; return send(response, { ok: true, record: state.local[body.taskId] }) }
    if (body.action === 'send' || body.action === 'retry-send') {
      const payload = body.action === 'retry-send' ? state.outbox.find(item => item.taskId === body.taskId) : body
      controls.requests.push({ ...payload })
      if (controls.dropNextSend) { controls.dropNextSend = false; state.outbox.push({ ...payload }); request.socket.destroy(); return }
      if (controls.nonJsonNextSend) { controls.nonJsonNextSend = false; state.outbox.push({ ...payload }); response.writeHead(502, { 'content-type': 'text/plain' }); response.end('Fixture: unknown result'); return }
      if (controls.failNextSend) { controls.failNextSend = false; state.outbox.push({ ...payload }); return send(response, { ok: false, taskId: payload.taskId, code: 'timeout', error: '投递结果暂未确认，任务内容已保留。' }, 503) }
      const result = { ...task(9, payload.title, me, state.rooms.flatMap(item => item.members).find(member => member.userId === payload.to), payload.env, 'pending', 0), taskId: payload.taskId, room: payload.room }
      if (!state.tasks.some(item => item.taskId === payload.taskId)) state.tasks.push(result)
      state.outbox = state.outbox.filter(item => item.taskId !== payload.taskId)
      return send(response, { ok: true, task: result })
    }
    if (body.action === 'create' || body.action === 'join') {
      const code = body.action === 'join' ? body.code : 'NEW' + String(state.rooms.length).padStart(3, '2')
      state.rooms.push({ code, name: body.name ?? '新协作房间', ownerId: me.userId, members: [me, lin] })
      return send(response, { ok: true, code })
    }
    if (body.action === 'leave' || body.action === 'disband') { state.rooms = state.rooms.filter(item => item.code !== body.code); return send(response, { ok: true }) }
    return send(response, { ok: false, error: '未知预览操作。' }, 400)
  } catch (error) { send(response, { ok: false, error: error.message }, 500) }
})
const port = Number(process.env.PORT ?? 4371)
server.listen(port, '127.0.0.1', () => console.log('Baton preview: http://127.0.0.1:' + port))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
