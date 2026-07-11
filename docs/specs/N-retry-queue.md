# Spec N — Durable Retry Queue (opt-in, beyond `after()`)

**Wave:** V1 | **Agent:** module-builder | **Depends on:** V0
**Files produced:** `src/lib/queue/qstash.ts`, `src/lib/db/deliveries.ts`,
`src/app/api/webhook/process/route.ts`, `src/app/api/webhook/process/handler.ts`,
`src/app/api/webhook/github/handler.ts` (edit), `src/lib/github/checks.ts` (edit —
idempotent check-run creation, see §3 below), `src/config/env.ts` was already edited
by V0 — do not re-edit it here beyond what V0 already added,
`tests/queue/qstash.test.ts`, `tests/db/deliveries.test.ts`,
`tests/route/process.test.ts`, `tests/route/webhook.test.ts` (edit — new cases only),
`tests/github/adapters.test.ts` (edit — new idempotency cases for `checks.ts`)

## Purpose

Today `handler.ts` acks 202 then runs the pipeline inside `after()`. If the process is
killed mid-work (execution-time limits, cold-start eviction) rather than throwing a
catchable error, Law 10's fail-open `catch` never runs — the check run can be left
hanging at `in_progress` with no retry, and GitHub won't redeliver because it already
saw the 202. This track adds an **opt-in** durable queue path (Upstash QStash, via raw
`fetch()` — no new npm dependency, CLAUDE.md Law 13) alongside — not instead of — the
existing `after()` path.

