// app/lib/latent-subkinds.ts — お客様の潜在の気持ちの「下の種類」の表（純関数・定数だけ・作業員16・2026-11-13）
//
// 竹内さん 11/13「文の要素の弱い部分・足りていない部分の補強と、具体的な細分化を徹底する」（潜在 27% が一番低い）。
//   KB P1 d72ad06b（何で・何の部分を・どんな気持ちで・本当はどうしたいのか）・742118c7・542e92c9（気持ちを実際のやり取りから細分化）・41dadfe6（竹内さんの番だけで数える）。
// 何をするか: 上の種類（作業員10 の compose-sentence-plan.LATENT_KINDS と同じ名前）の下に、実例で分けた下の種類を置き、
//   下の種類ごとに「竹内さんが言う一文の型（phraseKind）」と先回りの事実（fact）・誘導先（lead）を持つ。
//   今の欄との対応: 作業員21 の customer-mindset.ANXIETY_TARGETS（8種）・作業員10 の LATENT_KINDS（9種）は上の種類だけを持つ＝下の種類は読めていない。
// 置き方: 読みの欄（道の前に置ける事実）。次の一手・押す・誘導の言葉は欄に入れない（lead は表の数えのための記録で、ブレインには渡さない）。
// スイッチ: LATENT_SUBKINDS（既定 off＝どこからも読まない）。

/** 上の種類（compose-sentence-plan.LATENT_KINDS と同じ名前） */
export const LATENT_TOP = ["審査", "先に取られる", "費用", "入居日・時期", "住み心地・周り", "物件が見つからない", "内覧できない", "対応・信頼", "事情の変化"] as const;
export type LatentTop = typeof LATENT_TOP[number];

export type LatentSubkind = {
  id: string;
  top: LatentTop;
  label: string;
  /** 手がかり（お客様の言葉・潜在の読みの部分・気持ち・したい事に当てる網） */
  cue: RegExp;
  /** 作業員21 の ANXIETY_TARGETS のどれに入るか（今の欄で読める上の種類） */
  mindsetTarget: string;
  /** 竹内さんが言う一文の型（文の側に渡す名前・作業員10 の骨の表と揃える前の案） */
  phraseKind: string;
};

