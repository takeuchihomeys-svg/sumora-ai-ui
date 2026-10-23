// app/lib/writing-blueprint.ts — 書く役の「文の設計図」（段1・決まった処理だけ・LLM なし）
//
// 2026-10-20 竹内さん（設計知見 f5a4b51a・7131fbc3）「文生成するところもこのように地図のような基本となる知識はあるのか。今軸がない気がしていて、
//   そのため不安定な文がたまに出来ている可能性がある」。ブレインには申込までの地図（apply-route-map）があるが、書く側には文の組み立ての軸が無く、
//   場面ごとの決まりが約4万字に積み重なっている＝かしこまりましたの重なり・説明口調の受け止め・段の崩れ・約束の文の抜けが時々出る。
//
// ここで持つ物（3つ）:
//   ①設計図のデータ（場面ごとの段の並び・要る段・書かない段・長さ）＝ WRITING_BLUEPRINTS
//      段: 名前→挨拶→お礼→受け（かしこまりました等）→答え（質問の順）→約束（期日つき）→誘い（内覧・申込）→支える一言→締め
//      並びと要る段は、竹内さんの手打ちの実送信（90日・場面ごと）で数えた形に合わせた（scripts/audit-writing-blueprint.ts）
//   ②選ぶ関数（場面＋その番の事実 → 書く役への短い指示 ≤500字）＝ buildWritingBlueprintNote
//      WRITING_BLUEPRINT（2026-10-23 から既定 on・=off で止める）の時 generate-reply の毎回変わる側（キャッシュしない側）に入る。off＝指示は1文字も変わらない
//   ③確かめる関数（下書き → 段の並び・要る段・書かない言葉の外れ）＝ checkDraftAgainstBlueprint
//      見張り（line_watch_turns）の下書きとスタッフの送信を読むだけで比べる（scripts/audit-writing-blueprint.ts）
//
// ⚠ 判断（何を答える・何を約束する・AIX）はブレインが決める（P0 9eb6aa9c）。ここは「決まった中身をどの順・どの段で書くか」の形だけ。
// ⚠ 場面は reply-scene の9場面（ReplyScene）＋申込までの地図の分かれ道の名前（文字列。地図が無い時は無視）で引く。

import type { ReplyScene } from "./reply-scene";

// ─── 段（パーツ）────────────────────────────────────────────────
export type BlueprintPart =
  | "name"      // 〇〇さん
  | "greeting"  // お世話になっております／はじめまして
  | "thanks"    // ありがとうございます／ご査収頂きありがとうございます
  | "ack"       // かしこまりました／はい😊／大丈夫です（受けの言葉・1回）
  | "answer"    // 本題（答え・報告・説明）
  | "promise"   // 確認させて頂きます／お送りさせて頂きます（これからする事）
  | "invite"    // 内覧・申込への誘い
  | "support"   // お気軽に・全力でサポート（支える一言）
  | "closing";  // 何卒よろしくお願い致します／ご査収ください

export const PART_JA: Record<BlueprintPart, string> = {
  name: "名前", greeting: "挨拶", thanks: "お礼", ack: "受け", answer: "答え", promise: "約束", invite: "誘い", support: "支える一言", closing: "締め",
};

/** 基本の並び（竹内さん 10/20 の基礎の構成: 名前＋書き出し→お礼・受け止め→受けの言葉＋本題→約束・期日→誘い→締め） */
export const BASE_ORDER: readonly BlueprintPart[] = ["name", "greeting", "thanks", "ack", "answer", "promise", "invite", "support", "closing"];

// ─── 文を段に分ける（決まった処理）─────────────────────────────────────
const EMOJI = "[\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}\\u{FE0F}\\u{200D}]";
/** 1文の終わり（！！・！・。・？の後の絵文字まで） */
const SENT_END_RE = new RegExp(`((?:！！|!!|！|!|。|？|\\?)+(?:${EMOJI}|[\\s　])*)`, "gu");

