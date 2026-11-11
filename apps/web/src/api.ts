import type { Candidate, ContractScan, MarketSnapshot, RouteAssessment, ScoreResult, SourceStatus, SwingStudy } from '@doomscout/domain';
import { apiBase } from './base-path.js';

function token(): string | null { return localStorage.getItem('doomscout.authToken'); }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = token();
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...init.headers } });
  if (!response.ok) { const detail = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }; throw new Error(detail.message ?? `Request failed (${response.status})`); }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface CandidateDetail { candidate: Candidate; swings: SwingStudy | null; route: RouteAssessment | null; contract: ContractScan | null; score: ScoreResult | null; pairs: Array<{ pairAddress: string; dex: string; liquidityUsd: string | null }> }
export interface QueueStatus { id?: string; state: string; position: number | null; queuedAhead: number; estimatedWaitSeconds: number; createdAt: string; updatedAt: string; progressStage?: string | null; progressPercent?: number }
export interface AssessmentQueued { jobId: string; chainId: number; address: string; state: 'queued'; queue: QueueStatus | null }
export interface JobActivity extends Required<Pick<QueueStatus, 'state' | 'position' | 'queuedAhead' | 'estimatedWaitSeconds' | 'createdAt' | 'updatedAt'>> { id: string; kind: string; origin: 'manual' | 'import' | 'discovery' | 'watchlist' | 'refresh' | 'universe' | 'maintenance' | 'other'; chainId: number | null; address: string | null; symbol: string | null; name: string | null; verdict: string | null; score: number | null; confidence: number | null; progressStage: string | null; progressPercent: number; attempts: number; runAfter: string; startedAt: string | null; completedAt: string | null; durationSeconds: number | null; error: string | null }
export interface JobEvent { id: number; jobId: string; eventType: string; stage: string | null; message: string; progressPercent: number | null; createdAt: string }
export const client = {
  candidates: (query = '', signal?: AbortSignal) => api<{ data: Candidate[]; meta?: { generatedAt: string; total: number } }>(`/api/v1/candidates${query}`, signal ? { signal } : {}),
  candidate: (chainId: number, address: string) => api<CandidateDetail>(`/api/v1/candidates/${chainId}/${address}`),
  setCanonicalPair: (chainId: number, address: string, pairAddress: string | null) => api<void>(`/api/v1/candidates/${chainId}/${address}/canonical-pair`, { method: 'PATCH', body: JSON.stringify({ pairAddress }) }),
  history: (chainId: number, address: string) => api<{ data: MarketSnapshot[] }>(`/api/v1/candidates/${chainId}/${address}/history`),
  assess: (address: string, chainId = 4663) => api<AssessmentQueued>('/api/v1/candidates/assess', { method: 'POST', body: JSON.stringify({ chainId, address }) }),
  job: (jobId: string) => api<QueueStatus>(`/api/v1/jobs/${jobId}`),
  jobs: (query = '') => api<{ data: JobActivity[]; generatedAt: string }>(`/api/v1/jobs${query}`),
  jobEvents: (query = '') => api<{ data: JobEvent[]; generatedAt: string }>(`/api/v1/job-events${query}`),
  import: (csv: string) => api<{ accepted: number; estimatedRequests: number }>('/api/v1/candidates/import', { method: 'POST', body: JSON.stringify({ chainId: 4663, csv }) }),
  sources: () => api<{ data: SourceStatus[]; generatedAt: string }>('/api/v1/sources/status'),
  operations: () => api<any>('/api/v1/operations'),
  alerts: () => api<{ data: Array<{ id: string; chainId: number; address: string; kind: string; severity: string; message: string; createdAt: string }> }>('/api/v1/alerts'),
  watchlists: () => api<{ data: Array<{ id: string; name: string; labels: string[] }> }>('/api/v1/watchlists'),
  watchlistItems: (id: string) => api<{ data: Array<{ candidate: Candidate; tags: string[]; note: string | null; addedAt: string }> }>(`/api/v1/watchlists/${id}/items`),
  createWatchlist: (name: string) => api<{ id: string }>('/api/v1/watchlists', { method: 'POST', body: JSON.stringify({ name }) }),
  addWatchlistItem: (id: string, chainId: number, address: string) => api<void>(`/api/v1/watchlists/${id}/items`, { method: 'POST', body: JSON.stringify({ chainId, address }) }),
  removeWatchlistItem: (id: string, chainId: number, address: string) => api<void>(`/api/v1/watchlists/${id}/items/${chainId}/${address}`, { method: 'DELETE' })
};

export function exportUrl(chainId: number, address: string, format: 'json' | 'env'): string { return `${apiBase}/api/v1/export/${chainId}/${address}?format=${format}`; }
export async function downloadExport(chainId: number, address: string, format: 'json' | 'env'): Promise<void> {
  const auth = token();
  const response = await fetch(exportUrl(chainId, address, format), { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = `doomscout-review.${format}`; anchor.click();
  URL.revokeObjectURL(objectUrl);
}
