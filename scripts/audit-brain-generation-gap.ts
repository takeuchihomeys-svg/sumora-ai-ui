// ブレインの判断と、実際に出来た文・スタッフが送った文の間のギャップを測る（読み取りのみ）
// 2026-09-23 竹内「実際のスタッフの文の生成との間でブレインの部分にギャップがあると思うからそこも埋めたい／
//   状況把握の部分を強める必要もある」
//
// 設計知見「final-check はブレインの判断をほとんど受け取っていなかった — 出している側と読む側を数えて確かめる」
//   と同じやり方で、**出している側（ブレイン）と使う側（生成）を突き合わせる**。
//
// 測ること（生成の記録 ai_reply_examples.reply_context_snapshot は生成の瞬間の値を持っている）:
//   ① ブレインの判断の鮮度（tier）ごとの、下書きがそのまま送られた率
//   ② ブレインの方向（brainReplyDirection）が、生成で実際に使われた方向（effectiveReplyDirection）と
//      **別物になっている割合**＝ブレインの判断が生成に届いていない率
//   ③ ブレインが値を出していない項目の割合（方向・締め・お客様の質問）
//   ④ ①〜③の組み合わせごとの質（そのまま送信率・似ている度）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-generation-gap.ts [DAYS=120]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);
type Row = {
  created_at: string; was_ai_used: boolean | null; ai_similarity: number | null;
  sent_reply: string | null; ai_draft: string | null; reply_context_snapshot: Record<string, unknown> | null;
};
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const avg = (a: number[]) => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length);
const used = (xs: Row[]) => xs.filter((x) => x.was_ai_used === true).length;
const sims = (xs: Row[]) => xs.map((x) => x.ai_similarity).filter((v): v is number => typeof v === "number");
const line = (name: string, xs: Row[], total: number) =>
  `   ${name.padEnd(34)} ${String(xs.length).padStart(5)}件（${pct(xs.length, total).padStart(6)}） ／ そのまま送信 ${pct(used(xs), xs.length).padStart(7)} ／ 似ている度 ${avg(sims(xs)).toFixed(3)}`;

