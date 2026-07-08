# Spec I — Gateway Webhook Receiver

**Wave:** 2 | **Agent:** module-builder | **Depends on:** A (verifySignature), H (pipeline), W0 (env)
**Files produced:** `src/app/api/webhook/github/route.ts`,
`src/app/api/webhook/github/handler.ts`, `tests/route/webhook.test.ts`
**Gate note (Law 12):** run only your own test file. ALSO run `npm run build` — a Next.js
route file's exports are validated by `next build` (not by `tsc --noEmit`); see the split
rule below.

## Route-file export rule (discovered in deployment)
A Next.js App Router `route.ts` may export ONLY HTTP method handlers (`GET`/`POST`/…) and
route-segment config (`runtime`, `dynamic`, `maxDuration`, …). Any other export makes
`next build` fail its generated route-type check — even though `tsc --noEmit` passes. So
the `makePostHandler` testing seam lives in a sibling `handler.ts`; `route.ts` imports it
and exports only `runtime`, `dynamic`, and `POST`. Tests import `makePostHandler` from
`@/app/api/webhook/github/handler`.

## Purpose
SRD Module 1: `/api/webhook/github`. Verify HMAC (constant time), extract the four fields,
acknowledge 202 immediately, defer the pipeline. This file is a THIN shell — zero business
logic.

## Route contract
```ts
export const runtime = 'nodejs';        // node:crypto + typescript lib require Node runtime
export const dynamic = 'force-dynamic';
export async function POST(req: Request): Promise<Response>;
```
Next.js App Router route handler (`Request`/`Response` web APIs — do NOT use NextRequest
features; keep it portable and trivially testable by calling POST() directly with a
standard Request).

## Control flow (exact order — Laws 4 & 5)
```
 1. const raw = await req.text()            // RAW body FIRST — before any parsing
 2. verifyGithubSignature({ payload: raw,
      signatureHeader: req.headers.get('x-hub-signature-256'),
      secret: loadEnv().githubWebhookSecret })
    └─ false → return Response.json({ error: 'invalid signature' }, { status: 401 })
 3. const event = req.headers.get('x-github-event')
    └─ event !== 'pull_request' → 202 Response.json({ queued: false, reason: 'ignored event' })
 4. payload = JSON.parse(raw) as PullRequestWebhookPayload
    └─ JSON.parse throws → 400 { error: 'malformed JSON' }   (signature already passed,
       so this is a misconfigured sender, not an attacker)
 5. payload.action not in ['opened', 'synchronize'] →
       202 { queued: false, reason: 'ignored action' }        (SRD trigger events)
 6. payload.installation?.id missing → 202 { queued: false, reason: 'no installation' }
    (log a warning — the App is misconfigured, but never 5xx a webhook: GitHub disables
    noisy hooks).
 7. Build PipelineInput (SRD Module 1 extraction):
      installationId: payload.installation.id
      backendRepoId:  payload.repository.id
      backendOwner:   payload.repository.owner.login
      backendRepo:    payload.repository.name
      prNumber:       payload.pull_request.number
      headSha:        payload.pull_request.head.sha     // pull_request.head.sha
      headRef:        payload.pull_request.head.ref     // pull_request.head.ref
      baseRef:        payload.pull_request.base.ref     // pull_request.base.ref
 8. after(() => processPullRequest(buildDeps(), input))       // Law 5 — import { after } from 'next/server'
 9. return Response.json({ queued: true }, { status: 202 })   // SRD: immediate 202 Accepted
```

### buildDeps() — module-private helper in this file
```ts
function buildDeps(): PipelineDeps {
  const env = loadEnv();
  return { env, db: createDbClient(env), getInstallationClient };
}
```
Called INSIDE the after() callback path (step 8 shows it inline) — never at module top
level (imports must stay side-effect free for tests and builds without env vars).

## Testing seam
`after()` from next/server cannot run in vitest. Structure the file so the handler takes
an optional injection:
```ts
export function makePostHandler(overrides?: {
  defer?: (task: () => Promise<void>) => void;   // default: (t) => after(t)
  deps?: PipelineDeps;
  pipeline?: typeof processPullRequest;
}): (req: Request) => Promise<Response>;
export const POST = makePostHandler();
```
Tests call `makePostHandler({ defer: (t) => tasks.push(t), deps: fakeDeps, pipeline: spy })`.
This keeps prod wiring identical while making deferral observable.

## Acceptance tests
Helper: `sign(body, secret)` computes a real sha256 header with node:crypto.
1. Valid signed `pull_request.opened` payload → 202 `{ queued: true }`; deferred task
   captured; invoking it calls the pipeline spy with the EXACT PipelineInput (assert all
   8 fields).
2. Bad signature → 401; pipeline spy NOT called; defer NOT called.
3. Missing signature header → 401.
4. `x-github-event: push` → 202 `queued: false`; no defer.
5. Action `closed` → 202 `queued: false`; no defer.
6. Missing `installation` → 202 `queued: false, reason: 'no installation'`.
7. Signed but malformed JSON body → 400.
8. Response arrives before the deferred task runs (assert spy uncalled until the captured
   task is manually awaited) — proves Law 5 ordering.

## Forbidden
- `await processPullRequest(...)` before responding (Law 5).
- Reading the body via `req.json()` (destroys the raw text needed for HMAC — Law 4).
- Any GET/PUT handlers; any middleware; any secret in any log line.
