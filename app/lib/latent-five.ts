// app/lib/latent-five.ts — 潜在の読みの5段（対象・気がかり・理由・想定・具体的な気持ち）と出所（純関数・作業員16・2026-11-13）
//
// 竹内さん 11/13「何について、どんな事を気にしているのか。なぜそのように気にしているのか。どうなっていくと（この依頼で）想定しているか。
//   人間の具体的な気持ちを細かく理解できるように」。KB P1 d72ad06b（何で・何の部分を・どんな気持ちで・本当はどうしたいのか）の続き・742118c7・542e92c9・41dadfe6。
// 5段（1つのお客様の発言ごと）:
//   1 object  何について（どの物件の・どの部分の・どの事か）
//   2 concern どんな事を気にしているか（具体の中身）
//   3 reason  なぜそう気にしているか（きっかけ・事情・前の経験・会話の手がかり）
//   4 expect  どうなっていくと想定しているか（この依頼で期待している結果・次の流れ）
//   5 feeling 具体的な気持ち（種類×強さ）
// どの段も出所（src）を付ける。会話・記録に出所が無い推し量りは guess=true（文の側では言い切らない）。
// 今の欄との対応（数えは scripts/latent-five-table.ts）:
//   作業員10 の LatentFour（latent_read）: part→1・feeling.what→2と5が混ざる・trigger→3の「きっかけ」だけ（事情・前の経験・出所の印は無い）・want→4・feeling.strength→5の強さ（種類が無い）
//   作業員21 の customer_mindset: anxiety.target→1の粗い種類・state/hesitation→5の種類の一部（2・3・4 は無い）
//   作業員7 の turn_aims はこちら側の目的なので、お客様の5段には当たらない
// 置き方: 事実の欄（道の前に置いてよい）。次の一手・押す・誘導の言葉は入れない。スイッチ LATENT_FIVE（既定 off＝どこからも読まない）。

export const LATENT_FIVE_STAGES = ["object", "concern", "reason", "expect", "feeling"] as const;
export type LatentFiveStage = typeof LATENT_FIVE_STAGES[number];
export const LATENT_FIVE_LABEL: Record<LatentFiveStage, string> = {
  object: "何について", concern: "どんな事を気にしているか", reason: "なぜそう気にしているか", expect: "どうなっていくと想定しているか", feeling: "具体的な気持ち",
};
/** 出所（会話の言葉・記録の事実・推測） */
export const LATENT_SRCS = ["customer_words", "earlier_words", "our_send", "record", "guess"] as const;
export type LatentSrc = typeof LATENT_SRCS[number];
/** 2026-11-13 点検役の19番（読めていない段: 気持ちの強さと種類 14）で足した種類: 遠慮・申し訳なさ／不信・疑問／信頼・再来／前向きな保留／念押し */
export const FEELING_KINDS = ["不安", "焦り", "期待", "遠慮・申し訳なさ", "迷い", "不満", "安心", "不信・疑問", "信頼・再来", "前向きな保留", "念押し"] as const;
export type FeelingKind = typeof FEELING_KINDS[number];
/** 気持ちの向き: 物件への気持ちと、こちら（担当）への気持ちを分ける。掲載（ポータル）への疑問も別 */
export const FEELING_TOWARDS = ["property", "us", "listing", "self"] as const;
export type FeelingToward = typeof FEELING_TOWARDS[number];
export type FeelingStrength = "strong" | "mid" | "weak";

/** B. なぜ（why）: 今の li（1行・出所なし）の置き換え。材料は customer-fact-ledger・登録の条件・action-ledger */
export const WHY_KINDS = ["earlier_circumstance", "our_last_send", "listing_gap", "past_experience", "condition_check"] as const;
export type WhyKind = typeof WHY_KINDS[number];
export const WHY_KIND_LABEL: Record<WhyKind, string> = {
  earlier_circumstance: "前に言った事情（職業・同居・異動・予算の出所）", our_last_send: "こちらの直前の送信・確認の結果", listing_gap: "掲載との食い違い",
  past_experience: "前の経験", condition_check: "登録の条件との照らし",
};
export const WHY_REFS = ["earlier_words", "our_send", "fact_ledger", "registered_conditions", "action_ledger"] as const;
export type WhyRef = typeof WHY_REFS[number];
export type LatentWhy = { kind: WhyKind; ref: WhyRef | null; quote: string | null; text: string; guess: boolean };

