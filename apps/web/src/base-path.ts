export function resolveApiBase(apiUrl: string | undefined, appBaseUrl: string): string {
  if (apiUrl !== undefined) return apiUrl.replace(/\/$/, '');
  return appBaseUrl === '/' ? '' : appBaseUrl.replace(/\/$/, '');
}

export const apiBase = resolveApiBase(import.meta.env.VITE_API_URL, import.meta.env.BASE_URL);
