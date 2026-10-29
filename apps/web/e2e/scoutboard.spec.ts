import { expect, test } from '@playwright/test';

test('operator console renders boundaries and discovery navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Scoutboard' })).toBeVisible();
  await expect(page.getByText('No wallet. No signing.')).toBeVisible();
  await page.getByRole('link', { name: 'Discovery' }).click();
  await expect(page.getByRole('heading', { name: 'Discovery inbox' })).toBeVisible();
  await expect(page.getByLabel('Token contract')).toBeVisible();
});

test('candidate headers request ascending and descending sorts', async ({ page }) => {
  await page.goto('/');
  const firstRequest = page.waitForRequest((request) => request.url().includes('/api/v1/candidates') && request.url().includes('sort=token') && request.url().includes('direction=asc'));
  await page.getByRole('button', { name: /Token/ }).click();
  await firstRequest;
  const nextRequest = page.waitForRequest((request) => request.url().includes('/api/v1/candidates') && request.url().includes('sort=token') && request.url().includes('direction=desc'));
  await page.getByRole('button', { name: /Token/ }).click();
  await nextRequest;
});

test('candidate filters collapse on mobile and remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: /Filters & sorting/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Search candidates')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Search candidates')).toBeVisible();

  await expect(page.getByRole('columnheader', { name: 'Market cap' })).toBeHidden();
  await expect(page.getByRole('columnheader', { name: 'Score' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Verdict' })).toBeVisible();
});

test('mobile auth stays out of the way until requested', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const authToggle = page.getByRole('button', { name: 'API token' });
  const authInput = page.getByLabel('API bearer token');
  await expect(authToggle).toBeVisible();
  await expect(authToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(authInput).toBeHidden();
  await authToggle.click();
  await expect(authToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(authInput).toBeVisible();

  const scoutboardLink = page.getByRole('link', { name: 'Scoutboard' });
  const linkBox = await scoutboardLink.boundingBox();
  expect(linkBox?.height).toBeGreaterThanOrEqual(44);
});

test('tapping a mobile candidate row expands its assessment snapshot', async ({ page }) => {
  const address = '0x1111111111111111111111111111111111111111';
  const candidate = { chainId: 4663, address, symbol: 'FOX', name: 'Fox', decimals: 18, totalSupply: '1000', assetType: 'crypto', state: 'assessed', canonicalPair: null, discoveredAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', watched: false, score: 72, verdict: 'PASS', confidence: 81, scoreVersion: '1.0.0', flags: [{ code: 'OWNER', label: 'Owner control', severity: 'medium', state: 'detected', confidence: 90, explanation: 'Owner retains control', evidence: [] }], latestSnapshot: { marketCapUsd: '100000', liquidityUsd: '50000', volume24hUsd: '12000', pairCreatedAt: '2026-09-01T00:00:00Z' }, swingScore: 65, swingEventsPerDay: 1.25, routeState: 'available' };
  await page.route('**/api/v1/candidates?**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [candidate] }) }));
  await page.route(`**/api/v1/candidates/4663/${address}/history`, async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ fingerprint: 'one', source: 'dexscreener', ingestedAt: '2026-10-01T00:00:00Z', sourceTime: null, priceUsd: '1', priceNative: null, marketCapUsd: '100000', liquidityUsd: '50000', volume24hUsd: '12000' }, { fingerprint: 'two', source: 'dexscreener', ingestedAt: '2026-10-01T00:05:00Z', sourceTime: null, priceUsd: '1.1', priceNative: null, marketCapUsd: '110000', liquidityUsd: '51000', volume24hUsd: '12500' }] }) }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const row = page.getByRole('row').filter({ hasText: 'FOX' }).first();
  await row.click();
  await expect(page.getByText('Assessment snapshot')).toBeVisible();
  await expect(page.getByText('81/100')).toBeVisible();
  await expect(page.getByText('Owner control')).toBeVisible();
  await expect(page.getByLabel('FOX retained price history')).toBeVisible();
  await expect(page.getByLabel(/Retained price history chart/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Full assessment/ })).toBeVisible();
});

test('candidate filters and sorting survive a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Market profile').selectOption('new');
  await page.getByLabel('Asset type').selectOption('tokenized_stock');
  await page.getByLabel('Sort candidates').selectOption('volume');
  await page.getByRole('button', { name: /Sort descending; change direction/ }).click();
  await page.reload();
  await expect(page.getByLabel('Market profile')).toHaveValue('new');
  await expect(page.getByLabel('Asset type')).toHaveValue('tokenized_stock');
  await expect(page.getByLabel('Sort candidates')).toHaveValue('volume');
  await expect(page.getByRole('button', { name: /Sort ascending; change direction/ })).toBeVisible();
});

test('upstream API throttling is visible instead of fabricating candidates', async ({ page }) => {
  await page.route('**/api/v1/candidates**', async (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'Rate limit reached' }) }));
  await page.goto('/');
  await expect(page.getByText('Could not load candidates: Rate limit reached')).toBeVisible();
  await expect(page.getByText('No candidates match these filters.')).toBeVisible();
});

test('token detail survives the loading-to-data render transition', async ({ page }) => {
  const address = '0x1111111111111111111111111111111111111111';
  const candidate = { chainId: 4663, address, symbol: 'FOX', name: 'Fox', decimals: 18, totalSupply: '1000', assetType: 'crypto', state: 'assessed', canonicalPair: null, discoveredAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', watched: false, score: 50, verdict: 'CAUTION', confidence: 40, scoreVersion: '1.0.0', flags: [], latestSnapshot: null };
  await page.route(`**/api/v1/candidates/4663/${address}`, async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidate, swings: null, route: null, contract: null, score: null, pairs: [] }) }));
  await page.route(`**/api/v1/candidates/4663/${address}/history`, async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }));
  await page.goto(`/tokens/4663/${address}`);
  await expect(page.getByRole('heading', { name: /FOX/ })).toBeVisible();
  await expect(page.getByRole('button', { name: `Copy contract address ${address}` })).toBeVisible();
  await expect(page.getByText(/React error/)).toHaveCount(0);
});
