/** @type {import('next').NextConfig} */
const nextConfig = {
  // Serve the client-side trading UI as static files through Vercel's CDN.
  // This removes unnecessary server rendering overhead and improves repeat-load performance.
  output: 'export',
  trailingSlash: true,
  poweredByHeader: false,
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@deriv/core'],
}

module.exports = nextConfig