/** A. 依頼の想定（turn_expect）: この依頼でお客様がどうなると想定しているか */
export const EXPECT_OUTCOMES = ["answer_only", "send_now", "discount", "remove_and_resend", "decide_material", "consult", "relation_check"] as const;
export type ExpectOutcome = typeof EXPECT_OUTCOMES[number];
export const EXPECT_OUTCOME_LABEL: Record<ExpectOutcome, string> = {
  answer_only: "答えだけ", send_now: "今すぐ送って", discount: "値下げ・割引", remove_and_resend: "外して出し直し", decide_material: "行くかの判断材料", consult: "相談したい", relation_check: "関係の確かめ",
};
export const EXPECT_DECIDERS = ["fact", "staff_check", "customer_side"] as const;
export type ExpectDecider = typeof EXPECT_DECIDERS[number];
export type TurnExpect = { outcome: ExpectOutcome; next_if: string | null; decided_by: ExpectDecider; text: string; src: LatentSrc };

export type LatentFive = {
  object: { property: string | null; part: string; matter: string; src: LatentSrc } | null;
  concern: { text: string; src: LatentSrc } | null;
  reason: LatentWhy | null;
  expect: TurnExpect | null;
  feeling: { kind: FeelingKind; strength: FeelingStrength; toward: FeelingToward; src: LatentSrc } | null;
};

export function latentFiveOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.LATENT_FIVE ?? "").trim().toLowerCase() === "on";
}

export const LATENT_FIVE_FIELD = `"latent_five": {"object": {"property": "物件名か null", "part": "物件のどの部分・どの事（例: 初期費用・審査・内覧の日）", "matter": "その中の具体（例: カード払いが使えるか）", "src": "customer_words|earlier_words|our_send|record|guess"}, "concern": {"text": "具体的に何を気にしているか（30字以内）", "src": "同上"}, "reason": {"kind": "${WHY_KINDS.join("|")}", "ref": "${WHY_REFS.join("|")}（どの発言・送信・帳面・登録の条件か・無ければ null）", "quote": "根拠の言葉そのまま（20字以内・無ければ null）", "text": "なぜそう気にしているか（40字以内）", "guess": "出所の無い推し量りなら true"}, "expect": {"outcome": "${EXPECT_OUTCOMES.join("|")}", "next_if": "お客様が条件の形で言った先の流れ（例: 無ければ内覧はやめる・5万に近づけば申込）。無ければ null", "decided_by": "${EXPECT_DECIDERS.join("|")}（事実で決まる／スタッフの確認で決まる／お客様の側で決まる）", "text": "この依頼でどうなると想定しているか（30字以内）", "src": "同上"}, "feeling": {"kind": "${FEELING_KINDS.join("|")}", "strength": "strong|mid|weak（めっちゃ・！！！＝強／💦・すいません・ちょっと＝弱めの手がかり）", "toward": "${FEELING_TOWARDS.join("|")}（物件へ／こちらへ／掲載へ／自分の事情へ）", "src": "同上"}}`;
export const LATENT_FIVE_RULES = `【潜在の5段（latent_five・事実の欄）】お客様の今の一通を、何について→どんな事を気にしているか→なぜ→この依頼でどうなると想定しているか→具体的な気持ち（種類と強さ）の5段で読む。どの段も出所を付ける（customer_words＝今の一通／earlier_words＝前の発言／our_send＝こちらの送信／record＝記録の事実）。出所の無い推し量りは src を guess にする（文では言い切らない）。読めない段は null。ここには読みだけを書き、どう返すか・どこへつなぐかは書かない。`;

