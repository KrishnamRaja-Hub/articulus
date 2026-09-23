/* Dev-only: scroll the built site, load Scenario 2, screenshot each section. Usage: node scripts/shots.mjs [width] */
import { chromium } from 'playwright'
const width = Number(process.argv[2] ?? 1440)
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
await page.goto('http://localhost:4173/')
await page.waitForTimeout(3500)
// crawl down slowly so every ScrollTrigger fires
const total = await page.evaluate(() => document.body.scrollHeight)
for (let y = 0; y < total; y += 400) { await page.mouse.wheel(0, 400); await page.waitForTimeout(90) }
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'Load Scenario 2' }).click()
await page.waitForTimeout(1200)
for (const id of ['top', 'trap', 'stories', 'plan']) {
  await page.locator(`#${id}`).scrollIntoViewIfNeeded()
  await page.waitForTimeout(700)
  await page.locator(`#${id}`).screenshot({ path: `/tmp/sec-${id}-${width}.png` })
}
await page.screenshot({ path: `/tmp/full-${width}.png`, fullPage: true })
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
console.log(JSON.stringify({ width, horizontalOverflowPx: overflow, errors }, null, 1))
await browser.close()