/** 文に分ける（改行と文末の記号で切る・空は捨てる） */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\n+/)) {
    const parts = line.split(SENT_END_RE);
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      cur += parts[i];
      if (i % 2 === 1) { if (cur.trim()) out.push(cur.trim()); cur = ""; }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

const NAME_HEAD_RE = /^[^\s、。！!？?]{1,14}(?:さん|様)(?=[\s　、,]|$|お世話|はじめ|こんにち|こんばん|おはよう|ご連絡|かしこまり|ありがとう|お待たせ)/u;
const GREETING_RE = /お世話になっております|はじめまして|初めまして|ご連絡頂きありがとうございます|ご連絡いただきありがとうございます|お問い合わせ頂きありがとうございます|お待たせ(?:致し|いたし)ました|おはようございます|こんにちは|こんばんは|夜分/;
const CLOSING_RE = /何卒よろしくお願い|よろしくお願い(?:致し|いたし|申し上げ)ます|ご査収(?:くださ|下さ)|お気をつけて(?:お越し|お帰り)|宜しくお願い(?:致し|いたし)ます/;
const SUPPORT_RE = /お気軽に|全力で|いつでも(?:ご|お)|サポート(?:を)?(?:させて|致し|いたし)|尽力|ご安心(?:して|下さ|くださ)|お力になれ/;
const INVITE_RE = /(?:内覧|内見|ご案内|見学)[^。！!]{0,24}(?:可能|出来|できます|させて頂|させていただ|いかが|如何|お待ち|ご都合)|(?:お)?申込(?:み)?(?:で|にて)?[^。！!]{0,10}(?:抑え|押さえ|いかが|如何|オススメ|おすすめ|お待ち)|ご来店/;
const PROMISE_RE = /(?:確認|ピックアップ|お送り|送付|作成|お探し|探し|探させ|調べ|お調べ|交渉|手配|ご用意|ご連絡|お伝え|お問い合わせ|問い合わせ)(?:させて)?(?:頂|いただ)?き?(?:ます|致します|いたします)(?!か)|次第(?:ご連絡|お送り|お伝え|ご報告)|折り返し/;
const PAST_DONE_RE = /(?:させて)?(?:頂|いただ)きました|(?:致し|いたし)ました|お送りしました/;
const THANKS_RE = /ありがとう(?:ございます|御座います|ございました)|有難う|ご査収頂き|恐れ入ります|助かります/;
const ACK_RE = /^(?:かしこまりました|承知(?:致)?しました|承知いたしました|了解(?:致)?しました|はい|大丈夫です|全然大丈夫です|とんでもございません|とんでもないです)/;

/** 1文をどの段か決める（強い順） */
export function classifySentence(s: string): BlueprintPart {
  const t = s.normalize("NFKC").replace(new RegExp(EMOJI, "gu"), "").trim();
  if (GREETING_RE.test(t) && t.replace(GREETING_RE, "").replace(/[\s!！。、]/g, "").length <= 14) return "greeting";
  if (CLOSING_RE.test(t)) return "closing";
  if (ACK_RE.test(t) && t.replace(ACK_RE, "").replace(/[\s!！。、😊😌]/g, "").length <= 2) return "ack";
  if (THANKS_RE.test(t) && t.length <= 40 && !PROMISE_RE.test(t)) return "thanks";
  if (SUPPORT_RE.test(t)) return "support";
  if (INVITE_RE.test(t)) return "invite";
  if (PROMISE_RE.test(t) && !PAST_DONE_RE.test(t)) return "promise";
  if (GREETING_RE.test(t)) return "greeting";
  return "answer";
}

export type PartSeq = { parts: BlueprintPart[]; sentences: Array<{ part: BlueprintPart; text: string }> };

/** 本文を段の並びにする（名前は頭から剥がす・同じ段の連続は1つにまとめる） */
export function partsOf(text: string): PartSeq {
  const raw = String(text ?? "").replace(/\r/g, "").trim();
  const sentences: Array<{ part: BlueprintPart; text: string }> = [];
  let body = raw;
  const nm = body.match(NAME_HEAD_RE);
  if (nm) { sentences.push({ part: "name", text: nm[0] }); body = body.slice(nm[0].length).replace(/^[\s　、,]+/, ""); }
  for (const s of splitSentences(body)) sentences.push({ part: classifySentence(s), text: s });
  const parts: BlueprintPart[] = [];
  for (const x of sentences) if (parts[parts.length - 1] !== x.part) parts.push(x.part);
  return { parts, sentences };
}

// ─── 設計図のデータ ────────────────────────────────────────────────
export type WritingBlueprint = {
  key: string;
  name: string;
  /** その場面の狙い（申込までの地図の言葉） */
  aim: string;
  /** 段の並び（この順で書く・無い段は飛ばす） */
  order: BlueprintPart[];
  /** 要る段 */
  required: BlueprintPart[];
  /** 書かない段 */
  forbidden: BlueprintPart[];
  /** 文の数の上限（名前・挨拶を除く） */
  maxSentences: number;
  /** 場面の一言（書く役へ） */
  note: string;
};

/**
 * 場面ごとの設計図（reply-scene の9場面）。
 * 線の引き方（2026-10-20・竹内さんの手打ち 90日 722番・お客様の番の後3時間以内の最初のまとまり・物件カード/見積の本体は除く）:
 *   要る段 = その場面で 70% 以上に出る段／書かない段 = 5% 以下しか出ず設計知見にも「書かない」がある段／文の数 = 上位10%
 *   各行の「数:」は段の出る率（名前・挨拶は除く）と、基本の並びと逆の対が無い割合（＝並びの揃い方）。
 *   order は全部の段を並べる（無い段は飛ばす）＝確かめる時に順位が必ず引ける。
 */
export const WRITING_BLUEPRINTS: Record<ReplyScene, WritingBlueprint> = {
  // 数: n=116 受け63・締め59・答え47・支える28・誘い28・約束23／揃う87%／文 中央3・上位10% 4。多い形「受け→締め」21%
  ack: { key: "ack", name: "短いお礼・了承", aim: "関係をつなぐ",
    order: ["name", "greeting", "ack", "thanks", "answer", "promise", "invite", "support", "closing"], required: [], forbidden: [], maxSentences: 4,
    note: "短く受けて閉じる（はい😊！！／かしこまりました！！＋約束かお気軽に＋何卒）。前の約束・別の話題を足さない" },
  // 数: n=39 受け100・支える82・答え64・締め28・約束23・誘い13／揃う69%／文 中央3。多い形「受け→答え→支える一言」18%
  considering: { key: "considering", name: "検討中・保留", aim: "関係をつなぐ",
    order: ["name", "greeting", "ack", "thanks", "answer", "promise", "invite", "support", "closing"], required: ["ack", "support"], forbidden: [], maxSentences: 6,
    note: "気持ちを受けて押さずに閉じる（扉の1文まで）。催促・内覧の日時の打診はしない" },
  // 数: n=99 答え82・受け32・誘い29・約束27・締め25／揃う87%／文 中央3・上位10% 6。多い形「答え」だけ 29%
  question: { key: "question", name: "質問", aim: "不安を解く",
    order: ["name", "greeting", "thanks", "ack", "answer", "promise", "invite", "support", "closing"], required: ["answer"], forbidden: [], maxSentences: 6,
    note: "答えから書く（理由を具体的に）。分からない事だけ確認の約束" },
  // 数: n=119 約束81・支える64・答え60・締め53・受け40・お礼26・誘い4／揃う67%／文 中央4・上位10% 5。多い形「答え→約束→支える一言→締め」12%
  conditions: { key: "conditions", name: "条件の提示・変更", aim: "条件を聞き出す",
    order: ["name", "greeting", "thanks", "ack", "answer", "promise", "invite", "support", "closing"], required: ["promise"], forbidden: ["invite"], maxSentences: 5,
    note: "受けて条件を短く復唱し、ピックアップしてお送りする約束（期日つき）→支える一言" },
  // 数: n=76 答え74・約束67・締め34・受け33・お礼22／揃う75%／文 中央3・上位10% 5。多い形「受け→答え→約束」「答え→約束」各12%
  property_share: { key: "property_share", name: "物件を送ってきた", aim: "信用を頂く",
    order: ["name", "greeting", "thanks", "ack", "answer", "promise", "invite", "support", "closing"], required: ["answer"], forbidden: [], maxSentences: 5,
    note: "送って頂いたお礼→募集状況の確認の約束（分かり次第ご連絡）" },
  // 数: n=54 答え70・受け61・約束54・締め31／揃う78%／文 中央3・上位10% 5。多い形「受け→約束」17%
  cost: { key: "cost", name: "初期費用・見積", aim: "申込へ誘う",
    order: ["name", "greeting", "thanks", "ack", "answer", "promise", "invite", "support", "closing"], required: ["answer"], forbidden: [], maxSentences: 5,
    note: "最大限割引の御見積書をお送りする約束。まだ送っていない番にご査収は書かない" },
  // 数: n=48 受け65・答え63・誘い42・約束35・締め29／揃う60%（一番揃わない）／文 中央3・上位10% 5
  viewing: { key: "viewing", name: "内覧・日程", aim: "信用を頂く",
    order: ["name", "greeting", "thanks", "ack", "answer", "promise", "invite", "support", "closing"], required: [], forbidden: [], maxSentences: 5,
    note: "日時・当日の連絡を受けて短く（当日の連絡は かしこまりました＋お気をつけてお越しください）" },
  // 数: n=68 答え88・受け38・締め37・お礼32・誘い25・約束24・支える22／揃う68%／文 中央3・上位10% 7
  apply: { key: "apply", name: "申込・審査", aim: "不安を解く",
    order: ["name", "greeting", "thanks", "ack", "answer", "promise", "invite", "support", "closing"], required: ["answer"], forbidden: [], maxSentences: 7,
    note: "手続き・審査の問いには答えから。不安には通るまでサポートの姿勢" },
  // 数: n=100 受け73・締め51・答え47・支える43・約束37／揃う80%／文 中央3・上位10% 5
  other: { key: "other", name: "その他", aim: "関係をつなぐ",
    order: [...BASE_ORDER], required: [], forbidden: [], maxSentences: 5,
    note: "" },
};

/** 地図の分かれ道で形が決まる物（apply-route-map の RouteBranchId と同じ名前。地図が無い時は使わない） */
export const BRANCH_BLUEPRINTS: Record<string, Partial<WritingBlueprint> & { must?: string[] }> = {
  // 2026-10-20 竹内さんの決定 937c480f/d6b6edc1「大丈夫です😊！！ / 弊社にてご内見可能です！！ / ご挨拶も兼ねまして一度ご内見頂ければ…」
  other_agent_viewing: { name: "他社で内覧", aim: "信用を頂く", order: ["name", "greeting", "ack", "thanks", "answer", "invite", "promise", "support", "closing"], required: ["ack", "invite"], forbidden: [],
    must: ["①大丈夫です（否定しない）", "②弊社でもご内見可能です", "③ご挨拶も兼ねて一度ご内見頂ければ安心してお任せ頂ける"] },
  // a10bd246: 断り・キャンセル・否決の直後は営業を乗せず受け止めだけ（原則14）
  declined: { required: ["ack"], forbidden: ["invite", "promise"], maxSentences: 3, note: "受け止めだけ（営業を乗せない）" },
};

// ─── その番の事実 ────────────────────────────────────────────────
export type BlueprintTurnFacts = {
  scene: ReplyScene | null;
  /** 申込までの地図の分かれ道（無ければ null） */
  routeBranch?: string | null;
  /** お客様の質問（お客様が書いた順） */
  questions?: readonly string[];
  /** この番で何かを送る・送った（物件資料・見積書・画像・AIX の本体） */
  sentThisTurn?: boolean;
  /** まだ果たしていない約束がある（前の番の約束） */
  promiseOutstanding?: boolean;
};

/**
 * 2026-10-23 計画7: 既定 on（試験 YUMA4・下書きまで 30問で前より悪い 0・良い 2（揺れ））。止める WRITING_BLUEPRINT=off
 *   on で動く物: 設計図の注記（buildWritingBlueprintNote）・場面の型（writing-blueprint-patterns.ts）・出口2つ（約束だけの番のご査収・致します/いたします）
 */
export function writingBlueprintEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.WRITING_BLUEPRINT ?? "").trim().toLowerCase() !== "off";
}

