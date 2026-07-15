import type { MetadataRoute } from 'next';
import { loadDashboardEnv } from '@/config/env';

/**
 * Resolve the public base URL for the sitemap. Mirrors the defensive pattern in
 * `sessionState.ts`: `loadDashboardEnv()` throws when dashboard env vars are unset
 * (webhook-only deploys), so any throw falls back to localhost.
 */
function baseUrl(): string {
  try {
    return loadDashboardEnv().baseUrl;
  } catch {
    return 'http://localhost:3000';
  }
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${baseUrl()}/`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 1,
    },
  ];
}
