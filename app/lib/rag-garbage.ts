// app/lib/rag-garbage.ts — RAG の置き場（手本 ai_reply_examples・ナレッジ ai_reply_knowledge）の「ゴミ」の型を決める（純関数・DB なし）
//
// 2026-10-08 竹内さん「RAG 検索を行う際のゴミデータが質を下げている可能性もあるので、その点も調査する」
//   監査 scripts/audit-rag-garbage.ts が全行に当てて数え、検索の上位に入った割合と、その番の下書きが実送信から遠かったかを結ぶ。
//   ここは「型を決める」だけ。外す・弾くの判断は監査で目で読んでから（CLAUDE.md「おかしな文を1通見つけた時」）。
//
// 型は2つに分ける:
//   hard … 手本・ナレッジとして渡すと、そのまま誤りになる物（テスト会話・申込以降・個人情報・文字化け・AIX の番の文・禁止の言い回しの残り）
//   soft … 書き方の基準（竹内さん＝書き手A）から外れる・自己強化の恐れ（従業員の書き方・AI の下書きのまま⭐）。外さず並べ替えで下げる物
//
// ⚠ 読む側で既に外している物（isUsableExampleText・isCustomerFacingExample）と、注入の直前に直している物（normalizeBannedPhrasing＝
//   夜分・承知・絵文字・新築・ペット／maskExampleAmounts／example-pii-guard）は「residual=false」で印を付ける（数えるが、今の質は下げていない）。

import { isUsableExampleText, isCustomerFacingExample } from "./example-hygiene";
import { writerFromText } from "./staff-writer";
import { WAITED_RE } from "./greeting";
import { NIGHT_GREETING_RE } from "./banned-phrasing";
import { enforceEmojiAllowlist } from "./emoji-allowlist";
import { fixSecondPersonOkyaku } from "./okyaku-address";
import { examplePiiReason } from "./example-pii-guard";
import { classifySentKind } from "./sent-shape";

export type GarbageType =
  | "empty"            // 本文が空
  | "tiny"             // 5字以下（絵文字・記号を除く）
  | "long"             // 1,500字超（手本の枠を1件で食う）
  | "mojibake"         // 文字化け（U+FFFD・Shift_JIS を UTF-8 で読んだ形）
  | "unusable"         // isUsableExampleText で読む側が外す（失敗文・テスト送信・会社の事実に反する・JSON の名残 等）
  | "to_management"    // 管理会社宛て（返信の経路では読む側が外す）
  | "pii"              // 他のお客様の個人情報（LLM の直前で伏せる＝枠の無駄）
  | "test_conv"        // テスト会話（YUMA・スタッフ同士）
  | "post_apply"       // 申込以降の会話（今の対象外）
  | "aix_turn"         // 返信の手本なのに AIX の番の文（物件カード・見積書・待ち合わせ・候補日時 等）
  | "omatase"          // 「お待たせ致しました」（返信では使わない・注入の直前に直していない）
  | "okyaku"           // 相手を「お客様」と呼ぶ（注入の直前に直していない）
  | "night"            // 夜分遅く（注入の直前に直している）
  | "emoji"            // 許可外の絵文字（注入の直前に直している）
  | "writer_b"         // 従業員の書き方（いただ・いたし・いかが）＝竹内さんの基準から外れる
  | "auto_star"        // AI の下書きを直さず送って⭐（自己強化）
  | "dup";             // 同じ文の重複（2件目以降）

export const HARD_TYPES: ReadonlySet<GarbageType> = new Set<GarbageType>([
  "empty", "mojibake", "unusable", "to_management", "pii", "test_conv", "post_apply", "aix_turn", "omatase", "okyaku", "dup",
]);
/** 注入の直前に直している・読む側で外している型（数えるが今の質は下げていない） */
export const NEUTRALIZED_TYPES: ReadonlySet<GarbageType> = new Set<GarbageType>(["unusable", "to_management", "night", "emoji"]);

/** 文字化け: 置換文字・Shift_JIS/UTF-8 の取り違えで出る並び */
export const MOJIBAKE_RE = /�|[縺繧繝郢譁蜷][぀-ヿ一-鿿]{0,1}[縺繧繝郢]|Ã.|ã[\u0080-¿]/;

/** 表示に効く字だけの長さ（空白・絵文字・記号を除く） */
export function coreLength(s: string): number {
  return String(s ?? "").replace(/[\s\p{Extended_Pictographic}️‍！!？?。、,.．・〜~ー…]/gu, "").length;
}

