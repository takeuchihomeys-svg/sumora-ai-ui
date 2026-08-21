import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // テンプレートXLSファイルをサーバーレス関数バンドルに含める（Vercel対応）
  outputFileTracingIncludes: {
    "/api/fill-estimate": ["./public/templates/**/*"],
  },

  // public/ 以下の静的HTMLファイルをCDNキャッシュさせない
  // （デプロイ後すぐに最新版が反映されるようにするため）
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
