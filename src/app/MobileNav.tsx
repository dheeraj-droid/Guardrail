'use client';

import { useEffect, useState } from 'react';

/**
 * Mobile navigation for the site header. A hamburger button (visible only ≤720px
 * via CSS) toggles a full-width panel that drops under the sticky header with the
 * primary nav links plus the session chip or a Sign in button.
 *
 * Plain React state only — no portal, no external lib. The panel closes when a link
 * is clicked and when Escape is pressed. The desktop `.site-nav` is untouched; this
 * component and its trigger are hidden above 720px in globals.css.
 */
export function MobileNav({
  configured,
  login,
}: {
  configured: boolean;
  login: string | null;
}) {
  const [open, setOpen] = useState(false);

  // Close on Escape while open. Registered only when open so we don't hold a
  // listener for the whole session.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="mobile-nav">
      <button
        type="button"
        className="mobile-nav-toggle"
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 7h16M4 12h16M4 17h16"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>

      <div
        id="mobile-menu"
        className={`mobile-menu${open ? ' is-open' : ''}`}
        hidden={!open}
      >
        <nav className="mobile-menu-inner" aria-label="Mobile">
          <a href="/#how-it-works" onClick={close}>
            How it works
          </a>
          <a href="/#features" onClick={close}>
            Why Guardrail
          </a>
          <a href="/#faq" onClick={close}>
            FAQ
          </a>
          <a
            href="https://github.com/dheeraj-droid/Guardrail"
            target="_blank"
            rel="noreferrer"
            onClick={close}
          >
            GitHub
          </a>
          {login ? (
            <a className="mobile-menu-session" href="/dashboard" onClick={close}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="session-chip-avatar"
                src={`https://github.com/${login}.png`}
                alt=""
                width={24}
                height={24}
              />
              <span>@{login}</span>
            </a>
          ) : (
            configured && (
              <a
                className="button button-primary mobile-menu-cta"
                href="/api/auth/login"
                onClick={close}
              >
                Sign in with GitHub
              </a>
            )
          )}
        </nav>
      </div>
    </div>
  );
}
