// 台本の申込の門（scripts/lib/script-deepseek-gate.ts）と見張り (o) の許可の一覧の単体テスト（DB も LLM も使わない）
// 実行: npx tsx scripts/lib/__tests__/script-deepseek-gate.test.ts（全 PASS で exit 0）
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { imagesInBody, gateVerdict, urlVerdictOf, type UrlVerdict } from "../script-deepseek-gate";
import { deepseekWithoutCutoff, DS_GATE_ALLOW } from "../hazard-audit-core";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// 実物の形: property-image-read の本文（OpenAI 互換・image_url.url に会話の画像の URL）。線の向きは本番（post-apply の isAfterCutoff）と同じ
const during = "https://example.supabase.co/storage/v1/object/public/line-images/c1/during-apply.jpg";
const after = "https://example.supabase.co/storage/v1/object/public/line-images/c1/after-switch.jpg";
const pickup = "https://example.supabase.co/storage/v1/object/public/pickups/p1.png";
const body = (u: string) => JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: [{ type: "text", text: "資料を読んで" }, { type: "image_url", image_url: { url: u } }] }] });
const cut = "2026-10-20T00:00:00Z"; // 申込から切り替えた線（ここから後は渡してよい）
const cutOf = (c: string) => (c === "c1" ? cut : c === "c2" ? null : undefined);
ok("線より前（申込の間）の画像は block", urlVerdictOf([{ conversation_id: "c1", created_at: "2026-10-10T00:00:00Z" }], cutOf) === "block");
ok("線より後（切り替えた後）の画像は ok", urlVerdictOf([{ conversation_id: "c1", created_at: "2026-10-25T00:00:00Z" }], cutOf) === "ok");
ok("申込中（線なし＝null）は block", urlVerdictOf([{ conversation_id: "c2", created_at: "2026-10-25T00:00:00Z" }], cutOf) === "block");
ok("会話のメッセージに無い画像（物件ピックアップ）は ok", urlVerdictOf([], cutOf) === "ok");
const vs = new Map<string, UrlVerdict>([[during, "block"], [after, "ok"], [pickup, "ok"]]);
ok("本文の画像の URL を拾う", imagesInBody(body(after)).urls.join() === after);
ok("申込の間の画像は止める・後の画像と資料は通す", !gateVerdict(body(during), vs, false).ok && gateVerdict(body(after), vs, false).ok && gateVerdict(body(pickup), vs, false).ok);
ok("線が読めない画像は止める（安全側）", !gateVerdict(body("https://x/unknown.jpg"), vs, false).ok);
ok("画像の無い本文は通す", gateVerdict(JSON.stringify({ messages: [{ role: "user", content: "文だけ" }] }), new Map(), false).ok);
const b64 = JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] }] });
ok("base64 は既定で止める・許可で通す", !gateVerdict(b64, vs, false).ok && gateVerdict(b64, vs, true).ok);
const anth = JSON.stringify({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: during } }] }] });
ok("Anthropic の形（source.url）も拾う", !gateVerdict(anth, vs, false).ok);

// 見張り (o): 21本 → 門を import した16本と許可の5本で 0 本
const flagged: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!/node_modules|__tests__/.test(f)) walk(p); } else if (/\.ts$/.test(f)) { const rel = p.replace(/\\/g, "/"); if (deepseekWithoutCutoff(readFileSync(p, "utf8"), rel)) flagged.push(rel); } } };
walk("scripts");
ok("見張り (o): 門を通さない台本 0", flagged.length === 0, flagged.join(", "));
ok("許可の一覧は理由つき", Object.values(DS_GATE_ALLOW).every((r) => r.length >= 10));
ok("門の import が無い会話の画像の台本は今まで通り見つける", deepseekWithoutCutoff('import { readPropertyImage } from "../app/lib/property-image-read";\nawait readPropertyImage(u);', "scripts/new-one.ts"));

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
