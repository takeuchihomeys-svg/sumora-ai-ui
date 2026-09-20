// scripts/audit-pickup-guard.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-guard.ts
//
// 2026-09-19 竹内（慶次事例）。stripUngroundedConditions を**スタッフの実送信全件**に当てて
// 誤削除を数える（設計知見「落とす仕組みは過去の全件に当てて目で読む」）。
// 根拠は「その会話のお客様の発言（その時点まで）∪ 登録条件（property_customers）」。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { findUngroundedConditions, PICKUP_LINE_RE, COND_WORDS } from "../app/lib/pickup-condition-guard";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  // ① 宣言行に条件語がある実送信だけを集める
  let from = 0; const size = 1000;
  const cands: Array<{ conv: string; text: string; at: string }> = [];
  for (;;) {
    const { data, error } = await sb.from("messages")
      .select("conversation_id, text, created_at").neq("sender", "customer").not("text", "is", null)
      .range(from, from + size - 1);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    for (const m of data) {
      const t = String(m.text ?? "");
      const lines = t.split("\n").filter((l: string) => PICKUP_LINE_RE.test(l) && !/[?？]/.test(l));
      if (lines.some((l) => COND_WORDS.some((w: string) => l.includes(w)))) cands.push({ conv: m.conversation_id as string, text: t, at: m.created_at as string });
    }
    if (data.length < size) break;
    from += size;
  }
  console.log(`=== 宣言行に条件語がある実送信: ${cands.length}通 ===\n`);

  // ② 会話ごとに根拠（お客様の発言＋登録条件）を集めて当てる
  const condCache = new Map<string, string[]>();
  let changed = 0; const diffs: string[] = [];
  for (const c of cands) {
    if (!condCache.has(c.conv)) {
      const { data: cust } = await sb.from("messages")
        .select("text").eq("conversation_id", c.conv).eq("sender", "customer").not("text", "is", null).limit(300);
      const { data: conv } = await sb.from("conversations").select("property_customer_id").eq("id", c.conv).maybeSingle();
      const src = (cust ?? []).map((x: { text: string | null }) => String(x.text ?? ""));
      if (conv?.property_customer_id) {
        const { data: pc } = await sb.from("property_customers")
          .select("preferences, additional_conditions, ng_points, floor_plan, desired_area")
          .eq("id", conv.property_customer_id as string).maybeSingle();
        if (pc) src.push(Object.values(pc).filter(Boolean).join(" / "));
      }
      condCache.set(c.conv, src);
    }
    const hits = findUngroundedConditions(c.text, condCache.get(c.conv)!);
    if (hits.length === 0) continue;
    changed++;
    if (diffs.length < 20) {
      diffs.push(`  [${new Date(c.at).toLocaleDateString("ja-JP")}] 指摘: ${hits.map((x) => x.word).join("・")}\n    ${hits[0].line.slice(0, 120)}`);
    }
  }
  console.log(`--- 結果（落とさず warning として出す）---`);
  console.log(`  当てた ${cands.length}通 / **指摘が出る ${changed}通**（${((100 * changed) / Math.max(cands.length, 1)).toFixed(1)}%）`);
  console.log(`  ＝ スタッフの実送信でこの率なら、指摘が多すぎて無視される事はない\n`);
  console.log(`--- 指摘の中身（20件・本物の見落としか、根拠の取りこぼしかを目で読む）---`);
  diffs.forEach((d) => console.log(d));
}
main().catch((e) => { console.error(e); process.exit(1); });
