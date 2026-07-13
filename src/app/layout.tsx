import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { resolveSessionState } from './sessionState';
import { SignOutButton } from './SignOutButton';

export const metadata: Metadata = {
  title: 'Guardrail',
  description: 'Automated API contract enforcement across repositories.',
};

// Reading the per-request session cookie in the root layout makes every page dynamic —
// intentional here so the header can reflect sign-in state on every route.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { configured, login } = await resolveSessionState();

  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="container site-header-inner">
            <Link href="/" className="brand">
              Guardrail
            </Link>
            <nav className="site-nav">
              {login ? (
                <>
                  <Link href="/dashboard" className="session-chip">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="session-avatar"
                      src={`https://github.com/${login}.png`}
                      alt=""
                      width={24}
                      height={24}
                    />
                    <span className="session-login">{login}</span>
                  </Link>
                  <SignOutButton />
                </>
              ) : (
                configured && (
                  <a href="/api/auth/login" className="session-signin">
                    Sign in
                  </a>
                )
              )}
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