/** その番の設計図（場面＋分かれ道で上書き） */
export function resolveBlueprint(f: Pick<BlueprintTurnFacts, "scene" | "routeBranch">): WritingBlueprint & { must: string[] } {
  const base = WRITING_BLUEPRINTS[f.scene ?? "other"] ?? WRITING_BLUEPRINTS.other;
  const br = f.routeBranch ? BRANCH_BLUEPRINTS[f.routeBranch] : undefined;
  if (!br) return { ...base, must: [] };
  return { ...base, ...br, key: `${base.key}+${f.routeBranch}`, note: br.note ?? base.note, must: br.must ?? [] } as WritingBlueprint & { must: string[] };
}

export const BLUEPRINT_NOTE_MAX = 500;
const short = (q: string, n = 18) => { const s = q.replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** 書く役への短い指示（≤500字・毎回変わる側）。設計図に書く事が無ければ "" */
export function buildWritingBlueprintNote(f: BlueprintTurnFacts): string {
  const bp = resolveBlueprint(f);
  const lines: string[] = [];
  lines.push(`【🧩 文の設計図（${bp.name}・狙い:${bp.aim}）】この順で段を組む（無い段は飛ばす）: ${bp.order.map((p) => PART_JA[p]).join("→")}`);
  if (bp.required.length) lines.push(`- 要る段: ${bp.required.map((p) => requiredLabel(p)).join("・")}`);
  if (bp.forbidden.length) lines.push(`- 書かない段: ${bp.forbidden.map((p) => PART_JA[p]).join("・")}`);
  for (const m of bp.must) lines.push(`- 必ず: ${m}`);
  const qs = (f.questions ?? []).filter((q) => q.trim());
  if (qs.length >= 2) lines.push(`- 質問は聞かれた順に答える: ${qs.slice(0, 4).map((q, i) => `${i + 1}.${short(q)}`).join(" ")}`);
  lines.push("- 受けの言葉（かしこまりました等）は1回だけ・挨拶の行に付けず本題の段の頭に。気持ちを説明する受け止め（〜受け止めさせて頂きました）は書かない");
  if (!f.sentThisTurn) lines.push("- この番は何も送っていない＝「ご査収ください」は書かない");
  if (f.promiseOutstanding) lines.push("- 前の約束がまだ＝新しい約束を重ねず、その約束の続きとして書く");
  lines.push(`- 長さ: 名前・挨拶の他 ${bp.maxSentences}文まで・1段1事・調子（！！）をそろえる`);
  if (bp.note) lines.push(`- ${bp.note}`);
  let text = `\n\n${lines.join("\n")}`;
  if (text.length > BLUEPRINT_NOTE_MAX) text = text.slice(0, BLUEPRINT_NOTE_MAX - 1) + "…";
  return text;
}

/**
 * 2026-10-21 竹内さん A4「ただしい」（設計知見 fca0a40e）: 物件・費用の番で「確認させて頂きます」の約束だけで返す（答えは後で AIX）は正しい形。
 *   要る段「答え」は約束の段でも満たせる（指示と見張りの両方）。見張りの「答えが無い」85件のうち65件が約束だけの番だった。
 *   戻す BLUEPRINT_PROMISE_AS_ANSWER=off（答えの段だけで数える）
 */
export function promiseSatisfiesAnswer(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BLUEPRINT_PROMISE_AS_ANSWER ?? "").trim().toLowerCase() !== "off";
}
/** 要る段の表記（答えは約束でも満たせる時「答え（または約束）」） */
function requiredLabel(p: BlueprintPart, env?: Record<string, string | undefined>): string {
  return p === "answer" && promiseSatisfiesAnswer(env) ? `${PART_JA.answer}（まだ結果が無い事は約束の段で足りる）` : PART_JA[p];
}

