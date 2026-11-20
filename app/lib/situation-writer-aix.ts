// app/lib/situation-writer-aix.ts — AIX の2通目（aix-template-generate）の書き手へ、今の状況の記録と「こちらが前に伝えた事」を渡す（純関数・DB/LLM なし）
//
// 2026-11-21 作業員K2（竹内さん 11/21「2通目も、何度も同じ返信をするのを改善する。自分が言った事に対する次の返信の考えが弱い」・統括役の割り振り）。
//   作業員L の確かめ（11/21）: meta.situation_now（our_items・promises_open・checked 等）は generate-reply の書き手（SITUATION_WRITER_NOTE）だけが読み、
//   aix-template-generate は situation_now も our_items も読んでいなかった＝AIX の2通目の書き手は「こちらが前に何を言ったか」を項目で持っていない（材料が届いていない）。
//   ここでは L の situationWriterNote（事実だけの塊）に、our_items の直近の項目（種類・何を言ったか・お客様が答えたか）を足して渡す。
//   名前は L の our_items（our-part-types の OUR_PART_KINDS）と M の LinkKind にそろえる。道の言葉は書かない（決めるのは書き手とブレイン）。
//   数え（scripts/audit-ours-next-table.ts・30日 568番）: こちらが約束した後の次の塊で同じ型の約束を言い直した番 スタッフ 20/46・竹内さん 6/31（新しい話題の列）。
// スイッチ SITUATION_WRITER_NOTE_AIX=on（既定 off）。
import { situationWriterNote, type SituationNow, type SnOurItem } from "./situation-now";

export function situationWriterNoteAixOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SITUATION_WRITER_NOTE_AIX ?? "").trim().toLowerCase() === "on";
}

const KIND_JA: Record<string, string> = { question: "聞いた事", fact: "伝えた事実", promise: "約束", proposal: "提案・推し", invite: "誘い", property: "送った物件", aix: "送った AIX" };

/** our_items の直近（新しい順に最大 max 件）を1行ずつ。答えの有無は聞いた事・誘いだけ */
export function ourItemsWriterLines(items: ReadonlyArray<SnOurItem> | null | undefined, max = 6): string[] {
  const list = [...(items ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max).reverse();
  return list.map((i) => {
    const ans = i.kind === "question" || i.kind === "invite" ? (i.answered === true ? "（お客様は答えた）" : i.answered === false ? "（まだ答えが無い）" : "") : "";
    return `- ${KIND_JA[i.kind] ?? i.kind}「${String(i.text ?? i.label).replace(/\s+/g, " ").slice(0, 50)}」${ans}`;
  });
}

/** 書き手に渡す塊（無ければ ""）。L の事実の塊＋こちらが前に伝えた事 */
export function situationWriterNoteAix(sn: unknown, nowMs: number): string {
  if (!sn || typeof sn !== "object") return "";
  const base = situationWriterNote(sn, nowMs);
  const ours = ourItemsWriterLines((sn as SituationNow).our_items);
  const oursBlock = ours.length ? `\n\n【こちらが前に伝えた事（記録・同じ事を言い直さず、続きを書く材料）】\n${ours.join("\n")}` : "";
  return `${base}${oursBlock}`;
}