/** 2つの方向が「同じことを言っている」か（語の重なりで粗く見る。違いを過大に数えないため甘めにする） */
function sameDirection(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[。、！!？?\s]/g, "");
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B || A.includes(B) || B.includes(A)) return true;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2)));
  const ga = grams(A), gb = grams(B);
  let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size) >= 0.6;
}

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("created_at, was_ai_used, ai_similarity, sent_reply, ai_draft, reply_context_snapshot")
      .gte("created_at", since).not("reply_context_snapshot", "is", null)
      .order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const s = (r: Row) => (r.reply_context_snapshot ?? {}) as Record<string, unknown>;
  const rich = rows.filter((r) => "brainReplyDirection" in s(r) || "tier" in s(r));
  console.log(`直近${days}日の生成の記録 ${rows.length}件 ／ ブレインの値が残っている ${rich.length}件\n`);
  if (rich.length === 0) { console.log("※ 生成の記録の形が変わっている。鍵:", Object.keys(s(rows[0] ?? {} as Row)).join(", ")); return; }

  console.log(`① ブレインの判断の鮮度（tier）ごと`);
  const tiers = [...new Set(rich.map((r) => String(s(r).tier ?? "なし")))].sort();
  for (const t of tiers) console.log(line(`tier=${t}`, rich.filter((r) => String(s(r).tier ?? "なし") === t), rich.length));

  console.log(`\n② ブレインの方向が生成にそのまま使われたか`);
  const dirOf = (r: Row) => String(s(r).brainReplyDirection ?? "").trim();
  const effOf = (r: Row) => String(s(r).effectiveReplyDirection ?? "").trim();
  const noBrainDir = rich.filter((r) => !dirOf(r));
  const bothDir = rich.filter((r) => dirOf(r) && effOf(r));
  const kept = bothDir.filter((r) => sameDirection(dirOf(r), effOf(r)));
  const replaced = bothDir.filter((r) => !sameDirection(dirOf(r), effOf(r)));
  console.log(line("ブレインの方向が無い", noBrainDir, rich.length));
  console.log(line("方向がそのまま使われた", kept, rich.length));
  console.log(line("方向が別物に差し替わった", replaced, rich.length));
  console.log(`\n   差し替わった実物（5件・目で読む）`);
  for (const r of replaced.slice(0, 5)) {
    console.log(`   ── ブレイン : ${dirOf(r).slice(0, 84)}`);
    console.log(`      生成が使用: ${effOf(r).slice(0, 84)}`);
    console.log(`      そのまま送信: ${r.was_ai_used ? "はい" : "いいえ"}`);
  }

  console.log(`\n③ ブレインが値を出していない項目`);
  for (const k of ["brainReplyDirection", "brainClosingStrategy", "brainCustomerQuestions", "rawAction", "tpo_label", "stateKnown"]) {
    const missing = rich.filter((r) => {
      const v = s(r)[k];
      return v == null || v === "" || (Array.isArray(v) && v.length === 0) || v === false;
    });
    console.log(line(`${k} が空`, missing, rich.length));
  }

  console.log(`\n④ 状況把握の指標（スナップショットに残っている物）`);
  for (const k of ["stateKnown", "isCachedMeta", "isConditionPresented", "isNegativeContext", "isThinkingMsg", "isViewingCancel"]) {
    const on = rich.filter((r) => s(r)[k] === true);
    if (on.length) console.log(line(`${k}=true`, on, rich.length));
  }
  // ⑥ 方向が差し替わった時、**スタッフの実送信はどちらに沿ったか**。
  //   設計知見「どちらが正しいかは生成文と実送信の差分で決める」。
  //   ブレインだけが言っている内容語／生成だけが言っている内容語を作り、実送信に何個入っているかで比べる。
  const words = (s: string) => new Set(
    (s.match(/[一-龥]{2,}|[ァ-ヶー]{3,}|[A-Za-z]{3,}|\d{2,}/g) ?? [])
      .filter((w) => !/^(お客様|場合|内容|部分|形式|以下|以上|必要|可能|対応|確認|連絡|提案|送付|報告|実施|状況|今回|次回|文字|一行|一文|宣言|添える|受け取|合計)$/.test(w)),
  );
  let brainWin = 0, genWin = 0, tie = 0;
  const examples: Array<{ b: string; g: string; sent: string; bHit: number; gHit: number }> = [];
  for (const r of replaced) {
    const sent = (r.sent_reply ?? "").trim();
    if (!sent) continue;
    const B = words(dirOf(r)), G = words(effOf(r));
    const bOnly = [...B].filter((w) => !G.has(w));
    const gOnly = [...G].filter((w) => !B.has(w));
    if (bOnly.length === 0 && gOnly.length === 0) continue;
    const bHit = bOnly.filter((w) => sent.includes(w)).length / Math.max(bOnly.length, 1);
    const gHit = gOnly.filter((w) => sent.includes(w)).length / Math.max(gOnly.length, 1);
    if (bHit > gHit) { brainWin++; if (examples.length < 6) examples.push({ b: dirOf(r), g: effOf(r), sent, bHit, gHit }); }
    else if (gHit > bHit) genWin++;
    else tie++;
  }
  const tot = brainWin + genWin + tie;
  console.log(`\n⑥ 方向が差し替わった時、スタッフの実送信はどちらに沿ったか（${tot}件）`);
  console.log(`   ブレインの方向に沿った  ${String(brainWin).padStart(4)}件（${pct(brainWin, tot)}）`);
  console.log(`   生成の方向に沿った      ${String(genWin).padStart(4)}件（${pct(genWin, tot)}）`);
  console.log(`   どちらとも言えない      ${String(tie).padStart(4)}件（${pct(tie, tot)}）`);
  console.log(`\n   ブレインの方が合っていた実物（目で読む）`);
  for (const e of examples) {
    console.log(`   ── ブレイン : ${e.b.slice(0, 70)}`);
    console.log(`      生成が使用: ${e.g.slice(0, 70)}`);
    console.log(`      実送信    : ${e.sent.replace(/\n/g, " / ").slice(0, 100)}`);
  }

  const codes = new Map<string, number>();
  for (const r of rich) for (const c of (Array.isArray(s(r).finalCheckCodes) ? s(r).finalCheckCodes as string[] : [])) codes.set(c, (codes.get(c) ?? 0) + 1);
  console.log(`\n⑤ 最終チェックの指摘（上位10）`);
  for (const [c, n] of [...codes].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const hit = rich.filter((r) => (Array.isArray(s(r).finalCheckCodes) ? s(r).finalCheckCodes as string[] : []).includes(c));
    console.log(line(c, hit, rich.length).replace(/^   /, `   ${String(n).padStart(4)}回 `));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
