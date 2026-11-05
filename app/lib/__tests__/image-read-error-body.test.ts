// app/lib/__tests__/image-read-error-body.test.ts — 読み取りの HTTP の失敗の本文を伏せて残す（2026-11-05）
//   実行: npx tsx app/lib/__tests__/image-read-error-body.test.ts
import { sanitizeReadErrorBody } from "../property-image-read";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}`); } };
const b = sanitizeReadErrorBody('{"error":{"message":"Failed to download image from https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/abc.jpg?token=xyz (request_id: 880abb65)","type":"invalid_request_error"}}');
t("画像の URL は伏せる", !/https?:\/\//.test(b) && b.includes("<url>"));
t("誤りの文は残す", b.includes("Failed to download image") && b.includes("invalid_request_error"));
t("電話・メール・長い番号は伏せる", (() => { const x = sanitizeReadErrorBody("call 090-1234-5678 or a.b@example.com id 12345678901"); return !/090-1234-5678|example\.com|12345678901/.test(x) && x.includes("<num>") && x.includes("<mail>"); })());
t("200字まで", sanitizeReadErrorBody("x".repeat(500)).length === 200);
t("空", sanitizeReadErrorBody("") === "");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
