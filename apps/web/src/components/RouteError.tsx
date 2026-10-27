import { AlertTriangle } from 'lucide-react';
import { Link, useRouteError } from 'react-router-dom';

export function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : 'The page could not be rendered.';
  return <main className="page"><div className="panel notice error"><AlertTriangle/><h1>DoomScout hit a UI error</h1><p>{message}</p><p>No research data was changed. Reload this page; if it repeats, check Operations.</p><Link className="button" to="/">Return to Scoutboard</Link></div></main>;
}