/** 環境の切り替えつき（off の時は必ず ""） */
export function writingBlueprintNoteIfEnabled(f: BlueprintTurnFacts, env?: Record<string, string | undefined>): string {
  return writingBlueprintEnabled(env) ? buildWritingBlueprintNote(f) : "";
}

// ─── 確かめる（下書き → 外れ）─────────────────────────────────────────
export type BlueprintBreakType =
  | "dup_ack"               // 受けの言葉（かしこまりました等）が2回
  | "ack_on_greeting"       // かしこまりましたが挨拶の行に付いた
  | "explain_empathy"       // 気持ちを説明する受け止め（受け止めさせて頂きました・ご状況しっかり）
  | "kasa_not_sent"         // 何も送っていない番に「ご査収ください」
  | "material_missing"      // 「資料に記載がなかった／記載がございません」
  | "order"                 // 段の並びが設計図の逆（締めの後に本題 等）
  | "missing_required"      // 要る段が無い
  | "forbidden_part"        // 書かない段がある
  | "question_order"        // 質問と違う順で答えた
  | "too_long"              // 文の数が上限を超えた
  | "dup_closing";          // 締めが2回以上

export const BREAK_JA: Record<BlueprintBreakType, string> = {
  dup_ack: "受けの言葉が2回", ack_on_greeting: "かしこまりましたが挨拶の行に", explain_empathy: "説明口調の受け止め", kasa_not_sent: "送っていないのにご査収",
  material_missing: "資料に記載が無い旨", order: "段の並びが逆", missing_required: "要る段が無い", forbidden_part: "書かない段がある",
  question_order: "質問と違う順に答えた", too_long: "長すぎる", dup_closing: "締めが2回",
};