/** 下の種類（並びは当てる順＝細かい方が先） */
export const LATENT_SUBKINDS: readonly LatentSubkind[] = [
  { id: "cost_payment", top: "費用", label: "支払い方法・時期（分割・カード・振込・支払い日）", cue: /分割|カード|振込|振り込|支払い(?:日|時期|方法)|いつまでに払/, mindsetTarget: "費用", phraseKind: "支払い方法の会社の事実（カードなら分割）を答える" },
  { id: "cost_initial_total", top: "費用", label: "初期費用の総額が予算を超える・見えない", cue: /初期費用|総額|見積|敷金|礼金|仲介手数料|鍵交換|前家賃/, mindsetTarget: "費用", phraseKind: "最大限割引の御見積で総額を見せる" },
  { id: "cost_monthly", top: "費用", label: "月々の家賃・管理費が重い", cue: /家賃|月々|管理費|共益費|賃料|予算/, mindsetTarget: "費用", phraseKind: "家賃管理費込の額と条件の合い方を言う" },
  { id: "cost_hidden", top: "費用", label: "後から費用が増える・安い理由が分からない", cue: /後から|追加で|他に(?:かかる|費用)|安い理由|なぜ安|安すぎ/, mindsetTarget: "費用", phraseKind: "安い理由（還元の仕組み）と費用の中身を言い切る" },
  { id: "screen_attribute", top: "審査", label: "属性（職業・収入・学生・夜職・ブラック・借入）で落ちる", cue: /職業|収入|学生|夜職|ブラック|借入|カードローン|延滞|フリーター|転職|勤続|アリバイ/, mindsetTarget: "審査", phraseKind: "独立系の保証会社など通る道を言う" },
  { id: "screen_guarantor", top: "審査", label: "保証人・保証会社・名義・緊急連絡先", cue: /保証人|保証会社|名義|緊急連絡先|代理契約|親/, mindsetTarget: "審査", phraseKind: "代理契約・保証会社の会社の事実を言う" },
  { id: "screen_docs_period", top: "審査", label: "書類・審査の期間・結果待ち", cue: /書類|審査(?:の)?(?:期間|結果|日数)|何日|いつ(?:結果|わかる)/, mindsetTarget: "手続き", phraseKind: "審査の期間（2〜3営業日〜1週間程）を言う" },
  { id: "taken_popular", top: "先に取られる", label: "人気・残りが少ない・他の申込", cue: /他の(?:人|方)|申込(?:が)?入|人気|残り|埋ま/, mindsetTarget: "先に取られる", phraseKind: "1部屋のみ・申込で抑えられる線を言う" },
  { id: "taken_waiting", top: "先に取られる", label: "待つ間・迷う間・入居が先で取られる", cue: /待つ|迷う|検討(?:中|する間)|入居(?:が)?先|まだ先|間に合/, mindsetTarget: "先に取られる", phraseKind: "キャンセル料の線（保証会社の審査通過まで）と抑える時期を言う" },
  { id: "time_move_in", top: "入居日・時期", label: "入居日に間に合うか・最短はいつか", cue: /入居(?:日|時期|でき)|最短|最速|退去|今の家|引っ越し(?:日|時期)/, mindsetTarget: "日程", phraseKind: "申込から入居までの期間を会社の事実で言う" },
  { id: "time_apply_when", top: "入居日・時期", label: "いつ申し込めばよいか・探し始めの時期", cue: /いつ(?:頃)?申し?込|探し始め|早すぎ|いつから探/, mindsetTarget: "日程", phraseKind: "抑えられる期間（入居の1ヶ月前）を言う" },
  { id: "view_schedule", top: "内覧できない", label: "内覧の日時が合うか・行けるか", cue: /内覧|内見|日曜|土曜|平日|何時|時間|行け/, mindsetTarget: "日程", phraseKind: "ご都合に合わせてご案内できる事を言う" },
  { id: "view_not_possible", top: "内覧できない", label: "内見できない物件（退去前・完成前）", cue: /内見(?:は)?でき(?:ない|ません)|退去前|完成前|まだ見られ/, mindsetTarget: "日程", phraseKind: "申込で先に抑えてから内覧できる線を言う" },
  { id: "view_measure", top: "内覧できない", label: "寸法・家具が入るか・室内を確かめたい", cue: /寸法|メジャー|家具|家電|入るか|測/, mindsetTarget: "物件の中身", phraseKind: "当日に確かめられる事を言う" },
  { id: "living_noise", top: "住み心地・周り", label: "音・振動・構造", cue: /音|振動|騒音|木造|鉄筋|RC/, mindsetTarget: "物件の中身", phraseKind: "構造の事実（RC は音が伝わりにくい）を言う" },
  { id: "living_area", top: "住み心地・周り", label: "治安・周り・虫・階・日当たり", cue: /治安|周り|周辺|虫|階|日当たり|知り合い|遠い|距離|駅から|立地|場所/, mindsetTarget: "立地・治安", phraseKind: "周りの事実と、合わなければ探す約束を言う" },
  { id: "living_equipment_gap", top: "住み心地・周り", label: "設備・広さ・室内がイメージと違う", cue: /設備|エアコン|洗面|収納|狭|広さ|畳|和室|キッチン/, mindsetTarget: "物件の中身", phraseKind: "確かめた結果と、合う物件を探す約束を言う" },
  { id: "find_fit", top: "物件が見つからない", label: "条件に合う部屋が本当に見つかるか・他の選択肢", cue: /見つか|他に|他にも|似た|新着|選択肢|条件に合/, mindsetTarget: "その他", phraseKind: "全域から探す・新着をお送りする約束を言う" },
  { id: "trust_awkward", top: "対応・信頼", label: "断る・見送る・何度も頼む気まずさ", cue: /すみません|申し訳|何度も|何回も|せっかく|お手数|悪い|断る|気まず/, mindsetTarget: "その他", phraseKind: "全然大丈夫です＋満足いくまでサポートを言う" },
  { id: "trust_other_agent", top: "対応・信頼", label: "他社・掲載情報を信じてよいか・他社で内覧", cue: /他社|他の不動産|別の不動産|掲載|SUUMO|スーモ/, mindsetTarget: "その他", phraseKind: "弊社でも申込・内覧できる会社の事実を言う" },
  { id: "change_household", top: "事情の変化", label: "人数・同居・事情が変わった", cue: /別れ|一人|二人|同居|家族|子供|子ども|ペット/, mindsetTarget: "その他", phraseKind: "事情を受けて条件を組み直す事を言う" },
];

export type LatentReadLike = { trigger?: { text?: string } | null; part?: { point?: string } | null; feeling?: { what?: string } | null; want?: string | null };
/** 潜在の読み（作業員10 の LatentFour の形）から下の種類を当てる網（候補の網・ブレインの決めではない＝P0 9eb6aa9c） */
export function subkindOf(r: LatentReadLike): LatentSubkind | null {
  // 当てる順: 部分（何について）→ 気持ち → きっかけ → したい事（したい事は先の流れを含むので最後）
  for (const t of [r.part?.point, r.feeling?.what, r.trigger?.text, r.want]) {
    if (!t || !String(t).trim()) continue;
    const hit = LATENT_SUBKINDS.find((x) => x.cue.test(String(t)));
    if (hit) return hit;
  }
  return null;
}

export function latentSubkindsOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.LATENT_SUBKINDS ?? "").trim().toLowerCase() === "on";
}
