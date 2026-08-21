import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // テンプレートXLSファイルをサーバーレス関数バンドルに含める（Vercel対応）
  outputFileTracingIncludes: {
    "/api/fill-estimate": ["./public/templates/**/*"],
  },

  // public/ 以下の静的HTMLファイルをCDNキャッシュさせない
  // （デプロイ後すぐに最新版が反映されるようにするため）
  async redirects() {
    return [
      {
        source: "/",
        destination: "/iyeyasu.html",
        permanent: false,
        has: [{ type: "host" as const, value: "ieyas-chintai.com" }],
      },
      {
        source: "/",
        destination: "/iyeyasu.html",
        permanent: false,
        has: [{ type: "host" as const, value: "www.ieyas-chintai.com" }],
      },
    ];
  },

  async headers() {
    return [
      {
        source: "/:path*.html",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Pragma",
            value: "no-cache",
          },
          {
            key: "Expires",
            value: "0",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
