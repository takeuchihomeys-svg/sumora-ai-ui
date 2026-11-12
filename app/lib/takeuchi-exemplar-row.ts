// app/lib/takeuchi-exemplar-row.ts — 竹内さんの手本の束（exemplar-bank.json）の1通 ⇄ 表 takeuchi_exemplars の1行（純関数）
//
// 2026-11-12 作業員23（竹内さん 11/12「今の設計からブレインと文の生成で足りていない部分を強化していく」）。
//   作業員5 の takeuchi-exemplar（pickExemplar）・作業員10 の exemplarNoteFor は、本番に手本を置く表が無く on にしても注記が出なかった。
//   表に入れる形を決める（scripts/takeuchi-exemplars-load.ts が使う）:
//   ① 文の本文（sentences[].text）とお客様の発言（customer）・潜在のきっかけ（発言の引用）は入れない＝役目・なぜ・ブレインの欄と事実の種類だけ（注記も文は写させない）
//   ② 残す言葉（why・fact・latent_four）は名前・連絡先・住所などの値を伏せる（maskPII・maskPersonalValues＋英字の名前の敬称）。
//      「」『』の中の引用は「…」に、文・発言を14字以上そのまま写した所も「…」に
//   ②’ 物件名（部屋番号の無い物も）は「（物件）」に（11/12 統括役の判断: 他のお客様の手本の物件名が書き手に混ざって文に出る事故を防ぐ）。
//      一覧は解剖の潜在の4つの part.property と竹内さんの文の「〇〇 703号室」から（propertyNameVariants で言い方を広げる）。
//      部屋番号の付いた物件名は一覧が無くても PROPERTY_WITH_ROOM で伏せる。fact の条件の値（駐車場込み12万以内 等）は残す
//   ③ 申込の門（turn-application-gate）で外れる番は入れない（理由を返す・門を引けない番も入れない＝迷えば外す）
// テスト: app/lib/__tests__/takeuchi-exemplar-row.test.ts
import { maskPII, maskBareRoomNo } from "./pii-mask";
import { maskPersonalValues } from "./example-pii-guard";
import { brainFieldOf, LATENT_KEYS, type Exemplar, type ExemplarSentence, type LatentKey, type BrainField } from "./takeuchi-exemplar";
import { LEAD_TO, type LeadTo, type SentenceRole } from "./takeuchi-anatomy-roles";

/** 束の1通（scripts/anatomy-exemplar-bank.ts が作る形） */
export type BankEntry = Exemplar & { hand?: boolean };
/** 表の1行（文の本文 text は持たない） */
export type ExemplarRow = {
  id: string; scene: string; latent: LatentKey; lead: LeadTo; hand: boolean;
  sentences: Array<{ role: SentenceRole | null; why: string; brainField: BrainField }>;
  latent_four: { trigger: string; part: string; feeling: string; want: string } | null;
  fact: string | null; source_turn: string; updated_at?: string;
};
export type RowOptions = { propertyNames?: ReadonlyArray<string> };

