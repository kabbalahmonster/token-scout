const adminUrl = 'http://127.0.0.1:2019';
const routePath = '/config/apps/http/servers/srv0/routes';

const proxy = (dial) => ({ handler: 'reverse_proxy', upstreams: [{ dial }] });
const prefixedProxy = (path, dial, group = 'doomscout-handler') => ({
  group,
  match: [{ path: [path] }],
  handle: [{
    handler: 'subroute',
    routes: [
      { handle: [{ handler: 'rewrite', strip_path_prefix: '/doomscout' }] },
      { handle: [proxy(dial)] }
    ]
  }]
});

const doomScoutRoute = {
  match: [{ host: ['doomdash.ca'], path: ['/doomscout', '/doomscout/*'] }],
  handle: [{
    handler: 'subroute',
    routes: [
      {
        group: 'doomscout-handler',
        match: [{ path: ['/doomscout'] }],
        handle: [{ handler: 'static_response', status_code: 308, headers: { Location: ['/doomscout/'] } }]
      },
      prefixedProxy('/doomscout/api/*', '127.0.0.1:3001'),
      prefixedProxy('/doomscout/docs*', '127.0.0.1:3001'),
      prefixedProxy('/doomscout/*', '127.0.0.1:4174')
    ]
  }],
  terminal: true
};

async function ensureRoute() {
  const response = await fetch(`${adminUrl}${routePath}`);
  if (!response.ok) throw new Error(`Caddy config read failed (${response.status})`);
  const routes = await response.json();
  const configured = routes.some((route) => {
    const value = JSON.stringify(route);
    return value.includes('/doomscout/*') && value.includes('127.0.0.1:4174');
  });
  if (configured) return;

  const update = await fetch(`${adminUrl}${routePath}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([doomScoutRoute, ...routes])
  });
  if (!update.ok) throw new Error(`Caddy config update failed (${update.status}): ${await update.text()}`);
}

let lastError;
for (let attempt = 1; attempt <= 30; attempt += 1) {
  try {
    await ensureRoute();
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.error(`Caddy route attempt ${attempt} failed:`, error instanceof Error ? error.message : error);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
throw lastError;
