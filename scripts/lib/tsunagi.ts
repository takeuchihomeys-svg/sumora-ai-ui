// scripts/lib/tsunagi.ts — 「つなぎ」（次の一手へつなぐ文）の型を竹内さんの1通から決まった計算で読む（純関数・LLM なし・費用 0）
//
// 2026-11-15 作業員H（竹内さん 11/15「つなぎの部分弱いところ強化できるように、土台の部分追加と細分化した強化お願い」・統括役の頼み 1〜5）:
//   今の物差し（compose-prod-elements のつなぎ）は「内覧・申込の誘いがあるか・同じ種類か」の2種類だけで、本番で比べられる番が 6番しかなかった。
//   つなぎの型を7つ＋入れないに分け、強さ（押す・添える）と位置（何通目か・最後の文か）も読む。
//   名前は K の aim（viewing_date／estimate／apply_hold／none）・turn-anatomy-fields の誘導先（LeadTo）に揃える（kAimOf）。
// テスト: scripts/lib/__tests__/tsunagi.test.ts
import { sentencesOf } from "../../app/lib/compose-blueprint";

/** つなぎの型（優先の順＝1通に複数あれば上の物を主にする） */
export const TSUNAGI_KINDS = ["apply", "viewing", "estimate", "ask_send", "question", "next_contact", "keep", "none"] as const;
export type TsunagiKind = typeof TSUNAGI_KINDS[number];
export const TSUNAGI_JA: Record<TsunagiKind, string> = {
  apply: "申込の誘い", viewing: "内覧の誘い", estimate: "見積の誘い", ask_send: "物件を送ってもらう誘い",
  question: "質問で返事をもらう", next_contact: "次の連絡の約束", keep: "継続の一言（全力サポート等）", none: "入れない",
};
export type Strength = "push" | "soft" | "plain";

const RE: Record<Exclude<TsunagiKind, "none">, RegExp> = {
  apply: /お申込(み)?(を)?(し|して|させて|頂|いただ|下さ|くださ|頂け|の(方|お手続き))|お部屋(を)?(抑|押さ)え|申込(み)?(フォーマット|の(ご案内|流れ))/,
  viewing: /ご内覧|ご案内(させて|致|出来|でき|可能)|内覧(の)?(候補|日|ご希望)|お部屋(を)?(ご)?見(て|に)(頂|いただ)/,
  estimate: /御見積(書)?(を)?(作成|お送り|同封|ご用意)|お見積(り|書)(を)?(作成|お送り)/,
  ask_send: /(物件|お部屋|URL|画像|スクショ|資料)[^。！!？?]{0,12}(お送り|送って)(頂|いただ)け|お送り(頂|いただ)けましたら|教えて(頂|いただ)け(ます|ません)?(でしょうか|か)/,
  question: /(でしょうか|ますでしょうか|ございますか|ご(ざい)?ますか|ですか|ますか)[？?]|(いかが|如何)(でしょうか|ですか|致しましょうか)/,
  next_contact: /確認(出来|でき|が取れ)次第|出次第(お送り|ご連絡)|ピックアップ(して|させて頂き|させていただき|し)(お送り|ご連絡)|作成(して|させて頂き|し)(お送り)|改めて(ご連絡|お送り)|分かり次第/,
  keep: /全力で[^。！!]{0,10}サポート|見つかるまで|お気軽に(ご連絡|ご相談|お申し付け)|何でも(お気軽に)?(ご相談|お聞き)/,
};
const SOFT_RE = /お気に召され|もし(よろしければ|ご興味|宜しければ)|よろしければ|宜しければ|お気軽|ご検討(頂|いただ)|ご都合(が)?(合え|宜しけれ)/;
const PUSH_RE = /是非|ぜひ|お伺い(させて|しても|出来)|ご都合(の)?(よろしい|良い|宜しい)(お)?日(にち)?(を)?(お)?(教え|お知らせ|お聞かせ)|お早め|埋まって(しまう|しまい)|先に(お部屋を)?(抑|押さ)え/;

export type TsunagiSentence = { kind: Exclude<TsunagiKind, "none">; strength: Strength; index: number; last: boolean; text: string };
/** 1通の文ごとのつなぎ（無い文は出さない・1文に2つの型があれば両方）。question は「お客様に聞く」文だけ（こちらの約束の「〜でしょうか」は少ない） */
export function tsunagiSentences(text: string): TsunagiSentence[] {
  const sens = sentencesOf(String(text ?? "").normalize("NFKC"));
  const out: TsunagiSentence[] = [];
  sens.forEach((s, i) => {
    for (const k of TSUNAGI_KINDS) {
      if (k === "none") continue;
      if (RE[k].test(s)) {
        out.push({ kind: k, strength: PUSH_RE.test(s) ? "push" : SOFT_RE.test(s) ? "soft" : "plain", index: i, last: i === sens.length - 1, text: s });
      }
    }
  });
  return out;
}
const RANK = new Map<TsunagiKind, number>(TSUNAGI_KINDS.map((k, i) => [k, i]));
/** 1通の主のつなぎ（優先の順で一番上）・強さ・何文目か */
export function tsunagiOf(text: string): { kind: TsunagiKind; strength: Strength | null; all: TsunagiKind[]; atLast: boolean | null } {
  const ss = tsunagiSentences(text);
  if (!ss.length) return { kind: "none", strength: null, all: [], atLast: null };
  const main = [...ss].sort((a, b) => (RANK.get(a.kind)! - RANK.get(b.kind)!) || a.index - b.index)[0];
  return { kind: main.kind, strength: main.strength, all: [...new Set(ss.map((s) => s.kind))], atLast: main.last };
}

