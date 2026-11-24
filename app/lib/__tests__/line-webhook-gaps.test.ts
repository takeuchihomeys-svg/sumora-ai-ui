// LINE の受け口の残りの穴（app/lib/line-webhook-gaps.ts・台帳 #437）
// 実行: npx tsx app/lib/__tests__/line-webhook-gaps.test.ts（全 PASS で exit 0）
import { lineWebhookGapsOn, placeholderTextOf } from "../line-webhook-gaps";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
ok("既定は off", !lineWebhookGapsOn({}) && lineWebhookGapsOn({ LINE_WEBHOOK_GAPS: "on" }));
ok("動画・音声・位置情報は1行で残す", placeholderTextOf("video") === "[動画]" && placeholderTextOf("audio") === "[音声]" && placeholderTextOf("location") === "[位置情報]");
ok("知らない種類も捨てない", placeholderTextOf("imagemap") === "[その他の通]");
ok("今ある道で残す種類は null（二重に残さない）", ["text", "image", "file", "sticker", "", null, undefined].every((t) => placeholderTextOf(t as string) === null));
console.log(`line-webhook-gaps: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
