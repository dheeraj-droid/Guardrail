'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Scroll-reveal wrapper. Progressive-enhancement by design: the wrapped content
 * renders in its final, visible state — the fade-up only exists inside keyframes
 * gated behind `.reveal.is-visible` (see globals.css). If this script never runs,
 * the content is simply visible. One IntersectionObserver per wrapper; the stagger
 * between sibling cards is expressed purely in CSS via `:nth-child` delays.
 */
export function Reveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // classList, not setState — no re-render, and it avoids the
            // set-state-in-effect lint smell.
            node.classList.add('is-visible');
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );

    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={className ? `reveal ${className}` : 'reveal'}>
      {children}
    </div>
  );
}
