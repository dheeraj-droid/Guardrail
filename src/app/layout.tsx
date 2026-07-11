import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import './globals.css';

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

export const metadata: Metadata = {
  title: 'Guardrail — Stop breaking API changes before they merge',
  description:
    'Guardrail intercepts backend pull requests that change an OpenAPI contract, scans your linked frontend for code that would break, and blocks the merge before it ships.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <div className="page-grain" aria-hidden="true" />
        <header className="site-header">
          <div className="container site-header-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true" />
              <span>Guardrail</span>
            </Link>
            <nav className="site-nav" aria-label="Primary">
              <a href="#how-it-works">How it works</a>
              <a href="#features">Why Guardrail</a>
              <a
                className="site-nav-link-strong"
                href="https://github.com/dheeraj-droid/Guardrail"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M7 17 17 7M17 7H8M17 7v9"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="container site-footer-inner">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true" />
              <span>Guardrail</span>
            </div>
            <p className="site-footer-note">
              Contract enforcement for teams that ship backend and frontend in lockstep.
            </p>
            <p className="site-footer-copy">
              Built with the GitHub Checks API · {new Date().getFullYear()}
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
