// app/lib/compose-phrase-catalog.ts — 竹内さんの言い方の骨と割合の表（場面×役目・COMPOSE_PHRASE_CATALOG・既定 off・純関数）
//   作業員10・2026-11-13（弱い所の台帳 writer:no-phrase-catalog【土台】・KB 41dadfe6 基準は竹内さんの番だけ・d16cfe1b 土台→細分化）
//
// ■ 作業員23 の文型カタログ（sentence-pattern-catalog・SENTENCE_PATTERN_CATALOG）と重ねない。足りない所だけ足す:
//   あちらは1文の骨の完全一致で数える（受け14・締め14・継続の約束8・信頼4・潜在2・押さえ方0 の組・載らない割合が平均4割）。
//   ここは ① 信頼の作り方を、竹内さんの文そのものから決まった語で読み、場面×主の役目で割合にする（ラベルでなく文から）
//          ② 役目ごとの「文の終わりの言い方（述べ方の芯）」を場面×役目で束ねて割合にする（骨の完全一致より粗い＝束ねると一番の芯が 57%）
// ■ 数え（費用0・竹内さんの 198番 exam-cache/anatomy-roles/roles-r1.json・名乗りが「鈴木」の文は確かめるまで入れない）
//   信頼（①）を正解53番（信頼がある47番）に当てると 27/47（今の設計図の場面×誘導先の表 20/47・いつも「事実＋手間」22/47）。見ていない9番は 8/9（いつも「事実＋手間」でも 9/9＝この9番では差が見えない）
//   押さえ方は同じやり方で 17/53（いつも「結論から＋言葉を拾う」26/53）＝文から決まった語で読むと弱い→表に入れない（押さえ方は作業員23 の型づくりと判断の側で）
// ■ 表のデータは compose-phrase-catalog-data.ts（scripts/build-phrase-catalog.ts が作る・本文なし・割合と札だけ）

import { PHRASE_TRUST_TABLE, PHRASE_ENDING_TABLE, PHRASE_CATALOG_BUILT } from "./compose-phrase-catalog-data";
import { ROLE_LABEL, type SentenceRole } from "./takeuchi-anatomy-roles";
import type { TrustMethod } from "./takeuchi-seven-read";

type Env = Record<string, string | undefined>;
export function composePhraseCatalogOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_PHRASE_CATALOG ?? "").trim().toLowerCase() === "on";
}

/** 竹内さんの文から信頼の作り方を決まった語で読む（1通の全部の文から） */
export const TRUST_TEXT_RE: ReadonlyArray<[TrustMethod, RegExp]> = [
  ["effort", /確認させて|お調べ|管理会社|交渉|お探しさせて|撮影|作成し/],
  ["support", /全力|ご満足|サポート/],
  ["deadline", /明日|本日中|次第|一番で/],
  ["flexible", /いつでも|ご都合|お気軽|ごゆっくり/],
  ["options", /も探させて|別の|代わり|併せて|も含めて/],
  ["honest_weak", /ですが|オーバー|難しい|ございませんでした/],
  ["fact", /となります|御座います|ございます|可能です/],
];
export function trustOfText(text: string): TrustMethod[] {
  return TRUST_TEXT_RE.filter(([, re]) => re.test(String(text ?? ""))).map(([k]) => k);
}
export const TRUST_JA: Partial<Record<TrustMethod, string>> = {
  effort: "こちらの手間を見せる（管理会社に確認・お調べ）", support: "サポートの姿勢", deadline: "期日を示す", flexible: "都合に合わせる",
  options: "選択肢を残す", honest_weak: "弱点を正直に", fact: "事実の裏付け（となります）",
};

