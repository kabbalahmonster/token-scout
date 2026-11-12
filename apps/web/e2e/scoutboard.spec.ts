import { expect, test } from '@playwright/test';

test('operator console renders boundaries and discovery navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Scoutboard' })).toBeVisible();
  await expect(page.getByText('No wallet. No signing.')).toBeVisible();
  await page.getByRole('link', { name: 'Discovery' }).click();
  await expect(page.getByRole('heading', { name: 'Discovery inbox' })).toBeVisible();
  await expect(page.getByLabel('Token contract')).toBeVisible();
});

test('operations exposes a live assessment queue and focused terminal timeline', async ({ page }) => {
  const address = '0x1111111111111111111111111111111111111111';
  await page.route('**/api/v1/operations', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ database: true, jobs: { queued: 1, running: 1, completed: 12, failed: 2 }, sources: [], process: {} }) }));
  await page.route('**/api/v1/sources/status', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], generatedAt: new Date().toISOString() }) }));
  await page.route('**/api/v1/alerts', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }));
  await page.route('**/api/v1/jobs?**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: '11111111-1111-4111-8111-111111111111', kind: 'assess', origin: 'manual', state: 'running', chainId: 4663, address, symbol: 'FOX', name: 'Fox', verdict: null, score: null, confidence: null, position: 0, queuedAhead: 0, estimatedWaitSeconds: 0, progressStage: 'checking_route', progressPercent: 80, attempts: 1, runAfter: '2026-11-11T20:00:00Z', createdAt: '2026-11-11T20:00:00Z', startedAt: '2026-11-11T20:00:02Z', completedAt: null, updatedAt: '2026-11-11T20:00:08Z', durationSeconds: 6, error: null }], generatedAt: new Date().toISOString() }) }));
  await page.route('**/api/v1/job-events?**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 3, jobId: '11111111-1111-4111-8111-111111111111', eventType: 'progress', stage: 'checking_route', message: 'Simulating the configured principal round trip.', progressPercent: 80, createdAt: '2026-11-11T20:00:08Z' }], generatedAt: new Date().toISOString() }) }));
  await page.goto('/operations');
  await expect(page.getByRole('heading', { name: 'Assessment console' })).toBeVisible();
  await expect(page.getByText('FOX')).toBeVisible();
  await expect(page.getByText('checking route')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect FOX assessment timeline' }).click();
  await expect(page.getByText('Job timeline')).toBeVisible();
  await expect(page.getByText('Simulating the configured principal round trip.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open assessment for FOX' })).toHaveAttribute('href', `/tokens/4663/${address}`);
  const reassessment = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/v1/candidates/assess'));
  await page.route('**/api/v1/candidates/assess', async (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: '22222222-2222-4222-8222-222222222222', chainId: 4663, address, state: 'queued', queue: { state: 'queued', position: 1, queuedAhead: 0, estimatedWaitSeconds: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }) }));
  await page.getByRole('button', { name: 'Queue FOX for reassessment' }).click();
  expect((await reassessment).postDataJSON()).toEqual({ chainId: 4663, address });
  await expect(page.getByRole('button', { name: 'FOX queued for reassessment' })).toBeDisabled();
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
  const chart = page.getByLabel(/Retained price history chart/);
  await expect(chart).toBeVisible();
  const chartBox = await chart.boundingBox();
  const canvasRightEdges = await chart.locator('canvas').evaluateAll((canvases) => canvases.map((canvas) => canvas.getBoundingClientRect().right));
  expect(Math.max(...canvasRightEdges)).toBeGreaterThan((chartBox?.x ?? 0) + (chartBox?.width ?? 0) - 2);
  await expect(page.getByRole('link', { name: /Full assessment/ })).toBeVisible();
});

