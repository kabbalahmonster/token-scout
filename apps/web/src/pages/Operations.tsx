import { useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Clock3, Copy, ExternalLink, KeyRound, ListOrdered, Search, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { client, type JobActivity } from '../api.js';
import { Age } from '../components/Status.js';

function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function wait(seconds: number): string {
  if (seconds < 10) return '<10s';
  if (seconds < 60) return `~${Math.ceil(seconds / 10) * 10}s`;
  return `~${Math.ceil(seconds / 60)}m`;
}

function label(value: string | null): string { return (value ?? 'waiting').replaceAll('_', ' '); }
function tone(state: string): string { return state === 'completed' ? 'verdict-pass' : state === 'failed' ? 'verdict-reject' : state === 'running' ? 'queue-running' : 'verdict-caution'; }

function JobCard({ job, selected, onSelect }: { job: JobActivity; selected: boolean; onSelect: () => void }) {
  const display = job.symbol ?? job.name ?? (job.address ? `${job.address.slice(0, 10)}…${job.address.slice(-6)}` : label(job.kind));
  const timing = job.state === 'queued'
    ? job.position === null ? `scheduled ${new Date(job.runAfter).toLocaleString()}` : `#${job.position} · starts ${wait(job.estimatedWaitSeconds)}`
    : job.state === 'running' ? `${duration(job.durationSeconds)} elapsed`
      : `${duration(job.durationSeconds)} · ${job.completedAt ? new Date(job.completedAt).toLocaleString() : 'finished'}`;
  return <article className={`job-card ${selected ? 'selected' : ''}`}>
    <button className="job-main" type="button" onClick={onSelect} aria-pressed={selected} aria-label={`Inspect ${display} assessment timeline`}>
      <span className={`job-state badge ${tone(job.state)}`}>{job.state}</span>
      <span className="job-identity"><strong>{display}</strong><small>{job.origin} · {job.kind}{job.attempts > 1 ? ` · attempt ${job.attempts}` : ''}</small></span>
      <span className="job-timing">{timing}<small>{label(job.progressStage)}</small></span>
      <span className="job-progress" aria-label={`${job.progressPercent}% complete`}><i style={{ width: `${job.progressPercent}%` }}/></span>
      {job.verdict && job.state === 'completed' ? <span className={`badge verdict-${job.verdict.toLowerCase()}`}>{job.verdict}{job.score === null ? '' : ` ${job.score.toFixed(1)}`}</span> : null}
      {job.error ? <span className="job-error" title={job.error}><AlertTriangle size={14}/>{job.error}</span> : null}
    </button>
    <div className="job-actions">
      {job.address ? <button type="button" title="Copy contract" aria-label={`Copy contract ${job.address}`} onClick={() => { void navigator.clipboard.writeText(job.address!); }}><Copy size={14}/></button> : null}
      {job.address && job.chainId ? <Link title="Open assessment" aria-label={`Open assessment for ${display}`} to={`/tokens/${job.chainId}/${job.address}`}><ExternalLink size={14}/></Link> : null}
    </div>
  </article>;
}

export function Operations() {
  const initialJob = new URLSearchParams(location.search).get('job');
  const [state, setState] = useState(''); const [origin, setOrigin] = useState(''); const [search, setSearch] = useState('');
  const [selectedJob, setSelectedJob] = useState<string | null>(initialJob); const deferredSearch = useDeferredValue(search.trim());
  const query = useMemo(() => { const params = new URLSearchParams({ limit: '150' }); if (state) params.set('state', state); if (origin) params.set('origin', origin); if (deferredSearch) params.set('search', deferredSearch); return `?${params}`; }, [state, origin, deferredSearch]);
  const sources = useQuery({ queryKey: ['sources'], queryFn: client.sources, refetchInterval: 10_000 });
  const operations = useQuery({ queryKey: ['operations'], queryFn: client.operations, refetchInterval: 10_000 });
  const jobs = useQuery({ queryKey: ['jobs', query], queryFn: () => client.jobs(query), refetchInterval: 2_000 });
  const eventsQuery = selectedJob ? `?jobId=${selectedJob}&limit=100` : '?limit=100';
  const events = useQuery({ queryKey: ['job-events', eventsQuery], queryFn: () => client.jobEvents(eventsQuery), refetchInterval: 2_000 });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: client.alerts, refetchInterval: 10_000 });
  const [token, setToken] = useState(localStorage.getItem('doomscout.authToken') ?? '');
  const databaseStatus = operations.isPending ? { label: 'DB CHECKING', tone: 'verdict-caution' } : operations.isError ? { label: 'DB UNREACHABLE', tone: 'verdict-reject' } : operations.data.database ? { label: 'DB READY', tone: 'verdict-pass' } : { label: 'DB DOWN', tone: 'verdict-reject' };
  const counts = operations.data?.jobs ?? {};

  return <section className="page operations-page">
    <div className="pagehead"><div><p className="eyebrow">Live exploration</p><h1>Assessment console</h1><p>Watch contracts move from intake through market, route, swing, and risk evidence—with a retained receipt after they finish.</p></div><span className={`badge ${databaseStatus.tone}`}>{databaseStatus.label}</span></div>

    <div className="queue-overview" aria-label="Assessment queue summary">
      <button className={state === 'active' ? 'active' : ''} onClick={() => setState('active')}><Activity size={16}/><span>Active<strong>{Number(counts.queued ?? 0) + Number(counts.running ?? 0)}</strong></span></button>
      <button className={state === 'queued' ? 'active' : ''} onClick={() => setState('queued')}><ListOrdered size={16}/><span>Queued<strong>{String(counts.queued ?? 0)}</strong></span></button>
      <button className={state === 'completed' ? 'active' : ''} onClick={() => setState('completed')}><CheckCircle2 size={16}/><span>Completed<strong>{String(counts.completed ?? 0)}</strong></span></button>
      <button className={state === 'failed' ? 'active' : ''} onClick={() => setState('failed')}><AlertTriangle size={16}/><span>Failed<strong>{String(counts.failed ?? 0)}</strong></span></button>
    </div>

    <div className="assessment-console">
      <section className="queue-panel panel">
        <div className="console-head"><div><h2><ListOrdered size={16}/> Assessment queue</h2><p>Manual submissions lead; scheduled refresh work follows the worker's real priority order.</p></div><span className="pulse-label"><i/> updates every 2s</span></div>
        <div className="queue-controls">
          <label className="queue-search"><Search size={15}/><input aria-label="Search assessment queue" placeholder="Contract, symbol, name, or job ID" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
          <select aria-label="Assessment source" value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">All sources</option><option value="manual">Manual priority</option><option value="import">Bulk import</option><option value="discovery">Discovery</option><option value="watchlist">Watchlist</option><option value="refresh">Priority refresh</option><option value="universe">Universe refresh</option><option value="maintenance">Maintenance</option></select>
          <select aria-label="Assessment state" value={state} onChange={(event) => setState(event.target.value)}><option value="">All activity</option><option value="active">Active</option><option value="queued">Queued</option><option value="running">Running</option><option value="completed">Recently completed</option><option value="failed">Failed</option></select>
        </div>
        <div className="job-list">
          {jobs.isError ? <div className="notice error">Could not load assessment activity: {jobs.error.message}</div> : null}
          {jobs.data?.data.map((job) => <JobCard key={job.id} job={job} selected={selectedJob === job.id} onSelect={() => setSelectedJob((current) => current === job.id ? null : job.id)}/>)}
          {!jobs.isPending && !jobs.data?.data.length ? <div className="console-empty"><Clock3/><strong>No matching jobs</strong><span>Try another state or source filter.</span></div> : null}
        </div>
      </section>

      <section className="terminal-panel panel" aria-label="Live assessment readout">
        <div className="terminal-head"><div><Terminal size={16}/><strong>{selectedJob ? 'Job timeline' : 'Exploration stream'}</strong></div>{selectedJob ? <button type="button" onClick={() => setSelectedJob(null)}>Show all</button> : <span>LIVE</span>}</div>
        <div className="terminal-screen" aria-live="polite">
          {events.data?.data.map((event) => <div className={`terminal-line event-${event.eventType}`} key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>{event.progressPercent === null ? '···' : String(event.progressPercent).padStart(3, ' ')}%</span><strong>{label(event.stage)}</strong><p>{event.message}</p></div>)}
          {!events.isPending && !events.data?.data.length ? <div className="terminal-empty">No retained assessment events match this view yet.</div> : null}
        </div>
      </section>
    </div>

    <div className="section-label"><span>Provider health</span></div>
    <div className="sourcegrid">{sources.data?.data.map((source) => <article className={`source panel ${source.state}`} key={source.source}><div><Activity/><strong>{source.source.replaceAll('_', ' ')}</strong><span>{source.state.replaceAll('_', ' ')}</span></div><dl><dt>Last success</dt><dd><Age date={source.lastSuccessAt}/></dd><dt>Latency</dt><dd>{source.latencyMs === null ? 'unknown' : `${source.latencyMs} ms`}</dd><dt>Failures</dt><dd>{source.failures}</dd><dt>Message</dt><dd>{source.message ?? 'none'}</dd></dl></article>)}</div>

    <div className="twocol"><form className="panel" onSubmit={(event) => { event.preventDefault(); if (token) localStorage.setItem('doomscout.authToken', token); else localStorage.removeItem('doomscout.authToken'); location.reload(); }}><KeyRound/><h2>Bearer token</h2><p>Stored only in this browser. Required for mutations on non-local deployments.</p><label>Token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)}/></label><button>Save locally</button></form><div className="panel"><h2>In-app alerts</h2><div className="eventlist">{alerts.data?.data.map((alert) => <div key={alert.id}><span className={`direction ${alert.severity === 'critical' ? 'down' : 'up'}`}>{alert.severity}</span><span>{alert.kind}</span><span>{alert.message}</span><span>{new Date(alert.createdAt).toLocaleString()}</span></div>)}{!alerts.data?.data.length ? <p>No retained alerts.</p> : null}</div></div></div>
  </section>;
}
