// 往復文脈のセルが選ばれたかどうかで、返信の質は変わるのか（読み取りのみ）
//
// 2026-09-20 竹内「直す」
// 直す前に**効果を確かめる**（設計知見「分析強化の原則」: 材料やルールを足す前に測る）。
//
// reply_context_snapshot（ai_reply_examples の列）には生成の瞬間の turnPair が丸ごと残っている:
//   { staff: "estimate_send", ruleId: "ES_POSITIVE", ... }
// ruleId が null ＝ その場面に合うセルが PAIR_MATRIX に無かった（direction が汎用・必須要素も例文も無い）。
// was_ai_used / ai_similarity と突き合わせれば、**セルの有無で採用率が変わるか**が直接分かる。
// 変わらなければセルを足しても効果が無い。変われば足す価値がある。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 16; p++) {
    const { data } = await sb.from("ai_reply_examples")
      .select("id, was_ai_used, ai_similarity, conversation_state, reply_context_snapshot, created_at")
      .not("reply_context_snapshot", "is", null)
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  console.log(`=== 生成の記録が残っている下書き ${rows.length}件（直近${days}日）===\n`);

  type Cell = { n: number; used: number; simSum: number; simN: number };
  const mk = (): Cell => ({ n: 0, used: 0, simSum: 0, simN: 0 });
  const withRule = mk(), noRule = mk();
  const byStaffKind = new Map<string, Cell>();
  const byRuleId = new Map<string, Cell>();

  for (const r of rows) {
    const snap = (r.reply_context_snapshot ?? {}) as Record<string, unknown>;
    const tp = (snap.turnPair ?? {}) as Record<string, unknown>;
    const ruleId = tp.ruleId == null ? null : String(tp.ruleId);
    const staffKind = String(tp.staff ?? "(不明)");
    const used = r.was_ai_used === true;
    const sim = Number(r.ai_similarity);
    const add = (c: Cell) => { c.n++; if (used) c.used++; if (Number.isFinite(sim)) { c.simSum += sim; c.simN++; } };
    add(ruleId ? withRule : noRule);
    if (!byStaffKind.has(staffKind)) byStaffKind.set(staffKind, mk());
    add(byStaffKind.get(staffKind)!);
    const k = ruleId ?? "(セルなし)";
    if (!byRuleId.has(k)) byRuleId.set(k, mk());
    add(byRuleId.get(k)!);
  }

  const line = (label: string, c: Cell) => {
    const used = c.n ? ((c.used / c.n) * 100).toFixed(1) : "-";
    const sim = c.simN ? (c.simSum / c.simN).toFixed(3) : "-";
    console.log(`  ${label.padEnd(26)} ${String(c.n).padStart(5)}件  そのまま送信 ${used.padStart(5)}%  似ている度 ${sim}`);
  };
  console.log(`--- ★ セルが選ばれたか ---`);
  line("セルあり（rule != null）", withRule);
  line("セルなし（rule == null）", noRule);
  const d = (withRule.n && noRule.n) ? ((withRule.used / withRule.n) - (noRule.used / noRule.n)) * 100 : NaN;
  console.log(`\n  差: ${Number.isFinite(d) ? `${d > 0 ? "+" : ""}${d.toFixed(1)} ポイント` : "-"}（セルありの方が高ければ、セルを足す価値がある）`);

  console.log(`\n--- 直前スタッフ発言の種類別 ---`);
  for (const [k, c] of [...byStaffKind.entries()].sort((a, b) => b[1].n - a[1].n)) line(k, c);

  console.log(`\n--- セル別（上位15・件数順）---`);
  for (const [k, c] of [...byRuleId.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) line(k, c);

  // staff=other の中で、セルが選ばれた/選ばれなかったの内訳
  const other = rows.filter((r) => {
    const tp = ((r.reply_context_snapshot ?? {}) as Record<string, unknown>).turnPair as Record<string, unknown> | undefined;
    return String(tp?.staff ?? "") === "other";
  });
  const oWith = other.filter((r) => {
    const tp = ((r.reply_context_snapshot ?? {}) as Record<string, unknown>).turnPair as Record<string, unknown> | undefined;
    return tp?.ruleId != null;
  });
  console.log(`\n--- 直前=other の内訳 ---`);
  console.log(`  ${other.length}件のうち、セルが選ばれた（ANY_* が拾った）: ${oWith.length}件（${other.length ? ((oWith.length / other.length) * 100).toFixed(1) : "-"}%）`);
  const oWithUsed = oWith.filter((r) => r.was_ai_used === true).length;
  const oNo = other.length - oWith.length;
  const oNoUsed = other.filter((r) => r.was_ai_used === true).length - oWithUsed;
  console.log(`    セルあり: ${oWith.length}件 そのまま送信 ${oWith.length ? ((oWithUsed / oWith.length) * 100).toFixed(1) : "-"}%`);
  console.log(`    セルなし: ${oNo}件 そのまま送信 ${oNo ? ((oNoUsed / oNo) * 100).toFixed(1) : "-"}%`);
}
main().catch((e) => { console.error(e); process.exit(1); });