/** 重複を見る時の正規化（空白・絵文字・記号・名前の呼びかけの揺れを除く） */
export function dupKey(s: string): string {
  return String(s ?? "")
    .replace(/[\s\p{Extended_Pictographic}️‍！!？?。、,.．・〜~ー…]/gu, "")
    .replace(/^[^\n]{0,12}?(?:さん|様)/, "")
    .slice(0, 400);
}

/**
 * 返信の手本が AIX の番の文か。AIX が作る資料そのもの（物件カード・見積書の本体・待ち合わせ）と、AIX【内覧調整】の候補日時だけ。
 *   ⚠「御見積書お送りさせて頂きます」「確認させて頂きます」のような約束の文は返信の番（当てない）。
 *   2026-10-08 初回の監査で classifySentKind の「見積書」（御見積書の語だけで当たる）・aix-territory の「希少性の煽り」等を
 *   そのまま使うと約束の文まで AIX の番に数えていた → 資料の形と候補日時だけに絞った。
 */
export const ESTIMATE_BODY_RE = /初期費用[：:]|初期費用さらに|【[^】\n]{2,28}[0-9０-９]{2,4}\s*(?:号室?|室)】[\s\S]{0,200}[0-9０-９][0-9０-９,，]{3,}円/;
/**
 * 物件オススメ（AIX【物件オススメ】の文）: 「かなりオススメ出来るお部屋」と家賃の額が両方ある文。
 *   ⚠ 「合計90,000円」だけでは当てない（10/09 監査: 7bdb6f3c「他社で家賃＋共益費合計90,000円…明日念の為管理会社に確認」＝返信の番の確認の約束が外れていた）
 */
export const RECOMMEND_BODY_RE = /オススメ(?:出来|でき)る(?:お部屋|物件)(?:と|に)?(?:なります|です|が(?:新着で)?募集に出)/;   // 「〜ピックアップしてお送り」（初回の約束）は当てない（10/09 監査 fd3b4a87）
export const RENT_AMOUNT_RE = /家賃[^\n]{0,6}?[¥￥]?[0-9０-９][0-9０-９,，]{3,}円/;
/** 「9/21日(月曜) 12:00〜16:00」「10/13(火) 16:30〜18:30」の候補の枠 */
export const VIEWING_SLOTS_RE = /\d{1,2}\s*[/／月]\s*\d{1,2}\s*日?\s*(?:[（(][^）)\n]{1,4}[）)])?\s*\d{1,2}[:：]\d{2}\s*[〜~～\-－]\s*\d{1,2}[:：]\d{2}/;
/**
 * 物件カード（AIX【物件オススメ／物件送る】の資料）: （オススメポイント）・【物件名 号室】・🌟物件名 号室。
 *   ⚠ classifySentKind の「🌟があれば物件カード」は使わない（10/09 監査: 「🌟ご希望の地域や駅御座いますでしょうか」
 *   「🌟10月中旬以降のご入居となります」「🌟お申込み後の流れをご案内」等、強調の🌟の返信が外れていた）
 */
export const PROPERTY_CARD_RE = /（オススメポイント）|【[^】\n]{2,28}[0-9０-９]{2,4}\s*(?:号室?|室)】|🌟[^\n]{1,40}?[0-9０-９]{2,4}\s*号室/;
/**
 * 待ち合わせ（AIX【待ち合わせ場所】・当日の到着の連絡）: 時刻と「現地エントランス／お待ち合わせ／集合場所」が近くにある文・到着の連絡。
 *   ⚠ 時刻の無い「ご内覧現地お待ち合わせとなります」（現地集合かの質問への答え）・「現地お待ち合わせでご内覧頂く事も出来ます」（誘い）は返信の番
 *   （10/09 監査 1519f025・1d92b3a4）。classifySentKind の「内覧の待ち合わせ」は時刻を見ないので使わない
 */
