import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Copy, Heart, LoaderCircle, SlidersHorizontal } from 'lucide-react';
import type { AssetType, Candidate } from '@doomscout/domain';
import { client } from '../api.js';
import { PriceChart } from '../components/PriceChart.js';
import { Age, Money, StateBadge, VerdictBadge } from '../components/Status.js';

const column = createColumnHelper<Candidate>();
type CandidateSort = 'token' | 'asset_type' | 'score' | 'verdict' | 'state' | 'swing' | 'events_per_day' | 'liquidity' | 'market_cap' | 'volume' | 'volume_liquidity' | 'age' | 'route' | 'route_recovery' | 'flags' | 'updated';
const headerSorts: Record<string, CandidateSort> = { token: 'token', assetType: 'asset_type', score: 'score', verdict: 'verdict', state: 'state', liquidity: 'liquidity', marketCap: 'market_cap', volume: 'volume', age: 'age', swingScore: 'swing', swingEventsPerDay: 'events_per_day', routeState: 'route', flags: 'flags' };
const assetTypeLabels: Record<AssetType, string> = { crypto: 'Crypto', tokenized_stock: 'Tokenized stock', stablecoin: 'Stablecoin' };
type MarketProfile = 'quality' | 'established' | 'maturing' | 'new' | 'all';
interface ScoutboardSettings { search: string; assetType: AssetType | ''; marketProfile: MarketProfile; verdict: string; minScore: string; routeState: string; sort: CandidateSort; direction: 'asc' | 'desc' }
interface FilterPreset { name: string; search: string; assetType?: AssetType | ''; marketProfile?: MarketProfile; verdict: string; minScore: string }
const settingsKey = 'doomscout.scoutboardSettings';
function savedSettings(): Partial<ScoutboardSettings> {
  try { return JSON.parse(localStorage.getItem(settingsKey) ?? '{}') as Partial<ScoutboardSettings>; } catch { return {}; }
}

function SearchInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => onCommit(draft), 350);
    return () => window.clearTimeout(timer);
  }, [draft, onCommit, value]);
  return <input aria-label="Search candidates" placeholder="Symbol, name, or address" value={draft} onChange={(event) => setDraft(event.target.value)}/>;
}

