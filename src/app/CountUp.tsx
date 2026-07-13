'use client';

import { useEffect, useRef } from 'react';

interface CountUpProps {
  /** Target value to count to. */
  value: number;
  prefix?: string;
  suffix?: string;
  /** Count-up duration in ms. */
  duration?: number;
  className?: string;
}

function format(n: number, prefix: string, suffix: string): string {
  return `${prefix}${Math.round(n)}${suffix}`;
}

/**
 * Counts a number up from 0 to `value` (ease-out) when it scrolls into view.
 * SSR/initial render shows the FINAL value, so the correct number is present with
 * no JS and there is no hydration mismatch. The count is written straight to
 * `textContent` in the rAF loop — no per-frame React state. Reduced-motion renders
 * the final value immediately.
 */
export function CountUp({
  value,
  prefix = '',
  suffix = '',
  duration = 700,
  className,
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      node.textContent = format(value, prefix, suffix);
      return;
    }

    let raf = 0;
    let started = false;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    // Start from zero (node is below the fold, so this is never seen mid-count).
    node.textContent = format(0, prefix, suffix);

    const run = () => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        node.textContent = format(value * easeOut(t), prefix, suffix);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !started) {
            started = true;
            run();
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.6 },
    );

    io.observe(node);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [value, prefix, suffix, duration]);

  return (
    <span ref={ref} className={className}>
      {format(value, prefix, suffix)}
    </span>
  );
}