/** 空白を落とした NFKC */
const flat = (t: string | null | undefined) => String(t ?? "").normalize("NFKC").replace(/\s+/g, "");
// 写しを比べる時は空白・句読点・括弧・絵文字を無視する（「カードブラック、アコム借入あり」と「カードブラックアコム借入あり」を同じに）
const LOOSE_DROP = /[\s、。，．,.!！?？・「」『』（）()…~〜\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu;
export const loose = (t: string | null | undefined) => String(t ?? "").normalize("NFKC").replace(LOOSE_DROP, "");
const LATIN_HONORIFIC = /[A-Za-z]{2,}(?:さん|様|さま|ちゃん|くん)/g;
// 部屋番号の付いた物件名（「アーバネックス堺筋本町◯号室」「S-RESIDENCE江坂Eminence◯」）＝お客様が住む先の値 → （物件）
const PROPERTY_WITH_ROOM = /[ァ-ヴーA-Za-zⅠ-Ⅻ-][^、。・「」『』◯（）()]{1,30}◯(?:号室)?/g;
const PROPERTY_MARK = "（物件）";

/** 残す言葉の値を伏せる（名前・連絡先・住所・物件名・発言や文の写し）。quotes＝その番のお客様の発言と竹内さんの文・propertyNames＝propertyNameVariants の結果 */
export function scrubExemplarValue(text: string | null | undefined, quotes: ReadonlyArray<string>, max = 80, propertyNames: ReadonlyArray<string> = []): string {
  let t = flat(text);
  if (!t) return "";
  for (const n of propertyNames) if (n && t.includes(n)) t = t.split(n).join(PROPERTY_MARK);
  const src = quotes.map(loose).filter(Boolean);
  // 「」『』の中身は発言・文の引用＝4字以上なら伏せる（束のお客様の発言は先頭200字だけで写しか確かめられない番がある＝迷えば伏せる。
  //   実物: 「お客様自身が書いた『カードブラック…借入あり』」が束の発言の切れた後ろにあった）
  t = t.replace(/([「『])([^」』]{1,200})([」』])/g, (m, a: string, body: string, b: string) => (loose(body).length >= 4 ? `${a}…${b}` : m));
  // 括弧の無い写しも14字以上続けば「…」に（実物の束 181通の監査で2通: 潜在の部分に物件名＋部屋番号。10字では「何卒よろしくお願い致しますで締める」の型の言葉まで消えた）
  t = cutVerbatim(t, src, 14);
  t = maskBareRoomNo(maskPersonalValues(maskPII(t)).replace(LATIN_HONORIFIC, "お客様")).replace(/[0-9]{2,4}号室/g, "◯号室").replace(PROPERTY_WITH_ROOM, PROPERTY_MARK);
  // 伏せた結果、残りがほとんど無い（4字未満）なら空（「審査」のような元から短い言葉は残す）
  if ((/[…◯]/.test(t) || t.includes(PROPERTY_MARK)) && loose(t.split(PROPERTY_MARK).join("")).replace(/[…◯〇]/g, "").length < 4) return "";
  return t.length > max ? t.slice(0, max) : t;
}

/** 物件名の言い方の候補（全部・部屋番号や階を外した物・空白の前の頭の語）。空白を落とした NFKC・長い順。
 *  「物件」「URL」の入った物・数字で始まる物・3字未満は入れない（「物件No.107」「1104号室」「gm」で普通の言葉を消さない） */
export function propertyNameVariants(names: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  const add = (x: string) => { const k = flat(x); if (k.length >= 3 && !/物件|URL|^[0-9]/i.test(k)) out.add(k); };
  for (const raw of names) {
    const n = String(raw ?? "").normalize("NFKC").trim();
    if (!n) continue;
    add(n);
    add(n.replace(/\s*[0-9]+\s*(?:号室|階).*$/, "").replace(/\s+[0-9]+$/, "").replace(/(?<=[A-Za-z])[0-9]{3,4}$/, ""));
    add(n.split(/\s+/)[0]);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** 文の中から部屋番号・階の前の物件名を拾う（「スプランディッド難波WESTⅢ 703号室」→「スプランディッド難波WESTⅢ」）。手本の束の竹内さんの文から一覧を足す用 */
export function propertyNamesFromText(texts: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  const re = /([ァ-ヴーA-Za-zＡ-Ｚａ-ｚⅠ-Ⅻ][ァ-ヴー一-龯々A-Za-zＡ-Ｚａ-ｚⅠ-Ⅻ・-]{2,30})[ 　]?[0-9０-９]{2,4}(?:号室|階)/g;
  for (const t of texts) for (const m of String(t ?? "").matchAll(re)) out.add(m[1]);
  return [...out];
}

/** t の中で、src（loose 済み）のどれかにそのまま入っている minLen 字以上（句読点を除いて数える）の続きを「…」に（短い文どうしなので素直に探す） */
export function cutVerbatim(t: string, src: ReadonlyArray<string>, minLen: number): string {
  if (!src.length || loose(t).length < minLen) return t;
  let out = "", i = 0;
  while (i < t.length) {
    let best = 0;
    for (let j = i + 1; j <= t.length; j++) {
      const piece = loose(t.slice(i, j));
      if (!piece) continue;
      if (!src.some((s) => s.includes(piece))) break;
      if (piece.length >= minLen) best = j - i;
    }
    if (best) { out += "…"; i += best; } else { out += t[i]; i++; }
  }
  return out;
}

/** 束の1通 → 表の1行。入れない時は { skip: 理由 }。gateReason＝申込の門の理由（null＝申込の手前）・undefined＝門を引けなかった */
export function toExemplarRow(e: BankEntry, gateReason: string | null | undefined, opts: RowOptions = {}): { row: ExemplarRow } | { skip: string } {
  if (gateReason === undefined) return { skip: "申込の門を引けない（通が見つからない）" };
  if (gateReason) return { skip: `申込の門: ${gateReason}` };
  if (!e?.id || !e.scene) return { skip: "id・場面が無い" };
  if (!(LATENT_KEYS as readonly string[]).includes(e.latent)) return { skip: `潜在の型が分からない（${e.latent}）` };
  if (!(LEAD_TO as readonly string[]).includes(e.lead)) return { skip: `誘導先が分からない（${e.lead}）` };
  const sents = Array.isArray(e.sentences) ? e.sentences : [];
  if (!sents.length) return { skip: "文が無い" };
  const pn = opts.propertyNames ?? [];
  const quotes = [e.customer ?? "", ...sents.map((s) => s.text ?? "")];
  const sc = (x: string | null | undefined, max: number) => scrubExemplarValue(x, quotes, max, pn);
  const lf = e.latentFour;
  return {
    row: {
      id: e.id, scene: e.scene, latent: e.latent, lead: e.lead, hand: !!e.hand,
      sentences: sents.map((s) => ({ role: s.role ?? null, why: sc(s.why, 40), brainField: s.brainField ?? brainFieldOf(s.role ?? null) })),
      // きっかけ（trigger）はお客様の発言の引用そのもの＝入れない（形を揃えるため鍵は残して空）
      latent_four: lf ? { trigger: "", part: sc(lf.part, 40), feeling: sc(lf.feeling, 40), want: sc(lf.want, 60) } : null,
      fact: e.fact ? sc(e.fact, 80) || null : null,
      source_turn: e.id,
    },
  };
}

/** 束 → 表の行（入れない番は理由ごとに数える）。gateOf(id) は門の理由（null＝手前・undefined＝引けない） */
export function buildExemplarRows(bank: ReadonlyArray<BankEntry>, gateOf: (id: string) => string | null | undefined, opts: RowOptions = {}): { rows: ExemplarRow[]; skipped: Array<{ id: string; reason: string }> } {
  const rows: ExemplarRow[] = [], skipped: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const e of bank) {
    if (seen.has(e?.id)) { skipped.push({ id: e.id, reason: "同じ id が2つ" }); continue; }
    seen.add(e?.id);
    const r = toExemplarRow(e, gateOf(e?.id), opts);
    if ("row" in r) rows.push(r.row); else skipped.push({ id: String(e?.id ?? ""), reason: r.skip });
  }
  return { rows, skipped };
}

/** 表の行 → pickExemplar に渡す手本（本文・発言は空＝注記は役目・なぜ・事実だけ）。形が崩れた行は null */
export function rowToExemplar(r: unknown): (Exemplar & { hand: boolean }) | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.scene !== "string" || typeof o.latent !== "string" || typeof o.lead !== "string" || !Array.isArray(o.sentences)) return null;
  if (!(LATENT_KEYS as readonly string[]).includes(o.latent) || !(LEAD_TO as readonly string[]).includes(o.lead)) return null;
  const sentences: ExemplarSentence[] = (o.sentences as Array<Record<string, unknown>>).filter((s) => s && typeof s === "object").map((s) => {
    const role = (typeof s.role === "string" ? s.role : null) as SentenceRole | null;
    return { text: "", role, why: typeof s.why === "string" ? s.why : "", brainField: (typeof s.brainField === "string" ? s.brainField : brainFieldOf(role)) as BrainField };
  });
  if (!sentences.length) return null;
  const lf = o.latent_four && typeof o.latent_four === "object" ? o.latent_four as Record<string, unknown> : null;
  return {
    id: o.id, scene: o.scene, latent: o.latent as LatentKey, lead: o.lead as LeadTo, hand: o.hand === true, customer: "", sentences,
    latentFour: lf && typeof lf.want === "string" && typeof lf.feeling === "string" ? { trigger: String(lf.trigger ?? ""), part: String(lf.part ?? ""), feeling: lf.feeling, want: lf.want } : null,
    fact: typeof o.fact === "string" ? o.fact : null,
  };
}
