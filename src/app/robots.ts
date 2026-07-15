import type { MetadataRoute } from 'next';
import { loadDashboardEnv } from '@/config/env';

/**
 * Resolve the public base URL for SEO routes. Mirrors the defensive pattern in
 * `sessionState.ts`: `loadDashboardEnv()` throws when dashboard env vars are unset
 * (webhook-only deploys), so any throw falls back to localhost rather than crashing
 * the metadata route.
 */
function baseUrl(): string {
  try {
    return loadDashboardEnv().baseUrl;
  } catch {
    return 'http://localhost:3000';
  }
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/dashboard', '/api/'],
    },
    sitemap: `${baseUrl()}/sitemap.xml`,
  };
}
