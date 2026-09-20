// scripts/audit-viewing-recency.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-recency.ts
//
// 2026-09-19 竹内（慶次事例の続き）「内覧挨拶は当日にAIXからおこなうなら分かるが、
//   今回の場合持ち越したことで変な文になっていた」:
//   「内覧のお礼」の実送信68通が、**その直前N日以内に内覧の動きがあったか**を数えて鮮度の線を引く。
//   落とす仕組みを入れる前に「誤削除が0になる日数」を実データで決める（設計知見）。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const THANKS_RE = /(?:本日|先日|昨日)[^\n。！!]{0,8}(?:ご内覧|内覧|ご見学|お時間)[^\n。！!]{0,10}(?:頂き|いただき|くださり|下さり)[^\n。！!]{0,8}(?:ありがとう|有難う)/;
/** 内覧・来店の動き（打診・確定・到着・待ち合わせ） */
const VIEWING_MOVE_RE = /内覧|内見|ご案内可能|待ち合わせ|待合せ|現地|ご来店|来店|着きました|つきました|到着|ご都合よろしいお日にち|直近ですと/;

async function main() {
  let from = 0; const size = 1000;
  const hits: Array<{ conv: string; text: string; at: string }> = [];
  for (;;) {
    const { data, error } = await sb.from("messages")
      .select("conversation_id, text, created_at").neq("sender", "customer").not("text", "is", null)
      .range(from, from + size - 1);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    for (const m of data) { const t = String(m.text ?? ""); if (THANKS_RE.test(t)) hits.push({ conv: m.conversation_id as string, text: t, at: m.created_at as string }); }
    if (data.length < size) break;
    from += size;
  }
  console.log(`=== 「内覧のお礼」の実送信 ${hits.length}通 ===`);
  console.log(`各通の**直前N日**に内覧の動き（打診・確定・到着・待ち合わせ・来店）があったか\n`);

  const DAYS = [0.5, 1, 2, 3, 5, 7, 14, 30];
  const ok: Record<number, number> = {};
  const never: Array<{ at: string; text: string }> = [];
  for (const h of hits) {
    const { data: prev } = await sb.from("messages")
      .select("text, created_at").eq("conversation_id", h.conv)
      .lt("created_at", h.at).order("created_at", { ascending: false }).limit(120);
    const moves = (prev ?? []).filter((m) => VIEWING_MOVE_RE.test(String(m.text ?? "")));
    if (moves.length === 0) { never.push({ at: h.at, text: h.text }); continue; }
    const newest = Date.parse(moves[0].created_at as string);
    const gapD = (Date.parse(h.at) - newest) / 86400_000;
    for (const d of DAYS) if (gapD <= d) ok[d] = (ok[d] ?? 0) + 1;
  }
  console.log("--- 「直前N日以内に内覧の動きがある」を条件にした時、通る通数（＝誤削除にならない） ---");
  for (const d of DAYS) {
    const pass = ok[d] ?? 0;
    const drop = hits.length - pass;
    console.log(`  ${String(d).padStart(4)}日以内: 通る ${String(pass).padStart(3)}通 / **落ちる（誤削除）${String(drop).padStart(3)}通**`);
  }
  console.log(`\n  内覧の動きが一度も無い: ${never.length}通`);
  never.slice(0, 6).forEach((n) => console.log(`    [${new Date(n.at).toLocaleDateString("ja-JP")}] ${n.text.replace(/\n/g, " / ").slice(0, 90)}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
