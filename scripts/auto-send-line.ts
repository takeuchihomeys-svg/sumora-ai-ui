// scripts/auto-send-line.ts — 場面ごとの自動送信の線の一覧（土台の7つ ⑥・読むだけ・LLM なし・費用 0）
//   見張り line_watch_turns の直近 N 日（既定 60）を場面ごとに数え、候補／近い／遠い に分ける（線は scripts/lib/auto-send-line-core.ts）。
//   テスト用の会話は数えない。出力: .claude/exam-cache/auto-send-line/<日付>.md（場面の名前と数だけ・お客様の文は無い）
//   重い読み（60日の全件）なので夜に: exam-conductor.ts --add --runner=cmd --night --label=auto-send-line --cmd="scripts/auto-send-line.ts"
//   次の段（設計案・この道具は数えるだけ）: 候補の場面だけ「影の自動返信」（送らずに記録）→ 2週続けて候補なら竹内さんに解禁を聞く。最終チェックを省ける場面は block 0 が続く場面
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { tallyTurns, gradeScene, askScenes, AUTO_LINE } from "./lib/auto-send-line-core";
import { examCacheRoot } from "./lib/llm-cassette";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "60");

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; scene_key: string | null; verdict: string | null; verdict_detail: Record<string, unknown> | null; final_check: Record<string, unknown> | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id, scene_key, verdict, verdict_detail, final_check").gte("customer_turn_at", since).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  const lines = tallyTurns(rows.filter((r) => !isTestConversation(r.conversation_id))).map(gradeScene);
  const by = (g: string) => lines.filter((l) => l.grade === g);
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const L = [`# 場面ごとの自動送信の線（${day}・直近 ${DAYS}日）`, "", `線（11/03 竹内さんの決定）: 判定のある番 ${AUTO_LINE.minN}番以上・一致の Wilson 下限 ${AUTO_LINE.lower * 100}% 以上・返信か AIX かの外れ 0・最終チェックの block 0`, "",
    `## 候補 ${by("候補").length}`, ...by("候補").map((l) => `- ${l.scene}: ${l.why}`), "",
    `## 近い ${by("近い").length}`, ...by("近い").map((l) => `- ${l.scene}: ${l.why}`), "",
    `## 遠い ${by("遠い").length}（数の多い順）`, ...by("遠い").slice(0, 30).map((l) => `- ${l.scene}: ${l.why}`)];
  const out = join(examCacheRoot(), "auto-send-line");
  mkdirSync(out, { recursive: true });
  // 2週続けて候補の場面（11/03 夕 竹内さんの決定）: 前の回（7〜13日前）の候補と重なる場面だけ、竹内さんに解禁を伺う
  const cands = by("候補").map((l) => l.scene);
  const runs = readdirSync(out).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).map((x) => { try { return JSON.parse(readFileSync(join(out, x), "utf8")) as { day: string; cands: string[] }; } catch { return null; } }).filter((x): x is { day: string; cands: string[] } => !!x);
  const ask = askScenes(cands, runs, day);
  L.push("", `## 竹内さんに解禁を伺う場面（2週続けて候補・前の回 ${ask.prevDay ?? "無し＝来週から"}）`, ...(ask.scenes.length ? ask.scenes.map((x) => `- ${x}`) : ["- なし"]));
  writeFileSync(join(out, `${day}.json`), JSON.stringify({ day, cands, lines }, null, 1));
  writeFileSync(join(out, `${day}.md`), L.join("\n") + "\n");
  console.log(L.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
