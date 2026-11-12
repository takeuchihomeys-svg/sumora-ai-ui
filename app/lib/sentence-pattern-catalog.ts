// app/lib/sentence-pattern-catalog.ts — 竹内さんの実送信の「文型カタログ」（役目×場面×状況ごとの骨＋差し込み欄＋多数派と2番手の割合）（純関数・既定 off）
//
// 2026-11-12 作業員23（竹内さん 11/12「具体的にできていない部分を強化する」・作業員24 の洗い出しの根B）。
//   文の要素（受け・潜在の一文・押さえ方・信頼の作り方・締め・AIX 1通目の前後）は、竹内さんの言い方の型を書き手に見せないと上がらない。
//   手本（takeuchi-exemplar）は1通の組み立て（役目の並び）を渡す。ここは1文ごとの「言い方の型（骨）」を渡す。
//   ① 骨＝竹内さんの1文の値（名前・物件名・号室・金額・日付・時刻・広さ・駅・区・数）を差し込み欄 {…} に置き換えた物（skeletonize・決まった計算）
//   ② 組＝役目×場面×状況。状況は 受け＝開口語の3分岐（動く／答えるだけ／頂いた）・潜在の一文＝潜在の型（9種）・押さえ方／信頼／締め＝誘導先・
//      AIX＝ボタン（1通目の頭と終わりの一文・2通目は場面）。場面ごとに少ない時のために場面 "*" の組も作る
//   ③ 2通以上で同じ骨だけ載せる（1通だけの言い方は載せない＝その人の文を写さない・型だけ）。多数派・2番手の割合と、載らなかった割合（other）を持つ
//   ④ 伏せ方は手本の表（takeuchi-exemplar-row）と同じ: 名前はお客様・物件名は（物件）→ ここでは差し込み欄 {名前}・{物件名}。maskPII も通す
//   ⑤ 潜在の一文は「事実が無い型は言わない」: 型ごとに竹内さんが潜在の一文（worry）を書いた割合と、先回りの事実がある割合を数え、say（言う）を決める
//   書き手への注記は SENTENCE_PATTERN_CATALOG=on の時だけ（既定 off）。例文は渡さない＝骨と割合だけ
// テスト: app/lib/__tests__/sentence-pattern-catalog.test.ts
import { maskPII } from "./pii-mask";
import { latentKeyOf, leadKeyOf, LATENT_KEYS, type LatentKey } from "./takeuchi-exemplar";
import { splitSentences, type LeadTo, type SentenceRole } from "./takeuchi-anatomy-roles";
import { keepPromiseOf, KEEP_PROMISE_JA, REASON_JA, type KeepPromiseKind, type ReasonKind } from "./turn-anatomy-fields";

/** 潜在の型の9種（LATENT_KEYS から 読めない none と 1通しか無い trust_other を除く） */
export const LATENT_NINE = LATENT_KEYS.filter((k) => k !== "none" && k !== "trust_other") as Exclude<LatentKey, "none" | "trust_other">[];
/** 受けの開口語の3分岐（動く→かしこまりました／答えるだけ→はい／頂いた→〇〇頂きありがとうございます） */
export type OpenerBranch = "act" | "answer" | "received";
export const OPENER_EXPECTED: Record<OpenerBranch, OpenerWord> = { act: "kashikomari", answer: "hai", received: "arigato" };
export type OpenerWord = "kashikomari" | "hai" | "arigato" | "daijobu" | "none" | "other";
export const OPENER_WORD_JA: Record<OpenerWord, string> = { kashikomari: "かしこまりました", hai: "はい", arigato: "〇〇頂きありがとうございます", daijobu: "大丈夫です", none: "受けなし", other: "その他" };
export type CatalogKind = "uke" | "worry" | "trust" | "barrier" | "apply" | "viewing" | "keep" | "close" | "aix_head" | "aix_tail" | "aix2_head" | "aix2_tail" | "keep_promise";
export const KIND_JA: Record<CatalogKind, string> = {
  uke: "受け", worry: "潜在の一文", trust: "信頼の作り方", barrier: "障壁を下げる", apply: "押さえ方（申込へ）", viewing: "内覧へ", keep: "新着・つなぐ", close: "締め",
  aix_head: "AIX 1通目の頭の一文", aix_tail: "AIX 1通目の終わりの一文", aix2_head: "AIX 2通目の頭の一文", aix2_tail: "AIX 2通目の終わりの一文", keep_promise: "継続の約束（種類ごと）",
};

