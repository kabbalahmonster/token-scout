import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileUp, Radar } from 'lucide-react';
import { client, type AssessmentQueued, type QueueStatus } from '../api.js';

function waitLabel(seconds: number): string {
  if (seconds < 10) return 'under 10 seconds';
  if (seconds < 60) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function QueueNotice({ submission, status }: { submission: AssessmentQueued; status: QueueStatus | undefined }) {
  const queue = status ?? submission.queue;
  if (!queue) return <div className="notice success">High-priority assessment queued.</div>;
  if (queue.state === 'running') return <div className="notice success">Assessment is running now for {submission.address.slice(0, 10)}…</div>;
  if (queue.state === 'completed') return <div className="notice success">Assessment complete. It is now available on the Scoutboard.</div>;
  if (queue.state === 'failed') return <div className="notice error">Assessment failed after its retry budget. Check Operations for provider health.</div>;
  return <div className="notice success">High priority · queue position {queue.position ?? '—'} · estimated start {waitLabel(queue.estimatedWaitSeconds)}.</div>;
}

export function Discovery() {
  const [address, setAddress] = useState(''); const [csv, setCsv] = useState(''); const [submission, setSubmission] = useState<AssessmentQueued | null>(null);
  const assess = useMutation({ mutationFn: () => client.assess(address), onSuccess: (queued) => { setSubmission(queued); setAddress(''); } });
  const job = useQuery({
    queryKey: ['job', submission?.jobId],
    queryFn: () => client.job(submission!.jobId),
    enabled: Boolean(submission?.jobId),
    initialData: submission?.queue ?? undefined,
    refetchInterval: (query) => ['completed', 'failed'].includes(query.state.data?.state ?? '') ? false : 2_000
  });
  const bulk = useMutation({ mutationFn: () => client.import(csv), onSuccess: () => setCsv('') });
  return <section className="page"><div className="pagehead"><div><p className="eyebrow">Lead intake</p><h1>Discovery inbox</h1><p>Validate a Robinhood Chain contract or import a bounded address list.</p></div></div><div className="twocol forms"><form className="panel" onSubmit={(event) => { event.preventDefault(); assess.mutate(); }}><Radar/><h2>Assess one contract</h2><p>Manual assessments jump to the front of the queue. The worker checks bytecode before polling market and route sources.</p><label>Token contract<input required pattern="^0x[a-fA-F0-9]{40}$" placeholder="0x…" value={address} onChange={(event) => setAddress(event.target.value)}/></label><button disabled={assess.isPending}>{assess.isPending ? 'Queueing…' : 'Queue priority assessment'}</button>{submission ? <QueueNotice submission={submission} status={job.data}/> : null}{assess.isError ? <div className="notice error">{assess.error.message}</div> : null}</form><form className="panel" onSubmit={(event) => { event.preventDefault(); bulk.mutate(); }}><FileUp/><h2>CSV / line import</h2><p>Maximum 500 addresses. A 100-token import can create roughly 600 upstream calls and is rate-budgeted.</p><label>Addresses<textarea required rows={8} placeholder={'0x123…\n0x456…'} value={csv} onChange={(event) => setCsv(event.target.value)}/></label><button disabled={bulk.isPending}>{bulk.isPending ? 'Validating…' : 'Validate and queue'}</button>{bulk.data ? <div className="notice success">Accepted {bulk.data.accepted}; approximately {bulk.data.estimatedRequests} source requests.</div> : null}{bulk.isError ? <div className="notice error">{bulk.error.message}</div> : null}</form></div></section>;
}
