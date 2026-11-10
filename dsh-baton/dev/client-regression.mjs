/** Browser regressions against fixture API + real React/client.js; no DSH calls. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { chromium, expect } = createRequire(import.meta.url)('playwright/test')
const base = process.env.BATON_PREVIEW_URL ?? 'http://127.0.0.1:4371'
// The DSH boundary is a service registry whose providers can activate later.
const harness = (await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    contents: `
      import React, { useEffect } from 'react'
      import { createRoot } from 'react-dom/client'
      const slots = new Map(), services = new Map()
      window.reviewServices = services
      window.reviewNavigations = []
      window.__ModuleLoader__ = { load({ factory }) {
        factory(name => { if (name === 'react') return React; throw new Error(name) }).apply({
          get(name) { return services.get(name) },
          effect(fn) { fn() },
          slots: { inject(name, register) { register() }, register({ id }, component) { slots.set(id, component) } },
        })
      } }
      await import('../client.js')
      function App() {
        useEffect(() => { document.querySelector('.bt-trigger')?.click() }, [])
        return React.createElement(React.Fragment, null,
          React.createElement(slots.get('baton-trigger')),
          React.createElement(slots.get('baton-panel')))
      }
      createRoot(document.getElementById('root')).render(React.createElement(App))
    `,
  },
  bundle: true, write: false, format: 'esm', target: 'es2022',
})).outputFiles[0].text

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
const failures = []
async function check(name, run, custom = false) {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.request.post(base + '/__preview', { data: { reset: true } })
    if (custom) await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: harness }))
    await page.goto(base)
    await page.waitForLoadState('networkidle')
    assert.deepEqual(errors, [], 'client boot should not throw')
    await run(page)
    assert.deepEqual(errors, [], 'interaction should not cause an unhandled error')
    console.log('PASS: ' + name)
  } catch (error) {
    failures.push(name)
    console.error('FAIL: ' + name + '\n' + error.message)
  } finally { await page.close() }
}

try {
  await check('unmodified preview boots and can navigate to a created session', async page => {
    await expect(page.getByRole('button', { name: '发起接力', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /登录页接口联调/ }).click()
    await page.getByRole('button', { name: '接受并启动', exact: true }).click()
    await expect(page.locator('.bt-shell')).not.toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: '已打开示例会话' })).toBeVisible()
  })

  await check('provider activated after plugin apply still opens accepted session', async page => {
    await page.evaluate(() => window.reviewServices.set('uiWorkspace', {
      openSession(id) { window.reviewNavigations.push(id) },
    }))
    await page.getByRole('button', { name: /登录页接口联调/ }).click()
    await page.getByRole('button', { name: '接受并启动', exact: true }).click()
    await expect(page.locator('.bt-shell')).not.toBeVisible()
    assert.equal((await page.evaluate(() => window.reviewNavigations)).length, 1)
  }, true)

  for (const mode of ['unavailable', 'rejected']) {
    await check(`navigation ${mode} preserves the panel and submitted session`, async page => {
      if (mode === 'rejected') await page.evaluate(() => window.reviewServices.set('uiWorkspace', {
        async openSession() { throw new Error('test navigation unavailable') },
      }))
      await page.getByRole('button', { name: /登录页接口联调/ }).click()
      await page.getByRole('button', { name: '接受并启动', exact: true }).click()
      await expect(page.getByRole('alert').filter({ hasText: '会话已保留' })).toBeVisible()
      await expect(page.locator('.bt-shell')).toBeVisible()
      const state = await (await page.request.get(base + '/__preview/state')).json()
      assert.equal(Object.values(state.local).filter(record => record.phase === 'submitted').length, 1)
      // A later provider or retry must use the existing session, without resubmitting.
      await page.evaluate(() => window.reviewServices.set('uiWorkspace', {
        openSession(id) { window.reviewNavigations.push(id) },
      }))
      await page.route('**/api/baton', async route => {
        const body = route.request().postDataJSON()
        if (body.action === 'session') return route.fulfill({ json: { ok: true, exists: true } })
        return route.continue()
      })
      await page.getByRole('button', { name: '定位会话', exact: true }).first().click()
      await expect(page.locator('.bt-shell')).not.toBeVisible()
      assert.equal((await page.evaluate(() => window.reviewNavigations)).length, 1)
      const after = await (await page.request.get(base + '/__preview/state')).json()
      assert.deepEqual(after.local, state.local)
    }, true)
  }

  await check('Escape closes environment menu before send dialog; Tab stays trapped', async page => {
    await page.getByRole('button', { name: '发起接力', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '发起一次接力' })
    const input = dialog.locator('input[role="combobox"]')
    await input.click()
    await expect(input).toHaveAttribute('aria-expanded', 'true')
    await input.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(input).toHaveAttribute('aria-expanded', 'false')
    await input.press('ArrowDown')
    await input.press('Enter')
    await expect(input).toHaveValue('frontend')
    await expect(input).toHaveAttribute('aria-expanded', 'false')
    const cancel = dialog.getByRole('button', { name: '取消', exact: true })
    await cancel.focus()
    await cancel.press('Tab')
    await expect(dialog.getByRole('button', { name: '关闭对话框', exact: true })).toBeFocused()
    await input.focus()
    await input.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('.bt-shell')).toBeVisible()
    await page.getByRole('button', { name: '关闭接力', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('.bt-shell')).not.toBeVisible()
  }, true)
} finally { await browser.close() }

if (failures.length) throw new Error(failures.length + ' client regression(s) failed: ' + failures.join('; '))
