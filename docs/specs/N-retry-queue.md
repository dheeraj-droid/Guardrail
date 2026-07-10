# Spec N — Durable Retry Queue (opt-in, beyond `after()`)

**Wave:** V1 | **Agent:** module-builder | **Depends on:** V0
**Files produced:** `src/lib/queue/qstash.ts`, `src/lib/db/deliveries.ts`,
`src/app/api/webhook/process/route.ts`, `src/app/api/webhook/process/handler.ts`,
`src/app/api/webhook/github/handler.ts` (edit), `src/config/env.ts` was already edited
by V0 — do not re-edit it here beyond what V0 already added,
`tests/queue/qstash.test.ts`, `tests/db/deliveries.test.ts`,
`tests/route/process.test.ts`, `tests/route/webhook.test.ts` (edit — new cases only)

## Purpose

Today `handler.ts` acks 202 then runs the pipeline inside `after()`. If the process is
killed mid-work (execution-time limits, cold-start eviction) rather than throwing a
catchable error, Law 10's fail-open `catch` never runs — the check run can be left
hanging at `in_progress` with no retry, and GitHub won't redeliver because it already
saw the 202. This track adds an **opt-in** durable queue path (Upstash QStash, via raw
`fetch()` — no new npm dependency, CLAUDE.md Law 13) alongside — not instead of — the
existing `after()` path, plus delivery-level idempotency so neither path can double-run
a pipeline invocation.

