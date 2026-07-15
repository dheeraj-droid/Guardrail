import type { NextConfig } from 'next';

// Single CSP applied to every response. Notes on the non-'self' allowances:
//   img-src   https://github.com + https://avatars.githubusercontent.com — layout.tsx
//             loads the signed-in user's avatar from https://github.com/<login>.png, which
//             302-redirects to avatars.githubusercontent.com; both origins must be allowed
//             or the authenticated header avatar breaks. data: covers inline/data-URI images.
//   connect-src https://github.com — dashboard/client calls to GitHub.
//   form-action https://github.com — OAuth form posts to GitHub.
// 'unsafe-inline' for script/style reflects Next's current inline runtime/styles; tighten
// to nonces/hashes only if the app moves off inline injection.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
  "connect-src 'self' https://github.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self' https://github.com",
].join('; ');

const nextConfig: NextConfig = {
  // Do not bundle the ~8MB TypeScript compiler into the serverless function;
  // the AST scanner imports it at runtime (see src/lib/scan/astScanner.ts).
  serverExternalPackages: ['typescript'],

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default nextConfig;
