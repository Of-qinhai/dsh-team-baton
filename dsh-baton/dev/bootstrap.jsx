import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

const slots = new Map()
const cleanups = []
const services = new Map([['uiWorkspace', {
  openSession(sessionId) {
    window.dispatchEvent(new CustomEvent('baton-preview:navigate', { detail: sessionId }))
  },
}]])
window.__ModuleLoader__ = {
  load({ factory }) {
    factory(name => {
      if (name === 'react') return React
      throw new Error('Unknown preview module: ' + name)
    }).apply({
      get(name) { return services.get(name) },
      effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) },
      slots: {
        inject(_name, register) { register() },
        register({ id }, component) { slots.set(id, component) },
      },
    })
  },
}

await import('../client.js')
const Trigger = slots.get('baton-trigger')
const Panel = slots.get('baton-panel')

function App() {
  const [sessionId, setSessionId] = useState(null)
  useEffect(() => {
    const navigate = event => setSessionId(event.detail)
    window.addEventListener('baton-preview:navigate', navigate)
    document.querySelector('.bt-trigger')?.click()
    return () => window.removeEventListener('baton-preview:navigate', navigate)
  }, [])
  return <>
    <div className="preview-bar"><span>DSH <small>WORKBENCH</small></span><span>交互预览 · 示例数据 <button onClick={() => document.documentElement.classList.toggle('dark')}>切换明暗</button></span></div>
    <div className="preview-workbench"><aside><strong>工作区</strong><p>产品研发</p><p>接口联调</p><p>交互体验优化</p><Trigger /></aside><main><span>团队协作 / 项目工作区</span><h1>让事情顺畅地交接。</h1><p>选择侧边栏的「接力」，打开团队收件箱。</p><div className="preview-lines"><i /><i /><i /><i /></div></main></div>
    <Panel />
    {sessionId ? <div role="status">已打开示例会话：{sessionId}</div> : null}
  </>
}

createRoot(document.getElementById('root')).render(<App />)
window.addEventListener('beforeunload', () => cleanups.forEach(cleanup => cleanup()))
