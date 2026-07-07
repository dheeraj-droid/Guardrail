import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '@/lib/scan/concurrency';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  // Acceptance 1: Order preserved even when item 0 is the SLOWEST worker.
  it('preserves input order despite reversed delays', async () => {
    const items = [0, 1, 2, 3, 4];
    const results = await mapWithConcurrency(items, 2, async (item) => {
      // Reversed delay: earlier items sleep longer, so they resolve last.
      await sleep((items.length - item) * 10);
      return `r${item}`;
    });
    expect(results).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  // Acceptance 2: Concurrency cap — with limit 3 over 10 items, max in-flight is exactly 3.
  it('never runs more than `limit` workers concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active--;
      return item;
    });

    expect(maxActive).toBe(3);
  });

  // Acceptance 3: limit larger than items.length works (5 items, limit 50).
  it('handles limit greater than items.length', async () => {
    const items = [10, 20, 30, 40, 50];
    const results = await mapWithConcurrency(items, 50, async (item) => item / 10);
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  // Acceptance 4: Worker rejection propagates (rejects) and does not hang.
  it('propagates the first worker rejection without hanging', async () => {
    const items = [0, 1, 2, 3];
    await expect(
      mapWithConcurrency(items, 2, async (item) => {
        if (item === 2) throw new Error('boom');
        await sleep(5);
        return item;
      }),
    ).rejects.toThrow('boom');
  });

  // Acceptance 5: limit 0 / -1 / 2.5 → throws.
  it('throws on non-positive-integer limits', async () => {
    const items = [1, 2, 3];
    const worker = async (x: number) => x;
    await expect(mapWithConcurrency(items, 0, worker)).rejects.toThrow(
      'limit must be a positive integer',
    );
    await expect(mapWithConcurrency(items, -1, worker)).rejects.toThrow(
      'limit must be a positive integer',
    );
    await expect(mapWithConcurrency(items, 2.5, worker)).rejects.toThrow(
      'limit must be a positive integer',
    );
  });

  // Acceptance 6: Empty items → [], worker never called.
  it('returns [] for empty input and never calls the worker', async () => {
    let called = false;
    const results = await mapWithConcurrency([], 4, async (x) => {
      called = true;
      return x;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });
});
