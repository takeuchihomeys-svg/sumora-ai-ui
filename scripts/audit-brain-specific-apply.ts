// 足した「🧠 今回ブレインが掴んだ中身」を実物に当てて、入る行を目で読む（読み取りのみ・全件監査）
// 2026-09-23 竹内「スタッフの文の生成との間でブレインの部分にギャップがある／状況把握の部分を強める」
//
// 設計知見「監査で止める」「件数だけ見ない・目で読む」。見るのは3つ:
//   ① 何件で足されるか（＝今まで届いていなかったブレインの判断の数）
//   ② 足された中身が、スタッフの実送信に実際に現れているか（内容語で照合）
//   ③ 足すと危ない物（型とぶつかる・古い・具体が無い抽象文）が混ざっていないか ← 目で読む
//
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-specific-apply.ts [DAYS=120] [SHOW=14]
import { createClient } from "@supabase/supabase-js";
import { buildBrainSpecificNote } from "../app/lib/brain-specific-note";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);
type Row = { was_ai_used: boolean | null; sent_reply: string | null; reply_context_snapshot: Record<string, unknown> | null };
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
/** 内容語（固有名詞・条件語）。汎用語は落とす */
const words = (s: string) => new Set(
  (s.match(/[一-龥]{2,}|[ァ-ヶー]{3,}|[A-Za-z]{3,}|\d{2,}/g) ?? [])
    .filter((w) => !/^(お客様|場合|内容|部分|形式|以下|以上|必要|可能|対応|報告|実施|状況|今回|次回|文字|一行|一文|宣言|添える|受け取|合計|提案|送付|連絡|確認)$/.test(w)),
);

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const SHOW = Number(process.env.SHOW ?? 14);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("was_ai_used, sent_reply, reply_context_snapshot")
      .gte("created_at", since).not("reply_context_snapshot", "is", null)
      .order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const s = (r: Row) => (r.reply_context_snapshot ?? {}) as Record<string, unknown>;
  const rich = rows.filter((r) => "brainReplyDirection" in s(r));
  console.log(`直近${days}日 ${rows.length}件 ／ ブレインの値が残っている ${rich.length}件\n`);

  let added = 0, skippedScene = 0, skippedSame = 0, skippedNone = 0;
  const samples: Array<{ note: string; type: string; sent: string; hit: number; used: boolean }> = [];
  for (const r of rich) {
    const snap = s(r);
    const brainDir = String(snap.brainReplyDirection ?? "").trim();
    const eff = String(snap.effectiveReplyDirection ?? "").trim();
    // スナップショットに残っている場面フラグから「新しい提案を禁止している場面」を組み立てる
    const noNew = snap.isViewingCancel === true || snap.isNegativeContext === true
      || snap.isPostStrongRecommendation === true || snap.isGratitudeReplyTPO === true
      || snap.isTemporaryLeaveMsg === true || snap.isThinkingMsg === true;
    const fresh = snap.isCachedMeta !== true && String(snap.tier ?? "") !== "T2";
    if (!brainDir) { skippedNone++; continue; }
    const note = buildBrainSpecificNote({ brainDirection: brainDir, effectiveDirection: eff, fresh, noNewProposalScene: noNew });
    if (!note) { if (noNew) skippedScene++; else skippedSame++; continue; }
    added++;
    const sent = (r.sent_reply ?? "").trim();
    const W = [...words(brainDir)];
    const hit = W.length ? W.filter((w) => sent.includes(w)).length / W.length : 0;
    samples.push({ note: brainDir, type: eff.slice(0, 60), sent, hit, used: r.was_ai_used === true });
  }
  console.log(`① 足される: ${added}件（${pct(added, rich.length)}）`);
  console.log(`   足さない: ブレインが方向を出していない ${skippedNone} ／ 提案禁止の場面 ${skippedScene} ／ 既に型に入っている・古い ${skippedSame}`);

  const withSent = samples.filter((x) => x.sent);
  const strong = withSent.filter((x) => x.hit >= 0.5);
  const none = withSent.filter((x) => x.hit === 0);
  console.log(`\n② 足す中身が、スタッフの実送信に現れているか（実送信がある ${withSent.length}件）`);
  console.log(`   半分以上の内容語が実送信にある  ${strong.length}件（${pct(strong.length, withSent.length)}）＝ 届いていれば効いた可能性が高い`);
  console.log(`   1語も無い                      ${none.length}件（${pct(none.length, withSent.length)}）＝ 足しても実送信とは関係なかった`);
  console.log(`   そのまま送信された割合: 内容語あり ${pct(strong.filter((x) => x.used).length, strong.length)} ／ 無し ${pct(none.filter((x) => x.used).length, none.length)}`);

  console.log(`\n③ 実物（実送信との重なりが高い順・${SHOW}件。危ない足し方が無いか目で読む）`);
  for (const x of withSent.sort((a, b) => b.hit - a.hit).slice(0, SHOW)) {
    console.log(`\n   ── 重なり ${(x.hit * 100).toFixed(0)}%${x.used ? "・そのまま送信" : ""}`);
    console.log(`      足す中身: ${x.note.slice(0, 76)}`);
    console.log(`      型(生成) : ${x.type}`);
    console.log(`      実送信   : ${x.sent.replace(/\n/g, " / ").slice(0, 96)}`);
  }
  console.log(`\n④ 1語も無かった物（足しても関係なかった物・5件。害が無いか目で読む）`);
  for (const x of none.slice(0, 5)) {
    console.log(`   足す中身: ${x.note.slice(0, 60)}  ／ 実送信: ${x.sent.replace(/\n/g, " / ").slice(0, 70)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
