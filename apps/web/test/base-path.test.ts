import { describe, expect, it } from 'vitest';
import { resolveApiBase } from '../src/base-path.js';

describe('API base path', () => {
  it('uses root-relative API routes for a root deployment', () => {
    expect(resolveApiBase(undefined, '/')).toBe('');
  });

  it('uses the app base for a subpath deployment', () => {
    expect(resolveApiBase(undefined, '/doomscout/')).toBe('/doomscout');
  });

  it('prefers and normalizes an explicit API URL', () => {
    expect(resolveApiBase('https://api.example.test/', '/doomscout/')).toBe('https://api.example.test');
  });
});