test('a candidate can be added to the watchlist directly from Scoutboard', async ({ page }) => {
  const address = '0x1111111111111111111111111111111111111111';
  const candidate = { chainId: 4663, address, symbol: 'FOX', name: 'Fox', decimals: 18, totalSupply: '1000', assetType: 'crypto', state: 'assessed', canonicalPair: null, discoveredAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', watched: false, score: 72, verdict: 'PASS', confidence: 81, scoreVersion: '1.0.0', flags: [], latestSnapshot: { marketCapUsd: '100000', liquidityUsd: '50000', volume24hUsd: '12000', pairCreatedAt: '2026-09-01T00:00:00Z' }, swingScore: 65, swingEventsPerDay: 1.25, routeState: 'available' };
  await page.route('**/api/v1/candidates?**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [candidate] }) }));
  await page.route('**/api/v1/watchlists', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Conviction', labels: [] }] }) }));
  const added = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/v1/watchlists/11111111-1111-4111-8111-111111111111/items'));
  await page.route('**/api/v1/watchlists/11111111-1111-4111-8111-111111111111/items', async (route) => route.fulfill({ status: 204 }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await page.getByRole('button', { name: 'Add FOX to Conviction' }).click();
  const request = await added;
  expect(request.postDataJSON()).toEqual({ chainId: 4663, address });
  await expect(page.getByRole('button', { name: 'FOX is on a watchlist' })).toBeDisabled();
  await expect(page.getByText('Assessment snapshot')).toHaveCount(0);
});

test('a candidate can be queued for reassessment directly from Scoutboard', async ({ page }) => {
  const address = '0x1111111111111111111111111111111111111111';
  const candidate = { chainId: 4663, address, symbol: 'FOX', name: 'Fox', decimals: 18, totalSupply: '1000', assetType: 'crypto', state: 'assessed', canonicalPair: null, discoveredAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', watched: false, score: 72, verdict: 'PASS', confidence: 81, scoreVersion: '1.0.0', flags: [], latestSnapshot: { marketCapUsd: '100000', liquidityUsd: '50000', volume24hUsd: '12000', pairCreatedAt: '2026-09-01T00:00:00Z' }, swingScore: 65, swingEventsPerDay: 1.25, routeState: 'available' };
  await page.route('**/api/v1/candidates?**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [candidate] }) }));
  const queued = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/v1/candidates/assess'));
  await page.route('**/api/v1/candidates/assess', async (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: '22222222-2222-4222-8222-222222222222', chainId: 4663, address, state: 'queued', queue: { state: 'queued', position: 1, queuedAhead: 0, estimatedWaitSeconds: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }) }));
  await page.goto('/');

  await page.getByRole('button', { name: 'Queue FOX for reassessment' }).click();
  expect((await queued).postDataJSON()).toEqual({ chainId: 4663, address });
  await expect(page.getByRole('button', { name: 'FOX queued for reassessment' })).toBeDisabled();
  await expect(page.getByText('Assessment snapshot')).toHaveCount(0);
});

test('candidate filters and sorting survive a reload', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: /Filters & sorting/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.getByLabel('Market profile').selectOption('new');
  await page.getByLabel('Asset type').selectOption('tokenized_stock');
  await page.getByLabel('Sort candidates').selectOption('volume');
  await page.getByRole('button', { name: /Sort descending; change direction/ }).click();
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
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
  const queued = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/v1/candidates/assess'));
  await page.route('**/api/v1/candidates/assess', async (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: '22222222-2222-4222-8222-222222222222', chainId: 4663, address, state: 'queued', queue: { state: 'queued', position: 1, queuedAhead: 0, estimatedWaitSeconds: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }) }));
  await page.goto(`/tokens/4663/${address}`);
  await expect(page.getByRole('heading', { name: /FOX/ })).toBeVisible();
  await expect(page.getByRole('button', { name: `Copy contract address ${address}` })).toBeVisible();
  await page.getByRole('button', { name: 'Queue FOX for reassessment' }).click();
  expect((await queued).postDataJSON()).toEqual({ chainId: 4663, address });
  await expect(page.getByRole('button', { name: 'FOX queued for reassessment' })).toBeDisabled();
  await expect(page.getByText(/React error/)).toHaveCount(0);
});
