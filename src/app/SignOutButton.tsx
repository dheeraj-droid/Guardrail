'use client';

// Global sign-out control for the site header. Mirrors LinkManager.handleLogout: POST to
// the logout route with the CSRF header, then hard-navigate to `/` in a finally block so
// the redirect happens even if the request fails.
const CSRF_HEADERS = { 'x-guardrail-request': 'dashboard' } as const;

export function SignOutButton() {
  async function handleSignOut(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: CSRF_HEADERS });
    } finally {
      window.location.href = '/';
    }
  }

  return (
    <button
      type="button"
      className="button session-signout"
      onClick={() => void handleSignOut()}
    >
      Sign out
    </button>
  );
}