// ── ① 骨 ──
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
type SlotRule = [slot: string, re: RegExp];
const SLOT_RULES: SlotRule[] = [
  ["{金額}", /[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:万円|万|円)/g],
  ["{日付}", /[0-9]{1,2}月[0-9]{1,2}日(?:\([日月火水木金土]\))?|[0-9]{1,2}月(?:中旬|上旬|下旬|中|末|頃)?|[0-9]{1,2}日(?:\([日月火水木金土]\))?/g],
  ["{時刻}", /[0-9]{1,2}時(?:[0-9]{1,2}分|半)?|[0-9]{1,2}:[0-9]{2}/g],
  ["{広さ}", /[0-9]+(?:\.[0-9]+)?\s*(?:帖|畳|㎡|m2)/g],
  ["{間取り}", /[1-9](?:SLDK|LDK|SDK|DK|K|R)/g],
  ["{徒歩}", /徒歩\s*[0-9]+\s*分/g],
  ["{階}", /[0-9]+\s*階/g],
  ["{号室}", /[0-9]{2,4}\s*号室/g],
  ["{築年}", /築\s*[0-9]+\s*年|[0-9]{4}年(?:[0-9]{1,2}月)?築?/g],
];
// 物件名: 号室・部屋番号・{号室} の前の、カタカナ・英字で始まる続き（「プレジオ神戸WEST 203号室」）
const PROPERTY_BEFORE_ROOM = /[ァ-ヴーA-Za-zⅠ-Ⅻ][ァ-ヴー一-龯々A-Za-zⅠ-Ⅻ・\-]{1,30}\s?(?=\{号室\}|[0-9]{3,4}(?![0-9,万円帖㎡階分年]))/g;
const STATION = /「[^」]{1,12}」(?:駅)?/g;
const WARD = /[一-龯]{1,3}区/g;
const NAME_HONORIFIC = /(?:YUMA|お客様|[A-Za-z]{2,}|[ァ-ヴー]{2,8}|[一-龯]{1,4})(?=さん|様)/g;

/** 1文 → 骨（値を差し込み欄に）。propertyNames＝伏せる物件名の言い方（takeuchi-exemplar-row の propertyNameVariants・空白なし NFKC） */
export function skeletonize(text: string, propertyNames: ReadonlyArray<string> = []): { skeleton: string; slots: string[] } {
  let t = String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!t) return { skeleton: "", slots: [] };
  const flatT = t.replace(/\s+/g, "");
  if (propertyNames.some((n) => n && flatT.includes(n))) {
    t = flatT;
    for (const n of propertyNames) if (n && t.includes(n)) t = t.split(n).join("{物件名}");
  }
  // maskPII は「田中さん」を「お客様」に伏せる＝竹内さんの文では相手の名前の所（竹内さんは「お客様」と書かない）→ {名前}さん
  t = maskPII(t, undefined, { keepDates: true }).replace(/お客様(?:さん|様)?/g, "{名前}さん");
  t = t.replace(NAME_HONORIFIC, (m) => (/^(?:皆|奥|神|様)/.test(m) ? m : "{名前}"));
  t = t.replace(STATION, "{駅}").replace(/[一-龯ァ-ヴーA-Za-z]{1,6}と申します/g, "{担当者名}と申します").replace(/(?<![0-9])[0-9]{1,2}\/[0-9]{1,2}(?![0-9])/g, "{日付}");
  for (const [slot, re] of SLOT_RULES) t = t.replace(re, slot);
  t = t.replace(PROPERTY_BEFORE_ROOM, "{物件名}").replace(/\{物件名\}\s?[0-9]{3,4}(?![0-9])/g, "{物件名}{号室}");
  t = t.replace(WARD, "{区}").replace(/(?<![{A-Za-z])[0-9]+(?:\.[0-9]+)?(?![}])/g, "{数}");
  t = slotAreaConditions(t);
  t = t.replace(/(\{[^}]+\})(?:[・、,]?\1)+/g, "$1").replace(/\s+/g, " ").trim();
  const slots = [...new Set(t.match(/\{[^}]+\}/g) ?? [])];
  return { skeleton: t, slots };
}
/** 探す範囲と条件の並び（「西区周辺全域から家賃{金額}・{間取り}で{名前}さんに…」）を {エリア}・{条件} に。
 *  実物（181通の継続の約束 50通）: 竹内さんの「ピックアップしてお送り」の文はお客様ごとの範囲と条件の並びを持ち、骨が散っていた（96%が1通だけ） */
