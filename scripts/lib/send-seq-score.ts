// scripts/lib/send-seq-score.ts — 試験で「送る物の並び」（R=返信・A=AIX の並び）を、ブレインの答えと竹内さんの実送信で比べる（決まった計算・LLM なし）
//   2026-11-10 作業員7: seq-dig の10本で並びを1つも数えられなかった（brain-exam が send_sequence を答案に残していなかった・作業員7b の差分の続き）。
//   竹内さんの90日（816番）: R 67%・AR 9.6%・RR 7.7%・A 5.4%・RAR 3.4%・RA 2.3%・ARR 1.5%（app/lib/send-sequence.ts）。
//
//   正解の並び: 札「並び:XX」があればそれ（人が確かめた・60分の窓）。無ければ問題の staffText（番の後30分の実送信を「\n―\n」で並べた物・AIX の通は【AIX】）から作る。
//     - AIX の続き（画像・テンプレートの文）は1つの A にまとめる。AIX でない画像だけの通は数えない（currentStepOf と同じ）。staffText が空＝正解なし（数えない）。
//   ブレインの並び: send_sequence（TWO_MESSAGE_SEQUENCE=on の時だけ・sanitizeSendSequence が1通の形は置かない）があればそれ。
//     無ければ1通: AIX の番（reply_mode=aix かつ action）＝A・それ以外（返信・2段の約束）＝R。2択の番は「R か A」のどちらでも一致。
import { splitDraftParts } from "../../app/lib/send-sequence";

export type SeqBrain = { send_sequence?: Array<{ slot?: string }> | null; reply_mode?: string | null; action?: string | null; two_choice_mode?: boolean | null } | null | undefined;

/** 実送信（staffText）から並びの記号。空なら null */
export function seqOfStaffText(staffText: string | null | undefined): string | null {
  const parts = String(staffText ?? "").split(/\n―\n/).map((t) => t.trim()).filter(Boolean);
  let s = "";
  for (const t of parts) {
    const isAix = t.startsWith("【AIX】");
    const body = t.replace(/^【AIX】/, "").trim();
    if (!isAix && /^\[画像\]$/.test(body)) continue; // 手で送った画像だけの通は数えない
    const k = isAix ? "A" : "R";
    if (k === "A" && s.endsWith("A")) continue; // AIX の続きの通は1つ
    s += k;
  }
  return s || null;
}

/** 正解の並び（札が先・無ければ実送信から） */
export function wantSeqOf(p: { tags?: string[] | null; staffText?: string | null }): { seq: string; from: "札" | "実送信" } | null {
  const tag = (p.tags ?? []).find((g) => g.startsWith("並び:"));
  if (tag && /^[RA]+$/.test(tag.slice(3))) return { seq: tag.slice(3), from: "札" };
  const s = seqOfStaffText(p.staffText);
  return s ? { seq: s, from: "実送信" } : null;
}

/** ブレインの並び（"R|A" は2択） */
export function brainSeqOf(b: SeqBrain): { seq: string; recorded: boolean } {
  const s = b?.send_sequence;
  if (Array.isArray(s) && s.length) return { seq: s.map((x) => (x?.slot === "aix" ? "A" : "R")).join(""), recorded: true };
  if (b?.two_choice_mode) return { seq: "R|A", recorded: false };
  return { seq: b?.reply_mode === "aix" && (b?.action ?? "").trim() ? "A" : "R", recorded: false };
}

export const seqMatch = (want: string, got: string): boolean => got.split("|").includes(want);
const replies = (s: string) => s.split("").filter((c) => c === "R").length;
/** 返信の通数の一致（2択は少ない方で数える＝R でも A でも返信は 0〜1） */
export const replyCountMatch = (want: string, got: string): boolean => got.split("|").some((g) => replies(g) === replies(want));
/** 下書きの通数（「---」の行で分けた数・無ければ 0） */
export const draftPartCount = (text: string | null | undefined): number => splitDraftParts(text).length;

export type SeqRow = { id: string; want: string; from: "札" | "実送信"; got: string; recorded: boolean; draft: string | null };

export function seqStats(rows: SeqRow[]) {
  const n = rows.length;
  const match = rows.filter((x) => seqMatch(x.want, x.got)).length;
  const countMatch = rows.filter((x) => replyCountMatch(x.want, x.got)).length;
  const multiWant = rows.filter((x) => x.want.length >= 2);
  const multiHit = multiWant.filter((x) => seqMatch(x.want, x.got)).length;
  const singleWant = rows.filter((x) => x.want.length === 1);
  /** 1通の番に2通以上を出した（余計な分け） */
  const overSplit = singleWant.filter((x) => !x.got.includes("|") && x.got.length >= 2);
  /** 2通以上の番を1通にまとめた（分け損ね） */
  const underSplit = multiWant.filter((x) => x.got.split("|").every((g) => g.length === 1));
  const multiReplyWant = rows.filter((x) => replies(x.want) >= 2);
  const draftSplit = multiReplyWant.filter((x) => draftPartCount(x.draft) >= 2).length;
  const draftHave = multiReplyWant.filter((x) => !!x.draft).length;
  return { n, match, countMatch, multiN: multiWant.length, multiHit, singleN: singleWant.length, overSplit, underSplit, multiReplyN: multiReplyWant.length, draftSplit, draftHave, recorded: rows.filter((x) => x.recorded).length };
}

/** 要約の1行（pct は brain-exam の書き方を受け取る） */
export function sendSeqSummary(rows: SeqRow[], pct: (a: number, b: number) => string): string {
  if (!rows.length) return "";
  const s = seqStats(rows);
  const list = (xs: SeqRow[]) => xs.map((x) => ` ${x.id}=${x.got}（正解 ${x.want}）`).join("").slice(0, 300);
  const fromTag = rows.filter((x) => x.from === "札").length;
  return `送る物の並び（回 ${s.n}・正解は札 ${fromTag}／実送信 ${s.n - fromTag}・ブレインが send_sequence を出した ${s.recorded}）: 一致 ${pct(s.match, s.n)}｜返信の通数の一致 ${pct(s.countMatch, s.n)}｜2通以上の番の一致 ${pct(s.multiHit, s.multiN)}`
    + `｜1通の番を割った ${s.overSplit.length}/${s.singleN}${list(s.overSplit)}｜2通以上の番を1通に ${s.underSplit.length}/${s.multiN}`
    + (s.multiReplyN ? `｜返信2通以上の番の下書き「---」で分かれた ${s.draftSplit}/${s.draftHave}（下書きあり）` : "");
}
