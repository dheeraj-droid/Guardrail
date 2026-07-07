import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGithubSignature } from '@/lib/crypto/verifySignature';

const PAYLOAD = '{"zen":"Design for failure."}';
const SECRET = 's3cr3t';

/** Compute the real HMAC-SHA256 hex digest for a payload/secret pair. */
function sign(payload: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('verifyGithubSignature', () => {
  it('1. accepts a valid signature', () => {
    const header = `sha256=${sign(PAYLOAD, SECRET)}`;
    expect(
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: header, secret: SECRET }),
    ).toBe(true);
  });

  it('2. rejects a signature with one hex char flipped', () => {
    const hex = sign(PAYLOAD, SECRET);
    // Flip the first hex character to a different valid hex digit.
    const flipped = (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1);
    const header = `sha256=${flipped}`;
    expect(
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: header, secret: SECRET }),
    ).toBe(false);
  });

  it('3. rejects a missing header (null) and an empty header', () => {
    expect(
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: null, secret: SECRET }),
    ).toBe(false);
    expect(
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: '', secret: SECRET }),
    ).toBe(false);
  });

  it('4. rejects a header without the sha256= prefix', () => {
    const header = `sha1=${sign(PAYLOAD, SECRET)}`;
    expect(
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: header, secret: SECRET }),
    ).toBe(false);
  });

  it('5. accepts UPPERCASE hex with the correct value (lowercasing rule)', () => {
    const header = `sha256=${sign(PAYLOAD, SECRET).toUpperCase()}`;
    expect(
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: header, secret: SECRET }),
    ).toBe(true);
  });

  it('6. rejects a signature computed with a different secret', () => {
    const header = `sha256=${sign(PAYLOAD, 'wrong-secret')}`;
    expect(
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: header, secret: SECRET }),
    ).toBe(false);
  });

  it('7. rejects a signature of different length without throwing', () => {
    expect(() =>
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: 'sha256=abcd', secret: SECRET }),
    ).not.toThrow();
    expect(
      verifyGithubSignature({ payload: PAYLOAD, signatureHeader: 'sha256=abcd', secret: SECRET }),
    ).toBe(false);
  });

  it('8. produces the same result for Buffer and string payloads', () => {
    const bufPayload = Buffer.from(PAYLOAD, 'utf8');
    const header = `sha256=${sign(bufPayload, SECRET)}`;
    const fromString = verifyGithubSignature({
      payload: PAYLOAD,
      signatureHeader: header,
      secret: SECRET,
    });
    const fromBuffer = verifyGithubSignature({
      payload: bufPayload,
      signatureHeader: header,
      secret: SECRET,
    });
    expect(fromString).toBe(true);
    expect(fromBuffer).toBe(true);
    expect(fromBuffer).toBe(fromString);
  });
});
