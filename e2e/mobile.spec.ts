import { expect, test } from '@playwright/test'

test('mobile navigation and checkout complete in Chromium', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Seja dono do futuro da arte digital.' })).toBeVisible()
  const reset = await page.evaluate(async () => {
    const response = await fetch('/api/__test/reset', { method: 'POST' })
    return response.ok
  })
  expect(reset).toBe(true)

  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible()
  await page.getByRole('button', { name: 'Close navigation menu' }).click()

  await page.goto('/checkout')
  await expect(page.getByRole('heading', { name: 'Complete your purchase' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm purchase' }).click()
  await expect(page.getByRole('heading', { name: 'Your purchase is locked in.' })).toBeVisible()

  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(hasOverflow).toBe(false)
})