export type BlueprintBreak = { type: BlueprintBreakType; detail: string };

const KASHIKO_RE = /かしこまりました|承知(?:致)?しました|承知いたしました/g;
const EXPLAIN_EMPATHY_RE = /受け止めさせて(?:頂|いただ)き|(?:ご状況|お気持ち|お悩み)[^。！!]{0,8}(?:しっかり|受け止め|理解させて)/;
const MATERIAL_MISSING_RE = /(?:資料|図面|募集図面|物件資料)[^。！!]{0,10}(?:記載|記入)[^。！!]{0,6}(?:なかった|無かった|ございません|御座いません|ありません|がなく|が無く)/;
const KASA_RE = /ご査収(?:くださ|下さ|の程|頂けますと|お願い)/;

/** 質問の話題（答えの順を見るための語の網） */
const TOPICS: Array<[string, RegExp]> = [
  ["初期費用", /初期費用|見積|総額|費用|敷金|礼金|頭金/], ["家賃", /家賃|賃料|管理費|共益費/], ["ペット", /ペット|犬|猫/], ["駐車場", /駐車場|駐輪|バイク/],
  ["入居日", /入居(?:日|可能|時期)|いつから|退去予定|空き予定/], ["内覧", /内覧|内見|見学/], ["審査", /審査|保証(?:会社|人)/], ["申込", /申込|申し込/],
  ["設備", /設備|エアコン|洗濯|宅配|ネット|wifi|Wi-?Fi|オートロック|インターネット|浴室|バス|トイレ|キッチン|コンロ/i], ["募集", /募集|空いて|空室|まだ(?:あり|空)/],
  ["契約", /契約|更新|解約|違約/], ["場所", /駅|徒歩|距離|周辺|治安|スーパー|コンビニ/],
];
export function topicsOf(text: string): string[] { return TOPICS.filter(([, re]) => re.test(text)).map(([k]) => k); }

