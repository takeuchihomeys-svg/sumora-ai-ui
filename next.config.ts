import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // テンプレートXLSファイルをサーバーレス関数バンドルに含める（Vercel対応）
  outputFileTracingIncludes: {
    "/api/fill-estimate": ["./public/templates/**/*"],
    // 2026-09-24 物件資料の PDF を画像にして DeepSeek に読ませる（pdfjs の CMap・標準フォント＋ @napi-rs/canvas のネイティブ）
    "/api/merge-pdfs": ["./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*", "./node_modules/@napi-rs/canvas*/**/*"],
  },
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],

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
      {
        source: "/",
        destination: "/giga-chintai.html",
        permanent: false,
        has: [{ type: "host" as const, value: "gigachintai.com" }],
      },
      {
        source: "/",
        destination: "/giga-chintai.html",
        permanent: false,
        has: [{ type: "host" as const, value: "www.gigachintai.com" }],
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