**Opt-in, not a replacement:** every design decision below preserves byte-identical
behavior for a deployment that never sets `QSTASH_TOKEN` (including the live deployment
at `guardrail-coral.vercel.app`, per `docs/IMPLEMENTATION_LOG.md`'s 2026-07-09 entry).
`isQueueConfigured()` (from V0's `env.ts` amendment) is the one branch point.

## File 1 — `src/lib/queue/qstash.ts` (IO)

No new npm dependency — raw `fetch()` + `node:crypto`, mirroring
`src/lib/crypto/verifySignature.ts`'s HMAC shape exactly.

```ts
import type { QueueEnv } from '@/config/env';
import type { PipelineInput } from '@/types/github';

/**
 * Publish a pipeline job to QStash for durable, retried delivery to `processUrl`
 * (the deployment's own /api/webhook/process endpoint, an absolute URL). Throws on any
 * non-2xx response or network error — the caller (handler.ts) decides what a publish
 * failure means for the HTTP response it sends back to GitHub.
 */
export async function publishPipelineJob(
  queueEnv: QueueEnv,
  processUrl: string,
  input: PipelineInput,
): Promise<void>;

/**
 * Verify a QStash callback's signature header against BOTH the current and next
 * signing key (QStash's documented key-rotation contract — a valid signature under
 * EITHER key passes). Never throws; malformed input returns false, mirroring
 * verifyGithubSignature's contract exactly (Law 4's constant-time spirit extended to
 * this second, separate trust boundary).
 */
export function verifyQStashSignature(opts: {
  payload: string;
  signatureHeader: string | null | undefined;
  currentSigningKey: string;
  nextSigningKey: string;
}): boolean;
```

Implementation:
- `publishPipelineJob`: `POST https://qstash.upstash.io/v2/publish/${encodeURIComponent(processUrl)}`
  with header `Authorization: Bearer ${queueEnv.qstashToken}` and `Content-Type:
  application/json`, body `JSON.stringify(input)`. `!response.ok` → throw
  `new Error(\`QStash publish failed: ${response.status}\`)`.
- `verifyQStashSignature`: QStash signs with JWT-style HMAC
  (`Upstash-Signature` header, a JWT whose payload includes a body hash) — implement
  per QStash's published verification algorithm: decode the JWT, verify its signature
  with `createHmac('sha256', signingKey)` against the header+payload per JWT's own
  spec, verify the embedded body-hash claim matches `sha256(payload)`, verify
  `exp`/`iat` are sane. Try `currentSigningKey` first, then `nextSigningKey` on
  failure — `true` if either succeeds. **Never** compare using `===`/`!==` on the raw
  signature material — reuse `timingSafeEqual` for the final byte comparison exactly
  as `verifySignature.ts` does. If the exact QStash JWT-verification algorithm proves
  more involved than fits cleanly in a hand-rolled function, that is a legitimate
  finding to report back rather than silently approximating security-critical
  signature verification — CLAUDE.md's "never improvise public APIs, STOP and report"
  applies with extra force to a crypto boundary.

## File 2 — `src/lib/db/deliveries.ts`

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Atomically claim a webhook delivery id. Returns true iff THIS call claimed it
 * (first time seen); false if it was already claimed (duplicate delivery — caller
 * must no-op). Never throws on a duplicate — only on an actual DB error.
 */
export async function claimDelivery(
  db: SupabaseClient,
  deliveryId: string,
): Promise<boolean>;
```

Implementation: `db.from('processed_deliveries').insert({ delivery_id: deliveryId })`.
Supabase surfaces a unique-violation as `error.code === '23505'` — that specific code
means "already claimed," so return `false` (not an error). Any OTHER `error` truthy
value throws `new Error('processed_deliveries claim failed: ' + error.message)`,
mirroring `projectLinks.ts`'s existing error-message convention. No error → return
`true`.

## File 3 — `src/app/api/webhook/process/route.ts` + `handler.ts`

Same route/handler split as `webhook/github` (Next.js App Router route files may only
export HTTP method handlers + route-segment config — see the WHY comment already in
`webhook/github/handler.ts` and copy its reasoning verbatim into this new pair, do not
re-derive it).

```ts
// process/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = makePostHandler();
```

```ts
// process/handler.ts
export function makePostHandler(overrides?: {
  deps?: PipelineDeps;
  pipeline?: typeof processPullRequest;
  queueEnv?: QueueEnv;
}): (req: Request) => Promise<Response>;
```

Control flow:
1. `const raw = await req.text()` — raw body first, same discipline as the GitHub route
   even though this is an internal hop (consistent habit, and the signature covers the
   raw bytes).
2. Verify `verifyQStashSignature({ payload: raw, signatureHeader:
   req.headers.get('upstash-signature'), currentSigningKey: queueEnv.qstashCurrentSigningKey,
   nextSigningKey: queueEnv.qstashNextSigningKey })` — invalid → `401`.
3. `JSON.parse(raw)` as `PipelineInput` — malformed → `400` (a QStash-side bug, not
   worth retrying).
4. **Await** `pipeline(deps, input)` directly — no `after()` here. QStash's own
   invocation already grants this request its own timeout/retry budget; deferring
   further would just reintroduce the exact risk this track exists to close.
5. Return `200` on completion (even if `processPullRequest` internally concluded
   `neutral` due to a caught pipeline error — Law 10 already guarantees
   `processPullRequest` never rejects, so "it returned" IS the success signal; QStash
   should not retry a run that completed, even with a neutral outcome).
6. If `pipeline(...)` somehow rejects anyway (contract violation, but defend the HTTP
   layer regardless), catch it and return a non-2xx so QStash retries delivery.

**Idempotency is NOT re-checked here** — `claimDelivery` runs once, in
`webhook/github/handler.ts`, before either the queue-publish or `after()` branch (File
4 below). By the time QStash calls this route, the delivery is already claimed; this
route's only job is running the pipeline QStash asked it to run.

## File 4 — `src/app/api/webhook/github/handler.ts` (edit)

Insert two things into the existing control flow, both AFTER step 6 (installation-id
check) and BEFORE step 7 (build `PipelineInput` — unchanged) in the current file:

**6a. Claim the delivery (both modes):**
```ts
const deliveryId = req.headers.get('x-github-delivery');
if (deliveryId) {
  const claimed = await claimDelivery(deps.db, deliveryId);
  if (!claimed) {
    return Response.json({ queued: false, reason: 'duplicate delivery' }, { status: 200 });
  }
}
```
A missing `x-github-delivery` header (should never happen for a real GitHub webhook,
but the route must not 500 on it) skips the claim rather than failing closed — same
fail-open spirit as the rest of this file. `deps.db` requires `buildDeps()` (or an
override) to be resolved BEFORE this point now, not lazily inside the deferred
callback — this is the one structural change to the file's ordering; the deferred
`pipeline(...)` call in step 8 keeps using the already-resolved `deps` instead of
calling `buildDeps()` again inside the callback.

**Step 8 replacement — branch on queue configuration:**
```ts
const queueEnv = overrides?.queueEnv ?? tryLoadQueueEnv();
if (queueEnv) {
  try {
    await publish(queueEnv, processUrl(req), input);
  } catch (error) {
    console.error('[guardrail] queue publish failed:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: 'failed to enqueue' }, { status: 502 });
  }
  return Response.json({ queued: true }, { status: 202 });
}

// Fallback: no queue configured — today's v1 behavior, byte-for-byte.
defer(() => pipeline(deps, input));
return Response.json({ queued: true }, { status: 202 });
```
- `tryLoadQueueEnv()`: a small module-private wrapper around `isQueueConfigured()` +
  `loadQueueEnv()` — return `undefined` when not configured, the typed `QueueEnv`
  when it is. Do not call `loadQueueEnv()` unconditionally (it throws when unconfigured
  — this file must not throw just because a deployment hasn't set up a queue).
- `publish` is a new injectable override (default `publishPipelineJob`), following the
  exact same seam pattern `defer`/`deps`/`pipeline` already use — tests must be able to
  observe a publish call without a real network request.
- `processUrl(req)`: derive the process endpoint's absolute URL from the incoming
  request (`new URL('/api/webhook/process', req.url).toString()`) — do not hardcode a
  domain, so this works identically across preview/production deployments.
- A publish failure returns `502` (not `202`) precisely so GitHub's own webhook-delivery
  retry mechanism covers it — acking `202` into a job that never got enqueued would be
  the exact "acked but not actually queued" gap this track exists to close.

## Acceptance tests

`qstash.test.ts`:
1. `publishPipelineJob` success → exactly one `fetch` call with the right URL/headers/body.
2. Non-2xx response → throws with the status code in the message.
3. `verifyQStashSignature` valid signature under the CURRENT key → true.
4. Valid signature under the NEXT key only (simulating key rotation) → true.
5. Invalid/tampered signature → false, never throws.
6. Missing header → false.

`deliveries.test.ts` (mock Supabase client chain, no network):
1. First claim of a fresh `delivery_id` → `true`.
2. Second claim of the same `delivery_id` (mock returns the unique-violation error
   shape) → `false`, no throw.
3. An unrelated DB error → throws containing the message.

`process.test.ts` (mirror `webhook.test.ts`'s `sign()`-helper pattern, using
`verifyQStashSignature`'s real algorithm to construct valid test signatures — do not
stub the crypto):
1. Valid signature, valid `PipelineInput` body → pipeline spy called with the exact
   input; `200`.
2. Invalid signature → `401`; pipeline spy not called.
3. Malformed JSON body → `400`.
4. Pipeline spy configured to reject → non-2xx response.

`webhook.test.ts` — new cases added to the existing suite (all 8 existing acceptance
tests from Spec I must still pass unmodified):
1. No `QSTASH_TOKEN` configured → behaves exactly as today (existing test 1's assertion
   set, replayed to confirm zero regression) — `defer` called, not `publish`.
2. `QSTASH_TOKEN` configured (inject `queueEnv` override) → `publish` called with the
   built `PipelineInput`, `defer` NOT called, response is `202`.
3. `publish` override configured to reject → response is `502`; `defer` not called.
4. Same `x-github-delivery` header value sent twice (both with a queue configured and
   with `after()` fallback) → second call returns `200 { reason: 'duplicate delivery' }`,
   neither `publish` nor `defer`/pipeline is invoked the second time.
5. Missing `x-github-delivery` header → claim step is skipped, request proceeds exactly
   as before this track existed (regression safety for any test payload that omits it).

## Manual verification (cannot be captured in an automated test)

Before this track is considered done for real (not just green in CI), run one live
round-trip against a real QStash sandbox project: configure `QSTASH_TOKEN` +
signing keys on a preview deployment, trigger a real webhook, and confirm the
`process` route actually gets called and concludes the check run. Log this exactly like
`docs/IMPLEMENTATION_LOG.md`'s 2026-07-09 live-verification entry — do not let a later
docs update claim "v2 fully verified live" from CI green alone; the queue path
specifically needs its own live confirmation, separate from typecheck/test.

## Forbidden

- Any new npm dependency for QStash integration (Law 13) — raw `fetch()` + `node:crypto`
  only.
- Reusing `GITHUB_WEBHOOK_SECRET` (or any GitHub-trust-boundary value) to verify the
  QStash callback — it is a genuinely separate trust boundary with its own secret pair.
- `await`-ing `processPullRequest` inside `webhook/github/handler.ts` before responding,
  in EITHER branch (Law 5 still applies — the queue branch awaits only the fast
  `publish` call, never the pipeline itself).
- Skipping the delivery-claim step for the `after()` fallback path — idempotency
  protection must cover both branches, not just the new queue path.
