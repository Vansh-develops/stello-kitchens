/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy API calls to the NestJS backend. Target is configurable so the same
  // build works in dev (localhost) and in the container network (http://api:3001).
  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN || "http://localhost:3001";
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
  transpilePackages: ["@stello/shared"],
};

export default nextConfig;
