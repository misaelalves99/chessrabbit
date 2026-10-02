/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The whole app is client-rendered and talks to the API over HTTP, so there
  // is no server work to keep: `next build` emits a plain static bundle into
  // ./out that a CDN can serve for free. Removes the Node process from the
  // box entirely (SCALABILITY_PLAN Phase 2.4, pulled forward - it costs
  // nothing to do at launch).
  //
  // NOTE: NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL are inlined at BUILD time,
  // not read at runtime. A CDN bundle must be rebuilt to point at a different
  // API host - see docs/DEPLOYMENT.md.
  output: "export",

  // Static hosts map /app to /app/index.html; without this the export emits
  // /app.html and deep links 404 on most CDNs.
  trailingSlash: true,

  // Static exports serve local assets directly, including the donation QR code.
  images: { unoptimized: true },
};
module.exports = nextConfig;
