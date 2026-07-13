// Track N — Durable Retry Queue (docs/PLAN_V2.md §3), QStash delivery-target route
// entrypoint.
//
// A Next.js App Router route file may export ONLY HTTP method handlers and route-segment
// config; `next build` fails on any other export (see the identical note in
// webhook/github/route.ts — copied verbatim, not re-derived). The handler factory +
// testing seam therefore live in ./handler.ts. This file stays minimal.
import { makePostHandler } from './handler';

export const runtime = 'nodejs'; // node:crypto requires the Node runtime
export const dynamic = 'force-dynamic';

export const POST = makePostHandler();
