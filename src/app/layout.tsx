import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Guardrail',
  description: 'Automated API contract enforcement across repositories.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="container">
            <a href="/" className="brand">
              Guardrail
            </a>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
