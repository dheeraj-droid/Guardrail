import { describe, it, expect } from 'vitest';
import { sealSession, unsealSession, type SessionData } from '@/lib/auth/session';

const SECRET = 'a'.repeat(32);

function sampleData(overrides?: Partial<SessionData>): SessionData {
  return {
    token: 'gh-token-abc',
    login: 'octocat',
    userId: 583231,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('sealSession / unsealSession', () => {
  it('1. round-trip: seal then unseal returns the original data', () => {
    const data = sampleData();
    const sealed = sealSession(data, SECRET);

    expect(typeof sealed).toBe('string');
    expect(sealed.split('.')).toHaveLength(3);

    const result = unsealSession(sealed, SECRET);
    expect(result).toEqual(data);
  });

  it('2a. tampered ciphertext -> null', () => {
    const sealed = sealSession(sampleData(), SECRET);
    const [iv, ciphertext, tag] = sealed.split('.') as [string, string, string];

    // Flip the first character of the ciphertext segment (stays valid base64url).
    const flipped = (ciphertext[0] === 'a' ? 'b' : 'a') + ciphertext.slice(1);
    const tampered = [iv, flipped, tag].join('.');

    expect(unsealSession(tampered, SECRET)).toBeNull();
  });

  it('2b. tampered auth tag -> null', () => {
    const sealed = sealSession(sampleData(), SECRET);
    const [iv, ciphertext, tag] = sealed.split('.') as [string, string, string];

    const flipped = (tag[0] === 'a' ? 'b' : 'a') + tag.slice(1);
    const tampered = [iv, ciphertext, flipped].join('.');

    expect(unsealSession(tampered, SECRET)).toBeNull();
  });

  it('3. expired session (expiresAt <= now) -> null', () => {
    const data = sampleData({ expiresAt: 1_000_000 });
    const sealed = sealSession(data, SECRET);

    // Default `now` (Date.now()) is already long past 1_000_000ms, but also assert the
    // explicit-`now` seam directly at the boundary (expiresAt === now -> expired).
    expect(unsealSession(sealed, SECRET)).toBeNull();
    expect(unsealSession(sealed, SECRET, 1_000_000)).toBeNull();
    expect(unsealSession(sealed, SECRET, 999_999)).toEqual(data);
  });

  it('4. garbage / empty / null / undefined -> null (never throws)', () => {
    expect(unsealSession(null, SECRET)).toBeNull();
    expect(unsealSession(undefined, SECRET)).toBeNull();
    expect(unsealSession('', SECRET)).toBeNull();
    expect(unsealSession('not-a-sealed-value', SECRET)).toBeNull();
    expect(unsealSession('a.b', SECRET)).toBeNull(); // wrong part count
    expect(unsealSession('a.b.c.d', SECRET)).toBeNull(); // wrong part count
    expect(unsealSession('!!!.###.$$$', SECRET)).toBeNull(); // base64 garbage
  });

  it('5. two seals of identical data use different IVs and differ entirely', () => {
    const data = sampleData();
    const sealedA = sealSession(data, SECRET);
    const sealedB = sealSession(data, SECRET);

    const ivA = sealedA.split('.')[0];
    const ivB = sealedB.split('.')[0];
    expect(ivA).not.toBe(ivB);
    expect(sealedA).not.toBe(sealedB);

    // Both still unseal correctly regardless.
    expect(unsealSession(sealedA, SECRET)).toEqual(data);
    expect(unsealSession(sealedB, SECRET)).toEqual(data);
  });
});