export const MEETING_BODY_RE = /\d{1,2}(?:[:：;]\d{2}|時)[^\n]{0,30}(?:現地エントランス|お?待ち合わせ|集合場所)|(?:現地エントランス|お待ち合わせ場所|集合場所)[^\n]{0,30}\d{1,2}(?:[:：]\d{2}|時)|現地エントランス前?(?:に)?到着(?:して|致して|いたして)おります|到着が\d{1,2}[:：]\d{2}/;
export function aixTurnReason(sent: string): string | null {
  if (ESTIMATE_BODY_RE.test(sent)) return "見積書の本体";   // 見積書の本体は【物件名 号室】で始まるので物件カードより先に見る
  if (PROPERTY_CARD_RE.test(sent)) return "物件カード";
  if (MEETING_BODY_RE.test(sent)) return "内覧の待ち合わせ";
  if (RECOMMEND_BODY_RE.test(sent) && RENT_AMOUNT_RE.test(sent)) return "物件オススメ";
  if (VIEWING_SLOTS_RE.test(sent)) return "内覧の候補日時";
  return null;
}

export type ExampleRowLike = {
  sent_reply: string | null;
  customer_message?: string | null;
  entry_source?: string | null;
  conversation_id?: string | null;
  is_starred?: boolean | null;
  was_ai_used?: boolean | null;
  was_ai_modified?: boolean | null;
};
export type ExampleCtx = { isTestConv?: boolean; isPostApply?: boolean; isDup?: boolean };
/** 会話の id が無い古い行（6〜7月）のテスト送信: 竹内さんのテスト用の名前「YUMA」が本文にある */
export const TEST_NAME_RE = /YUMA/;
/**
 * 申込以降の中身の語。申込以降の期間（deal_outcomes.applied_at〜ended_at）の行でも、内覧当日の挨拶・物件の確認など申込前と同じ形の文が半分ほどある
 * （2026-10-08 監査: 期間だけで印を付けた 478行を読むと「本日16時お部屋ご案内」等が混ざっていた）→ 期間＋この語の両方で印を付ける
 *   2026-10-09 入口の監査で「審査期間3日間程となります」「緊急連絡先様でもお申込み自体可能です」のような**審査・手続きの説明**
 *   （申込前のお客様にも返信で答える番・feedback_procedure_question_reply）まで外れていた → 申込の手続き・状況の連絡だけに絞った
 *   （申込完了・番手・審査の進捗/結果/否決・緊急連絡先の情報の受け取り・契約書類・重説・鍵）。
 *   「お気に召されましたらお申込みさせていただきます」（申込の誘い）・「フォーマットご入力」（お部屋探しの条件の書式）・「審査通過の可能性」（保証会社の説明）は当てない（10/09 監査 8cc1845c・1c44a633・c9da048c）
 */
export const POST_APPLY_TEXT_RE = /お?申込(?:み)?(?:完了|頂き(?:まし|あり)|いただき(?:まし|あり)|情報|内容)|[0-9０-９一二三]番手|審査(?:の)?(?:進捗|結果|否決|継続|催促)|審査通過(?:と|致し|いたし|しました)|否決となり|緊急連絡先(?:様)?(?:の)?(?:ご情報|情報|お名前|フリガナ)|契約書(?:類)?(?:を|も)?(?:ご郵送|郵送|お送り|届)|重要事項説明|重説|鍵(?:の)?(?:お渡し|受け?取り)|本人確認書類お送り/;

/**
 * 手本 1行のゴミの型（文の中身＋会話の事情）。返信の手本（line_reply）だけ AIX の番の判定をする
 * （AIX の手本は AIX の文そのものなので aix_turn は当てない）。
 */
export function exampleGarbageTypes(row: ExampleRowLike, ctx: ExampleCtx = {}): GarbageType[] {
  const out: GarbageType[] = [];
  const sent = String(row.sent_reply ?? "");
  const cm = String(row.customer_message ?? "");
  if (!sent.trim()) { out.push("empty"); return out; }
  if (coreLength(sent) <= 5 && !/[ぁ-んァ-ン一-龥]{2}/.test(sent)) out.push("tiny");
  if (sent.length > 1500) out.push("long");
  if (MOJIBAKE_RE.test(sent) || MOJIBAKE_RE.test(cm)) out.push("mojibake");
  if (!isUsableExampleText(sent)) out.push("unusable");
  if (!isCustomerFacingExample(sent)) out.push("to_management");
  if (examplePiiReason(sent) || examplePiiReason(cm)) out.push("pii");
  if (ctx.isTestConv || (!row.conversation_id && (TEST_NAME_RE.test(sent) || TEST_NAME_RE.test(cm)))) out.push("test_conv");
  if (ctx.isPostApply && POST_APPLY_TEXT_RE.test(sent)) out.push("post_apply");
  const isReply = (row.entry_source ?? "line_reply") === "line_reply";
  if (isReply && aixTurnReason(sent)) out.push("aix_turn");
  // お待たせ: 返信では使わない。AIX は前の文から3時間以上空いた時だけ可（feedback_no_omatase）＝AIX の手本・テンプレートには印を付けない
  if (isReply && WAITED_RE.test(sent)) out.push("omatase");
  if (fixSecondPersonOkyaku(sent).changes.length > 0) out.push("okyaku");
  if (new RegExp(NIGHT_GREETING_RE.source, NIGHT_GREETING_RE.flags.replace("g", "")).test(sent)) out.push("night");
  if (enforceEmojiAllowlist(sent).changes.length > 0) out.push("emoji");
  if (writerFromText(sent).writer === "employee") out.push("writer_b");
  if (row.is_starred && row.was_ai_used === true && row.was_ai_modified === false) out.push("auto_star");
  if (ctx.isDup) out.push("dup");
  return out;
}