function FilterPanel({ search, setSearch, assetType, setAssetType, marketProfile, setMarketProfile, verdict, setVerdict, minScore, setMinScore, routeState, setRouteState, sort, setSort, direction, setDirection, presets, setPresets, presetName, setPresetName }: {
  search: string; setSearch: Dispatch<SetStateAction<string>>;
  assetType: AssetType | ''; setAssetType: Dispatch<SetStateAction<AssetType | ''>>;
  marketProfile: MarketProfile; setMarketProfile: Dispatch<SetStateAction<MarketProfile>>;
  verdict: string; setVerdict: Dispatch<SetStateAction<string>>;
  minScore: string; setMinScore: Dispatch<SetStateAction<string>>;
  routeState: string; setRouteState: Dispatch<SetStateAction<string>>;
  sort: CandidateSort; setSort: Dispatch<SetStateAction<CandidateSort>>;
  direction: 'asc' | 'desc'; setDirection: Dispatch<SetStateAction<'asc' | 'desc'>>;
  presets: FilterPreset[]; setPresets: Dispatch<SetStateAction<FilterPreset[]>>;
  presetName: string; setPresetName: Dispatch<SetStateAction<string>>;
}) {
  const [open, setOpen] = useState(false);
  const activeFilterCount = [search, assetType, marketProfile === 'all' ? '' : marketProfile, verdict, minScore, routeState].filter(Boolean).length;
  return <div className={`filters-panel${open ? ' open' : ''}`}>
    <button className="filters-toggle" type="button" aria-expanded={open} aria-controls="scoutboard-filters" onClick={() => setOpen((current) => !current)}><span><SlidersHorizontal size={16}/>Filters &amp; sorting{activeFilterCount ? <strong>{activeFilterCount} active</strong> : null}</span><span>{sort.replaceAll('_', ' ')} · {direction === 'desc' ? 'high to low' : 'low to high'}<ChevronDown size={16}/></span></button>
    <div className="filters" id="scoutboard-filters" hidden={!open}>
      <SearchInput value={search} onCommit={setSearch}/>
      <select aria-label="Asset type" value={assetType} onChange={(event) => setAssetType(event.target.value as AssetType | '')}><option value="crypto">Crypto</option><option value="tokenized_stock">Tokenized stocks</option><option value="stablecoin">Stablecoins</option><option value="">All asset types</option></select>
      <select aria-label="Market profile" value={marketProfile} onChange={(event) => setMarketProfile(event.target.value as MarketProfile)}><option value="quality">Quality long-term</option><option value="established">Established (30d+)</option><option value="maturing">Maturing (7d+)</option><option value="new">New (&lt;7d)</option><option value="all">All ages</option></select>
      <select aria-label="Verdict" value={verdict} onChange={(event) => setVerdict(event.target.value)}><option value="">Any verdict</option><option>PASS</option><option>CAUTION</option><option>REJECT</option><option>UNASSESSED</option></select>
      <select aria-label="Route state" value={routeState} onChange={(event) => setRouteState(event.target.value)}><option value="">Any route</option><option value="available">Available</option><option value="not_configured">Not configured</option><option value="no_route_or_liquidity">No route</option><option value="quote_failed">Failed</option><option value="timed_out">Timed out</option><option value="stale">Stale</option></select>
      <select aria-label="Sort candidates" value={sort} onChange={(event) => setSort(event.target.value as CandidateSort)}><option value="token">Token</option><option value="asset_type">Asset type</option><option value="score">Composite score</option><option value="verdict">Verdict</option><option value="state">Lifecycle</option><option value="swing">Swing score</option><option value="events_per_day">Events/day</option><option value="liquidity">Liquidity</option><option value="market_cap">Market cap</option><option value="volume">24h volume</option><option value="volume_liquidity">Volume / liquidity</option><option value="age">Pair age</option><option value="route">Route state</option><option value="route_recovery">Route recovery</option><option value="flags">Detected flags</option><option value="updated">Latest update</option></select>
      <button className="sort-direction" type="button" aria-label={`Sort ${direction === 'desc' ? 'descending' : 'ascending'}; change direction`} onClick={() => setDirection((current) => current === 'desc' ? 'asc' : 'desc')}>{direction === 'desc' ? <ArrowDown size={15}/> : <ArrowUp size={15}/>}</button>
      <input className="small" aria-label="Minimum score" type="number" min="0" max="100" placeholder="Min score" value={minScore} onChange={(event) => setMinScore(event.target.value)}/>
      <select aria-label="Saved filter preset" onChange={(event) => { const preset = presets.find((item) => item.name === event.target.value); if (preset) { setSearch(preset.search); setAssetType(preset.assetType ?? 'crypto'); setMarketProfile(preset.marketProfile ?? 'quality'); setVerdict(preset.verdict); setMinScore(preset.minScore); } }}><option value="">Load preset</option>{presets.map((preset) => <option key={preset.name}>{preset.name}</option>)}</select>
      <input className="small" aria-label="Preset name" placeholder="Preset name" value={presetName} onChange={(event) => setPresetName(event.target.value)}/>
      <button type="button" onClick={() => { if (!presetName.trim()) return; const next = [...presets.filter((item) => item.name !== presetName.trim()), { name: presetName.trim(), search, assetType, marketProfile, verdict, minScore }]; setPresets(next); localStorage.setItem('doomscout.filterPresets', JSON.stringify(next)); setPresetName(''); }}>Save</button>
    </div>
  </div>;
}

