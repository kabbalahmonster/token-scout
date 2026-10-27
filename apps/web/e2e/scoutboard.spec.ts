import { expect, test } from '@playwright/test';

test('operator console renders boundaries and discovery navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Scoutboard' })).toBeVisible();
  await expect(page.getByText('No wallet. No signing.')).toBeVisible();
  await page.getByRole('link', { name: 'Discovery' }).click();
  await expect(page.getByRole('heading', { name: 'Discovery inbox' })).toBeVisible();
  await expect(page.getByLabel('Token contract')).toBeVisible();
});

test('upstream API throttling is visible instead of fabricating candidates', async ({ page }) => {
  await page.route('**/api/v1/candidates**', async (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'Rate limit reached' }) }));
  await page.goto('/');
  await expect(page.getByText('Could not load candidates: Rate limit reached')).toBeVisible();
  await expect(page.getByText('No candidates yet.')).toBeVisible();
});
