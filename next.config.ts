import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // テンプレートXLSファイルをサーバーレス関数バンドルに含める（Vercel対応）
  outputFileTracingIncludes: {
    "/api/fill-estimate": ["./public/templates/**/*"],
    // 2026-09-24 物件資料の PDF を画像にして DeepSeek に読ませる（pdfjs の CMap・標準フォント＋ @napi-rs/canvas のネイティブ）
    //   ⚠ 2026-09-24 本番の初回で `Setting up fake worker failed: Cannot find module '.../pdfjs-dist/legacy/build/pdf.worker.mjs'`:
    //   disableWorker でも pdfjs は pdf.worker.mjs を動的 import する（fake worker）。動的 import はファイル追跡に乗らないので legacy/build を丸ごと同梱する
    //   2026-09-24 本番（Linux）は日本語フォントが無く文字が抜けた → public/fonts/NotoSansJP.ttf（OFL）を同梱して pdf-render が登録する
    //   2026-09-24 竹内「文字が反映されていないバグ」の本当の原因は cMap が渡っていなかった事（require.resolve が Turbopack で数値に置き換わった）。
    //     置き場は app/lib/pdfjs-assets.ts が process.cwd()/node_modules/pdfjs-dist/{cmaps,standard_fonts}/ で求める＝下の cmaps・standard_fonts の同梱が要る。
    //     pdf-text / pdf-render を使うルートを増やしたら、ここにも同じ4つを足す（無いと [pdfjs-assets] の警告が出て文字が抜ける）
    "/api/merge-pdfs": ["./node_modules/pdfjs-dist/legacy/build/**/*", "./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*", "./node_modules/@napi-rs/canvas*/**/*", "./public/fonts/**/*"],
    // 売上サポの「画像トリミング」（PDF 1ページ目を画像にして会社の帯を落とす）も同じ物が要る
    "/api/property-pickups/trim": ["./node_modules/pdfjs-dist/legacy/build/**/*", "./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*", "./node_modules/@napi-rs/canvas*/**/*", "./public/fonts/**/*"],
    // 2026-09-24 竹内「必要な所だけを切り出して読ませる。表の文字は文字層から」: 画像で分析もサーバーで PDF の文字層を取り、1ページ目を描いて間取り図を切り出す
    "/api/property-pickups/analyze": ["./node_modules/pdfjs-dist/legacy/build/**/*", "./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*", "./node_modules/@napi-rs/canvas*/**/*", "./public/fonts/**/*"],
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
      // 2026-09-24 pdf.js の worker は ES モジュール（.mjs）。ブラウザが JS として読めるように型を明示する
      {
        source: "/pdfjs/:path*.mjs",
        headers: [{ key: "Content-Type", value: "text/javascript; charset=utf-8" }],
      },
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