function AssessmentChart({ candidate }: { candidate: Candidate }) {
  const history = useQuery({ queryKey: ['history', candidate.chainId, candidate.address], queryFn: () => client.history(candidate.chainId, candidate.address), refetchInterval: 60_000 });
  const snapshots = history.data?.data ?? [];
  return <section className="assessment-chart" aria-label={`${candidate.symbol ?? candidate.address} retained price history`}><div className="assessment-chart-head"><div><strong>Retained price history</strong><span>Tap two points to compare them.</span></div><span>{history.isLoading ? 'loading…' : `${snapshots.length} samples`}</span></div>{history.isError ? <div className="notice error">Could not load retained history: {history.error.message}</div> : history.isLoading ? <div className="assessment-chart-empty">Loading chart…</div> : snapshots.length ? <PriceChart snapshots={snapshots}/> : <div className="assessment-chart-empty">No retained history yet.</div>}</section>;
}

const preferredWatchlistKey = 'doomscout.preferredWatchlist';
type Watchlist = { id: string; name: string; labels: string[] };
function QuickWatch({ candidate, lists, added, pending, failed, onWatch }: { candidate: Candidate; lists: Watchlist[]; added: boolean; pending: boolean; failed: boolean; onWatch: (candidate: Candidate) => void }) {
  const watched = candidate.watched || added;
  const targetName = lists.find((list) => list.id === localStorage.getItem(preferredWatchlistKey))?.name ?? lists[0]?.name;
  const label = watched ? `${candidate.symbol ?? candidate.address} is on a watchlist` : `Add ${candidate.symbol ?? candidate.address} to ${targetName ?? 'a watchlist'}`;
  return <span className="quick-watch-wrap"><button className={`quick-watch${watched ? ' watched' : ''}${failed ? ' failed' : ''}`} type="button" aria-label={label} title={failed ? 'Could not add to watchlist; tap to retry' : label} disabled={watched || pending} onClick={() => onWatch(candidate)}>{pending ? <LoaderCircle className="spin" size={16}/> : <Heart size={16} fill={watched ? 'currentColor' : 'none'}/>}</button>{failed ? <span className="quick-watch-error" role="status">Could not add</span> : null}</span>;
}

