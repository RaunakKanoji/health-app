import type { NextConfig } from "next";

const config: NextConfig = {
  // Preserve the request origin in Clerk's same-URL rewrite. Next normalizes
  // 127.0.0.1 to localhost otherwise, which can recursively proxy local requests.
  skipProxyUrlNormalize: true,
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.API_URL ?? "http://127.0.0.1:4001"}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Cache-Control", value: "private, no-store" }
    ] }];
  }
};
export default config;
