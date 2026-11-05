// scripts/sent-image-reread.ts — 読めなかった送付の資料の画像の読み直し（埋め戻し）。既定は dry（読むだけ・DB に書かない・LINE に送らない）
//
// 2026-11-05 作業員1（案3'・DeepSeek の残高切れ 11:40〜 JST で送った物件の記録が抜けた）。仕組みは app/lib/sent-image-reread.ts。
// 実行:
//   npx tsx --env-file=.env.local scripts/sent-image-reread.ts --since=2026-11-05T02:40:00Z            … 対象の数・会話の数だけ（DeepSeek も呼ばない）
//   npx tsx --env-file=.env.local scripts/sent-image-reread.ts --since=… --dry-read                    … DeepSeek で読んで、入る予定の sent_properties の行を数える（DB に書かない）
//   npx tsx --env-file=.env.local scripts/sent-image-reread.ts --since=… --apply                       … 読み直して記録を埋める（統括役の判断の後だけ）
import { findRereadTargets, runSentImageReread } from "../app/lib/sent-image-reread-server";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);

async function main() {
  const since = arg("since");
  const sinceMs = since ? Date.parse(since) : Date.now() - 72 * 3600_000;
  if (!Number.isFinite(sinceMs)) throw new Error(`--since が読めない: ${since}`);
  const windowHours = Math.max(1, (Date.now() - sinceMs) / 3600_000);
  const limit = Number(arg("limit", "200"));
  if (flag("apply")) {
    const r = await runSentImageReread({ windowHours, limit });
    console.log(JSON.stringify({ ok: r.ok, targets: r.targets, conversations: r.conversations, inserted: r.results.filter((x) => x.sentProperties === "inserted").length, results: r.results }, null, 1));
    return;
  }
  const targets = (await findRereadTargets({ windowHours, limit })).filter((t) => Date.parse(t.sentAt) >= sinceMs);
  const convs = new Set(targets.map((t) => t.conversationId));
  console.log(`対象の送付の画像 ${targets.length}枚・会話 ${convs.size}（${new Date(sinceMs).toISOString()} 以降・試験の会話と見積書等は外した）`);
  for (const t of targets) console.log(`  ${t.sentAt.slice(0, 19)} ${t.conversationId.slice(0, 8)} ${t.source}`);
  if (!flag("dry-read")) return;
  // 読むだけ（DeepSeek）。入る予定の sent_properties の行＝物件として読めて、同じ会話の送った物件に同じ物が無い物
  const { sharedPropertyImageRead, SENT_IMAGE_READ_TIMEOUT_MS } = await import("../app/lib/property-image-read");
  const { isSameProperty } = await import("../app/lib/sent-property-record");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
  let willInsert = 0, notProperty = 0, failed = 0, dup = 0;
  for (const t of targets) {
    const r = await sharedPropertyImageRead(t.imageUrl, { timeoutMs: SENT_IMAGE_READ_TIMEOUT_MS, conversationId: t.conversationId });
    if (!r.isProperty || !r.items.length) { if (r.raw.startsWith("{")) notProperty++; else failed++; console.log(`  ${t.conversationId.slice(0, 8)} ${r.raw.startsWith("{") ? "物件でない" : "読めない"}`); continue; }
    const it = r.items[0];
    const { data } = await sb.from("sent_properties").select("property_name, room_no").eq("conversation_id", t.conversationId).limit(300);
    const hit = ((data ?? []) as Array<{ property_name: string | null; room_no: string | null }>).some((x) => isSameProperty({ property_name: x.property_name ?? "", room_no: x.room_no }, { property_name: it.propertyName, room_no: it.roomNumber ?? "" }));
    if (hit) dup++; else willInsert++;
    console.log(`  ${t.conversationId.slice(0, 8)} ${it.propertyName} ${it.roomNumber ?? ""} → ${hit ? "同じ物件の行あり（入れない）" : "入る予定"}`);
  }
  console.log(`入る予定の sent_properties ${willInsert}行・同じ物件の行あり ${dup}・物件でない ${notProperty}・読めない ${failed}（DB には書いていない）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