export function Scoutboard() {
  const cache = useQueryClient();
  const [initial] = useState(savedSettings);
  const [search, setSearch] = useState(initial.search ?? ''); const [assetType, setAssetType] = useState<AssetType | ''>(initial.assetType ?? 'crypto'); const [marketProfile, setMarketProfile] = useState<MarketProfile>(initial.marketProfile ?? 'quality'); const [verdict, setVerdict] = useState(initial.verdict ?? ''); const [minScore, setMinScore] = useState(initial.minScore ?? ''); const [routeState, setRouteState] = useState(initial.routeState ?? ''); const [sort, setSort] = useState<CandidateSort>(initial.sort ?? 'score'); const [direction, setDirection] = useState<'asc' | 'desc'>(initial.direction ?? 'desc'); const [presetName, setPresetName] = useState('');
  const [page, setPage] = useState(0);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [expandedAddress, setExpandedAddress] = useState<string | null>(null);
  const [addedAddresses, setAddedAddresses] = useState(() => new Set<string>());
  const [watchErrorAddress, setWatchErrorAddress] = useState<string | null>(null);
  const [presets, setPresets] = useState<FilterPreset[]>(() => { try { return JSON.parse(localStorage.getItem('doomscout.filterPresets') ?? '[]') as FilterPreset[]; } catch { return []; } });
  useEffect(() => { localStorage.setItem(settingsKey, JSON.stringify({ search, assetType, marketProfile, verdict, minScore, routeState, sort, direction } satisfies ScoutboardSettings)); }, [search, assetType, marketProfile, verdict, minScore, routeState, sort, direction]);
  const [isMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const pageSize = isMobile ? 25 : 100;
  const params = new URLSearchParams(); if (search) params.set('search', search); if (assetType) params.set('assetType', assetType); if (verdict) params.set('verdict', verdict); if (minScore) params.set('minScore', minScore); if (routeState) params.set('routeState', routeState);
  if (marketProfile === 'quality') { params.set('minPairAgeDays', '30'); params.set('minLiquidityUsd', '25000'); params.set('minVolumeUsd', '1000'); if (!minScore || Number(minScore) < 50) params.set('minScore', '50'); }
  else if (marketProfile === 'established') params.set('minPairAgeDays', '30');
  else if (marketProfile === 'maturing') params.set('minPairAgeDays', '7');
  else if (marketProfile === 'new') params.set('maxPairAgeDays', '7');
  params.set('sort', sort); params.set('direction', direction); params.set('limit', String(pageSize + 1)); params.set('offset', String(page * pageSize));
  const queryString = params.size ? `?${params}` : '';
  const query = useQuery({ queryKey: ['candidates', params.toString()], queryFn: ({ signal }) => client.candidates(queryString, signal), placeholderData: (previous) => previous, staleTime: 20_000, refetchInterval: 60_000 });
  useEffect(() => setPage(0), [search, assetType, marketProfile, verdict, minScore, routeState, sort, direction]);
  const watchlists = useQuery({ queryKey: ['watchlists'], queryFn: client.watchlists, staleTime: 60_000 });
  const watch = useMutation({
    mutationFn: async (candidate: Candidate) => {
      let available = watchlists.data?.data ?? [];
      if (!available.length) {
        const created = await client.createWatchlist('Main watchlist');
        available = [{ id: created.id, name: 'Main watchlist', labels: [] }];
        await cache.invalidateQueries({ queryKey: ['watchlists'] });
      }
      const preferredId = localStorage.getItem(preferredWatchlistKey);
      const target = available.find((list) => list.id === preferredId) ?? available[0];
      if (!target) throw new Error('Could not create a watchlist');
      localStorage.setItem(preferredWatchlistKey, target.id);
      await client.addWatchlistItem(target.id, candidate.chainId, candidate.address);
    },
    onMutate: () => setWatchErrorAddress(null),
    onSuccess: async (_, candidate) => {
      setAddedAddresses((current) => new Set(current).add(candidate.address));
      await cache.invalidateQueries({ queryKey: ['candidates'] });
    },
    onError: (_, candidate) => setWatchErrorAddress(candidate.address)
  });
  const columns = useMemo(() => [
    column.accessor((row) => row.symbol ?? row.address, { id: 'token', header: 'Token', cell: ({ row }) => { const candidate = row.original; const copied = copiedAddress === candidate.address; return <div className="token-cell"><div className="token"><strong>{candidate.symbol ?? 'UNKNOWN'}</strong><span>{candidate.name ?? `${candidate.address.slice(0, 8)}…${candidate.address.slice(-5)}`}</span><span className="mobile-market-cap">MCap <Money value={candidate.latestSnapshot?.marketCapUsd}/></span></div><button className={`copy-address${copied ? ' copied' : ''}`} type="button" title={candidate.address} aria-label={`${copied ? 'Copied' : 'Copy'} contract address ${candidate.address}`} onClick={() => { void navigator.clipboard.writeText(candidate.address).then(() => { setCopiedAddress(candidate.address); window.setTimeout(() => setCopiedAddress((current) => current === candidate.address ? null : current), 1500); }); }}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button></div>; } }),
    column.accessor((row) => row.latestSnapshot?.marketCapUsd, { id: 'marketCap', header: 'Market cap', cell: (info) => <Money value={info.getValue()}/> }),
    column.accessor('assetType', { header: 'Asset type', cell: (info) => <span className={`asset-type asset-${info.getValue()}`}>{assetTypeLabels[info.getValue()]}</span> }),
    column.accessor('score', { header: 'Score', cell: ({ row }) => <div className="score"><strong>{row.original.score ?? '—'}</strong><span>{row.original.confidence}% confidence</span></div> }),
    column.accessor('verdict', { header: 'Verdict', cell: (info) => <VerdictBadge verdict={info.getValue()}/> }),
    column.accessor('state', { header: 'Lifecycle', cell: (info) => <StateBadge state={info.getValue()}/> }),
    column.accessor((row) => row.latestSnapshot?.liquidityUsd, { id: 'liquidity', header: 'Liquidity', cell: (info) => <Money value={info.getValue()}/> }),
    column.accessor((row) => row.latestSnapshot?.volume24hUsd, { id: 'volume', header: '24h volume', cell: (info) => <Money value={info.getValue()}/> }),
    column.accessor((row) => row.latestSnapshot?.pairCreatedAt, { id: 'age', header: 'Pair age', cell: (info) => <Age date={info.getValue()}/> }),
    column.accessor('swingScore', { header: 'Swing', cell: (info) => info.getValue() === null || info.getValue() === undefined ? <span className="unknown">collecting</span> : `${info.getValue()!.toFixed(0)}/100` }),
    column.accessor('swingEventsPerDay', { header: 'Events/day', cell: (info) => info.getValue() === null || info.getValue() === undefined ? <span className="unknown">collecting</span> : info.getValue()!.toFixed(2) }),
    column.accessor('routeState', { header: 'Route', cell: (info) => <StateBadge state={info.getValue() ?? 'not_attempted'}/> }),
    column.display({ id: 'flags', header: 'Flags', cell: ({ row }) => { const flags = row.original.flags.filter((flag) => flag.state === 'detected'); return <span className={flags.length ? 'flag-count' : 'muted'}>{flags.length ? <><AlertTriangle size={14}/>{flags.length}</> : 'none detected*'}</span>; } }),
    column.display({ id: 'go', cell: ({ row }) => { const candidate = row.original; const expanded = expandedAddress === candidate.address; return <div className="row-actions"><QuickWatch candidate={candidate} lists={watchlists.data?.data ?? []} added={addedAddresses.has(candidate.address)} pending={watch.isPending && watch.variables.address === candidate.address} failed={watchErrorAddress === candidate.address} onWatch={(selected) => watch.mutate(selected)}/><button className="row-expand" type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${candidate.symbol ?? candidate.address} assessment`} aria-expanded={expanded} onClick={() => setExpandedAddress((current) => current === candidate.address ? null : candidate.address)}>{expanded ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}</button></div>; } })
  ], [addedAddresses, copiedAddress, expandedAddress, watch.isPending, watch.variables, watchErrorAddress, watchlists.data?.data]);
  const candidateData = query.data?.data;
  const pageCandidates = useMemo(() => (candidateData ?? []).slice(0, pageSize), [candidateData, pageSize]);
  const hasNextPage = (query.data?.data.length ?? 0) > pageSize;
  const columnVisibility = useMemo(() => isMobile ? { marketCap: false, assetType: false, state: false, liquidity: false, volume: false, age: false, swingScore: false, swingEventsPerDay: false, routeState: false, flags: false } : {}, [isMobile]);
  const table = useReactTable({
    data: pageCandidates,
    columns,
    state: { columnVisibility },
    getCoreRowModel: getCoreRowModel()
  });
  return <section className="page">
    <div className="pagehead"><div><p className="eyebrow">Candidate intelligence</p><h1>Scoutboard</h1><p>Ranked for grid/gridless suitability—not hype, safety, or predicted profit.</p></div><div className="stat"><strong>{pageCandidates.length}</strong><span>visible candidates · page {page + 1}</span></div></div>
    <FilterPanel search={search} setSearch={setSearch} assetType={assetType} setAssetType={setAssetType} marketProfile={marketProfile} setMarketProfile={setMarketProfile} verdict={verdict} setVerdict={setVerdict} minScore={minScore} setMinScore={setMinScore} routeState={routeState} setRouteState={setRouteState} sort={sort} setSort={setSort} direction={direction} setDirection={setDirection} presets={presets} setPresets={setPresets} presetName={presetName} setPresetName={setPresetName}/>
    {query.isError ? <div className="notice error">Could not load candidates: {query.error.message}</div> : null}
    <div className="tablewrap"><table className="candidate-table"><thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => { const headerSort = headerSorts[header.id]; const active = headerSort === sort; return <th key={header.id} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>{headerSort ? <button className={`sort-header${active ? ' active' : ''}`} type="button" onClick={() => { if (active) setDirection((current) => current === 'desc' ? 'asc' : 'desc'); else { setSort(headerSort); setDirection(headerSort === 'token' || headerSort === 'asset_type' ? 'asc' : 'desc'); } }}>{flexRender(header.column.columnDef.header, header.getContext())}{active ? (direction === 'desc' ? <ArrowDown size={12}/> : <ArrowUp size={12}/>) : <ArrowUpDown size={12}/>}</button> : flexRender(header.column.columnDef.header, header.getContext())}</th>; })}</tr>)}</thead><tbody>{query.isLoading ? <tr><td colSpan={columns.length}>Loading retained evidence…</td></tr> : table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => { const candidate = row.original; const expanded = expandedAddress === candidate.address; const detectedFlags = candidate.flags.filter((flag) => flag.state === 'detected'); const toggle = () => setExpandedAddress((current) => current === candidate.address ? null : candidate.address); return <Fragment key={row.id}><tr className={`candidate-row${expanded ? ' expanded' : ''}`} tabIndex={0} aria-expanded={expanded} onClick={(event) => { if (!(event.target as HTMLElement).closest('a,button,input,select,textarea')) toggle(); }} onKeyDown={(event) => { if ((event.target as HTMLElement).closest('a,button,input,select,textarea')) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } }}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>{expanded ? <tr className="candidate-expanded-row"><td colSpan={columns.length}><div className="assessment-summary"><div className="assessment-summary-head"><div><span className="eyebrow">Assessment snapshot</span><strong>{candidate.symbol ?? candidate.name ?? 'Unknown token'}</strong></div><Link className="button secondary" to={`/tokens/${candidate.chainId}/${candidate.address}`}>Full assessment <ChevronRight size={15}/></Link></div><div className="assessment-metrics"><span>Asset<strong>{assetTypeLabels[candidate.assetType]}</strong></span><span>Confidence<strong>{candidate.confidence}/100</strong></span><span>Lifecycle<strong>{candidate.state.replaceAll('_', ' ')}</strong></span><span>Market cap<strong><Money value={candidate.latestSnapshot?.marketCapUsd}/></strong></span><span>Liquidity<strong><Money value={candidate.latestSnapshot?.liquidityUsd}/></strong></span><span>24h volume<strong><Money value={candidate.latestSnapshot?.volume24hUsd}/></strong></span><span>Pair age<strong><Age date={candidate.latestSnapshot?.pairCreatedAt}/></strong></span><span>Swing<strong>{candidate.swingScore === null || candidate.swingScore === undefined ? 'collecting' : `${candidate.swingScore.toFixed(0)}/100`}</strong></span><span>Events/day<strong>{candidate.swingEventsPerDay === null || candidate.swingEventsPerDay === undefined ? 'collecting' : candidate.swingEventsPerDay.toFixed(2)}</strong></span><span>Route<strong>{(candidate.routeState ?? 'not_attempted').replaceAll('_', ' ')}</strong></span></div><AssessmentChart candidate={candidate}/><div className={`assessment-flags${detectedFlags.length ? ' detected' : ''}`}><AlertTriangle size={15}/><div><strong>{detectedFlags.length ? `${detectedFlags.length} detected flag${detectedFlags.length === 1 ? '' : 's'}` : 'No static flags detected*'}</strong>{detectedFlags.length ? <span>{detectedFlags.map((flag) => flag.label).join(' · ')}</span> : <span>Static analysis is not an audit or safety guarantee.</span>}</div></div></div></td></tr> : null}</Fragment>; }) : <tr><td colSpan={columns.length}><div className="empty"><strong>No candidates match these filters.</strong><span>Change the market profile or asset type.</span></div></td></tr>}</tbody></table></div>
    <nav className="pagination" aria-label="Scoutboard pages"><button type="button" disabled={page === 0 || query.isFetching} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button><span>Page {page + 1}{query.isFetching ? ' · refreshing…' : ''}</span><button type="button" disabled={!hasNextPage || query.isFetching} onClick={() => setPage((current) => current + 1)}>Next</button></nav>
    <p className="footnote">* Static analysis is not an audit. “None detected” never means safe.</p>
  </section>;
}
