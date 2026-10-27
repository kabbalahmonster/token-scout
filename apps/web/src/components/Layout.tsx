import { useState } from 'react';
import { Activity, Binoculars, BookOpen, Heart, KeyRound, Radar, Search, ShieldCheck } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

const links = [
  { to: '/', label: 'Scoutboard', icon: Radar },
  { to: '/discovery', label: 'Discovery', icon: Search },
  { to: '/watchlists', label: 'Watchlists', icon: Heart },
  { to: '/operations', label: 'Operations', icon: Activity }
];

export function Layout() {
  const [authToken, setAuthToken] = useState(localStorage.getItem('doomscout.authToken') ?? '');
  const apiBase = import.meta.env.VITE_API_URL ?? '';
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brandmark">D</div><div><strong>DoomScout</strong><span>chain intelligence</span></div></div>
      <nav aria-label="Primary navigation">{links.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={18}/><span>{label}</span></NavLink>)}</nav>
      <div className="boundary"><ShieldCheck size={16}/><span>Read-only research<br/>No wallet. No signing.</span></div>
      <a className="docs" href={`${apiBase}/docs`} target="_blank" rel="noreferrer"><BookOpen size={15}/> API docs</a>
    </aside>
    <main><header className="topbar"><div><Binoculars size={18}/><span>Robinhood Chain</span><code>4663</code></div><form className="quick-auth" onSubmit={(event) => { event.preventDefault(); if (authToken) localStorage.setItem('doomscout.authToken', authToken); else localStorage.removeItem('doomscout.authToken'); location.reload(); }}><KeyRound size={14}/><input aria-label="API bearer token" type="password" autoComplete="off" placeholder="API token" value={authToken} onChange={(event) => setAuthToken(event.target.value)}/><button type="submit">Save</button></form><span className="live"><i/> Live evidence</span></header><Outlet/></main>
  </div>;
}