**Opt-in, not a replacement:** every design decision below preserves byte-identical
behavior for a deployment that never sets `QSTASH_TOKEN` (including the live deployment
at `guardrail-coral.vercel.app`, per `docs/IMPLEMENTATION_LOG.md`'s 2026-07-09 entry).
`isQueueConfigured()` (from V0's `env.ts` amendment) is the one branch point.

### The idempotency problem this track must actually solve (read carefully)

A durable queue introduces a NEW double-run vector that a naive "claim the delivery
once at ingress" design does not close: **QStash's own retries land on the `process`
route, not on the ingress `webhook/github` route.** If invocation #1 of `process/route.ts`
is slow, times out, or QStash simply doesn't see a clean `200` in time, QStash redelivers
the SAME job — as a fresh request straight to `process/route.ts` — and the ingress
delivery-claim (File 2/File 4 below) never runs again for that redelivery, because it
already ran once, earlier, at ingress. Two `process` invocations means two full pipeline
runs, and `createInProgressCheckRun` (`checks.ts`, unchanged today) unconditionally
`POST`s a fresh check run every time it's called — so this produces two check runs on
the same commit, not one.

**Two independent, complementary fixes, both required:**
1. **`claimDelivery`/`processed_deliveries` (Files 2 & 4, unchanged from the original
   design) still matters** — it protects against GitHub itself redelivering the same
   webhook to *ingress* (assuming GitHub reuses the delivery GUID on its own automatic
   retries, which is the documented but not iron-clad case). Keep it.
2. **`createInProgressCheckRun` must become idempotent (File 3a below) — this is the
   fix that actually closes the QStash-retry gap**, because it protects at the point
   where a duplicate WOULD be created, regardless of which delivery mechanism caused the
   redundant invocation or whether any delivery-id was preserved end-to-end. This also
   correctly preserves the crash-recovery case retries exist for in the first place: if
   invocation #1 dies BEFORE ever creating a check run, a retry still creates one fresh
   and completes normally — idempotency only suppresses a duplicate when one is already
   in flight or already exists, never blocks a genuine first attempt.

Accept one residual, deliberately-not-solved edge case: if invocation #1 truly
completes and concludes the check run, and a late/spurious retry fires anyway,
`createInProgressCheckRun`'s lookup only reuses a run that is NOT yet `completed` — so
that rare case produces a second, harmless, redundant *completed* run rather than data
loss or a stuck in-progress run. Solving that fully would need a locking/lease mechanism
this system's actual risk profile does not justify (Guardrail is a merge-blocking bot,
not a payments system) — do not build one.

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
- `verifyQStashSignature`: **exact algorithm, verified against QStash's own SDK source
  (`upstash/sdk-qstash-ts/src/receiver.ts`) — do not deviate or re-derive from memory:**
  1. Header is `Upstash-Signature` (note: NOT `X-Upstash-Signature` — no `X-` prefix).
     Missing/empty header → `false`.
  2. The header value is a compact JWT: `<base64url-header>.<base64url-payload>.<base64url-signature>`.
     Split on `.`; anything other than exactly 3 segments → `false`.
  3. Compute the expected signature as
     `createHmac('sha256', signingKey).update(\`${headerSegment}.${payloadSegment}\`).digest()`
     (raw bytes, not hex/base64 yet — HMAC over the ASCII JWT header+payload segments
     exactly as they appear in the token, per JWT/JWS compact-serialization signing
     input). Decode the token's own signature segment from base64url to raw bytes.
     Compare the two BYTE BUFFERS with `timingSafeEqual` (length-mismatch guard first,
     same pattern `verifySignature.ts` already uses) — never compare the base64url
     strings directly.
  4. Try `currentSigningKey` first; if step 3's comparison fails, retry the WHOLE
     verification (steps 3+) with `nextSigningKey` (QStash's documented key-rotation
     contract — a signature valid under either key passes). Both failing → `false`.
  5. Decode the payload segment (base64url → JSON) and validate claims:
     - `iss` must equal exactly `"Upstash"`.
     - `exp` must be in the future and `nbf` must be in the past (both are Unix
       seconds — compare against `Date.now() / 1000`, no injected clock, matching
       `verifySignature.ts`'s no-side-effect style).
     - `body` claim: compute `createHash('sha256').update(payload).digest('base64url')`
       over the RAW request body string (never a re-`JSON.stringify`'d version — same
       "raw bytes, never re-serialized" discipline Law 4 already applies to the GitHub
       HMAC), strip any trailing `=` padding from BOTH the computed hash and the claim
       before comparing (QStash's own implementation does this — the claim may or may
       not carry padding depending on client), and compare as plain strings (this one
       comparison is a hash-of-a-hash-like value already bound by the outer JWT
       signature, not raw secret material, so `timingSafeEqual` is not required here —
       reserve it for step 3's HMAC comparison, which IS the actual secret-bound
       check).
     - This spec deliberately does NOT validate the `sub` claim (would require passing
       the receiver's own exact URL through and comparing string-for-string, which is
       an extra coupling to deployment configuration for marginal security value here —
       the body-hash + HMAC signature already authenticate the payload came from
       someone holding the signing key). Note this omission in the acceptance-test
       comments so a future reviewer can see it was a deliberate scope cut, not an
       oversight.
  6. Any parse failure, malformed base64url, malformed JSON, or claim validation
     failure at any step → `false`, never throw (mirrors `verifyGithubSignature`'s
     total-function contract exactly).

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

**`claimDelivery` is NOT re-checked here** — it runs once, in `webhook/github/handler.ts`,
before either the queue-publish or `after()` branch (File 4 below), and only protects
against GitHub redelivering to *ingress*. This route's real protection against a QStash
redelivery landing here a second time is `createInProgressCheckRun`'s idempotency (File
5, below) — inside `pipeline(deps, input)` itself, not something this route needs to
implement directly. Do not add a second delivery-claim check in this file; the point of
File 5's fix is precisely that this route does NOT need to know it's being retried.

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

## File 5 — `src/lib/github/checks.ts` (edit — idempotent check-run creation)

**This is the fix that actually closes the QStash-retry double-run gap** (see Purpose).
`createInProgressCheckRun`'s exported signature does NOT change — every existing caller
(`processPullRequest.ts`, unmodified by this track) keeps working exactly as today; only
the function body changes.

```ts
export async function createInProgressCheckRun(
  octokit: Octokit,
  params: { owner: string; repo: string; headSha: string },
): Promise<number> {
  const { owner, repo, headSha } = params;

  // Idempotency (Track N): reuse an existing NOT-YET-COMPLETED run with our name on
  // this exact repo+sha instead of creating a duplicate. A queue retry (or a GitHub
  // redelivery that slipped past the ingress delivery-claim) invoking this a second
  // time for the same commit must not produce a second check run.
  const { data: existing } = await octokit.request(
    'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
    { owner, repo, ref: headSha, check_name: CHECK_NAME },
  );
  // Filter on name explicitly, even though check_name already scopes the GET query —
  // defensive against a mock/fake in tests not honoring the query param, and makes
  // this function's own logic (not just the API call) what's actually being verified.
  const inFlight = existing.check_runs.find(
    (run) => run.status !== 'completed' && run.name === CHECK_NAME,
  );
  if (inFlight) {
    return inFlight.id;
  }

  // ...existing POST /repos/{owner}/{repo}/check-runs body, UNCHANGED...
}
```

Notes:
- The lookup call is ONE extra GitHub API request per pipeline invocation — acceptable;
  do not try to avoid it with caching (a cache would itself need its own
  invalidation/staleness story, which is exactly the kind of extra machinery File
  5's own design note above says this system's risk profile doesn't justify).
- Filtering on `run.status !== 'completed'` (not `run.conclusion`) is deliberate:
  `status` transitions `queued` → `in_progress` → `completed`; `conclusion` is only set
  once `status === 'completed'`. A run this function should reuse is any run that
  hasn't reached `completed` yet, regardless of what it will eventually conclude.
- This function is NOT part of the multi-frontend aggregation work (Track P) — it fires
  exactly once per `processPullRequest` invocation today and continues to do so; this
  change only affects what happens when `processPullRequest` itself is invoked more
  than once for the same commit, which is purely a retry/redelivery concern.

## Acceptance tests

`qstash.test.ts` — build real JWTs in the test file (base64url-encode a header/payload,
HMAC-sign with `node:crypto`, exactly per File 1's algorithm) so these tests exercise
the actual verification path, not a stubbed one:
1. `publishPipelineJob` success → exactly one `fetch` call with the right URL/headers/body.
2. Non-2xx response → throws with the status code in the message.
3. `verifyQStashSignature` valid signature under the CURRENT key → true.
4. Valid signature under the NEXT key only (simulating key rotation) → true.
5. Invalid/tampered signature (flip a byte in the signature segment) → false, never throws.
6. Missing header → false.
7. Malformed JWT (not 3 dot-separated segments) → false, never throws.
8. `iss` claim wrong (not `"Upstash"`) → false, even with a structurally valid signature.
9. `exp` in the past → false. `nbf` in the future → false.
10. `body` claim doesn't match `sha256(payload)` (tampered body, signature otherwise
    valid — proves the body-hash check is real, not a no-op) → false.
11. Comment in the test file noting the `sub` claim is deliberately unvalidated (Purpose
    §, File 1) — not a test case, a documentation note so a future reviewer sees the
    scope cut was deliberate.

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

`adapters.test.ts` — new cases for `createInProgressCheckRun` (existing cases for this
file, including the un-touched `concludeCheckRun` tests, must all still pass unmodified):
1. No existing check run for repo+sha+name → `POST` called once, returns the new run's
   id (today's exact behavior, unmodified — this is the regression case).
2. An existing run for repo+sha+name with `status: 'in_progress'` → NO `POST` call;
   returns the existing run's id.
3. An existing run for repo+sha+name with `status: 'completed'` → `POST` IS called (a
   completed run is not "in flight" — see File 5's documented residual-edge-case note);
   returns the new run's id.
4. Multiple existing runs, one `in_progress` and one older `completed` → the
   `in_progress` one's id is reused (find the first non-completed match, do not assume
   array ordering beyond "at least one non-completed entry exists").
5. Existing runs list includes a DIFFERENT check name (e.g. some other GitHub App's
   check) → ignored; the `check_name` query param already scopes the GET, but assert
   this defensively in case a fake/mock doesn't honor it, so the filter logic in this
   function's own code is what's actually being tested, not just the query param.

## Manual verification (cannot be captured in an automated test)

Before this track is considered done for real (not just green in CI), run one live
round-trip against a real QStash sandbox project: configure `QSTASH_TOKEN` +
signing keys on a preview deployment, trigger a real webhook, and confirm the
`process` route actually gets called and concludes the check run. **This must include
deliberately forcing a QStash redelivery** (QStash's dashboard/API supports manually
retrying a message, or configure a very short response timeout temporarily) and
confirming only ONE check run results — the automated tests in this spec exercise
`createInProgressCheckRun`'s idempotency against a mock, but never against QStash's
actual retry behavior end-to-end, which is precisely the scenario this whole track
exists to handle. Log this exactly like `docs/IMPLEMENTATION_LOG.md`'s 2026-07-09
live-verification entry — do not let a later docs update claim "v2 fully verified live"
from CI green alone; the queue path specifically needs its own live confirmation,
separate from typecheck/test. The signature-verification algorithm in File 1 was
derived from reading QStash's own SDK source, not tested against a live QStash
request — the live round-trip is also this algorithm's first real-world test; if it
fails, treat a signature-verification mismatch as the first hypothesis, not a
transport/network issue.

## Forbidden

- Any new npm dependency for QStash integration (Law 13) — raw `fetch()` + `node:crypto`
  only. This includes `jose` (QStash's own SDK's dependency for this) — File 1's
  algorithm is written out in exact, hand-implementable detail specifically so this
  dependency is not needed.
- Reusing `GITHUB_WEBHOOK_SECRET` (or any GitHub-trust-boundary value) to verify the
  QStash callback — it is a genuinely separate trust boundary with its own secret pair.
- `await`-ing `processPullRequest` inside `webhook/github/handler.ts` before responding,
  in EITHER branch (Law 5 still applies — the queue branch awaits only the fast
  `publish` call, never the pipeline itself).
- Treating `claimDelivery`/`processed_deliveries` (Files 2 & 4) as sufficient
  idempotency protection on its own — File 5's `createInProgressCheckRun` change is not
  optional or a "nice to have," it is the fix for the double-run vector this track's
  Purpose section actually identifies. Do not implement Files 1-4 and skip File 5.
- Adding a locking/lease mechanism to fully close the rare late-retry-after-completion
  edge case File 5 documents as an accepted residual risk — that is over-engineering for
  this system, not a gap to close.
- Skipping the delivery-claim step for the `after()` fallback path — idempotency
  protection must cover both branches, not just the new queue path.
