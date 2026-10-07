import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A named webhook's short URL, in the shape Option Alpha uses: /hook/<secret>. A second segment is allowed
  // (/hook/<anything>/<secret>) and ignored, so a URL copied from that style of address still resolves.
  // Headers on every response: no framing of the app (clickjacking), no guessing of file types, no address sent along when
  // a link is followed (a webhook URL holds a secret), and HTTPS only once it has been used.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/hook/:token", destination: "/api/webhook/hook/:token" },
      { source: "/hook/:prefix/:token", destination: "/api/webhook/hook/:token" },
    ];
  },
};

export default nextConfig;