/** 文の終わりの言い方（述べ方の芯）。値・名前は先に伏せてある前提でなくても、文の終わりだけを見る */
const EMO = /[\u{1F300}-\u{1FAFF}☀-➿]/gu;
const ENDINGS = /(確認(?:させて頂き|し)?(?:ます|次第[^。]*)|ピックアップ[^。]{0,8}お送りさせて頂きます|お送りさせて頂きます|サポートさせて頂きます|ご案内させて頂きます|抑えさせて頂きます|ご連絡させて頂きます|お申し付けください|よろしくお願い致します|ありがとうございます|かしこまりました|となります|(?:可能|大丈夫)です|御座います|ございます|お待ちしております|ご査収ください|如何でしょうか|幸いです|させて頂きます)$/;
export function endingOf(text: string): string | null {
  const t = String(text ?? "").normalize("NFKC").replace(EMO, "").replace(/[!！?？。、,\s]+$/g, "").replace(/いただ/g, "頂").replace(/下さい/g, "ください").replace(/でき/g, "出来");
  const tail = t.split(/[、,]/).pop() ?? t;
  const m = tail.match(ENDINGS);
  return m ? m[1] : null;
}

export type TrustRow = { n: number; shares: Array<[TrustMethod, number]> };
export type EndingRow = { n: number; top: Array<[string, number]> };
const pick = <T>(table: Readonly<Record<string, T & { n: number }>>, scene: string | null, key: string, minN = 3): (T & { n: number; at: string }) | null => {
  const a = scene ? table[`${scene}|${key}`] : undefined;
  if (a && a.n >= minN) return { ...a, at: `${scene}|${key}` };
  const b = table[`*|${key}`];
  return b ? { ...b, at: `*|${key}` } : null;
};
/** 場面×主の役目 → 竹内さんの信頼の作り方（多い順・割合） */
export function trustFor(scene: string | null, mainRole: SentenceRole | null): (TrustRow & { at: string }) | null {
  return mainRole ? pick<TrustRow>(PHRASE_TRUST_TABLE as unknown as Record<string, TrustRow>, scene, mainRole) : null;
}
/** 設計図の信頼の作り方の足し（多い順の2つ・割合 30% 以上だけ） */
export function trustHowFor(scene: string | null, mainRole: SentenceRole | null): TrustMethod[] {
  const r = trustFor(scene, mainRole);
  return r ? r.shares.filter(([, s]) => s >= 0.3).slice(0, 2).map(([k]) => k) : [];
}
/** 場面×役目 → 文の終わりの言い方の上位（割合） */
export function endingsFor(scene: string | null, role: SentenceRole): (EndingRow & { at: string }) | null {
  return pick<EndingRow>(PHRASE_ENDING_TABLE as unknown as Record<string, EndingRow>, scene, role, 4);
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** 書き手への注記（on の時だけ・文は写さない＝札と終わりの言い方と割合だけ） */
export function phraseCatalogNote(o: { scene: string | null; mainRole: SentenceRole | null; roles: ReadonlyArray<SentenceRole> }, env?: Env): string {
  if (!composePhraseCatalogOn(env)) return "";
  const L: string[] = [];
  const t = trustFor(o.scene, o.mainRole);
  if (t && t.shares.length) L.push(`- 信頼の作り方（竹内さんの同じ場面×主の役目 ${t.n}番）: ${t.shares.slice(0, 3).map(([k, s]) => `${TRUST_JA[k] ?? k} ${pct(s)}`).join("・")}`);
  const ends = [...new Set(o.roles)].filter((r) => r !== "greet").map((r) => { const e = endingsFor(o.scene, r); return e && e.top.length ? `${(ROLE_LABEL[r] ?? r).replace(/（.*$/, "")}＝${e.top.slice(0, 2).map(([f, s]) => `「${f}」${pct(s)}`).join("／")}` : null; }).filter(Boolean);
  if (ends.length) L.push(`- 文の終わりの言い方（竹内さんの場面×役目の割合・言い回しは毎回同じにしない）: ${ends.join("・")}`);
  return L.join("\n");
}
export const PHRASE_CATALOG_VERSION = `phrase-catalog@${PHRASE_CATALOG_BUILT}`;

// ─── 形の欄（COMPOSE_FORM_SLOTS・既定 off・弱い所の台帳 writer:no-form-slots【細分化】） ─────────────
//   長さ＝竹内さんの場面×主の役目ごとの文の数（中央値と真ん中の半分）・絵文字＝場面ごとの1通の数と種類（😊 😌 🌟 ✨ だけ・feedback_emoji_allowlist）・
//   期日の言葉＝材料（事実・資料・お客様の今の文・こちらの直近の送信）にある物だけ（無ければ期日を書かない＝下書きから消した型 deadline_promise と同じ線）。
//   締めの種類は COMPOSE_CLOSING_TABLE（compose-value-slots）の行が持つ（ここでは重ねない）
import { PHRASE_LENGTH_TABLE, PHRASE_EMOJI_TABLE } from "./compose-phrase-catalog-data";
export function composeFormSlotsOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_FORM_SLOTS ?? "").trim().toLowerCase() === "on";
}
const EMOJI_OK = ["😊", "😌", "🌟", "✨"];
export function lengthFor(scene: string | null, mainRole: SentenceRole | null): { n: number; median: number; p25: number; p75: number; at: string } | null {
  if (!mainRole) return null;
  const a = scene ? PHRASE_LENGTH_TABLE[`${scene}|${mainRole}`] : undefined;
  if (a && a.n >= 3) return { ...a, at: `${scene}|${mainRole}` };
  const b = PHRASE_LENGTH_TABLE[`*|${mainRole}`];
  return b ? { ...b, at: `*|${mainRole}` } : null;
}
export function emojiFor(scene: string | null): { n: number; median: number; p75: number; kinds: string[] } | null {
  const e = (scene && PHRASE_EMOJI_TABLE[scene]?.n >= 5 ? PHRASE_EMOJI_TABLE[scene] : PHRASE_EMOJI_TABLE["*"]) ?? null;
  return e ? { n: e.n, median: e.median, p75: e.p75, kinds: e.kinds.map(([k]) => k).filter((k) => EMOJI_OK.includes(k)) } : null;
}
export function formSlotsNote(o: { scene: string | null; mainRole: SentenceRole | null; dates: ReadonlyArray<string> }, env?: Env): string {
  if (!composeFormSlotsOn(env)) return "";
  const L = lengthFor(o.scene, o.mainRole), E = emojiFor(o.scene);
  const parts = [
    L ? `長さ ${L.p25 === L.p75 ? `${L.median}文` : `${L.p25}〜${L.p75}文`}（竹内さんの同じ場面×主の役目 ${L.n}番の真ん中）` : null,
    E ? `絵文字は ${E.p75 > 0 ? `${E.p75}つまで` : "無し"}（${E.kinds.join("・") || "😊・😌"} だけ）` : null,
    o.dates.length ? `期日・日付の言葉は材料にある物だけ（${o.dates.slice(0, 4).join("・")}）` : "期日の言葉（明日中・本日中 等）は書かない（材料に無い）",
  ].filter(Boolean);
  return parts.length ? `- 形: ${parts.join("／")}` : "";
}

