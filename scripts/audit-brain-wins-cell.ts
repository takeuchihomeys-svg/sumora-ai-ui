// 「ブレインが勝つ」で必須要素がどれだけ落ちるか、落として良かったかを全件で見る（読み取りのみ）
//
// 2026-09-21 竹内「ブレインが勝つようにする」
//
// 設計知見「全件監査（過去の実送信に当てて、変換の前後を**目で読む**。件数だけ見ない）」。
//   落とした必須要素を、**スタッフが実際に送った次の1通**に当てる:
//     落とした要素をスタッフも書いていない → 落として正解
//     落とした要素をスタッフは書いていた   → 落としすぎ（セルが正しかった）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-wins-cell.ts
import { createClient } from "@supabase/supabase-js";
// ⚠ reply_context_snapshot の turnPair には ruleId しか残っていない（mustInclude の detect は関数なので JSON にならない）。
//   代わりに、同じスナップショットに残っている **cellConflicts**（＝新しい形で落とす要素そのもの）を使い、
//   PAIR_MATRIX から要素を引き直して実送信に当てる。
import { PAIR_MATRIX, mustIncludeSatisfied, type PairContext } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  // reply_context_snapshot に生成の瞬間の pair が残っている例を使う
  const ex = await page("ai_reply_examples", "id, conversation_id, sent_reply, reply_context_snapshot, created_at", "created_at", days);
  const withSnap = ex.filter((r) => r.reply_context_snapshot && typeof r.reply_context_snapshot === "object");
  console.log(`=== 材料: ai_reply_examples ${ex.length}件 / スナップショット有り ${withSnap.length}件（直近${days}日）===\n`);

  let cases = 0, droppedCases = 0, droppedElems = 0, staffWrote = 0;
  const byCls = new Map<string, { n: number; wrote: number }>();
  const good: string[] = [], bad: string[] = [];

  type Conflict = { kind?: string; ruleId?: string; element?: string; brainValue?: string; message?: string };
  for (const r of withSnap) {
    const snap = r.reply_context_snapshot as Record<string, unknown>;
    const strategy = (snap.brainStrategy ?? null) as { avoid_topics?: string[] } | null;
    const tp = (snap.turnPair ?? null) as { ruleId?: string | null } | null;
    if (!tp?.ruleId || !strategy?.avoid_topics?.length) continue;
    cases++;
    const conflicts = ((snap.cellConflicts ?? []) as Conflict[]).filter((c) => c.kind === "avoid_vs_must");
    if (conflicts.length === 0) continue;
    droppedCases++;
    const rule = PAIR_MATRIX.find((x) => x.id === tp.ruleId);
    const sent = String(r.sent_reply ?? "");
    for (const c of conflicts) {
      droppedElems++;
      const elem = rule?.mustInclude.find((m) => m.label === c.element);
      // pair 本体は残っていないので、detectFn が pair を見る要素は素の detect で当てる（保守的）
      const wrote = elem ? (elem.detectFn ? elem.detect.test(sent) : mustIncludeSatisfied(elem, sent, {} as PairContext)) : false;
      const cls = c.message?.match(/意味クラス:\s*([a-z_]+)/)?.[1] ?? "?";
      const b = byCls.get(cls) ?? { n: 0, wrote: 0 };
      b.n++; if (wrote) { b.wrote++; staffWrote++; }
      byCls.set(cls, b);
      const line = `     避ける「${c.brainValue}」で落とした要素: ${String(c.element).slice(0, 60)}\n     実送信: ${mask(sent).slice(0, 120)}`;
      if (wrote) { if (bad.length < 8) bad.push(line); } else if (good.length < 5) good.push(line);
    }
  }

  console.log(`=== ① どれだけ落ちるか ===`);
  console.log(`   セルと avoid が両方ある場面 ${cases}件 / そのうち必須要素が落ちた ${droppedCases}件 (${pct(droppedCases, cases)})`);
  console.log(`   落とした必須要素 ${droppedElems}個\n`);

  console.log(`=== ② 落として良かったか（スタッフの実送信に当てる）===`);
  console.log(`   意味クラス        落とした   スタッフも書いていた   判定`);
  for (const [k, v] of [...byCls.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const rate = v.wrote / v.n;
    console.log(`   ${k.padEnd(16)} ${String(v.n).padStart(4)}個  ${String(v.wrote).padStart(4)}個 (${pct(v.wrote, v.n).padStart(6)})  ${rate < 0.3 ? "✅ 落として正解" : rate > 0.5 ? "⚠ 落としすぎ" : "△ 半々"}`);
  }
  console.log(`\n   合計: ${staffWrote}/${droppedElems} = ${pct(staffWrote, droppedElems)} は落としたのにスタッフは書いていた（＝落としすぎ）`);

  console.log(`\n=== ③ 落として正解だった実物 ===`);
  for (const s of good) { console.log(`${"─".repeat(74)}`); console.log(s); }
  console.log(`\n=== ④ 落としすぎだった実物（セルが正しかった可能性）===`);
  for (const s of bad) { console.log(`${"─".repeat(74)}`); console.log(s); }
  if (bad.length === 0) console.log(`   （0件）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
