// stripApplyReceivedClaim を実データ全件に当てて、変わる物を全部読む（読み取りのみ）
// 2026-09-20 竹内（S さん事例）「このようなミス起きないようにテストもおこなう」
// CLAUDE.md 手順7: 全件監査。**変換の前後を目で読む**。件数だけ見ない。
import { createClient } from "@supabase/supabase-js";
import { stripApplyReceivedClaim, hasApplyReceivedClaim } from "../app/lib/apply-claim";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function grab(table: "messages" | "ai_reply_examples", col: string) {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const out: Array<{ t: string; at: string }> = [];
  for (let p = 0; p < 16; p++) {
    const { data } = table === "messages"
      ? await sb.from(table).select(`${col}, created_at`).eq("sender", "staff").gte("created_at", since)
          .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999)
      : await sb.from(table).select(`${col}, created_at`).gte("created_at", since)
          .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    for (const x of r) { const t = String(x[col] ?? ""); if (t && t !== "__SHOWN__") out.push({ t, at: String(x.created_at) }); }
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const sent = await grab("messages", "text");
  const draft = await grab("ai_reply_examples", "ai_draft");
  const ex = await grab("ai_reply_examples", "sent_reply");
  console.log(`実送信 ${sent.length}通 ／ 下書き ${draft.length}件 ／ 手本 ${ex.length}件\n`);

  for (const [label, rows] of [["★ 実送信（お客様に届いた文）", sent], ["手本 sent_reply", ex], ["下書き ai_draft", draft]] as Array<[string, typeof sent]>) {
    const changed = rows.filter((x) => stripApplyReceivedClaim(x.t).text !== x.t);
    console.log(`=== ${label}: ${changed.length}件 変わる ===`);
    if (changed.length === 0) { console.log(`  ✅ 1件も変わらない（誤削除0）\n`); continue; }
    for (const c of changed) {
      const { text, removed } = stripApplyReceivedClaim(c.t);
      console.log(`\n  [${c.at.slice(5, 16)}]`);
      console.log(`    前: ${c.t.replace(/\n/g, " ／ ").slice(0, 130)}`);
      console.log(`    後: ${text.replace(/\n/g, " ／ ").slice(0, 130)}`);
      console.log(`    落: ${removed.join(" / ")}`);
    }
    console.log("");
  }

  // 検出だけ（落とさないが印が付く物）も見る
  const flagged = sent.filter((x) => hasApplyReceivedClaim(x.t));
  console.log(`=== 参考: 実送信で判定に当たる（落とすかは別）: ${flagged.length}通 ===`);
  for (const f of flagged.slice(0, 8)) console.log(`  ${f.t.replace(/\n/g, " ").slice(0, 110)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