// ─── 信頼の下の役目（11/13 統括役・細分化）: 竹内さんの文から決まった語で読む。「となります」だけの事実の文は数えない ─────
export const TRUST_SUBS = ["effort", "support", "deadline", "flexible", "options", "honest_weak", "scarcity", "company_detail"] as const;
export type TrustSub = typeof TRUST_SUBS[number];
export const TRUST_SUB_JA: Record<TrustSub, string> = {
  effort: "こちらの手間", support: "サポートの姿勢", deadline: "期日", flexible: "都合に合わせる", options: "選択肢",
  honest_weak: "正直な弱点", scarcity: "少なさ", company_detail: "会社の具体",
};
export const SCARCITY_TEXT_RE = /1部屋のみ|一部屋のみ|こちらの1部屋|1部屋となります|残り1|このお部屋のみ|のみとなります|2番手/;
export const COMPANY_TEXT_RE = /独立系|保証会社|仲介手数料|弊社|審査(?:通過|基準)|クレジットカード/;
export function trustSubsOfText(text: string): TrustSub[] {
  const t = String(text ?? "");
  const out = trustOfText(t).filter((k): k is TrustSub => k !== "fact" && (TRUST_SUBS as readonly string[]).includes(k));
  if (SCARCITY_TEXT_RE.test(t)) out.push("scarcity");
  if (COMPANY_TEXT_RE.test(t)) out.push("company_detail");
  return [...new Set(out)];
}
