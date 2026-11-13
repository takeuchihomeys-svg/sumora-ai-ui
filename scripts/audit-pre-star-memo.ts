// scripts/audit-pre-star-memo.ts
// 🌟の前の作業メモを落とす出口（app/lib/pre-star-memo.ts）の全件監査（読むだけ・DB に書かない）
//   スタッフの送った文（sent_reply）に当たる通 ＝ 誤削除。0 でなければ出口は入れない。
//   AI の下書き（ai_draft）に当たる通 ＝ 捕まえた作業メモ。前後を目で読む（--show）。
// 実行: npx tsx --env-file=.env.local scripts/audit-pre-star-memo.ts [--show] [--days=N]
//   ※ 全期間の読みは重いので JST 9〜22時を避ける
import { createClient } from "@supabase/supabase-js";
import { stripPreStarMemo } from "../app/lib/pre-star-memo";
import { stripMetaNarration } from "../app/lib/meta-narration";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const show = process.argv.includes("--show");
const days = Number(arg("days") ?? "0");

/** aix/action の finalize と同じ順: 🌟前のメモ → 作業メモの行 → もう一度🌟前のメモ。当たった時だけ removed を返す */
function pipeline(text: string): { text: string; removed: string | null } {
  const a = stripPreStarMemo(text);
  const b = stripPreStarMemo(stripMetaNarration(a.text).text);
  const removed = [a.removed, b.removed].filter(Boolean).join(" ／ ");
  return { text: b.text, removed: removed || null };
}

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const since = days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : "2000-01-01";
  let from = 0, total = 0, sentHit = 0, draftHit = 0, draftStillAfterMeta = 0;
  const sentHits: string[] = [];
  for (;;) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, created_at, aix_action, entry_source, ai_draft, sent_reply")
      .gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 499);
    if (error) throw error;
    if (!data?.length) break;
    for (const r of data) {
      total++;
      if (r.sent_reply) {
        // 本番と同じ順（finalize と同じ3段）でスタッフの文に掛けて確かめる
        const s = pipeline(r.sent_reply);
        if (s.removed) { sentHit++; sentHits.push(`${String(r.id).slice(0, 8)} ${String(r.created_at).slice(0, 10)} ${s.removed.slice(0, 80).replace(/\n/g, "⏎")}`); }
      }
      if (r.ai_draft) {
        // 本番と同じ順: stripPreStarMemo → stripMetaNarration → stripPreStarMemo（aix/action の finalize）
        const d = pipeline(r.ai_draft);
        if (d.removed) {
          draftHit++;
          if (stripPreStarMemo(r.ai_draft).removed) draftStillAfterMeta++;
          if (show) {
            console.log(`\n── ${String(r.id).slice(0, 8)} ${String(r.created_at).slice(0, 10)} ${r.aix_action ?? r.entry_source}`);
            console.log(`  落とす: ${d.removed.slice(0, 160).replace(/\n/g, "⏎")}`);
            console.log(`  残る先頭: ${d.text.slice(0, 60).replace(/\n/g, "⏎")}`);
          }
        }
      }
    }
    from += data.length;
    if (data.length < 500) break;
  }
  console.log(`\n読んだ行 ${total}／スタッフの送った文に当たる（誤削除） ${sentHit}／AI の下書きに当たる ${draftHit}（うち元の文に直接でも当たる ${draftStillAfterMeta}）`);
  for (const h of sentHits) console.log(`  誤削除? ${h}`);
})();
