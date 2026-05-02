import withBundleAnalyzer from '@next/bundle-analyzer';

// Optional sub-path deploy: set NEXT_PUBLIC_BASE_PATH=/cards at build time
// to serve the entire app under that prefix (used when deploying behind
// rebuilding-iran.com/cards). Locally we leave it unset so the launchctl
// service at localhost:3737 keeps working with bare paths.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  basePath: BASE_PATH,
  // Standalone output bakes a tiny Node server so the Docker image can run
  // without dragging the whole node_modules tree.
  output: process.env.STANDALONE_BUILD === 'true' ? 'standalone' : undefined,
  async headers() {
    return [
      {
        // Header `source` is matched RELATIVE to basePath in Next.js >= 13,
        // so '/sw.js' covers '/cards/sw.js' automatically. Service-Worker-Allowed
        // is broadened to '/' even when behind a basePath so the SW can
        // optionally control sibling paths if we ever want to.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: BASE_PATH || '/' },
        ],
      },
      {
        source: '/manifest.json',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
    ];
  },
};

// Run with `ANALYZE=true npm run build` to surface the bundle visualizer.
// Off by default so normal builds aren't slowed by report generation.
const withAnalyzer = withBundleAnalyzer({ enabled: process.env.ANALYZE === 'true' });

export default withAnalyzer(nextConfig);
