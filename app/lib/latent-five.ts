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
export const FEELING_KINDS = ["不安", "焦り", "期待", "遠慮", "迷い", "不満", "安心"] as const;
export type FeelingKind = typeof FEELING_KINDS[number];

export type LatentFive = {
  object: { property: string | null; part: string; matter: string; src: LatentSrc } | null;
  concern: { text: string; src: LatentSrc } | null;
  reason: { text: string; src: LatentSrc } | null;
  expect: { text: string; src: LatentSrc } | null;
  feeling: { kind: FeelingKind; strength: "strong" | "mid" | "weak"; src: LatentSrc } | null;
};

export function latentFiveOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.LATENT_FIVE ?? "").trim().toLowerCase() === "on";
}

export const LATENT_FIVE_FIELD = `"latent_five": {"object": {"property": "物件名か null", "part": "物件のどの部分・どの事（例: 初期費用・審査・内覧の日）", "matter": "その中の具体（例: カード払いが使えるか）", "src": "customer_words|earlier_words|our_send|record|guess"}, "concern": {"text": "具体的に何を気にしているか（30字以内）", "src": "同上"}, "reason": {"text": "なぜそう気にしているか＝きっかけ・事情・前の経験（会話・記録に無ければ null か src を guess）", "src": "同上"}, "expect": {"text": "この依頼でどうなると想定・期待しているか（30字以内）", "src": "同上"}, "feeling": {"kind": "${FEELING_KINDS.join("|")}", "strength": "strong|mid|weak", "src": "同上"}}`;
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
    reason: re && s(re.text, 60) ? { text: s(re.text, 60)!, src: src(re.src) } : null,
    expect: ex && s(ex.text, 40) ? { text: s(ex.text, 40)!, src: src(ex.src) } : null,
    feeling: fe && (FEELING_KINDS as readonly string[]).includes(String(fe.kind)) ? { kind: fe.kind as FeelingKind, strength: fe.strength === "strong" || fe.strength === "weak" ? fe.strength : "mid", src: src(fe.src) } : null,
  };
  return LATENT_FIVE_STAGES.some((k) => out[k]) ? out : null;
}
/** 文の側で言い切ってよい段（出所が推測でない段）だけ */
export function assertableStages(l: LatentFive | null | undefined): LatentFiveStage[] {
  if (!l) return [];
  return LATENT_FIVE_STAGES.filter((k) => { const v = l[k] as { src?: LatentSrc } | null; return !!v && v.src !== "guess"; });
}

/** 作業員10 の LatentFour（latent_read）から5段のどれが埋まるか（今の欄で読めている段の数え） */
export type LatentFourLike = { trigger?: { kind?: string; text?: string } | null; part?: { property?: string | null; point?: string } | null; feeling?: { what?: string; strength?: string } | null; want?: string | null };
const REASON_RE = /ため|ので|から|経験|前に|以前|事情|今の(?:家|部屋)|退去|転勤|就職|入学|別れ|家族|子|ペット|悩まされ/;
const FEELING_KIND_RE: Array<[FeelingKind, RegExp]> = [["焦り", /急|早く|間に合|焦/], ["遠慮", /申し訳|すみません|気まず|遠慮|何度も/], ["迷い", /迷|悩|決め(?:られ|かね)|比べ/], ["期待", /期待|楽しみ|したい|進めたい|前向き/], ["不満", /不満|残念|高い|狭い|遠い/], ["不安", /不安|心配|気に(?:し|な)|落ち|払える|足り/]];
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
