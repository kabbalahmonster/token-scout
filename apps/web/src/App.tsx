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

const apiBase = import.meta.env.VITE_API_URL ?? '';
const router = createBrowserRouter([{ element: <Layout/>, errorElement: <RouteError/>, children: [{ path: '/', element: <Scoutboard/> }, { path: '/tokens/:chainId/:address', element: <TokenDetail/> }, { path: '/discovery', element: <Discovery/> }, { path: '/watchlists', element: <Watchlists/> }, { path: '/operations', element: <Operations/> }] }], { basename: import.meta.env.BASE_URL });
export function App() { const cache = useQueryClient(); useEffect(() => {
  const events = new EventSource(`${apiBase}/api/v1/events`);
  let refresh: ReturnType<typeof setTimeout> | undefined;
  // A worker cycle can update many scores together. Coalesce that burst into
  // one refresh instead of issuing a request for every candidate event.
  events.addEventListener('score.updated', () => {
    if (refresh) clearTimeout(refresh);
    refresh = setTimeout(() => { void cache.invalidateQueries({ queryKey: ['candidates'] }); }, 250);
  });
  return () => { events.close(); if (refresh) clearTimeout(refresh); };
}, [cache]); return <RouterProvider router={router}/>; }
