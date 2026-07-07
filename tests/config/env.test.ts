import { describe, it, expect } from 'vitest';
import { loadEnv } from '@/config/env';

function completeStub(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    GITHUB_WEBHOOK_SECRET: 'whsec',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'line1\\nline2',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srk',
    SCAN_CONCURRENCY: '8',
    MAX_SCAN_FILES: '2000',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadEnv', () => {
  it('1. returns every field with numbers parsed', () => {
    const env = loadEnv(completeStub());
    expect(env.githubWebhookSecret).toBe('whsec');
    expect(env.githubAppId).toBe('12345');
    expect(env.supabaseUrl).toBe('https://x.supabase.co');
    expect(env.supabaseServiceRoleKey).toBe('srk');
    expect(env.scanConcurrency).toBe(8);
    expect(env.maxScanFiles).toBe(2000);
  });

  it('2. throws naming the first missing required var', () => {
    expect(() => loadEnv(completeStub({ GITHUB_WEBHOOK_SECRET: undefined }))).toThrow(
      /GITHUB_WEBHOOK_SECRET/,
    );
  });

  it('3. un-escapes literal \\n in the private key', () => {
    const env = loadEnv(completeStub());
    expect(env.githubAppPrivateKey).toBe('line1\nline2');
    expect(env.githubAppPrivateKey).toContain('\n');
    expect(env.githubAppPrivateKey).not.toContain('\\n');
  });

  it('4. SCAN_CONCURRENCY: unset -> 8, "abc" -> 8, "16" -> 16', () => {
    expect(loadEnv(completeStub({ SCAN_CONCURRENCY: undefined })).scanConcurrency).toBe(8);
    expect(loadEnv(completeStub({ SCAN_CONCURRENCY: 'abc' })).scanConcurrency).toBe(8);
    expect(loadEnv(completeStub({ SCAN_CONCURRENCY: '16' })).scanConcurrency).toBe(16);
  });

  it('5. MAX_SCAN_FILES unset -> 2000', () => {
    expect(loadEnv(completeStub({ MAX_SCAN_FILES: undefined })).maxScanFiles).toBe(2000);
  });

  it('does not mutate the source object', () => {
    const stub = completeStub();
    const before = { ...stub };
    loadEnv(stub);
    expect(stub).toEqual(before);
  });
});
