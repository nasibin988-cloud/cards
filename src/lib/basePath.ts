/**
 * Single source of truth for the deploy-time basePath.
 *
 * Next.js auto-prefixes `<Link>` and route resolution, but a few APIs
 * (Service Worker registration, fetch URLs to public/ assets, library
 * `locateFile` callbacks) take raw strings that bypass that prefix. Use
 * `withBasePath('/sw.js')` for those.
 *
 * The value is baked at build time via `NEXT_PUBLIC_BASE_PATH`; it's an
 * empty string for the local launchctl service and `/cards` for the
 * Hetzner deploy.
 */

export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '');

export function withBasePath(path: string): string {
  if (!path.startsWith('/')) return path;
  return `${BASE_PATH}${path}`;
}
