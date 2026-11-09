import type { Candidate, Verdict } from '@doomscout/domain';

export function VerdictBadge({ verdict }: { verdict: Verdict }) { return <span className={`badge verdict-${verdict.toLowerCase()}`}>{verdict}</span>; }
export function StateBadge({ state }: { state: string }) { return <span className="state">{state.replaceAll('_', ' ')}</span>; }
export function Unknown({ value, suffix = '' }: { value: string | number | null | undefined; suffix?: string }) { return value === null || value === undefined ? <span className="unknown" title="This source did not provide a value">unknown</span> : <>{value}{suffix}</>; }
export function Money({ value }: { value: string | null | undefined }) { if (value === null || value === undefined) return <span className="unknown">unknown</span>; const number = Number(value); return <>{Number.isFinite(number) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: number > 9999 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(number) : value}</>; }
export function candidateMarketCap(candidate: Candidate): { value: string; estimated: boolean } | null {
  const reported = Number(candidate.latestSnapshot?.marketCapUsd);
  if (Number.isFinite(reported) && reported > 0) return { value: String(reported), estimated: false };
  const price = Number(candidate.latestSnapshot?.priceUsd);
  const supply = Number(candidate.totalSupply);
  const decimals = candidate.decimals;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(supply) || supply <= 0 || decimals === null || decimals < 0 || decimals > 255) return null;
  const estimate = price * supply / 10 ** decimals;
  return Number.isFinite(estimate) && estimate > 0 ? { value: String(estimate), estimated: true } : null;
}
export function CandidateMarketCap({ candidate }: { candidate: Candidate }) {
  const cap = candidateMarketCap(candidate);
  if (!cap) return <span className="unknown">unknown</span>;
  return <span title={cap.estimated ? 'Estimated from USD price and on-chain totalSupply; circulating supply may be lower.' : 'Provider reported'}>{cap.estimated ? '≈ ' : null}<Money value={cap.value}/></span>;
}
export function Age({ date }: { date: string | null | undefined }) { if (!date) return <span className="unknown">unknown</span>; const seconds = Math.max(0, (Date.now() - Date.parse(date)) / 1000); const amount = seconds > 86400 ? `${Math.floor(seconds / 86400)}d` : seconds > 3600 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 60)}m`; return <span title={new Date(date).toLocaleString()}>{amount}</span>; }
