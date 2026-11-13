// app/lib/takeuchi-exemplar.ts — 文の統括がその番の「場面×潜在の型×誘導先」で竹内さんの手本を1つ引く（純関数・既定 off）
//
// 2026-11-12 作業員5（竹内さん 11/12「文の構成のブレインや文の構成の部分も竹内の細かい部分をちゃんと理解すればより改善される。
//   ブレインとのつながりの部分をより細かく、より強化する」・KB 1f5bd301・d72ad06b）。
//   ① 鍵は決まった計算: 場面（resolveReplyScene の scene）× 潜在の型（お客様の発言とブレインの concern から・LATENT_KEYS）× 誘導先（ブレインの dir・action・mode から・leadKeyOf）
//   ② 手本は「竹内さんの実物の1通＝1文ずつの役目・なぜ・ブレインのどの欄に当たるか」。手本の中身（会話由来の文）は倉庫に置かない
//      （takeuchi_compose_examples と同じ扱い・作るのは scripts/anatomy-exemplar-bank.ts → exam-cache・本番では DB の表に置く案）。ここは鍵・引き方・注記の形だけ
//   ③ 引けない時は 場面×誘導先 → 誘導先 の順に広げる（どこまで広げたかを返す）
//   書き手への注記は TAKEUCHI_EXEMPLAR=on の時だけ（既定 off・配線は作業員10）。文を写させない＝役目の並び・なぜ・使った事実だけ渡す
// テスト: app/lib/__tests__/takeuchi-exemplar.test.ts
import type { SentenceRole, LeadTo } from "./takeuchi-anatomy-roles";

/** 潜在の型（11/12 の 198通の4つの読みで多かった順・鍵に使う） */
export const LATENT_KEYS = [
  "taken",        // 待つ間・迷う間に他の人に取られる
  "screening",    // 審査で落ちて第一候補を逃す
  "cost_total",   // 初期費用の総額が予算を超える・見えない
  "cost_extra",   // 後から費用が増える（追加・日割・ペット敷金・鍵交換）
  "move_in",      // 入居日に間に合わない・時期が読めない
  "find",         // 条件に合う部屋が本当に見つかるか（言い直し・広げる）
  "viewing_slot", // 内覧の日時・行けるか
  "living",       // 住み心地（虫・音・治安・階）・設備・広さ
  "awkward",      // 断る・見送る・何度も頼む気まずさ・事情の変化
  "trust_other",  // 他社・掲載情報を信じてよいか
  "none",         // 読めない・お礼だけ
] as const;
export type LatentKey = typeof LATENT_KEYS[number];

const LATENT_RULES: ReadonlyArray<[LatentKey, RegExp]> = [
  ["trust_other", /他社|他の不動産|不動産屋さん|スーモ|SUUMO|ホームズ|掲載|おとり|別の業者/],
  ["screening", /審査|ブラック|夜職|名義|保証人|保証会社|収入|学生|無職|借入/],
  ["taken", /埋ま|取られ|先に申込|他の方|なくな|まだ空いて|空いてますか|人気/],
  ["cost_extra", /追加|別途|日割|鍵交換|火災保険|ペット.*敷金|高くなる|プラス/],
  ["cost_total", /初期費用|見積|費用|分割|総額|いくら|安く|予算|限度額|万円?くらい/],
  ["move_in", /入居日|入居可能|最短|いつから|引っ越し時期|年末|来年|退去|入居時期/],
  ["viewing_slot", /内覧|内見|見学|何時|日曜|土曜|都合|日程|案内/],
  ["living", /虫|音|治安|階|騒|防音|木造|洗面|キッチン|エアコン|広い|狭い|床|設備/],
  ["awkward", /すみません|申し訳|お手数|せっかく|キャンセル|見送|別れ|移動|一旦|大丈夫です/],
  ["find", /ありますか|ないでしょうか|他に|新着|条件|エリア|駅|家賃|間取り|探して/],
];
/** 潜在の型（お客様の発言＋ブレインの concern の言葉から・上の規則から順に当てる） */
export function latentKeyOf(customerText: string | null | undefined, concern?: string | null): LatentKey {
  const t = `${customerText ?? ""} ${concern ?? ""}`;
  if (!t.trim()) return "none";
  for (const [k, re] of LATENT_RULES) if (re.test(t)) return k;
  return "none";
}

/** 誘導先（ブレインの判断の言葉から）。11/12 の gold 24番の外れの半分は、dir にあるのに設計図が拾えていなかった所 */
export function leadKeyOf(o: { dir?: string | null; action?: string | null; mode?: string | null }): LeadTo {
  const d = String(o.dir ?? "");
  const a = String(o.action ?? "");
  if (/application|申込|抑え|押さえ/.test(a) || /申込(み)?で(お部屋を?)?(抑|押さ)|お申込(み)?.*(勧め|提案|推奨)|抑える(提案|事を勧め)/.test(d)) return "apply";
  if (/estimate|見積/.test(a) || /御見積|見積書を作成/.test(d)) return "estimate";
  if (/viewing|meeting/.test(a) || /内覧(の)?(候補|日|案内|へ誘|を提案)|ご案内(する|できる)|内見/.test(d)) return "viewing";
  if (/伺|教えて|お送り(頂|いただ)|送ってもら|聞く|確認する(返信|形)?$/.test(d) && !/ピックアップ/.test(d)) return "ask_send";
  if (/property_send|pickup|recommend/.test(a) || /ピックアップ|新着|探して(お送り)?|お送りする(と)?約束|再開|待つ姿勢|待ちの|待つ|閉じる|締める/.test(d)) return "keep";
  if (/答え|伝え|説明|即答|解消/.test(d)) return "answer_only";
  return "none";
}