/** 番（同じ番の竹内さんの通を全部）のつなぎ: 主の型と、それが何通目に入ったか */
export function turnTsunagi(texts: ReadonlyArray<string>): { kind: TsunagiKind; strength: Strength | null; msg: number | null; perMsg: TsunagiKind[] } {
  const per = texts.map((t) => tsunagiOf(t));
  let best: { kind: TsunagiKind; strength: Strength | null; msg: number | null } = { kind: "none", strength: null, msg: null };
  per.forEach((p, i) => { if (p.kind !== "none" && (best.kind === "none" || RANK.get(p.kind)! < RANK.get(best.kind)!)) best = { kind: p.kind, strength: p.strength, msg: i + 1 }; });
  return { ...best, perMsg: per.map((p) => p.kind) };
}

/** 入れない番の理由（決まった計算・仮の分け） */
export type NoneReason = "after_aix" | "ack_only" | "apply_stage" | "decline" | "material" | "promise_is_next" | "answer_only";
export const NONE_REASON_JA: Record<NoneReason, string> = {
  after_aix: "AIX の後（AIX が次の一手を持った）", ack_only: "受け・お礼だけの番", apply_stage: "申込の段（書類・手続き）", decline: "残念な報告（申込が入っていた等）",
  material: "定型・資料の通", promise_is_next: "約束そのものが次の一手（確認・お送り）", answer_only: "答えだけ（つなぎを入れていない）",
};
export function noneReasonOf(o: { afterAix: boolean; scene: string | null; purpose: string | null }): NoneReason {
  if (o.afterAix) return "after_aix";
  if (o.purpose === "material") return "material";
  if (o.purpose === "decline") return "decline";
  if (o.scene === "apply") return "apply_stage";
  if (o.purpose === "ack") return "ack_only";
  if (o.purpose === "promise") return "promise_is_next";
  return "answer_only";
}

/** K の aim（viewing_date／estimate／apply_hold／none）・誘導先（LeadTo）への写し（名前を揃える） */
export function kAimOf(k: TsunagiKind): "viewing_date" | "estimate" | "apply_hold" | "none" {
  return k === "viewing" ? "viewing_date" : k === "estimate" ? "estimate" : k === "apply" ? "apply_hold" : "none";
}
export function leadToOf(k: TsunagiKind): "apply" | "estimate" | "viewing" | "ask_send" | "keep" | "answer_only" {
  return k === "apply" || k === "estimate" || k === "viewing" || k === "ask_send" ? k : k === "next_contact" || k === "keep" ? "keep" : "answer_only";
}

// ── 2: 外れの分け（竹内さんの番 × 下書き）──────────────────────────────────
export type TsunagiMiss = "ok" | "both_none" | "missing" | "extra" | "kind" | "strength" | "position";
export const TSUNAGI_MISS_JA: Record<TsunagiMiss, string> = {
  ok: "合っている", both_none: "どちらも入れない（合っている）", missing: "入れていない", extra: "竹内さんが入れない所に入れた",
  kind: "種類が違う", strength: "強さが違う（押す・添える）", position: "位置が違う（竹内さんは2通目）",
};
/** 竹内さんの通（番の全部）と下書き（1通）を比べる。言い回しの違いは種類・強さが同じ時は ok に数える（言い回しは別の物差し） */
export function tsunagiMiss(takeuchiTexts: ReadonlyArray<string>, draft: string): { miss: TsunagiMiss; t: ReturnType<typeof turnTsunagi>; d: ReturnType<typeof tsunagiOf> } {
  const t = turnTsunagi(takeuchiTexts), d = tsunagiOf(draft);
  let miss: TsunagiMiss;
  if (t.kind === "none" && d.kind === "none") miss = "both_none";
  else if (t.kind === "none") miss = "extra";
  else if (d.kind === "none") miss = t.msg && t.msg > 1 ? "position" : "missing";
  else if (t.kind !== d.kind) miss = d.all.includes(t.kind) ? "ok" : "kind";
  else if (t.strength && d.strength && t.strength !== d.strength && (t.strength === "push" || d.strength === "push")) miss = "strength";
  else miss = "ok";
  return { miss, t, d };
}
