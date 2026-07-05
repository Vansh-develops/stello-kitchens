/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy API calls to the NestJS backend during dev.
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://localhost:3001/api/:path*" }];
  },
  transpilePackages: ["@petpooja/shared"],
};

export default nextConfig;
