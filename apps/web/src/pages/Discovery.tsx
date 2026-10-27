import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FileUp, Radar } from 'lucide-react';
import { client } from '../api.js';

export function Discovery() {
  const [address, setAddress] = useState(''); const [csv, setCsv] = useState('');
  const assess = useMutation({ mutationFn: () => client.assess(address), onSuccess: () => setAddress('') });
  const bulk = useMutation({ mutationFn: () => client.import(csv), onSuccess: () => setCsv('') });
  return <section className="page"><div className="pagehead"><div><p className="eyebrow">Lead intake</p><h1>Discovery inbox</h1><p>Validate a Robinhood Chain contract or import a bounded address list.</p></div></div><div className="twocol forms"><form className="panel" onSubmit={(event) => { event.preventDefault(); assess.mutate(); }}><Radar/><h2>Assess one contract</h2><p>The worker checks bytecode before polling market and route sources.</p><label>Token contract<input required pattern="^0x[a-fA-F0-9]{40}$" placeholder="0x…" value={address} onChange={(event) => setAddress(event.target.value)}/></label><button disabled={assess.isPending}>{assess.isPending ? 'Queueing…' : 'Queue assessment'}</button>{assess.isSuccess ? <div className="notice success">Assessment queued. It will appear on the Scoutboard.</div> : null}{assess.isError ? <div className="notice error">{assess.error.message}</div> : null}</form><form className="panel" onSubmit={(event) => { event.preventDefault(); bulk.mutate(); }}><FileUp/><h2>CSV / line import</h2><p>Maximum 500 addresses. A 100-token import can create roughly 600 upstream calls and is rate-budgeted.</p><label>Addresses<textarea required rows={8} placeholder={'0x123…\n0x456…'} value={csv} onChange={(event) => setCsv(event.target.value)}/></label><button disabled={bulk.isPending}>{bulk.isPending ? 'Validating…' : 'Validate and queue'}</button>{bulk.data ? <div className="notice success">Accepted {bulk.data.accepted}; approximately {bulk.data.estimatedRequests} source requests.</div> : null}{bulk.isError ? <div className="notice error">{bulk.error.message}</div> : null}</form></div></section>;
}
