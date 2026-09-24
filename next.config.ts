import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // テンプレートXLSファイルをサーバーレス関数バンドルに含める（Vercel対応）
  outputFileTracingIncludes: {
    "/api/fill-estimate": ["./public/templates/**/*"],
    // 2026-09-24 物件資料の PDF を画像にして DeepSeek に読ませる（pdfjs の CMap・標準フォント＋ @napi-rs/canvas のネイティブ）
    //   ⚠ 2026-09-24 本番の初回で `Setting up fake worker failed: Cannot find module '.../pdfjs-dist/legacy/build/pdf.worker.mjs'`:
    //   disableWorker でも pdfjs は pdf.worker.mjs を動的 import する（fake worker）。動的 import はファイル追跡に乗らないので legacy/build を丸ごと同梱する
    "/api/merge-pdfs": ["./node_modules/pdfjs-dist/legacy/build/**/*", "./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*", "./node_modules/@napi-rs/canvas*/**/*"],
    // 売上サポの「画像トリミング」（PDF 1ページ目を画像にして会社の帯を落とす）も同じ物が要る
    "/api/property-pickups/trim": ["./node_modules/pdfjs-dist/legacy/build/**/*", "./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*", "./node_modules/@napi-rs/canvas*/**/*"],
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
