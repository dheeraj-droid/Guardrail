# Spec J — Integration Verification & Audit Loop

**Wave:** 3 | **Agents:** module-builder (part 1) then spec-auditor (part 2, orchestrated loop)
**Files produced:** `tests/integration/pipeline.e2e.test.ts`,
`tests/fixtures/frontend/profile.tsx`, `tests/fixtures/frontend/settings.ts`

## Part 1 — End-to-end integration test (module-builder)

One test file that exercises webhook → pipeline → verdict with ONLY the network faked,
proving the SRD state machine end-to-end. Reuse `makePostHandler` (Spec I) with a
synchronous defer and a fake-octokit-backed `PipelineDeps` (reuse/extract the router-style
fake from Track H's tests into a shared helper `tests/helpers/fakeGithub.ts` if needed —
allowed for this spec only).

### Frontend fixtures (author exactly)
`tests/fixtures/frontend/profile.tsx`
```tsx
export function Profile({ user }: { user: any }) {
  const { phoneNumber: phone } = user;          // alias — MUST be caught via source key
  return <div title={user.phoneNumber}>{phone}</div>;  // property access — caught
}
```
`tests/fixtures/frontend/settings.ts`
```ts
export const getAge = (u: any) => u.age;        // property access on mutated field
const { [key]: dynamic } = obj as any;          // computed — must NOT match
```
(Adjust the last line so the file parses standalone; its only job is a computed-key
non-match.)

### Scenarios (each = one `it()`, driving the SRD §4 matrix end-to-end)
1. **FAILURE row:** signed opened-PR webhook; DB row links backend→frontend; old/new spec
   fixtures v1/v2 (phoneNumber DELETED, age TYPE_MUTATED); tree lists both frontend
   fixtures. Assert: 202 first; after running deferred task, check-run concluded
   `failure`; comment body contains `profile.tsx` with TWO distinct line numbers for
   `phoneNumber` (alias destructure + property access) and `settings.ts` for `age`;
   comment starts with the marker.
2. **SUCCESS + comment row:** same but tree lists only a frontend file with no target
   usage → concluded `success`, comment contains "safe to merge".
3. **SUCCESS clean row:** old == new spec → `success`, zero tree/blob requests, zero
   comment requests.
4. **Monorepo:** link row with equal ids; frontend fixtures live under `web/src/` in the
   BACKEND repo tree at head sha; `frontend_src_directory: 'web/src'`. Assert scan
   requests hit the backend repo at head sha and the failure comment references
   `web/src/profile.tsx`.
5. **Fail-open:** make the tree endpoint reject 500 → concluded `neutral`,
   `Guardrail internal error`, and the POST handler still returned 202.

## Part 2 — The audit loop (orchestrator + spec-auditor; no new files)

Orchestrator protocol after Part 1 is green (PLAN §4 AUDIT LOOP):
1. `npm run typecheck && npm test` — must be green to start.
2. Spawn `spec-auditor` (read-only). It audits EVERY src file against its spec + CLAUDE.md
   laws and returns findings as `file:line — spec/law clause — defect — suggested fix`.
3. Findings? Batch per track → dispatch to `module-builder` with the finding text +
   owning spec path. Re-run gates. GOTO 2. Max 3 rounds; still dirty → escalate to human.
4. Exit criteria (all): zero auditor findings, typecheck green, full suite green,
   integration scenarios 1–5 green.

### Auditor focus list (highest-blunder-probability, in order)
- Law 4: route reads raw text before parse; timingSafeEqual not `===` (Spec A step 5-6).
- Law 6: BindingElement uses propertyName-first (Spec C decision table).
- Law 3: no PAT paths; client.ts is the only Octokit construction site.
- Law 10: no `failure` conclusion reachable from catch blocks (Spec H).
- Law 11: no Contents-API fetches inside scanRepo.ts; exactly one tree call.
- Law 8: prefix matching uses `prefix + '/'` boundary (Spec G step 3).
- Law 15: every conclude path truncates; Law 14: all output positions 1-based.
- Frozen types untouched (git diff of src/types/ vs W0 must be empty).

## Forbidden
- Live network calls of any kind in tests.
- Weakening any Wave 0–2 file to make a test pass without a spec-auditor finding first
  (fixes flow through the loop, not ad-hoc).
