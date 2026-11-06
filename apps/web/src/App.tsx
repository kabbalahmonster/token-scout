import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { RouteError } from './components/RouteError.js';
import { Discovery } from './pages/Discovery.js';
import { Operations } from './pages/Operations.js';
import { Scoutboard } from './pages/Scoutboard.js';
import { TokenDetail } from './pages/TokenDetail.js';
import { Watchlists } from './pages/Watchlists.js';
import { apiBase } from './base-path.js';

const router = createBrowserRouter([{ element: <Layout/>, errorElement: <RouteError/>, children: [{ path: '/', element: <Scoutboard/> }, { path: '/tokens/:chainId/:address', element: <TokenDetail/> }, { path: '/discovery', element: <Discovery/> }, { path: '/watchlists', element: <Watchlists/> }, { path: '/operations', element: <Operations/> }] }], { basename: import.meta.env.BASE_URL });
export function App() { const cache = useQueryClient(); useEffect(() => {
  const events = new EventSource(`${apiBase}/api/v1/events`);
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let lastRefresh = 0;
  // Coalesce bursts and cap continuous worker updates at one list refresh per
  // 30 seconds. Detail pages retain their own focused refresh intervals.
  events.addEventListener('score.updated', () => {
    if (refresh) return;
    const delay = Math.max(250, 30_000 - (Date.now() - lastRefresh));
    refresh = setTimeout(() => {
      refresh = undefined;
      lastRefresh = Date.now();
      void cache.invalidateQueries({ queryKey: ['candidates'] });
    }, delay);
  });
  return () => { events.close(); if (refresh) clearTimeout(refresh); };
}, [cache]); return <RouterProvider router={router}/>; }