const s = (v: unknown, n: number) => (typeof v === "string" && v.trim() && !/^(null|なし|無し)$/i.test(v.trim()) ? v.trim().slice(0, n) : null);
const src = (v: unknown): LatentSrc => ((LATENT_SRCS as readonly string[]).includes(String(v)) ? (v as LatentSrc) : "guess");
export function normalizeLatentFive(raw: unknown): LatentFive | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, Record<string, unknown> | null | undefined>;
  const ob = o.object, co = o.concern, re = o.reason, ex = o.expect, fe = o.feeling;
  const out: LatentFive = {
    object: ob && s(ob.part, 30) ? { property: s(ob.property, 40), part: s(ob.part, 30)!, matter: s(ob.matter, 40) ?? "", src: src(ob.src) } : null,
    concern: co && s(co.text, 40) ? { text: s(co.text, 40)!, src: src(co.src) } : null,
    reason: re && (WHY_KINDS as readonly string[]).includes(String(re.kind)) && s(re.text, 60)
      ? { kind: re.kind as WhyKind, ref: (WHY_REFS as readonly string[]).includes(String(re.ref)) ? (re.ref as WhyRef) : null, quote: s(re.quote, 30), text: s(re.text, 60)!, guess: re.guess === true || !(WHY_REFS as readonly string[]).includes(String(re.ref)) }
      : null,
    expect: ex && (EXPECT_OUTCOMES as readonly string[]).includes(String(ex.outcome))
      ? { outcome: ex.outcome as ExpectOutcome, next_if: s(ex.next_if, 40), decided_by: (EXPECT_DECIDERS as readonly string[]).includes(String(ex.decided_by)) ? (ex.decided_by as ExpectDecider) : "customer_side", text: s(ex.text, 40) ?? "", src: src(ex.src) }
      : null,
    feeling: fe && (FEELING_KINDS as readonly string[]).includes(String(fe.kind))
      ? { kind: fe.kind as FeelingKind, strength: fe.strength === "strong" || fe.strength === "weak" ? fe.strength : "mid", toward: (FEELING_TOWARDS as readonly string[]).includes(String(fe.toward)) ? (fe.toward as FeelingToward) : "property", src: src(fe.src) }
      : null,
  };
  return LATENT_FIVE_STAGES.some((k) => out[k]) ? out : null;
}
/** 文の側で言い切ってよい段（出所が推測でない段）だけ */
export function assertableStages(l: LatentFive | null | undefined): LatentFiveStage[] {
  if (!l) return [];
  return LATENT_FIVE_STAGES.filter((k) => {
    if (k === "reason") return !!l.reason && !l.reason.guess;
    const v = l[k] as { src?: LatentSrc } | null; return !!v && v.src !== "guess";
  });
}

// ─── 網（決まった計算は候補の網・P0 9eb6aa9c。ブレインが読む時の手がかりと、点検の数えに使う） ─────────
/** 気持ちの強さの手がかり（めっちゃ・！！！＝強／💦・すいません・ちょっと＝弱）。手がかりが無ければ null */
export function feelingStrengthCue(text: string): FeelingStrength | null {
  const t = String(text ?? "");
  if (/めっちゃ|めちゃくちゃ|すごく|かなり|絶対|！！！|!!!|😭|🥺{2,}/.test(t)) return "strong";
  if (/💦|すいません|すみません|ちょっと|少し|かも|かな/.test(t)) return "weak";
  return null;
}
/** 依頼の想定の手がかり: お客様の条件の形の言葉（なら・であれば・〜したいのですが・〜しなくてもいいので） */
export function expectNextIfCue(text: string): string | null {
  const m = String(text ?? "").match(/[^。！!？?\n]{0,30}(?:なら|であれば|でしたら|れば|たら|したいのですが|しなくてもいいので|なくてもいいので)[^。！!？?\n]{0,30}/);
  return m ? m[0].trim().slice(0, 40) : null;
}

/** 作業員10 の LatentFour（latent_read）から5段のどれが埋まるか（今の欄で読めている段の数え） */
export type LatentFourLike = { trigger?: { kind?: string; text?: string } | null; part?: { property?: string | null; point?: string } | null; feeling?: { what?: string; strength?: string } | null; want?: string | null };
const REASON_RE = /ため|ので|から|経験|前に|以前|事情|今の(?:家|部屋)|退去|転勤|就職|入学|別れ|家族|子|ペット|悩まされ/;
const FEELING_KIND_RE: Array<[FeelingKind, RegExp]> = [["焦り", /急|早く|間に合|焦/], ["遠慮・申し訳なさ", /申し訳|すみません|気まず|遠慮|何度も/], ["不信・疑問", /おとり|本当に|信じ|怪し|嘘/], ["念押し", /念のため|念の為|改めて確認|間違いない/], ["迷い", /迷|悩|決め(?:られ|かね)|比べ/], ["期待", /期待|楽しみ|したい|進めたい|前向き/], ["不満", /不満|残念|高い|狭い|遠い/], ["不安", /不安|心配|気に(?:し|な)|落ち|払える|足り/]];
export function stagesFromLatentFour(r: LatentFourLike): Record<LatentFiveStage, "typed" | "text_only" | "missing"> {
  const f = String(r.feeling?.what ?? "");
  const kind = FEELING_KIND_RE.find(([, re]) => re.test(f));
  return {
    object: r.part?.point ? "typed" : "missing",
    concern: f ? "text_only" : "missing",                                  // 気がかりと気持ちが1つの文に混ざる
    reason: r.trigger?.text && REASON_RE.test(`${r.trigger.text}${f}`) ? "text_only" : "missing", // きっかけ＝今の一通の言葉が主で、事情・前の経験は文に出た時だけ
    expect: r.want ? "text_only" : "missing",
    feeling: kind ? "text_only" : r.feeling?.strength ? "text_only" : "missing", // 強さはあるが種類の欄が無い
  };
}
