// scripts/audit-self-repeat.ts — 同じ下書きの中の二度言いを落とす出口（draft-repeat.ts dropSelfRepeats）の誤削除0の確かめ（読むだけ・LLM なし・DB に書かない）
//
// 2026-11-04 作業員6（文の外れ掘り 11/03 ③）。出口は誤削除0でなければ入れない（CLAUDE.md「おかしな文を1通見つけた時」）。
//   ① 竹内さん本人の送信（staff_writer=takeuchi・手打ち／AIX の文は分けて数える）に当てて、当たる通が0か（竹内さんが二度言いをしているなら消してはいけない形）
//   ② 過去の AI の下書き（ai_reply_examples.ai_draft）に当てて、落とす前後を全部書き出す（目で読む）
// 2026-11-05 作業員3: ②の物差しを「落とした文がスタッフの実送信に2回残っていたか」（＝スタッフも二度言いを残した＝落とすと実送信とずれる）にした
//   （旧の「1回でも実送信にあった」は、二度言いの片方を消して送った正しい直しまで数えていた）。--cache=<json> で材料を手元から読む・--dump=<json> で落とす。
// 夜だけ流す（営業時間 JST 9〜22時は重い読みをしない）。1000行ずつの頁で読む。
// 実行: npx tsx --env-file=.env.local scripts/audit-self-repeat.ts [--days=60] [--out=<scratchpad の md>] [--dump=<json>|--cache=<json>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dropSelfRepeats, splitSentencesJa, sentenceSimilarity, SELF_EXIT_SIM } from "../app/lib/draft-repeat";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || d;
const days = Number(arg("days", "60"));
const out = arg("out", "");
type Send = { id: string; text: string | null; created_at?: string; is_aix_generated?: boolean | null };
type Draft = { id: string; ai_draft: string | null; sent_reply: string | null; created_at?: string };

async function load(): Promise<{ sends: Send[]; drafts: Draft[] }> {
  const cache = arg("cache", "");
  if (cache) return JSON.parse(readFileSync(cache, "utf8"));
  const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) throw new Error(`営業時間（JST ${h}時）なので DB を読まない（--cache=<json> か 22時以降に）`);
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
  const sends = await page<Send>((f, t) => sb.from("messages").select("id, text, created_at, is_aix_generated").eq("sender", "staff").eq("staff_writer", "takeuchi")
    .gte("created_at", since).order("created_at").range(f, t));
  const drafts = await page<Draft>((f, t) => sb.from("ai_reply_examples").select("id, ai_draft, sent_reply, created_at")
    .not("ai_draft", "is", null).gte("created_at", since).order("created_at").range(f, t));
  const dump = arg("dump", "");
  if (dump) writeFileSync(dump, JSON.stringify({ sends, drafts }));
  return { sends, drafts };
}

/** 実送信の中に、その文と近い文がいくつあるか */
const countIn = (text: string, s: string) => splitSentencesJa(text).filter((x) => sentenceSimilarity(x, s) >= SELF_EXIT_SIM).length;

async function main() {
  const { sends, drafts } = await load();
  // ① 竹内さん本人（手打ち・AIX の文）
  const hitOf = (m: Send) => ({ id: m.id, aix: !!m.is_aix_generated, text: String(m.text ?? ""), r: dropSelfRepeats(String(m.text ?? "")) });
  const takeuchiHits = sends.map(hitOf).filter((x) => x.r.dropped.length);
  const manualHits = takeuchiHits.filter((x) => !x.aix), aixHits = takeuchiHits.filter((x) => x.aix);
  // ② AI の下書き
  const draftHits = drafts.map((d) => ({ id: d.id, before: String(d.ai_draft ?? ""), sent: String(d.sent_reply ?? ""), r: dropSelfRepeats(String(d.ai_draft ?? "")) })).filter((x) => x.r.dropped.length);
  // 落とした文がスタッフの実送信に2回以上残っていた（＝スタッフも二度言いを残した・落とすと実送信とずれる）
  const keptTwice = draftHits.filter((x) => x.sent && x.r.dropped.some((s) => countIn(x.sent, s) >= 2));
  const keptOnce = draftHits.filter((x) => x.sent && !keptTwice.includes(x) && x.r.dropped.some((s) => countIn(x.sent, s) === 1));
  // ③ スタッフ全員の実送信（下書きの番の sent_reply）にも当てる（11/05 b18ac4b8・9a764026 を見つけた物差し）
  const sentHits = drafts.filter((d) => d.sent_reply).map((d) => ({ id: d.id, r: dropSelfRepeats(String(d.sent_reply)) })).filter((x) => x.r.dropped.length);
  const lines = [
    `# 二度言いの出口の監査（${days}日・${new Date().toISOString()}）`,
    `- ① 竹内さん本人の手打ち ${sends.filter((m) => !m.is_aix_generated).length}通のうち当たり ${manualHits.length}通・AIX の文 ${sends.filter((m) => m.is_aix_generated).length}通のうち当たり ${aixHits.length}通（どちらも 0 でなければ入れない）`,
    `- ② AI の下書き ${drafts.length}通のうち当たり ${draftHits.length}通・落とした文がスタッフの実送信に2回残っていた（誤削除の候補）${keptTwice.length}通・1回だけ残った（片方を消して送った）${keptOnce.length}通`,
    `- ③ スタッフ全員の実送信（下書きの番）${drafts.filter((d) => d.sent_reply).length}通のうち当たり ${sentHits.length}通（0 でなければ入れない）`,
    ...sentHits.map((x) => `  - ${x.id.slice(0, 8)}: ${x.r.dropped.join(" ／ ")}`),
    "", "## ① 竹内さんの当たり（id と落とす文）", ...takeuchiHits.map((x) => `- ${x.id.slice(0, 8)}${x.aix ? "（AIX）" : ""}: ${x.r.dropped.join(" ／ ")}\n  全文: ${x.text.replace(/\n/g, " ⏎ ").slice(0, 400)}`),
    "", "## ② 下書きの前後（目で読む）",
    ...draftHits.flatMap((x) => [`### ${x.id.slice(0, 8)}${keptTwice.includes(x) ? "（⚠ 実送信に2回残っていた）" : keptOnce.includes(x) ? "（実送信は1回）" : ""}`, `落とす文: ${x.r.dropped.join(" ／ ")}`, "前:", "```", x.before, "```", "後:", "```", x.r.text, "```", "実送信:", "```", x.sent, "```"]),
  ];
  if (out) { writeFileSync(out, lines.join("\n")); console.log(`書いた: ${out}`); }
  console.log(lines.slice(0, 4).join("\n"));
  if (process.argv.includes("--list")) for (const x of draftHits) console.log(`${x.id.slice(0, 8)}${keptTwice.includes(x) ? " ⚠2" : keptOnce.includes(x) ? " 1" : " 0"}: ${x.r.dropped.join(" ／ ")}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
