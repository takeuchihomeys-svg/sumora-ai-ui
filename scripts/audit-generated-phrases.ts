// scripts/audit-generated-phrases.ts
// 「AI が書いたのに、こちらが一度も送ったことがない言い回し」を洗い出す（型との距離を測る）。
//
// 2026-09-18 竹内「型との距離を測る仕組み」:
//   これまで「よくわからん文」は竹内さんが画面で気付いて指摘 → 実データを数える、の繰り返しだった。
//   （物件名が混ざる／複数の／全力サポートの連発／重複しないよう選定…）
//   どれも最後は同じ問いに行き着く＝**その言い回しはスタッフ実送信に何件あるか**。0件なら創作。
//   それを毎回手で数えるのをやめ、生成文から言い回し（述部）を取り出して実送信と突き合わせる。
//
// 設計知見に従う:
//   ・自動で落とさない。**列挙するだけ**（落とす線は人が実物を見て引く）
//   ・件数を必ず出す（0件・1件・多数）／元の文も一緒に出して目で見られるようにする
//
// 実行: npx tsx --env-file=.env.local scripts/audit-generated-phrases.ts [--days=7] [--action=property_send] [--min=2]
import { createClient } from "@supabase/supabase-js";
import { extractPhraseShapes } from "../app/lib/phrase-shape";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const DAYS = Number(arg("days", "7"));
const ACTION = arg("action", "");
const MIN_HITS = Number(arg("min", "2")); // 生成側で何回以上出たものを報告するか（1回だけの揺れを除く）

type GenRow = { action_type: string | null; status: string | null; generated_text: string | null; created_at: string };

async function loadGenerated(): Promise<GenRow[]> {
  const since = new Date(Date.now() - DAYS * 24 * 3600_000).toISOString();
  const out: GenRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from("aix_generate_log")
      .select("action_type, status, generated_text, created_at")
      .gte("created_at", since).range(from, from + 999);
    if (ACTION) q = q.eq("action_type", ACTION);
    const { data, error } = await q;
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    out.push(...(data as GenRow[]));
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * スタッフ実送信（1年）を全件読み、**生成文と同じマスク**をかけた述部の件数表を作る。
 * ※ マスクした語で生のテキストを LIKE 検索しても当たらない（実送信には数字・物件名が入っているため）。
 *   突き合わせるなら両側に同じ整形をかける（最初この向きを間違えて、物件カードの定型が全部「0件」に出た）
 */
async function loadSentPredicates(): Promise<Map<string, number>> {
  const since = new Date(Date.now() - 365 * 24 * 3600_000).toISOString();
  const counts = new Map<string, number>();
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("messages")
      .select("text").eq("sender", "staff").gte("created_at", since).range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    for (const r of data as Array<{ text: string | null }>) {
      total++;
      for (const s of extractPhraseShapes(r.text ?? "")) {
        counts.set(s.predicate, (counts.get(s.predicate) ?? 0) + 1);
      }
    }
    if (data.length < 1000) break;
  }
  console.log(`実送信（365日）: ${total}通 → 言い回し ${counts.size}種類\n`);
  return counts;
}

(async () => {
  const rows = await loadGenerated();
  console.log(`生成ログ（直近${DAYS}日${ACTION ? ` / ${ACTION}` : ""}）: ${rows.length}件\n`);
  if (!rows.length) { console.log("（生成ログがありません）"); return; }

  // ── 言い回しを集める（どの生成に何回出たか・元の文も持つ）──
  type Agg = { count: number; actions: Set<string>; samples: string[] };
  const shapes = new Map<string, Agg>();
  for (const r of rows) {
    const text = r.generated_text ?? "";
    if (!text.trim()) continue;
    for (const s of extractPhraseShapes(text)) {
      const cur = shapes.get(s.predicate) ?? { count: 0, actions: new Set<string>(), samples: [] };
      cur.count++;
      cur.actions.add(`${r.action_type ?? "-"}/${r.status ?? "-"}`);
      if (cur.samples.length < 3 && !cur.samples.includes(s.clause)) cur.samples.push(s.clause);
      shapes.set(s.predicate, cur);
    }
  }
  const candidates = [...shapes.entries()].filter(([, v]) => v.count >= MIN_HITS)
    .sort((a, b) => b[1].count - a[1].count);
  console.log(`言い回し（${MIN_HITS}回以上出たもの）: ${candidates.length}種類 — 実送信と突き合わせます\n`);

  // ── 実送信の件数を引く（両側に同じマスクをかけて突き合わせる）──
  const sentCounts = await loadSentPredicates();
  const verdicts = candidates.map(([predicate, v]) => ({
    predicate, generated: v.count, sent: sentCounts.get(predicate) ?? 0,
    actions: [...v.actions], samples: v.samples,
  }));

  const unseen = verdicts.filter((v) => v.sent === 0).sort((a, b) => b.generated - a.generated);
  const rare = verdicts.filter((v) => v.sent > 0 && v.sent <= 3).sort((a, b) => b.generated - a.generated);

  console.log("=== ① こちらが一度も送ったことがない言い回し（実送信 0件）===");
  if (!unseen.length) console.log("  （なし）");
  for (const v of unseen) {
    console.log(`\n  ・「${v.predicate}」  生成${v.generated}回 / 実送信 0件   [${v.actions.join(", ")}]`);
    for (const s of v.samples) console.log(`      ${s}`);
  }

  console.log("\n\n=== ② ほとんど送っていない言い回し（実送信 1〜3件）===");
  if (!rare.length) console.log("  （なし）");
  for (const v of rare) {
    console.log(`  ・「${v.predicate}」  生成${v.generated}回 / 実送信 ${v.sent}件   [${v.actions.join(", ")}]`);
    console.log(`      ${v.samples[0] ?? ""}`);
  }

  console.log(`\n\n=== まとめ ===`);
  console.log(`  調べた言い回し: ${verdicts.length}種類`);
  console.log(`  実送信 0件 : ${unseen.length}種類（生成 ${unseen.reduce((n, v) => n + v.generated, 0)}回）`);
  console.log(`  実送信 1〜3件: ${rare.length}種類`);
  console.log(`  ※ ここに出たものを自動では落としません。実物を見て、落とす線は人が引きます`);
})();
