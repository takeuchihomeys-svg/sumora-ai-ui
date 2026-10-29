// scripts/build-aix-desk-cards.ts — AIX の担当の札を手元で作る（試し scripts/aix-desk-eval.ts 用の写し・竹内さんに聞く薄い札の一覧）
//
// 2026-10-29 作業員1: 札の作り方の本体は app/lib/aix-desk-cards-build.ts（週1の cron /api/cron/aix-desk-cards が表 aix_desk_cards に書く）。
//   この道具は表には書かない（手元にサーバーの鍵が無い・札の本文は git に入れない）。出力:
//   <倉庫の根>/.claude/exam-cache/aix-desk/cards.json（手元の写し）／<倉庫の根>/.claude/exam-cache/aix-desk/<日付>.md（中身の薄い札の一覧）
// 実行: npx tsx --env-file=.env.local scripts/build-aix-desk-cards.ts [--days=180] [--dry]
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAixDeskCards, AIX_DESK_OWNER_MIN } from "../app/lib/aix-desk-cards-build";
import { examCacheRoot } from "./lib/llm-cassette";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const DRY = process.argv.includes("--dry");

(async () => {
  const { cards, usages } = await buildAixDeskCards(sb, { days: DAYS });
  const genAt = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  const thinCards = cards.filter((c) => c.thin.length);
  console.log(`札 ${cards.length}枚・薄い札 ${thinCards.length}枚（竹内さんの送信 ${AIX_DESK_OWNER_MIN}未満 ${cards.filter((c) => c.owner < AIX_DESK_OWNER_MIN).length}）・平均 ${Math.round(cards.reduce((a, c) => a + c.text.length, 0) / Math.max(1, cards.length))}字・aix_usage_logs ${usages}件`);
  if (DRY) { for (const c of cards.slice(0, 3)) console.log(`\n${c.text}`); process.exit(0); }
  const dir = join(examCacheRoot(), "aix-desk"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cards.json"), JSON.stringify({ generatedAt: genAt, cards: Object.fromEntries(cards.map((c) => [c.key, c])) }, null, 1));
  const md = [
    `# AIX の担当の札・中身の薄い札（${genAt}）`, "",
    `札 ${cards.length}枚のうち、竹内さんに聞きたい札 ${thinCards.length}枚（竹内さんの送信が ${AIX_DESK_OWNER_MIN}件未満・テンプレート・決定・場面の定義が無い）`, "",
    "| 担当 | ボタン → ピッカー | 竹内さんの送信 | 足りない物 |", "|---|---|---|---|",
    ...thinCards.sort((a, b) => a.owner - b.owner).map((c) => `| ${c.key} | ${c.button}${c.picker ? ` → ${c.picker}` : ""} | ${c.owner} | ${c.thin.join("・")} |`),
  ].join("\n");
  writeFileSync(join(dir, `${genAt.slice(0, 10)}.md`), md);
  console.log(`書いた: ${join(dir, "cards.json")}・${join(dir, `${genAt.slice(0, 10)}.md`)}`);
  process.exit(0);
})();