/** 質問の答えの順（質問の話題が下書きに最初に出る位置が、質問の順と逆の対の数） */
export function questionOrderInversions(questions: readonly string[], draft: string): { checked: number; inversions: number } {
  const tops: string[] = [];
  for (const q of questions) { const t = topicsOf(q).find((x) => !tops.includes(x)); if (t) tops.push(t); }
  const pos = tops.map((t) => { const re = TOPICS.find(([k]) => k === t)![1]; const m = draft.match(re); return m?.index ?? -1; });
  const seen = tops.map((t, i) => ({ t, p: pos[i] })).filter((x) => x.p >= 0);
  let inv = 0;
  for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < seen.length; j++) if (seen[i].p > seen[j].p) inv++;
  return { checked: seen.length, inversions: inv };
}

/** 段の並びが設計図の順と逆の対（名前・挨拶は除く。同じ段が離れて2回出るのは数えない） */
export function orderInversions(parts: readonly BlueprintPart[], order: readonly BlueprintPart[]): Array<[BlueprintPart, BlueprintPart]> {
  const rank = (p: BlueprintPart) => { const i = order.indexOf(p); return i >= 0 ? i : BASE_ORDER.indexOf(p); };
  const out: Array<[BlueprintPart, BlueprintPart]> = [];
  const ps = parts.filter((p) => p !== "name" && p !== "greeting");
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    if (ps[i] === ps[j]) continue;
    if (rank(ps[i]) > rank(ps[j]) && !out.some(([a, b]) => a === ps[i] && b === ps[j])) out.push([ps[i], ps[j]]);
  }
  return out;
}

