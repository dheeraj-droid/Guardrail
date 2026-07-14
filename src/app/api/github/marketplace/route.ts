// T5 — GitHub Marketplace webhook receiver, route entrypoint.
//
// A Next.js App Router route file may export ONLY HTTP method handlers and route-segment
// config; `next build` fails on any other export. The handler factory + testing seam
// therefore live in ./handler.ts (see the note there). This file stays minimal.
import { makePostHandler } from './handler';

export const runtime = 'nodejs'; // node:crypto (verifyGithubSignature) requires the Node runtime
export const dynamic = 'force-dynamic';

export const POST = makePostHandler();
