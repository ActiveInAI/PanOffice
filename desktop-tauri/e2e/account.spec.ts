import { expect, test } from '@playwright/test'

/**
 * Account integration smoke: the home route mounts the Arch-GPT sign-in
 * panel (src/account/LoginPanel via App.tsx). No server here — this only
 * proves the shell wiring, not the auth flow (that is unit-tested against a
 * stub server in tests/account-client.test.ts).
 */
test('home mounts the Arch-GPT sign-in panel', async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('input[type="password"]')).toBeVisible()
  // QR sign-in lives behind the QR tab
  await page.getByRole('button', { name: 'QR' }).click()
  await expect(page.getByText('Create QR sign-in challenge')).toBeVisible()
})
