// Shared body-size guard for the webhook/marketplace route handlers. NOT a route file:
// the `_` prefix opts this folder out of Next.js routing entirely.
//
// Extracted from the verbatim-duplicated MAX_BODY_BYTES + checkBodySize() that previously
// lived in webhook/github/handler.ts, webhook/process/handler.ts, and
// github/marketplace/handler.ts.

// Early-rejection guard, NOT a metered stream cap: both GitHub and QStash always send a
// Content-Length header, so we can reject an oversized (or header-less / malformed) body
// before reading it. This does not defend against a chunked/streamed body with no length
// header — it is a cheap first gate on the documented senders. 25 MiB is GitHub's payload
// ceiling.
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Reject when Content-Length is absent, not a strict non-negative decimal, or exceeds
 * MAX_BODY_BYTES. Returns a 413 Response to send back, or null to proceed.
 */
export function checkBodySize(req: Request): Response | null {
  const header = req.headers.get('content-length');
  if (header === null || !/^\d+$/.test(header) || Number(header) > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload too large' }, { status: 413 });
  }
  return null;
}
