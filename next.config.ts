import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production'

// CSP is in report-only mode — not enforced — because Next.js RSC requires
// 'unsafe-inline' for scripts, and Vercel Blob images need an external img-src.
// Tighten progressively after reviewing violation reports.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  `img-src 'self' https://*.public.blob.vercel-storage.com data: blob:`,
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.stripe.com",
  "frame-src https://*.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ')

const nextConfig: NextConfig = {
  serverExternalPackages: ['sharp'],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.public.blob.vercel-storage.com',
      },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options',    value: 'nosniff' },
          { key: 'X-Frame-Options',            value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy',            value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',         value: 'camera=(self), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy-Report-Only', value: CSP_REPORT_ONLY },
          // HSTS only in production — local dev uses http
          ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
        ],
      },
    ]
  },
};

export default nextConfig;
