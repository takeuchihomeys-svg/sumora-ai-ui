// scripts/audit-self-repeat.ts — 同じ下書きの中の二度言いを落とす出口（draft-repeat.ts dropSelfRepeats）の誤削除0の確かめ（読むだけ・LLM なし・DB に書かない）
//
// 2026-11-04 作業員6（文の外れ掘り 11/03 ③）。出口は誤削除0でなければ入れない（CLAUDE.md「おかしな文を1通見つけた時」）。
//   ① 竹内さん本人の実送信（staff_writer=takeuchi・手打ち）に当てて、当たる通が0か（竹内さんが二度言いをしているなら消してはいけない形）
//   ② 過去の AI の下書き（ai_reply_examples.ai_draft）に当てて、落とす前後を全部書き出す（目で読む）
// 夜だけ流す（営業時間 JST 9〜22時は重い読みをしない）。1000行ずつの頁で読む。
// 実行: npx tsx --env-file=.env.local scripts/audit-self-repeat.ts [--days=60] [--out=<scratchpad の md>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { dropSelfRepeats } from "../app/lib/draft-repeat";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || d;
const days = Number(arg("days", "60"));
const out = arg("out", "");

async function main() {
  const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${h}時）なので流さない（--force で流す）`); return; }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const page = async <T,>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) => {
    const all: T[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await q(f, f + 999);
      if (error) throw new Error(error.message);
      all.push(...(data ?? []));
      if (!data || data.length < 1000) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return all;
  };
  // ① 竹内さん本人の手打ち
  const sends = await page<{ id: string; text: string | null }>((f, t) => sb.from("messages").select("id, text").eq("sender", "staff").eq("staff_writer", "takeuchi")
    .or("is_aix_generated.is.null,is_aix_generated.eq.false").gte("created_at", since).order("created_at").range(f, t));
  const takeuchiHits = sends.map((m) => ({ id: m.id, r: dropSelfRepeats(String(m.text ?? "")) })).filter((x) => x.r.dropped.length);
  // ② AI の下書き
  const drafts = await page<{ id: string; ai_draft: string | null; sent_reply: string | null }>((f, t) => sb.from("ai_reply_examples").select("id, ai_draft, sent_reply")
    .not("ai_draft", "is", null).gte("created_at", since).order("created_at").range(f, t));
  const draftHits = drafts.map((d) => ({ id: d.id, before: String(d.ai_draft ?? ""), sent: String(d.sent_reply ?? ""), r: dropSelfRepeats(String(d.ai_draft ?? "")) })).filter((x) => x.r.dropped.length);
  // 落とした文が竹内さん・スタッフの実送信に残っていた（＝消してはいけなかったかもしれない）数
  const keptInSent = draftHits.filter((x) => x.r.dropped.some((s) => x.sent.includes(s))).length;
  const lines = [
    `# 二度言いの出口の監査（${days}日・${new Date().toISOString()}）`,
    `- ① 竹内さん本人の手打ち ${sends.length}通のうち当たり ${takeuchiHits.length}通（0 でなければ入れない）`,
    `- ② AI の下書き ${drafts.length}通のうち当たり ${draftHits.length}通・落とした文がスタッフの実送信に残っていた ${keptInSent}通`,
    "", "## ① 竹内さんの当たり（id と落とす文）", ...takeuchiHits.map((x) => `- ${x.id.slice(0, 8)}: ${x.r.dropped.join(" ／ ")}`),
    "", "## ② 下書きの前後（目で読む）",
    ...draftHits.flatMap((x) => [`### ${x.id.slice(0, 8)}${x.r.dropped.some((s) => x.sent.includes(s)) ? "（⚠ 実送信に残っていた）" : ""}`, "前:", "```", x.before, "```", "後:", "```", x.r.text, "```", "実送信:", "```", x.sent, "```"]),
  ];
  if (out) { writeFileSync(out, lines.join("\n")); console.log(`書いた: ${out}`); }
  console.log(lines.slice(0, 3).join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
