// scripts/audit-pickup-condition.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-condition.ts
//
// 2026-09-19 竹内（慶次事例）「ペット飼育等お客さんいうていないのにペット飼育とでてしまった」:
//   **ピックアップ宣言の条件部分**に出る設備語が、その会話のお客様の発言にあるかを数える。
//   （前回の監査では「本文のどこかに出る条件語」で測って線が引けなかった＝物件カードの設備説明が混ざるため。
//     今回は「これから探す条件」として書いている所だけに絞る）
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** ピックアップ宣言の行（これから探す条件を書く所） */
const PICKUP_LINE_RE = /(?:ピックアップ|お探し|探させて|お調べ)[^\n]{0,20}(?:させて(?:頂|いただ)き|します|いたします|致します)/;
/** お客様が言う種類の条件語（こちらが設備として書く語は入れない） */
const COND = ["ペット", "駐車場", "楽器", "事務所", "二人入居", "ルームシェア", "喫煙", "バストイレ別", "独立洗面", "オートロック", "宅配ボックス", "角部屋", "分譲"];

async function main() {
  let from = 0; const size = 1000;
  const rows: Array<{ conv: string; line: string; word: string; at: string }> = [];
  for (;;) {
    const { data, error } = await sb.from("messages")
      .select("conversation_id, text, created_at").neq("sender", "customer").not("text", "is", null)
      .range(from, from + size - 1);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    for (const m of data) {
      for (const line of String(m.text ?? "").split("\n")) {
        if (!PICKUP_LINE_RE.test(line)) continue;
        for (const w of COND) if (line.includes(w)) rows.push({ conv: m.conversation_id as string, line, word: w, at: m.created_at as string });
      }
    }
    if (data.length < size) break;
    from += size;
  }
  console.log(`=== ピックアップ宣言の行に条件語が出た実送信: ${rows.length}件 ===\n`);

  const byWord: Record<string, { n: number; grounded: number; bad: string[] }> = {};
  for (const r of rows) {
    byWord[r.word] ??= { n: 0, grounded: 0, bad: [] };
    byWord[r.word].n++;
    const { count } = await sb.from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", r.conv).eq("sender", "customer").lte("created_at", r.at).ilike("text", `%${r.word}%`);
    if ((count ?? 0) > 0) byWord[r.word].grounded++;
    else if (byWord[r.word].bad.length < 3) byWord[r.word].bad.push(r.line.trim().slice(0, 90));
  }
  console.log("--- その語をお客様が（その時点までに）言っているか ---");
  let tn = 0, tg = 0;
  for (const [w, v] of Object.entries(byWord).sort((a, b) => b[1].n - a[1].n)) {
    tn += v.n; tg += v.grounded;
    console.log(`  ${w.padEnd(12)} ${String(v.n).padStart(3)}件 / お客様も言っている ${String(v.grounded).padStart(3)}件 （${((100 * v.grounded) / v.n).toFixed(0)}%）`);
    v.bad.forEach((b) => console.log(`      ✗ 根拠なし: ${b}`));
  }
  console.log(`\n  合計 ${tn}件 / 根拠あり ${tg}件 （${((100 * tg) / Math.max(tn, 1)).toFixed(1)}%）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
