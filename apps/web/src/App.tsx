import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { Discovery } from './pages/Discovery.js';
import { Operations } from './pages/Operations.js';
import { Scoutboard } from './pages/Scoutboard.js';
import { TokenDetail } from './pages/TokenDetail.js';
import { Watchlists } from './pages/Watchlists.js';

const router = createBrowserRouter([{ element: <Layout/>, children: [{ path: '/', element: <Scoutboard/> }, { path: '/tokens/:chainId/:address', element: <TokenDetail/> }, { path: '/discovery', element: <Discovery/> }, { path: '/watchlists', element: <Watchlists/> }, { path: '/operations', element: <Operations/> }] }]);
export function App() { const cache = useQueryClient(); useEffect(() => { const events = new EventSource('/api/v1/events'); events.addEventListener('score.updated', () => { void cache.invalidateQueries({ queryKey: ['candidates'] }); }); return () => events.close(); }, [cache]); return <RouterProvider router={router}/>; }
