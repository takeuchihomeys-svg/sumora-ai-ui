// scripts/verify-image-property-save.ts
// 実行: npx tsx --env-file=.env.local scripts/verify-image-property-save.ts
//
// 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは」
//   send-line-message の after() に入れた処理（読み取り → 照合 → sent_image_properties へ記録）を
//   **同じ手順でなぞって**、本番DBに記録できるところまで通す。
//   （send-line-message 自体は INTERNAL_API_SECRET が要るのでスクリプトからは叩けない。
//     after() が Vercel で走ること自体は、同じ経路の sent_facts 記録で実績がある）
//
// 書き込みはテスト会話「YUMA」だけ。書いた行は最後に消す。
export {};
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";
import { resolveReadProperty } from "../app/lib/property-name-match";
import { extractPropertyLabels } from "../app/lib/action-ledger";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA（竹内さん本人のテスト会話）

async function main() {
  // 実物の画像（スタッフが実際に送った物）を1枚
  const { data: imgs } = await sb.from("messages").select("image_url, conversation_id")
    .eq("sender", "staff").not("image_url", "is", null)
    .gte("created_at", new Date(Date.now() - 20 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(1);
  const src = ((imgs ?? []) as Array<{ image_url: string; conversation_id: string }>)[0];
  if (!src) { console.error("画像が見つからない"); process.exit(1); }
  // ⚠ messages.image_url は **JSON 配列の文字列**が入っている事がある（["https://…","https://…"]）。
  //   送信 API の image_url は単一URLなので実装側は問題ないが、DB から拾う時はほどく必要がある。
  const image_url = (() => {
    const raw = src.image_url.trim();
    if (!raw.startsWith("[")) return raw;
    try { const a = JSON.parse(raw) as string[]; return (a[0] ?? "").trim(); } catch { return raw; }
  })();
  console.log(`── 画像: ${image_url.slice(0, 88)}\n`);

  // ── ここから after() の中身と同じ ──────────────────────────────────
  const read = await readPropertyImage(image_url);
  console.log(`① 読み取り: ${read.items.length}件  ${read.items.slice(0, 3).map((x) => `${x.propertyName} ${x.roomNumber}`).join(" / ")}`);
  console.log(`   トークン 入力${read.usage?.input} / 出力${read.usage?.output}`);
  if (read.items.length === 0) { console.log("⚠ 読めなかったので終了"); return; }

  // 照合の辞書（その会話で既に分かっている物件名）。※ 実運用では送り先の会話で引く
  const known = new Set<string>();
  const { data: sp } = await sb.from("sent_properties").select("property_name").eq("conversation_id", src.conversation_id).limit(50);
  for (const r of (sp ?? []) as Array<{ property_name: string | null }>) if (r.property_name) known.add(r.property_name.trim());
  const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", src.conversation_id).order("created_at", { ascending: false }).limit(80);
  const joined = ((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n");
  for (const lbl of extractPropertyLabels(joined)) known.add(lbl.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim());
  const dict = [...known].filter((s) => s.length >= 2);
  console.log(`② 照合の辞書: ${dict.length}件  ${dict.slice(0, 3).join(" / ")}`);
  if (dict.length === 0) { console.log("⚠ 既知の物件名が無いので記録しない（誤読を入れない）"); return; }

  const fixed = read.items.map((x) => resolveReadProperty(x, dict)).filter((x): x is NonNullable<typeof x> => !!x);
  console.log(`③ 照合を通った: ${fixed.length}件  ${fixed.slice(0, 3).map((x) => `${x.propertyName} ${x.roomNumber}`).join(" / ")}`);
  if (fixed.length === 0) { console.log("⚠ 照合できないので記録しない"); return; }

  // ── ④ 記録（YUMA に書いて、確認したら消す）──
  const top = fixed[0];
  const testUrl = `${image_url}#verify-${Date.now()}`;   // 本物の行を上書きしないよう別キーで書く
  const { error } = await sb.from("sent_image_properties").upsert(
    { image_url: testUrl, conversation_id: CONV, property_name: top.propertyName, room_no: top.roomNumber, source: "staff_image_vision" },
    { onConflict: "image_url" },
  );
  if (error) { console.error(`④ ⚠ 書き込み失敗: ${error.message}`); process.exit(1); }

  const { data: saved } = await sb.from("sent_image_properties")
    .select("property_name, room_no, source").eq("image_url", testUrl).maybeSingle();
  console.log(`④ 記録できた: ${saved?.property_name} ${saved?.room_no}（source=${saved?.source}）`);

  // ── 片付け ──
  const { error: delErr } = await sb.from("sent_image_properties").delete().eq("image_url", testUrl);
  console.log(`\n── 片付け: ${delErr ? `⚠ ${delErr.message}` : "✅ 書いた行を消した"}`);
  const { count } = await sb.from("sent_image_properties").select("image_url", { count: "exact", head: true }).like("image_url", "%#verify-%");
  console.log(`   検証用の行の残り: ${count ?? 0}件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
