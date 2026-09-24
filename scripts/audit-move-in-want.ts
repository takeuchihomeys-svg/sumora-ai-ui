// scripts/audit-move-in-want.ts — お客様の入居時期の自由文（property_customers.move_in_time）を parseMoveInWant に当てる全件監査（DB は読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-move-in-want.ts [--today=2026-09-25]
//   値ごと（同じ文はまとめる）に「種類・その日までに・登録月」を出す。読めなかった（none/vague）・読み違いを目で確かめる。
//   お客様の名前・電話番号は出さない（入居時期の文だけ。数字の並びが電話番号に見える物は伏せる）
// 2026-09-25 初回: 結果は app/lib/move-in-want.ts の頭のコメントと memory/dept_search_tool.md
import { createClient } from "@supabase/supabase-js";
import { parseMoveInWant } from "../app/lib/move-in-want";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const today = (process.argv.find((a) => a.startsWith("--today=")) ?? "").slice(8) || undefined;
const safe = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "＊");

(async () => {
  const { data, error } = await sb.from("property_customers").select("move_in_time, created_at").limit(5000);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = (data ?? []) as Array<{ move_in_time: string | null; created_at: string | null }>;
  const withText = rows.filter((r) => String(r.move_in_time ?? "").trim());
  console.log(`property_customers ${rows.length}人・入居時期の文あり ${withText.length}人`);
  const kinds = new Map<string, number>();
  const lines: string[] = [];
  const byVal = new Map<string, { n: number; out: string[] }>();
  for (const r of withText) {
    const w = parseMoveInWant(r.move_in_time, { registeredAt: r.created_at, today });
    kinds.set(w.kind, (kinds.get(w.kind) ?? 0) + 1);
    const key = `${w.kind.padEnd(5)} ${String(w.wantBy ?? "").padEnd(10)} ${safe(String(r.move_in_time).replace(/\n/g, "⏎")).slice(0, 50)}`;
    const e = byVal.get(key) ?? { n: 0, out: [] };
    e.n++; e.out.push(String(r.created_at ?? "").slice(0, 7));
    byVal.set(key, e);
  }
  console.log(`種類: ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" / ")}`);
  console.log("（by=その日までに／asap=すぐ＝今日／after=始まりだけ／vague=目安・季節／none=決まっていない／past=過ぎた日＝札なし）\n");
  for (const [k, v] of [...byVal.entries()].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`${String(v.n).padStart(2)}× ${k}  登録:${[...new Set(v.out)].join(",")}`);
  console.log(lines.join("\n"));
})();
