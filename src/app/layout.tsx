import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import './globals.css';
import { loadDashboardEnv } from '@/config/env';
import { resolveSessionState } from './sessionState';
import { SignOutButton } from './SignOutButton';
import { MobileNav } from './MobileNav';

// Header reflects the current request's auth state, so the layout must render per-request.
export const dynamic = 'force-dynamic';

// next/font is part of `next` — no new dependency (CLAUDE.md Law 13). Self-hosted at
// build time, exposed as CSS variables consumed in globals.css.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

// The real brand mark (docs/assets/guardrail-logo.svg) — coral shield, white checkmark.
// Inlined rather than an <img> so it stays crisp at 22px with no extra request.
function BrandMark() {
  return (
    <svg
      className="brand-mark"
      width="22"
      height="22"
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M166 132 L346 132 Q366 132 366 152 L366 244 Q366 330 256 390 Q146 330 146 244 L146 152 Q146 132 166 132 Z"
        fill="#E9564A"
      />
      <path
        d="M208 250 L240 284 L316 200"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="34"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const APP_TITLE = 'Guardrail — Stop breaking API changes before they merge';
const APP_DESCRIPTION =
  'Guardrail intercepts backend pull requests that change an OpenAPI contract, scans your linked frontend for code that would break, and blocks the merge before it ships.';

/**
 * Resolve the public base URL for metadata. Mirrors the defensive pattern in
 * `sessionState.ts`: `loadDashboardEnv()` throws when dashboard env vars are unset
 * (webhook-only deploys), so any throw falls back to localhost.
 */
function metadataBaseUrl(): URL {
  try {
    return new URL(loadDashboardEnv().baseUrl);
  } catch {
    return new URL('http://localhost:3000');
  }
}

export const metadata: Metadata = {
  metadataBase: metadataBaseUrl(),
  title: APP_TITLE,
  description: APP_DESCRIPTION,
  openGraph: {
    title: APP_TITLE,
    description: APP_DESCRIPTION,
    siteName: 'Guardrail',
    type: 'website',
    url: '/',
  },
  twitter: {
    card: 'summary',
    title: APP_TITLE,
    description: APP_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1013' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { configured, login } = await resolveSessionState();

  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <div className="container site-header-inner">
            <Link href="/" className="brand">
              <BrandMark />
              <span>Guardrail</span>
            </Link>
            <nav className="site-nav" aria-label="Primary">
              <Link href="/#how-it-works">How it works</Link>
              <Link href="/#features">Why Guardrail</Link>
              <Link href="/#faq">FAQ</Link>
              <a
                href="https://github.com/dheeraj-droid/Guardrail"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
              {login ? (
                <>
                  <Link className="session-chip" href="/dashboard">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="session-chip-avatar"
                      src={`https://github.com/${login}.png`}
                      alt=""
                      width={24}
                      height={24}
                    />
                    <span className="session-chip-login">@{login}</span>
                  </Link>
                  <SignOutButton />
                </>
              ) : (
                configured && (
                  <a className="button button-primary" href="/api/auth/login">
                    Sign in
                  </a>
                )
              )}
            </nav>
            <MobileNav configured={configured} login={login} />
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <div className="container site-footer-inner">
            <div>
              <div className="brand">
                <BrandMark />
                <span>Guardrail</span>
              </div>
              <p className="site-footer-note">
                Contract enforcement for teams that ship backend and frontend in lockstep.
              </p>
              <p className="site-footer-copy">
                Built with the GitHub Checks API · {new Date().getFullYear()}
              </p>
            </div>
            <div className="footer-cols">
              <div className="footer-col">
                <span className="footer-col-title">Product</span>
                <Link href="/#how-it-works">How it works</Link>
                <Link href="/#features">Why Guardrail</Link>
                <Link href="/#faq">FAQ</Link>
              </div>
              <div className="footer-col">
                <span className="footer-col-title">Resources</span>
                <a
                  href="https://github.com/dheeraj-droid/Guardrail"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub
                </a>
                <a
                  href="https://github.com/dheeraj-droid/guardrail-demo"
                  target="_blank"
                  rel="noreferrer"
                >
                  Live demo repo
                </a>
              </div>
            </div>
          </div>
          <div className="footer-wordmark" aria-hidden="true">
            GUARDRAIL
          </div>
        </footer>
      </body>
    </html>
  );
}
