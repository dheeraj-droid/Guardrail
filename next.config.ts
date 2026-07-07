import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Do not bundle the ~8MB TypeScript compiler into the serverless function;
  // the AST scanner imports it at runtime (see src/lib/scan/astScanner.ts).
  serverExternalPackages: ['typescript'],
};

export default nextConfig;
