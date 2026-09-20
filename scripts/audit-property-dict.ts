// scripts/audit-property-dict.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-property-dict.ts [--n=20]
//
// 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは」
//   照合の辞書を「その会話の物件名」にすると、**画像だけで送った物件が救えない**
//   （本番で「グランパシフィック生野東 501」を読めたのに、その会話の辞書17件に無くて捨てた）。
//   辞書を**全社の物件名**（sent_properties の全件）に広げた時の
//   ①カバー率（照合を通る割合）②誤照合（別の物件に寄ってしまう）を実画像で測る。
// 読み取りのみ。
export {};
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";
import { matchKnownProperty, similarity } from "../app/lib/property-name-match";
import { extractPropertyLabels } from "../app/lib/action-ledger";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const N = Number((process.argv.find((a) => a.startsWith("--n=")) ?? "--n=20").split("=")[1]);

const unwrap = (raw: string) => {
  const t = (raw ?? "").trim();
  if (!t.startsWith("[")) return t;
  try { return ((JSON.parse(t) as string[])[0] ?? "").trim(); } catch { return t; }
};

async function main() {
  // ── 全社の物件名辞書 ──
  const all = new Set<string>();
  for (let page = 0; ; page++) {
    const { data } = await sb.from("sent_properties").select("property_name")
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    const r = (data ?? []) as Array<{ property_name: string | null }>;
    if (r.length === 0) break;
    for (const x of r) {
      const n = (x.property_name ?? "").replace(/^\s*【\s*[0-9０-９]{1,2}\s*】\s*/, "").trim();
      if (n.length >= 2) all.add(n);
    }
    if (r.length < 1000) break;
    if (page > 19) break;
  }
  const dictAll = [...all];
  console.log(`=== 全社の物件名辞書 ${dictAll.length}種類（sent_properties 全件から）===\n`);

  // ── 実画像で照合を比べる ──
  const { data: imgs } = await sb.from("messages").select("image_url, conversation_id, created_at")
    .eq("sender", "staff").not("image_url", "is", null)
    .gte("created_at", new Date(Date.now() - 25 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(N);
  const rows = (imgs ?? []) as Array<{ image_url: string; conversation_id: string; created_at: string }>;

  let read = 0, okConv = 0, okAll = 0, rescued = 0;
  const risky: Array<{ from: string; to: string; score: number }> = [];
  for (const im of rows) {
    const url = unwrap(im.image_url);
    if (!url.startsWith("http")) continue;
    const r = await readPropertyImage(url);
    if (r.items.length === 0) continue;
    read++;
    const top = r.items[0];

    // 会話だけの辞書
    const conv = new Set<string>();
    const { data: sp } = await sb.from("sent_properties").select("property_name").eq("conversation_id", im.conversation_id).limit(50);
    for (const x of (sp ?? []) as Array<{ property_name: string | null }>) if (x.property_name) conv.add(x.property_name.trim());
    const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", im.conversation_id).order("created_at", { ascending: false }).limit(80);
    const joined = ((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n");
    for (const lbl of extractPropertyLabels(joined)) conv.add(lbl.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim());

    const mConv = matchKnownProperty(top.propertyName, [...conv].filter((s) => s.length >= 2));
    const mAll = matchKnownProperty(top.propertyName, dictAll);
    if (mConv) okConv++;
    if (mAll) okAll++;
    if (!mConv && mAll) rescued++;
    // 誤照合の疑い: 完全一致でないのに全社辞書で寄った物
    if (mAll && !mAll.exact) risky.push({ from: top.propertyName, to: mAll.name, score: mAll.score });

    console.log(`  ${String(im.created_at).slice(5, 16)} 読=${top.propertyName.slice(0, 26).padEnd(26)} 会話辞書:${mConv ? "○" : "×"} 全社辞書:${mAll ? `○ ${mAll.name.slice(0, 22)}${mAll.exact ? "" : `(${mAll.score.toFixed(2)})`}` : "×"}`);
  }

  const pct = (n: number) => `${Math.round((100 * n) / Math.max(read, 1))}%`;
  console.log(`\n--- ${read}枚（物件名を読めた物）---`);
  console.log(`  会話だけの辞書で照合を通る   ${String(okConv).padStart(3)}枚 (${pct(okConv)})  ← 今の実装`);
  console.log(`  全社の辞書で照合を通る       ${String(okAll).padStart(3)}枚 (${pct(okAll)})`);
  console.log(`  **全社辞書で救える           ${String(rescued).padStart(3)}枚 (${pct(rescued)})**`);
  console.log(`\n--- 完全一致でないのに寄った物（誤照合の疑い・全部読む）---`);
  for (const x of risky) console.log(`  ${x.score.toFixed(2)}  ${x.from}  →  ${x.to}`);
  if (risky.length === 0) console.log(`  なし（全部が完全一致）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