export type ExemplarSentence = { text: string; role: SentenceRole | null; why: string; brainField: BrainField };
/** 手本の1通（中身は倉庫の外・DB の表から渡す） */
export type Exemplar = {
  id: string; scene: string; latent: LatentKey; lead: LeadTo;
  customer: string; sentences: ExemplarSentence[];
  latentFour?: { trigger: string; part: string; feeling: string; want: string } | null;
  fact?: string | null;
};
/** 文の役目 → ブレインのどの欄に当たるか（主＝問いへの答え・従＝約束・潜在＝奥の心配・事実＝先回りの裏付け・誘導先・受け・締め） */
export type BrainField = "main" | "sub_promise" | "latent" | "fact" | "lead" | "uke" | "close";
export function brainFieldOf(role: SentenceRole | null): BrainField {
  switch (role) {
    case "answer": return "main";
    case "promise": return "sub_promise";
    case "worry": return "latent";
    case "trust": case "barrier": return "fact";
    case "viewing": case "apply": case "estimate": case "ask_send": case "keep": return "lead";
    case "close": return "close";
    default: return "uke";
  }
}
export const BRAIN_FIELD_LABEL: Record<BrainField, string> = { main: "主（問いへの答え）", sub_promise: "従（確かめる約束）", latent: "潜在", fact: "事実（先回りの裏付け）", lead: "誘導先", uke: "受け", close: "締め" };

export const exemplarKey = (scene: string, latent: LatentKey, lead: LeadTo): string => `${scene}|${latent}|${lead}`;

/**
 * 手本を1つ引く（決まった計算）。scene×latent×lead → scene×lead → latent×lead → lead の順に広げる。同じ段に複数あれば、
 *   竹内さんの手で読んだ物（hand=true）→ 文の数が中くらい（3〜5文）→ id の順。どの段で引けたかを level で返す（0 が一番近い）
 */
export function pickExemplar<T extends Exemplar & { hand?: boolean }>(bank: ReadonlyArray<T>, key: { scene: string; latent: LatentKey; lead: LeadTo }, excludeId?: string): { ex: T; level: number } | null {
  const pool = bank.filter((e) => e.id !== excludeId);
  const levels: Array<(e: T) => boolean> = [
    (e) => e.scene === key.scene && e.latent === key.latent && e.lead === key.lead,
    (e) => e.scene === key.scene && e.lead === key.lead,
    (e) => e.latent === key.latent && e.lead === key.lead,
    (e) => e.lead === key.lead,
  ];
  // 同じ段の中では「代表の並び」（他の手本との役目の並びの近さの平均が一番高い＝medoid）を選ぶ。同点は手で読んだ物 → id
  //   （11/12 の初版は文の数で選んだ＝誘導先を正解で与えても gold 24番の近さ 0.41 で、たまたまの1通を引いていた）
  const seq = (e: T) => e.sentences.map((s) => s.role);
  for (let lv = 0; lv < levels.length; lv++) {
    const hit = pool.filter(levels[lv]);
    if (!hit.length) continue;
    const score = (e: T) => (hit.length === 1 ? 1 : hit.reduce((s, o) => s + (o === e ? 0 : roleSeqSimilarity(seq(e), seq(o))), 0) / (hit.length - 1));
    const best = hit.map((e) => ({ e, s: score(e) })).sort((a, b) => b.s - a.s || Number(!!b.e.hand) - Number(!!a.e.hand) || a.e.id.localeCompare(b.e.id))[0].e;
    return { ex: best, level: lv };
  }
  return null;
}

/** 既定 off。入れる TAKEUCHI_EXEMPLAR=on */
export function exemplarOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TAKEUCHI_EXEMPLAR ?? "").trim().toLowerCase() === "on";
}
/** 設計図の注記（文は写させない: 役目の並び・1文ずつのなぜとブレインの欄・使った事実・潜在の4つ）。off なら null */
export function exemplarNote(hit: { ex: Exemplar; level: number } | null, env?: Record<string, string | undefined>): string | null {
  if (!hit || !exemplarOn(env)) return null;
  const { ex } = hit;
  const L = [`【竹内さんの近い番の組み立て（${["場面×潜在×誘導先", "場面×誘導先", "潜在×誘導先", "誘導先"][hit.level]}が同じ・文は写さない）】`];
  L.push(`並び: ${ex.sentences.map((s) => s.role ?? "?").join(" > ")}`);
  ex.sentences.forEach((s, i) => L.push(`${i + 1}. ${s.role ?? "?"}（${BRAIN_FIELD_LABEL[s.brainField]}）: ${s.why}`));
  // 表の行はきっかけが発言の写しなら空（app/lib/takeuchi-exemplar-row.ts）＝「〜で、」を付けない
  if (ex.latentFour) L.push(`潜在: ${ex.latentFour.trigger ? `${ex.latentFour.trigger}で、` : ""}${ex.latentFour.part}について「${ex.latentFour.feeling}」→ 本当は ${ex.latentFour.want}`);
  if (ex.fact) L.push(`先回りに使った事実: ${ex.fact}`);
  return L.join("\n");
}

/** 役目の並びの近さ（最長共通部分列 ÷ 長い方）。挨拶・締めは数えない・続く同じ役目は1つにする（組み立ての型を比べる）。1＝同じ */
export function roleSeqSimilarity(a: ReadonlyArray<string | null>, b: ReadonlyArray<string | null>): number {
  const f = (x: ReadonlyArray<string | null>) => x.filter((r): r is string => !!r && r !== "greet" && r !== "close").filter((r, i, xs) => i === 0 || xs[i - 1] !== r);
  const A = f(a), B = f(b);
  if (!A.length && !B.length) return 1;
  const dp = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[A.length][B.length] / Math.max(A.length, B.length);
}