export function slotAreaConditions(t: string): string {
  let s = t.replace(/^(?!\{名前\})[^。!！]{0,100}?(?:周辺|圏内)?全域から、?/, "{エリア}から").replace(/^[^。!！{、]{1,40}?エリアで/, "{エリア}で");
  s = s.replace(/(\{エリア\}(?:から|で))([^。!！]{2,200}?)(?=で\{名前\}さん|で(?:オススメ)|のお部屋|のご条件|お部屋)/, (m, a: string, b: string) => (/・|\{/.test(b) ? `${a}{条件}` : m));
  s = s.replace(/(^|、|引き続き)([^。!！、]{2,80}?)のご条件/g, (m, a: string, b: string) => (/・|\{|無し|有り|可/.test(b) || b.length >= 4 ? `${a}{条件}のご条件` : m));
  return s;
}

/** 骨を比べる鍵（絵文字・終わりの記号・空白を落とす。言い方の違いだけ見る）。
 *  小さな揺れ（読点・を・新たに・全て・でき／出来・頂ける／頂く）は同じ骨に数える（継続の約束の実物で、これだけ違う骨が別々に数えられていた） */
export const skeletonKey = (s: string) => s.replace(EMOJI, "").replace(/[！!。？?…\s]+/g, "").replace(/[、,]/g, "").replace(/新たに|全て|を/g, "").replace(/でき/g, "出来").replace(/頂ける/g, "頂く");

/** 受けの文の開口語 */
export function openerWordOf(ukeText: string | null | undefined): OpenerWord {
  const t = String(ukeText ?? "").normalize("NFKC").replace(EMOJI, "").trim();
  if (!t) return "none";
  if (/^(?:[^。！!]{0,14})かしこまりました|^承知/.test(t)) return "kashikomari";
  if (/^はい/.test(t)) return "hai";
  if (/(?:頂き|いただき|下さり|くださり)?ありがとうございます/.test(t) && t.length <= 40) return "arigato";
  if (/^(?:全然)?大丈夫|^全然です/.test(t)) return "daijobu";
  return "other";
}
/** その番の開口語の分岐（お客様が何かを送った＝頂いた／こちらが動く＝動く／答えるだけ）。竹内さんの文の受け以外の役目と誘導先から決める */
export function openerBranchOf(o: { customer: string | null | undefined; lead: LeadTo | string | null | undefined; roles: ReadonlyArray<SentenceRole | string | null> }): OpenerBranch {
  const c = String(o.customer ?? "");
  if (/\[画像\]|\[ファイル\]|\[動画\]|https?:\/\/|【お部屋お探し中|ご希望のお部屋探しご条件|①【/.test(c)) return "received";
  const acts = new Set(["promise", "keep", "estimate", "viewing", "apply", "ask_send"]);
  if (["keep", "viewing", "estimate", "apply", "ask_send"].includes(String(o.lead ?? "")) || o.roles.some((r) => r && acts.has(r))) return "act";
  return "answer";
}

// ── ② 組と ③ 割合 ──
export type CatalogTurn = { id: string; scene: string; latent: LatentKey; lead: LeadTo; customer: string; sentences: Array<{ text: string; role: SentenceRole | null }>; fact?: string | null };
export type CatalogAix = { id: string; button: string; part: "first" | "second"; text: string };
export type CatalogPattern = { skeleton: string; slots: string[]; n: number; share: number };
export type CatalogGroup = { kind: CatalogKind; scene: string; situation: string; n: number; patterns: CatalogPattern[]; top: number; second: number; other: number };
/** 潜在の一文を言うか。worryRate＝潜在の一文（worry／barrier）を書いた割合・factRate＝それに先回りの事実を添えた割合・few＝通が少なく決められない（言わない側） */
export type LatentSay = { latent: string; n: number; worryRate: number; factRate: number; few: boolean; say: boolean };
export type OpenerStat = { branch: OpenerBranch; n: number; words: Array<{ word: OpenerWord; n: number; share: number }>; expected: OpenerWord; expectedShare: number };
/** 継続の約束の種類ごとの通と、理由の事実の種類の割合（reply-compose-conductor の keepPromise を {種類, 理由の事実} にする骨の元） */
export type KeepPromiseStat = { kind: KeepPromiseKind; n: number; reasons: Array<{ reason: ReasonKind | "none"; n: number; share: number }> };
export type PatternCatalog = { builtAt: string; sources: Record<string, number>; minCount: number; groups: CatalogGroup[]; latentSay: LatentSay[]; opener: OpenerStat[]; keepPromise: KeepPromiseStat[] };

const r2 = (x: number) => Math.round(x * 100) / 100;
/** 役目 → 組の種類（受け・潜在・信頼・障壁・押さえ方・内覧・つなぐ・締め。他の役目は載せない） */
const ROLE_KIND: Partial<Record<SentenceRole, CatalogKind>> = { uke: "uke", worry: "worry", trust: "trust", barrier: "barrier", apply: "apply", viewing: "viewing", keep: "keep", close: "close" };
/** AIX の文で頭・終わりの一文に使う行（箇条書き・オススメポイントの見出し・URL は飛ばす） */
const isBodyLine = (l: string) => !/^[・\-‐（(【①-⑳※]|^https?:|^\s*$|^[^\s:：]{1,8}[:：]|\[回答済み/.test(l.trim());
const isGreeting = (s: string) => /お世話になっております|^この度/.test(s);
const TERMINAL = /[。！!？?）)」』\p{Extended_Pictographic}\u{FE0F}]$/u;
/** AIX の本文 → 文（箇条書き・記入欄・住所の行を除き、途中で折り返した行はつなぐ・挨拶の文は除く） */
export function aixBodySentences(text: string): string[] {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(isBodyLine);
  let joined = "";
  for (const l of lines) joined += joined && !TERMINAL.test(joined) ? l : (joined ? "\n" : "") + l;
  return splitSentences(joined).filter((s) => !isGreeting(s));
}

/** 1つの組の割合（1通の中の同じ骨は1と数える・minCount 通以上の骨だけ載せる） */
function groupOf(kind: CatalogKind, scene: string, situation: string, items: Array<{ id: string; sk: { skeleton: string; slots: string[] } }>, minCount: number): CatalogGroup | null {
  const turns = new Set(items.map((x) => x.id));
  if (!turns.size) return null;
  const by = new Map<string, { skeleton: string; slots: string[]; ids: Set<string> }>();
  for (const x of items) {
    if (!x.sk.skeleton) continue;
    const k = skeletonKey(x.sk.skeleton);
    const g = by.get(k) ?? by.set(k, { skeleton: x.sk.skeleton, slots: x.sk.slots, ids: new Set() }).get(k)!;
    g.ids.add(x.id);
  }
  const n = turns.size;
  const patterns = [...by.values()].map((g) => ({ skeleton: g.skeleton, slots: g.slots, n: g.ids.size, share: r2(g.ids.size / n) }))
    .filter((p) => p.n >= minCount).sort((a, b) => b.n - a.n || a.skeleton.localeCompare(b.skeleton));
  const covered = patterns.reduce((s, p) => s + p.n, 0);
  return { kind, scene, situation, n, patterns, top: patterns[0]?.share ?? 0, second: patterns[1]?.share ?? 0, other: r2(Math.max(0, n - covered) / n) };
}

/** カタログを作る（決まった計算）。turns＝竹内さんの返信（申込の門を通した物）・aix＝AIX の1通目／2通目の本文 */
export function buildPatternCatalog(turns: ReadonlyArray<CatalogTurn>, aix: ReadonlyArray<CatalogAix>, o: { propertyNames?: ReadonlyArray<string>; minCount?: number; now?: string; minLatentN?: number; noSay?: ReadonlyArray<string> } = {}): PatternCatalog {
  const pn = o.propertyNames ?? [];
  const minCount = o.minCount ?? 2;
  type It = { kind: CatalogKind; scene: string; situation: string; id: string; sk: { skeleton: string; slots: string[] } };
  const items: It[] = [];
  const opener = new Map<OpenerBranch, Map<OpenerWord, number>>();
  const latentStat = new Map<string, { n: number; worry: number; fact: number }>();
  const keepStat = new Map<KeepPromiseKind, Map<ReasonKind | "none", number>>();
  for (const t of turns) {
    const roles = t.sentences.map((s) => s.role);
    const branch = openerBranchOf({ customer: t.customer, lead: t.lead, roles });
    const uke = t.sentences.find((s) => s.role === "uke");
    const w = openerWordOf(uke?.text);
    const m = opener.get(branch) ?? opener.set(branch, new Map()).get(branch)!;
    m.set(w, (m.get(w) ?? 0) + 1);
    if ((LATENT_NINE as string[]).includes(t.latent)) {
      const ls = latentStat.get(t.latent) ?? latentStat.set(t.latent, { n: 0, worry: 0, fact: 0 }).get(t.latent)!;
      ls.n++;
      // 潜在の一文＝奥の心配への答え（worry）か、先回りして障壁を下げる文（barrier）
      if (roles.some((r) => r === "worry" || r === "barrier")) ls.worry++;
      if (roles.some((r) => r === "worry" || r === "barrier") && String(t.fact ?? "").trim()) ls.fact++;
    }
    const keptHere = new Set<KeepPromiseKind>();
    for (const s of t.sentences) {
      // 継続の約束（役目に関わらず文の形で読む・1通の同じ種類は1つ）
      const kp = keepPromiseOf(s.text);
      if (kp && !keptHere.has(kp.kind)) {
        keptHere.add(kp.kind);
        const sk0 = skeletonize(s.text, pn);
        items.push({ kind: "keep_promise", scene: t.scene, situation: kp.kind, id: t.id, sk: sk0 }, { kind: "keep_promise", scene: "*", situation: kp.kind, id: t.id, sk: sk0 });
        const st = keepStat.get(kp.kind) ?? keepStat.set(kp.kind, new Map()).get(kp.kind)!;
        st.set(kp.reason ?? "none", (st.get(kp.reason ?? "none") ?? 0) + 1);
      }
      const kind = s.role ? ROLE_KIND[s.role] : undefined;
      if (!kind) continue;
      const situation = kind === "uke" ? branch : kind === "worry" ? t.latent : t.lead;
      const sk = skeletonize(s.text, pn);
      items.push({ kind, scene: t.scene, situation, id: t.id, sk }, { kind, scene: "*", situation, id: t.id, sk });
      // 障壁を下げる文は潜在の一文の骨にも入れる（潜在の型ごと）
      if (kind === "barrier") items.push({ kind: "worry", scene: t.scene, situation: t.latent, id: t.id, sk }, { kind: "worry", scene: "*", situation: t.latent, id: t.id, sk });
    }
  }
  for (const a of aix) {
    const lines = aixBodySentences(a.text);
    if (!lines.length) continue;
    const [hk, tk]: [CatalogKind, CatalogKind] = a.part === "first" ? ["aix_head", "aix_tail"] : ["aix2_head", "aix2_tail"];
    items.push({ kind: hk, scene: "*", situation: a.button, id: a.id, sk: skeletonize(lines[0], pn) });
    if (lines.length > 1) items.push({ kind: tk, scene: "*", situation: a.button, id: a.id, sk: skeletonize(lines[lines.length - 1], pn) });
  }
  const keyOf = (x: It) => `${x.kind}|${x.scene}|${x.situation}`;
  const byKey = new Map<string, It[]>();
  for (const x of items) (byKey.get(keyOf(x)) ?? byKey.set(keyOf(x), []).get(keyOf(x))!).push(x);
  const groups = [...byKey.values()].map((l) => groupOf(l[0].kind, l[0].scene, l[0].situation, l, minCount)).filter((g): g is CatalogGroup => !!g && g.patterns.length > 0)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.scene.localeCompare(b.scene) || b.n - a.n);
  // ⑤ 潜在の一文を言うか: 竹内さんが潜在の一文を書いた割合が2割以上、かつ先回りの事実を添えた番がある型だけ言う
  const latentSay: LatentSay[] = LATENT_NINE.map((k) => {
    const s = latentStat.get(k) ?? { n: 0, worry: 0, fact: 0 };
    const worryRate = s.n ? r2(s.worry / s.n) : 0, factRate = s.n ? r2(s.fact / s.n) : 0;
    const few = s.n < (o.minLatentN ?? 5);
    const forcedNo = (o.noSay ?? []).includes(k);
    return { latent: k, n: s.n, worryRate, factRate, few, say: !forcedNo && !few && worryRate >= 0.2 && s.fact > 0 };
  });
  const openerStats: OpenerStat[] = (["act", "answer", "received"] as OpenerBranch[]).map((b) => {
    const m = opener.get(b) ?? new Map<OpenerWord, number>();
    const n = [...m.values()].reduce((a, c) => a + c, 0);
    const words = [...m.entries()].map(([word, c]) => ({ word, n: c, share: n ? r2(c / n) : 0 })).sort((a, c) => c.n - a.n);
    return { branch: b, n, words, expected: OPENER_EXPECTED[b], expectedShare: words.find((x) => x.word === OPENER_EXPECTED[b])?.share ?? 0 };
  });
  const keepPromise: KeepPromiseStat[] = (["new_listing", "until_found", "invite"] as KeepPromiseKind[]).map((k) => {
    const m = keepStat.get(k) ?? new Map<ReasonKind | "none", number>();
    const n = [...m.values()].reduce((a, c) => a + c, 0);
    return { kind: k, n, reasons: [...m.entries()].map(([reason, c]) => ({ reason, n: c, share: n ? r2(c / n) : 0 })).sort((a, b) => b.n - a.n) };
  });
  return { builtAt: o.now ?? new Date().toISOString(), sources: { turns: turns.length, aix: aix.length }, minCount, groups, latentSay, opener: openerStats, keepPromise };
}

// ── 書き手への注記（既定 off） ──
export function patternCatalogOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENTENCE_PATTERN_CATALOG ?? "").trim().toLowerCase() === "on";
}
/** 組を引く（場面の組 → 無ければ場面 "*" の組） */
export function findGroup(cat: PatternCatalog, kind: CatalogKind, scene: string | null, situation: string): CatalogGroup | null {
  return cat.groups.find((g) => g.kind === kind && g.scene === scene && g.situation === situation)
    ?? cat.groups.find((g) => g.kind === kind && g.scene === "*" && g.situation === situation) ?? null;
}
const fmtGroup = (g: CatalogGroup, top = 2) =>
  g.patterns.slice(0, top).map((p, i) => `${i === 0 ? "多数" : "2番手"} ${Math.round(p.share * 100)}%: ${p.skeleton}`).join("／");

/** その番の注記（受け・潜在の一文・誘導先の文・締めの骨と割合。例文は渡さない）。off・カタログ無し・引けない時は null */
export function patternCatalogNote(cat: PatternCatalog | null, key: { scene: string | null; latent: LatentKey; lead: LeadTo; branch: OpenerBranch; keepKind?: KeepPromiseKind | null }, env?: Record<string, string | undefined>): string | null {
  if (!cat || !patternCatalogOn(env)) return null;
  const L: string[] = [];
  const op = cat.opener.find((x) => x.branch === key.branch);
  const opG = findGroup(cat, "uke", key.scene, key.branch);
  if (op && op.n) L.push(`受け（${{ act: "こちらが動く番", answer: "答えるだけの番", received: "頂いた番" }[key.branch]}）: 開口語は ${op.words.slice(0, 2).map((w) => `${OPENER_WORD_JA[w.word]} ${Math.round(w.share * 100)}%`).join("・")}${opG ? `／骨 ${fmtGroup(opG)}` : ""}`);
  const ls = cat.latentSay.find((x) => x.latent === key.latent);
  if (ls) {
    if (!ls.say) L.push(`潜在の一文: この型（${key.latent}）は竹内さんが言わない（事実が無い時は書かない）`);
    else { const g = findGroup(cat, "worry", key.scene, key.latent); if (g) L.push(`潜在の一文（${key.latent}・書いた割合 ${Math.round(ls.worryRate * 100)}%）: ${fmtGroup(g)}`); }
  }
  if (key.keepKind) {
    const g = findGroup(cat, "keep_promise", key.scene, key.keepKind);
    const st = (cat.keepPromise ?? []).find((x) => x.kind === key.keepKind);
    const rs = st?.reasons.filter((r) => r.reason !== "none").slice(0, 2).map((r) => `${REASON_JA[r.reason as ReasonKind]} ${Math.round(r.share * 100)}%`).join("・");
    if (g) L.push(`継続の約束（${KEEP_PROMISE_JA[key.keepKind]}）: ${fmtGroup(g)}${rs ? `／理由の事実（材料にある時だけ「〜ので」で前に置く）: ${rs}` : ""}`);
  }
  for (const kind of ["trust", "apply", "viewing", "keep", "close"] as CatalogKind[]) {
    const g = findGroup(cat, kind, key.scene, key.lead);
    if (g) L.push(`${KIND_JA[kind]}（誘導先 ${key.lead}）: ${fmtGroup(g)}`);
  }
  if (!L.length) return null;
  return [`【竹内さんの言い方の型（骨・{…}は材料の値を入れる・無い値は文ごと書かない・例文は写さない）】`, ...L].join("\n");
}

/** 番の鍵（generate-reply の材料から。手本の注記と同じ計算） */
export function catalogKeyOf(o: { scene: string | null; customerText: string; meta: unknown }): { scene: string | null; latent: LatentKey; lead: LeadTo; branch: OpenerBranch } {
  const m = (o.meta && typeof o.meta === "object" ? o.meta : {}) as Record<string, unknown>;
  const cc = m.customer_concern && typeof m.customer_concern === "object" ? m.customer_concern as Record<string, unknown> : null;
  const latent = latentKeyOf(o.customerText, cc ? `${cc.topic ?? ""} ${cc.object ?? ""}` : null);
  const lead = leadKeyOf({ dir: typeof m.reply_direction === "string" ? m.reply_direction : null, action: typeof m.action === "string" ? m.action : null, mode: typeof m.reply_mode === "string" ? m.reply_mode : null });
  return { scene: o.scene, latent, lead, branch: openerBranchOf({ customer: o.customerText, lead, roles: [] }) };
}
