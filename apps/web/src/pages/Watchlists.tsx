import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Heart, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { client } from '../api.js';
import { CandidateMarketCap, Money, VerdictBadge } from '../components/Status.js';

export function Watchlists() {
  const [name, setName] = useState('');
  const [listId, setListId] = useState('');
  const [candidateKey, setCandidateKey] = useState('');
  const cache = useQueryClient();
  const lists = useQuery({ queryKey: ['watchlists'], queryFn: client.watchlists });
  const candidates = useQuery({ queryKey: ['candidates', 'watch-picker'], queryFn: () => client.candidates('?limit=500') });
  useEffect(() => { if (!listId && lists.data?.data[0]) setListId(lists.data.data[0].id); }, [listId, lists.data]);
  const items = useQuery({ queryKey: ['watchlist-items', listId], queryFn: () => client.watchlistItems(listId), enabled: Boolean(listId), refetchInterval: 60_000 });
  const create = useMutation({ mutationFn: () => client.createWatchlist(name), onSuccess: async (created) => { setName(''); setListId(created.id); await cache.invalidateQueries({ queryKey: ['watchlists'] }); } });
  const add = useMutation({ mutationFn: async () => { const [chainId, address] = candidateKey.split(':'); if (!listId || !chainId || !address) throw new Error('Choose a watchlist and candidate'); await client.addWatchlistItem(listId, Number(chainId), address); }, onSuccess: async () => { setCandidateKey(''); await Promise.all([cache.invalidateQueries({ queryKey: ['watchlist-items', listId] }), cache.invalidateQueries({ queryKey: ['candidates'] })]); } });
  const remove = useMutation({ mutationFn: ({ chainId, address }: { chainId: number; address: string }) => client.removeWatchlistItem(listId, chainId, address), onSuccess: async () => { await Promise.all([cache.invalidateQueries({ queryKey: ['watchlist-items', listId] }), cache.invalidateQueries({ queryKey: ['candidates'] })]); } });
  const selected = lists.data?.data.find((list) => list.id === listId);

  return <section className="page">
    <div className="pagehead"><div><p className="eyebrow">Tracked research</p><h1>Watchlists</h1><p>View and manage the candidates receiving watched polling.</p></div><div className="stat"><strong>{items.data?.data.length ?? 0}</strong><span>tokens in {selected?.name ?? 'watchlist'}</span></div></div>
    <div className="twocol watchlist-forms">
      <form className="inlineform" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><input required maxLength={80} placeholder="New watchlist name" value={name} onChange={(event) => setName(event.target.value)}/><button disabled={create.isPending}>Create</button></form>
      <form className="inlineform" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}><select required aria-label="Watchlist" value={listId} onChange={(event) => setListId(event.target.value)}><option value="">Choose watchlist</option>{lists.data?.data.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select><select required aria-label="Candidate" value={candidateKey} onChange={(event) => setCandidateKey(event.target.value)}><option value="">Choose candidate</option>{candidates.data?.data.map((candidate) => <option key={`${candidate.chainId}:${candidate.address}`} value={`${candidate.chainId}:${candidate.address}`}>{candidate.symbol ?? candidate.address}</option>)}</select><button disabled={add.isPending}>Watch</button></form>
    </div>
    {add.isSuccess ? <div className="notice success">Candidate added; watched polling is now active.</div> : null}
    {create.isError || add.isError || remove.isError ? <div className="notice error">{create.error?.message ?? add.error?.message ?? remove.error?.message}</div> : null}
    {lists.data?.data.length ? <div className="watchlist-tabs" aria-label="Choose a watchlist">{lists.data.data.map((list) => <button key={list.id} type="button" className={list.id === listId ? 'active' : ''} aria-pressed={list.id === listId} onClick={() => setListId(list.id)}><Heart size={15} fill={list.id === listId ? 'currentColor' : 'none'}/>{list.name}</button>)}</div> : null}
    {items.isError ? <div className="notice error">Could not load this watchlist: {items.error.message}</div> : null}
    {items.isLoading ? <div className="empty"><strong>Loading watchlist…</strong></div> : items.data?.data.length ? <div className="tablewrap watchlist-wrap"><table className="watchlist-table"><thead><tr><th>Token</th><th>Verdict</th><th>Score</th><th>Liquidity</th><th>Market cap</th><th>24h volume</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{items.data.data.map(({ candidate, addedAt }) => <tr key={`${candidate.chainId}:${candidate.address}`}><td><Link className="token" to={`/tokens/${candidate.chainId}/${candidate.address}`}><strong>{candidate.symbol ?? 'Unknown'}</strong><span>{candidate.name ?? `${candidate.address.slice(0, 8)}…${candidate.address.slice(-6)}`}</span></Link></td><td><VerdictBadge verdict={candidate.verdict}/></td><td><span className="score"><strong>{candidate.score?.toFixed(1) ?? '—'}</strong><span>{candidate.confidence}% confidence</span></span></td><td><Money value={candidate.latestSnapshot?.liquidityUsd}/></td><td><CandidateMarketCap candidate={candidate}/></td><td><Money value={candidate.latestSnapshot?.volume24hUsd}/></td><td>{new Date(addedAt).toLocaleDateString()}</td><td><div className="watchlist-actions"><Link className="button secondary" aria-label={`View ${candidate.symbol ?? candidate.address}`} to={`/tokens/${candidate.chainId}/${candidate.address}`}><ExternalLink size={15}/></Link><button className="remove-watch" type="button" aria-label={`Remove ${candidate.symbol ?? candidate.address} from ${selected?.name ?? 'watchlist'}`} disabled={remove.isPending} onClick={() => remove.mutate({ chainId: candidate.chainId, address: candidate.address })}><Trash2 size={15}/></button></div></td></tr>)}</tbody></table></div> : <div className="empty"><Heart/><strong>{lists.data?.data.length ? 'This watchlist is empty' : 'No watchlists'}</strong><span>{lists.data?.data.length ? 'Choose a candidate above or add one from Scoutboard.' : 'Create one to organize candidates and enable watched polling.'}</span></div>}
  </section>;
}
