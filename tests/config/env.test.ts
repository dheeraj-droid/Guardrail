import { describe, it, expect } from 'vitest';
import { loadEnv, loadQueueEnv, isQueueConfigured } from '@/config/env';

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

  it('v2.1 MAX_REF_RESOLUTION_DEPTH/MAX_FRONTEND_LINKS_CONCURRENCY unset -> defaults 5 and 3', () => {
    const env = loadEnv(
      completeStub({ MAX_REF_RESOLUTION_DEPTH: undefined, MAX_FRONTEND_LINKS_CONCURRENCY: undefined }),
    );
    expect(env.maxRefResolutionDepth).toBe(5);
    expect(env.maxFrontendLinksConcurrency).toBe(3);
  });

  it('v2.2 MAX_REF_RESOLUTION_DEPTH/MAX_FRONTEND_LINKS_CONCURRENCY set to valid positive integers -> parsed values', () => {
    const env = loadEnv(
      completeStub({ MAX_REF_RESOLUTION_DEPTH: '9', MAX_FRONTEND_LINKS_CONCURRENCY: '4' }),
    );
    expect(env.maxRefResolutionDepth).toBe(9);
    expect(env.maxFrontendLinksConcurrency).toBe(4);
  });

  it('v2.3 MAX_REF_RESOLUTION_DEPTH/MAX_FRONTEND_LINKS_CONCURRENCY invalid values -> fall back to defaults', () => {
    const env1 = loadEnv(
      completeStub({ MAX_REF_RESOLUTION_DEPTH: '-1', MAX_FRONTEND_LINKS_CONCURRENCY: 'abc' }),
    );
    expect(env1.maxRefResolutionDepth).toBe(5);
    expect(env1.maxFrontendLinksConcurrency).toBe(3);

    const env2 = loadEnv(
      completeStub({ MAX_REF_RESOLUTION_DEPTH: 'abc', MAX_FRONTEND_LINKS_CONCURRENCY: '-1' }),
    );
    expect(env2.maxRefResolutionDepth).toBe(5);
    expect(env2.maxFrontendLinksConcurrency).toBe(3);
  });
});

function completeQueueStub(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    QSTASH_TOKEN: 'qstash-token',
    QSTASH_CURRENT_SIGNING_KEY: 'current-key',
    QSTASH_NEXT_SIGNING_KEY: 'next-key',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadQueueEnv', () => {
  it('v2.4 returns the typed object when all three QSTASH_* vars are set', () => {
    const env = loadQueueEnv(completeQueueStub());
    expect(env).toEqual({
      qstashToken: 'qstash-token',
      qstashCurrentSigningKey: 'current-key',
      qstashNextSigningKey: 'next-key',
    });
  });

  it('v2.5 throws "Missing required env var: <NAME>" when any one of the three is missing', () => {
    expect(() =>
      loadQueueEnv(completeQueueStub({ QSTASH_TOKEN: undefined })),
    ).toThrow(/Missing required env var: QSTASH_TOKEN/);
    expect(() =>
      loadQueueEnv(completeQueueStub({ QSTASH_CURRENT_SIGNING_KEY: undefined })),
    ).toThrow(/Missing required env var: QSTASH_CURRENT_SIGNING_KEY/);
    expect(() =>
      loadQueueEnv(completeQueueStub({ QSTASH_NEXT_SIGNING_KEY: undefined })),
    ).toThrow(/Missing required env var: QSTASH_NEXT_SIGNING_KEY/);
  });

  it('v2.7 memoizes across calls with no source override; an explicit source bypasses the memo', () => {
    const originals = {
      QSTASH_TOKEN: process.env.QSTASH_TOKEN,
      QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY,
      QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY,
    };
    try {
      process.env.QSTASH_TOKEN = 'process-token';
      process.env.QSTASH_CURRENT_SIGNING_KEY = 'process-current';
      process.env.QSTASH_NEXT_SIGNING_KEY = 'process-next';

      const a = loadQueueEnv();
      const b = loadQueueEnv();
      expect(a).toBe(b);

      const c = loadQueueEnv(completeQueueStub({ QSTASH_TOKEN: 'other-token' }));
      expect(c).not.toBe(a);
      expect(c.qstashToken).toBe('other-token');
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('isQueueConfigured', () => {
  it('v2.6 true when all three QSTASH_* vars are set; false when any is missing; never throws', () => {
    expect(isQueueConfigured(completeQueueStub())).toBe(true);
    expect(isQueueConfigured(completeQueueStub({ QSTASH_TOKEN: undefined }))).toBe(false);
    expect(isQueueConfigured(completeQueueStub({ QSTASH_CURRENT_SIGNING_KEY: undefined }))).toBe(
      false,
    );
    expect(isQueueConfigured(completeQueueStub({ QSTASH_NEXT_SIGNING_KEY: undefined }))).toBe(
      false,
    );
    expect(() => isQueueConfigured(completeQueueStub({ QSTASH_TOKEN: undefined }))).not.toThrow();
  });
});