/** 今の質を下げうる hard の型（読む側・注入の直前で消える物を除く） */
export function residualHard(types: ReadonlyArray<GarbageType>): GarbageType[] {
  return types.filter((t) => HARD_TYPES.has(t) && !NEUTRALIZED_TYPES.has(t));
}

// ─── ナレッジ（ai_reply_knowledge）────────────────────────────────

/** 禁止の言い回しを「使え」と読める形で含むか（「使わない／禁止／NG」の説明文は当てない） */
const NEGATION_NEAR_RE = /使わない|使用しない|禁止|NG|書かない|避け|入れない|×|✕|しない(?:こと)?|不要|NGワード/;
function mentionsAsPositive(content: string, re: RegExp): boolean {
  const lines = content.split(/\n|。/);
  return lines.some((l) => re.test(l) && !NEGATION_NEAR_RE.test(l));
}

export type KnowledgeRowLike = {
  title?: string | null;
  content?: string | null;
  category?: string | null;
  importance?: number | null;
  hypothesis_status?: string | null;
  correct_count?: number | null;
  wrong_count?: number | null;
};
export type KnowledgeGarbageType =
  | "empty" | "tiny" | "long" | "mojibake" | "pii"
  | "omatase_pos" | "okyaku_pos" | "night_pos"   // 禁止の言い回しを手本として含む（phrase・pattern）
  | "writer_b"                                     // phrase が従業員の書き方
  | "wrong_more"                                   // 答え合わせで外れの方が多い（2回以上）
  | "src_bad"                                      // 元の手本が今は外した手本（rejected/pii_excluded）・テスト会話・申込以降
  | "dup";

export function knowledgeGarbageTypes(row: KnowledgeRowLike, ctx: { srcBad?: boolean; isDup?: boolean } = {}): KnowledgeGarbageType[] {
  const out: KnowledgeGarbageType[] = [];
  const c = String(row.content ?? "");
  if (!c.trim()) { out.push("empty"); return out; }
  if (coreLength(c) < 8) out.push("tiny");
  if (c.length > 1500) out.push("long");
  if (MOJIBAKE_RE.test(c) || MOJIBAKE_RE.test(row.title ?? "")) out.push("mojibake");
  if (examplePiiReason(c)) out.push("pii");
  // 言い回しとして写される部分だけを見る: phrase は本文全体・pattern は「」の中
  //   （「お客様のペースを尊重」のような説明の語は当てない＝初回の監査で okyaku_pos 14行が全部この形だった）
  //   pattern は「」の中に当たった文（。・改行で区切る）だけを残し、その文に「使わない／禁止」等があれば当てない
  const quotedHit = (re: RegExp) => c.split(/\n|。/).some((sent) => (sent.match(/「[^」]{1,200}」/g) ?? []).some((q) => re.test(q)) && !NEGATION_NEAR_RE.test(sent));
  const sayHit = (re: RegExp) => row.category === "phrase" ? mentionsAsPositive(c, re) : row.category === "pattern" ? quotedHit(re) : false;
  if (sayHit(WAITED_RE)) out.push("omatase_pos");
  if (row.category === "phrase" ? fixSecondPersonOkyaku(c).changes.length > 0 : row.category === "pattern" && quotedHit(/お客様/) && (c.match(/「[^」]{1,200}」/g) ?? []).some((q) => fixSecondPersonOkyaku(q.slice(1, -1)).changes.length > 0)) out.push("okyaku_pos");
  if (sayHit(/夜分遅く/)) out.push("night_pos");
  if (row.category === "phrase" && writerFromText(c).writer === "employee") out.push("writer_b");
  if ((row.wrong_count ?? 0) >= 2 && (row.wrong_count ?? 0) > (row.correct_count ?? 0)) out.push("wrong_more");
  if (ctx.srcBad) out.push("src_bad");
  if (ctx.isDup) out.push("dup");
  return out;
}

