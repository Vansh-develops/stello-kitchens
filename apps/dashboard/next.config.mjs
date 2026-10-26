/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "Content-Security-Policy", value: "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; font-src 'self' data:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
  // Proxy API calls to the NestJS backend. Target is configurable so the same
  // build works in dev (localhost) and in the container network (http://api:3001).
  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN || "http://localhost:3001";
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      // The KDS board's Socket.IO client connects same-origin; proxy it to the API.
      // (Long-polling works through this rewrite; native WebSocket upgrade is handled
      // by the host nginx app. vhost — see deploy/nginx-host.conf.example.)
      { source: "/socket.io/:path*", destination: `${apiOrigin}/socket.io/:path*` },
    ];
  },
  transpilePackages: ["@stello/shared"],
};

export default nextConfig;
