'use client';

import { useEffect, useRef } from 'react';

/**
 * The landing-page "money shot": a static GitHub-checks mockup that PLAYS as a
 * short sequence when it scrolls into view. One IntersectionObserver adds
 * `is-playing` to the wrap; all choreography (rows ticking in, the breaking-usage
 * detail revealing, the "Merging is blocked" bar stamping in) lives in CSS as
 * animation-delays gated behind `.product-panel-wrap.is-playing` (see globals.css).
 * The markup is identical to the original static panel — it is fully visible with
 * no JS, and the sequence runs exactly once.
 */
export function ProductPanel() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add('is-playing');
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.3 },
    );

    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <div className="product-panel-wrap" aria-hidden="true" ref={ref}>
      <div className="product-panel">
        <div className="check-card">
          <div className="check-card-header">
            <div className="check-card-pr">
              <span className="pr-badge">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11.5 3a1.5 1.5 0 1 0-1.9 1.44v6.12a1.5 1.5 0 1 0 1 0V4.44A1.5 1.5 0 0 0 11.5 3ZM4.5 3a1.5 1.5 0 1 0-1 2.83v4.34a1.5 1.5 0 1 0 1 0V5.83A1.5 1.5 0 0 0 4.5 3Z" />
                </svg>
                #482
              </span>
              <span className="check-card-title">
                Remove deprecated <code>phoneNumber</code> from User
              </span>
            </div>
          </div>

          <div className="check-list">
            <div className="check-row">
              <span className="check-icon check-icon-pass">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="check-name">build</span>
              <span className="check-status">Passed</span>
            </div>
            <div className="check-row">
              <span className="check-icon check-icon-pass">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="check-name">unit-tests</span>
              <span className="check-status">Passed</span>
            </div>
            <div className="check-row check-row-fail">
              <span className="check-icon check-icon-fail">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </span>
              <span className="check-name">Guardrail / contract</span>
              <span className="check-status check-status-fail">2 breaking usages</span>
            </div>
          </div>

          <div className="check-detail">
            <p className="check-detail-head">
              <span className="check-detail-dot" /> Deleted field{' '}
              <code>User.phoneNumber</code> is still used in the frontend
            </p>
            <ul className="check-detail-list">
              <li>
                <span className="file">web/src/ProfileCard.tsx</span>
                <span className="loc">:24</span>
                <code className="usage">user.phoneNumber</code>
              </li>
              <li>
                <span className="file">web/src/checkout/Contact.tsx</span>
                <span className="loc">:11</span>
                <code className="usage">const {'{ phoneNumber }'} = user</code>
              </li>
            </ul>
          </div>

          <div className="check-blocked">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.6" />
              <path d="M3.7 3.7l8.6 8.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Merging is blocked
          </div>
        </div>
      </div>
    </div>
  );
}
