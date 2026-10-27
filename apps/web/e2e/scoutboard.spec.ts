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

test('token detail survives the loading-to-data render transition', async ({ page }) => {
  const address = '0x1111111111111111111111111111111111111111';
  const candidate = { chainId: 4663, address, symbol: 'FOX', name: 'Fox', decimals: 18, totalSupply: '1000', state: 'assessed', canonicalPair: null, discoveredAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', watched: false, score: 50, verdict: 'CAUTION', confidence: 40, scoreVersion: '1.0.0', flags: [], latestSnapshot: null };
  await page.route(`**/api/v1/candidates/4663/${address}`, async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidate, swings: null, route: null, contract: null, score: null, pairs: [] }) }));
  await page.route(`**/api/v1/candidates/4663/${address}/history`, async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }));
  await page.goto(`/tokens/4663/${address}`);
  await expect(page.getByRole('heading', { name: /FOX/ })).toBeVisible();
  await expect(page.getByText(/React error/)).toHaveCount(0);
});