export const KNOWLEDGE_HARD: ReadonlySet<KnowledgeGarbageType> = new Set<KnowledgeGarbageType>([
  "empty", "mojibake", "pii", "omatase_pos", "okyaku_pos", "night_pos", "wrong_more", "src_bad", "dup",
]);

// ── 2026-10-08 返信の経路の注入の直前の掃除（RAG の調査の結果を generate-reply に当てる・戻す RAG_REPLY_CLEAN=off）──
export function ragReplyCleanEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.RAG_REPLY_CLEAN ?? "").toLowerCase() !== "off";
}
/** 上位 N 件を取る前に、同じ文（dupKey が同じ sent_reply）の2件目以降を落とす（並びは保つ） */
export function dedupeExamplesBySent<T extends { sent_reply?: string | null }>(rows: ReadonlyArray<T>, enabled = ragReplyCleanEnabled()): T[] {
  if (!enabled) return [...rows];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = dupKey(r.sent_reply ?? "");
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(r);
  }
  return out;
}
/** 返信の経路のナレッジ: 「お待たせ」「夜分遅く」を言い回しとして含む phrase・pattern は渡さない */
export function isReplyUnsafeKnowledge(row: KnowledgeRowLike, enabled = ragReplyCleanEnabled()): boolean {
  if (!enabled) return false;
  return knowledgeGarbageTypes(row).some((t) => t === "omatase_pos" || t === "night_pos");
}

// ─── 入口の歯止め（2026-10-09 竹内さん承認「RAG の案は全部おすすめで承認」）──────────────────
// 返信の手本（line_reply）を保存する時、AIX の番の文（物件カード・見積書の本体・待ち合わせ・内覧の候補日時）と
// 申込以降の中身（申込以降の期間＋申込完了・審査・緊急連絡先・契約 等の語）は entry_source='rag_excluded' で保存する
// （行は残す＝件数・監査には出る。match_reply_examples / match_aix_reply_examples・フォールバックの直読みは line_reply / aix_* だけを見るので検索に入らない）。
//   AIX の番の文はスタッフだけが知る情報（日程・金額・物件）＝返信の手本にすると返信が作り話の日程・金額を書く（82e2d5cf 9/11「9/12(土)12:00〜14:00の枠」）。
//   監査 scripts/audit-rag-intake-guard.ts（過去の手本に当てて、外れる行を全部目で読む）。戻す: RAG_INTAKE_GUARD=off
export const RAG_EXCLUDED_ENTRY_SOURCE = "rag_excluded";

export function ragIntakeGuardEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.RAG_INTAKE_GUARD ?? "").toLowerCase() !== "off";
}

/** 申込以降の期間か（deal_outcomes の applied_at〜ended_at のどれかに入るか）。純関数 */
export function inApplyWindow(windows: ReadonlyArray<{ applied_at: string | null; ended_at: string | null }>, atIso: string): boolean {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return false;
  return windows.some((w) => {
    if (!w.applied_at) return false;
    const a = Date.parse(w.applied_at), e = w.ended_at ? Date.parse(w.ended_at) : Infinity;
    return Number.isFinite(a) && t >= a && t <= e;
  });
}

/**
 * 返信の手本を検索から外して保存する理由（無ければ null）。line_reply だけが対象（AIX の手本は AIX の文そのもの）。
 *   aix_turn:<物件カード|見積書の本体|内覧の待ち合わせ|内覧の候補日時> ／ post_apply
 */
export function ragIntakeExcludeReason(input: { entrySource: string | null | undefined; sentReply: string | null | undefined; inPostApplyWindow: boolean }, env?: Record<string, string | undefined>): string | null {
  if (!ragIntakeGuardEnabled(env)) return null;
  if ((input.entrySource ?? "line_reply") !== "line_reply") return null;
  const s = String(input.sentReply ?? "");
  if (!s.trim()) return null;
  const a = aixTurnReason(s);
  if (a) return `aix_turn:${a}`;
  if (input.inPostApplyWindow && POST_APPLY_TEXT_RE.test(s)) return "post_apply";
  return null;
}
