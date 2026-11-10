/** Standalone browser regression for the fixture preview; never connects to DSH. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium, expect } = createRequire(import.meta.url)('playwright/test')
const base = process.env.BATON_PREVIEW_URL ?? 'http://127.0.0.1:4371'
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  await page.request.post(base + '/__preview', { data: { reset: true, failNextSend: true } })
  await page.goto(base)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: '发起接力', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '发起一次接力' })
  await dialog.locator('select').nth(0).selectOption('GREEN8')
  await dialog.locator('select').nth(1).selectOption('22222222-2222-4222-8222-222222222222')
  await dialog.locator('input[placeholder^="例如"]').fill('Original uncertain task')
  await dialog.locator('input[placeholder="frontend"]').fill('frontend')
  await dialog.locator('textarea').fill('Keep this original payload')
  await dialog.getByRole('button', { name: '发送接力', exact: true }).click()
  await expect(dialog.locator('textarea')).toBeDisabled()
  const original = (await (await page.request.get(base + '/__preview/state')).json()).outbox[0]
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  // The old room can no longer accept retries, while other rooms still work.
  await page.request.post(base + '/api/baton', { data: { action: 'disband', code: 'GREEN8' } })
  await page.getByRole('button', { name: '刷新接力', exact: true }).click()
  await page.getByRole('button', { name: '发起接力', exact: true }).click()
  await dialog.getByRole('button', { name: '保留原投递，另建接力', exact: true }).click()
  await expect(dialog.locator('textarea')).toBeEnabled()
  await expect(dialog.locator('textarea')).toHaveValue('')
  await dialog.locator('select').nth(0).selectOption('DESGN6')
  await dialog.locator('select').nth(1).selectOption('22222222-2222-4222-8222-222222222222')
  await dialog.locator('input[placeholder^="例如"]').fill('Independent new task')
  await dialog.locator('input[placeholder="frontend"]').fill('frontend')
  await dialog.locator('textarea').fill('A different task')
  await dialog.getByRole('button', { name: '发送接力', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const state = await (await page.request.get(base + '/__preview/state')).json()
  assert.deepEqual(state.outbox, [original], 'the original request must remain intact')
  const newest = state.controls.requests.at(-1)
  assert.notEqual(newest.taskId, original.taskId)
  assert.equal(newest.room, 'DESGN6')
  assert.equal(newest.title, 'Independent new task')
  console.log('PASS: uncertain request retained; separate draft sent with a fresh taskId')
} finally {
  await browser.close()
}
