import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A named webhook's short URL, in the shape Option Alpha uses: /hook/<secret>. A second segment is allowed
  // (/hook/<anything>/<secret>) and ignored, so a URL copied from that style of address still resolves.
  async rewrites() {
    return [
      { source: "/hook/:token", destination: "/api/webhook/hook/:token" },
      { source: "/hook/:prefix/:token", destination: "/api/webhook/hook/:token" },
    ];
  },
};

export default nextConfig;
