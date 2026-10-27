const isDev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy. The session is an httpOnly cookie, so the main XSS
 * win left to block is script injection + exfiltration: connect-src is limited
 * to this origin plus the realtime socket origin (if separate), and eval is
 * only allowed in dev (React refresh needs it).
 */
function csp() {
  const connect = new Set(["'self'"]);
  const socket = process.env.NEXT_PUBLIC_SOCKET_ORIGIN;
  if (socket) {
    connect.add(socket);
    connect.add(socket.replace(/^http/, "ws"));
  }
  if (isDev) {
    for (const o of ["http://localhost:3001", "ws://localhost:3001", "http://127.0.0.1:3001", "ws://127.0.0.1:3001"]) connect.add(o);
  } else {
    connect.add("wss:"); // same-origin socket upgrade through the host proxy
  }
  return [
    "default-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "Content-Security-Policy", value: csp() },
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
