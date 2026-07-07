// Spec C, File 1 — bounded concurrency worker (SRD §3 "API Timeout Windows").
// PURE (Law 2): no IO, no env, no Octokit, no logging.
// Law 9: all bulk file fetches must route through this instead of unbounded Promise.all
// or sequential awaits. No external libs (Law 13 — p-limit is banned; this is hand-rolled).

/**
 * Run `worker` over `items` with at most `limit` concurrent executions.
 * Results preserve input order. Rejects with the FIRST worker error (callers that
 * need per-item resilience wrap their worker in try/catch themselves).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // 1. Validate limit: must be a positive finite integer.
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }

  // 2. Empty input: return without ever invoking the worker.
  if (items.length === 0) {
    return [];
  }

  // 3. Fixed-size result array + a shared cursor claimed atomically by each runner.
  const results = new Array<R>(items.length);
  let cursor = 0;

  // 4. Each runner pulls the next unclaimed index until the list is exhausted.
  const runner = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  };

  // 5. Spawn at most `limit` runners (never more than there are items). The first
  //    rejecting worker rejects this Promise.all, which propagates to the caller.
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runner),
  );

  // 6. Every slot is populated in input order.
  return results;
}
