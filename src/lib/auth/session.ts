// Spec K — session sealing. PURE: node:crypto only, no env access, no IO. The dashboard's
// only durable secret-bearing artifact is this sealed cookie value; get it wrong and the
// GitHub user token (SessionData.token) either leaks or can be forged.
//
// ACCEPTED RISK (T5, from the security audit): there is NO server-side session revocation.
// A sealed cookie is valid until `expiresAt`; we cannot invalidate one early (e.g. on a
// "sign out everywhere" or a suspected token leak) short of rotating GUARDRAIL_SESSION_SECRET,
// which logs everyone out at once. Accepted because sessions are short-lived (8h TTL) and
// the token they carry is itself revocable at GitHub. A server-side session store would be
// the fix if per-session revocation is ever required.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The signed-in user's session. `token` is a GitHub user-to-server access token — it MUST
 * NEVER be sent to the browser in any other form (e.g. embedded in HTML/JSON) and MUST
 * NEVER be logged.
 */
export interface SessionData {
  token: string;
  login: string;
  userId: number;
  expiresAt: number; // epoch ms
}

// The `__Host-` prefix is a browser-enforced hardening (T5): the cookie is only accepted
// when set with Secure, Path=/, and NO Domain attribute — every Set-Cookie string for this
// name already qualifies. Renaming invalidates any pre-existing sessions exactly once.
export const SESSION_COOKIE = '__Host-guardrail_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/** AES-256-GCM key material derived from the raw session secret. */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * Encrypt+authenticate `data` into an opaque cookie value:
 * `base64url(iv) + '.' + base64url(ciphertext) + '.' + base64url(authTag)`.
 * A fresh random 12-byte IV is drawn on every call, so two seals of identical data never
 * produce the same wire value.
 */
export function sealSession(data: SessionData, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    authTag.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt+verify a sealed session value. NEVER throws: every invalid input shape returns
 * `null` — missing/empty value, wrong part count, undecodable/garbage base64, a failed
 * auth tag (tampering), a JSON parse failure, missing required fields, or an expired
 * session (`expiresAt <= now`).
 */
export function unsealSession(
  value: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): SessionData | null {
  if (!value) return null;

  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [ivPart, ciphertextPart, authTagPart] = parts;
  if (!ivPart || !ciphertextPart || !authTagPart) return null;

  try {
    const key = deriveKey(secret);
    const iv = Buffer.from(ivPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    const authTag = Buffer.from(authTagPart, 'base64url');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    if (!isSessionData(parsed)) return null;
    if (parsed.expiresAt <= now) return null;

    return parsed;
  } catch {
    // Garbage base64, wrong-length IV/key/tag, or a failed GCM auth-tag check all land
    // here (Node's crypto APIs throw for each) — every one of them means "not a valid
    // session," never a crash.
    return null;
  }
}

function isSessionData(value: unknown): value is SessionData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === 'string' &&
    typeof v.login === 'string' &&
    typeof v.userId === 'number' &&
    typeof v.expiresAt === 'number'
  );
}