/** 下書きを設計図で確かめる（決まった処理・外れの一覧） */
export function checkDraftAgainstBlueprint(draft: string, f: BlueprintTurnFacts): { parts: BlueprintPart[]; breaks: BlueprintBreak[]; blueprint: string } {
  const bp = resolveBlueprint(f);
  const text = String(draft ?? "");
  const seq = partsOf(text);
  const breaks: BlueprintBreak[] = [];
  const kashiko = (text.match(KASHIKO_RE) ?? []).length;
  if (kashiko >= 2) breaks.push({ type: "dup_ack", detail: `${kashiko}回` });
  for (const line of text.split("\n")) if (/お世話になっております/.test(line) && KASHIKO_RE.test(line)) { breaks.push({ type: "ack_on_greeting", detail: "" }); break; }
  KASHIKO_RE.lastIndex = 0;
  if (EXPLAIN_EMPATHY_RE.test(text)) breaks.push({ type: "explain_empathy", detail: "" });
  if (!f.sentThisTurn && KASA_RE.test(text)) breaks.push({ type: "kasa_not_sent", detail: "" });
  if (MATERIAL_MISSING_RE.test(text)) breaks.push({ type: "material_missing", detail: "" });
  const inv = orderInversions(seq.parts, bp.order);
  if (inv.length) breaks.push({ type: "order", detail: inv.map(([a, b]) => `${PART_JA[a]}→${PART_JA[b]}`).join(",") });
  const has = new Set(seq.parts);
  // 10/21 A4: 要る段「答え」は約束の段でも満たせる（promiseSatisfiesAnswer）
  for (const p of bp.required) if (!has.has(p) && !(p === "answer" && has.has("promise") && promiseSatisfiesAnswer())) breaks.push({ type: "missing_required", detail: PART_JA[p] });
  for (const p of bp.forbidden) if (has.has(p)) breaks.push({ type: "forbidden_part", detail: PART_JA[p] });
  const closings = seq.sentences.filter((x) => x.part === "closing" && /よろしくお願い/.test(x.text)).length;
  if (closings >= 2) breaks.push({ type: "dup_closing", detail: `${closings}回` });
  const qs = f.questions ?? [];
  if (qs.length >= 2) { const q = questionOrderInversions(qs, text); if (q.inversions > 0) breaks.push({ type: "question_order", detail: `${q.inversions}/${q.checked}` }); }
  const n = seq.sentences.filter((x) => x.part !== "name" && x.part !== "greeting").length;
  if (n > bp.maxSentences) breaks.push({ type: "too_long", detail: `${n}>${bp.maxSentences}` });
  return { parts: seq.parts, breaks, blueprint: bp.key };
}

const Q_SENT_RE = /[?？]|ですか|ますか|でしょうか|ますかね|可能(?:です)?か|できますか|ありますか|ないですか|どう(?:です|でしょう|なり)|なんですか/;
/** お客様の文から質問の文を書いた順に拾う（答えの順を見るため・決まった処理） */
export function questionsOf(customerText: string): string[] {
  return splitSentences(String(customerText ?? "").normalize("NFKC")).filter((s) => Q_SENT_RE.test(s));
}
