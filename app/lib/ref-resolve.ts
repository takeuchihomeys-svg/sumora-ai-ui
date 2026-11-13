// app/lib/ref-resolve.ts — 一通ごとに「指す物を解く欄」ref_resolve（純関数・DB/LLM なし・作業員16（作業員4 の持ち場の代わり）・2026-11-13）
//
// 統括役の頼み 11/13: お客様の「ここ・あれ・上記3件・↑・URL・画像」が何を指すかを、道を決める前に1つの欄に置く。
//   欄: { word（言葉）, kind（ours＝こちらが送った・brought＝持ち込み・new_arrival＝新着・prev＝前の話）, targets（物件名・号室）, clues（手がかり）, certainty }
//   手がかり: quote（引用）・url（ポータルの id）・image（画像の読み取りの名前）・bundle_order（束の何件目）・last_send（直前の通）・name（名前の一致）・cost_filter（初期費用の条件で絞った）
// 実例: 12105「送ってきてくれたやつで初期費用5万以内はあれだけ？」＝こちらが送った物件を見積の初期費用で絞る（持ち込みではない）
//       12555 URL の号室が引けない＝certainty low と needs_room の印（次の番の掲載と見積の食い違いの入口）
//       10911 画像の物件名が空・読み取りの「難皮」＝似た名前（1字違い）で候補に当てる（言い切らない＝mid）
// 作業員5 の深さの札（BRAIN_DEPTH_V2 の refCount＝指す物の数）は refCountOf で数える。
// スイッチ: REF_RESOLVE（既定 off＝どこからも読まない・記録もしない）。

type Env = Record<string, string | undefined>;
export function refResolveOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  const v = (env.REF_RESOLVE ?? "").trim().toLowerCase();
  return v === "on" || v === "shadow";
}

export type RefKind = "ours" | "brought" | "new_arrival" | "prev";
export type RefClue = "quote" | "url" | "image" | "bundle_order" | "last_send" | "name" | "cost_filter";
export type RefCertainty = "high" | "mid" | "low";
export type RefTarget = { name: string; room: string | null };
export type RefItem = { word: string; kind: RefKind | null; targets: RefTarget[]; clues: RefClue[]; certainty: RefCertainty; note?: string };
export type RefResolve = { items: RefItem[]; refCount: number };

/** こちらが送った物件（sent-props-text の SentProp から・束の番号と見積の初期費用つき） */
export type RefSent = { name: string; room: string | null; sent_at: string; bundle_no?: number | null; bundle_pos?: number | null; channel?: string | null; estimate_initial_cost?: number | null; new_arrival?: boolean };
/** 持ち込み（お客様が送ってきた URL・画像・物件名） */
export type RefBrought = { name: string | null; room: string | null; at: string; url?: string | null; portal_id?: string | null; image_name?: string | null; from: "url" | "image" | "text" };

// ─── ポータルの URL → id（homes・suumo・athome・chintai） ───────────────────
export type PortalId = { site: "suumo" | "homes" | "athome" | "chintai"; id: string };
export function portalIdOf(url: string | null | undefined): PortalId | null {
  const u = String(url ?? "");
  let m = u.match(/suumo\.jp\/chintai\/(?:[a-z]+\/)*(?:jnc_|bc_|nc_)(\d{6,})/i) ?? u.match(/suumo\.jp\/[^\s]*?(?:jnc_|bc_|nc_)(\d{6,})/i);
  if (m) return { site: "suumo", id: m[1] };
  m = u.match(/homes\.co\.jp\/chintai\/(?:room|b-)\/?([0-9a-z_-]{6,})/i) ?? u.match(/homes\.co\.jp\/chintai\/b-(\d{6,})/i);
  if (m) return { site: "homes", id: m[1] };
  m = u.match(/athome\.co\.jp\/chintai\/(\d{6,})/i);
  if (m) return { site: "athome", id: m[1] };
  m = u.match(/chintai\.net\/detail\/bk-([0-9a-z]+)/i);
  if (m) return { site: "chintai", id: m[1] };
  return null;
}

// ─── 似た名前（画像の読み取りの1字違い「難皮」→「難波」） ───────────────────
const normName = (s: string) => s.normalize("NFKC").replace(/[\s・\-ー－]/g, "").toLowerCase();
/** 0〜1。同じ長さ近くで違う字が1つ以下なら 0.8 以上 */
export function nameSimilarity(a: string, b: string): number {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length) >= 0.6 ? 0.9 : 0.5;
  // 編集距離
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return 1 - d[x.length][y.length] / Math.max(x.length, y.length);
}

// ─── 言葉 ───────────────────
const OURS_RE = /送って(?:きて)?(?:くれ|頂い|いただい|下さっ|くださっ)た|ご?提案(?:頂い|いただい|して(?:くれ|頂い))た|(?:頂い|いただい)た(?:物件|お部屋|やつ)/;
const BROUGHT_RE = /(?:私|僕|自分|こちら)(?:が|から)送った|(?:さっき|先ほど|先程)の(?:URL|url|リンク|画像|スクショ)|(?:この|その)(?:URL|url|リンク)/;
const NEW_RE = /新着/;
const PREV_RE = /前(?:回|の)|以前の|この前の/;
const DEIXIS_RE = /ここ|そこ|こちら(?:の|は)|あれ|それ|これ|上記|上の|↑|[①-⑳]|[0-9０-９一二三四五]\s*(?:件目|つ目|番目)|最初の|最後の/;
const ORD_RE = /([①-⑳])|([0-9０-９一二三四五])\s*(?:件目|つ目|番目)|(最初|最後)の/;
const COST_RE = /初期費用\s*(?:が|は)?\s*([0-9０-９]+(?:\.[0-9]+)?)\s*万(?:円)?\s*(?:以内|以下|まで)/;
const URL_RE = /https?:\/\/[^\s）)」』]+/g;
const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
const ordOf = (s: string): number | "last" | null => {
  const m = s.match(ORD_RE);
  if (!m) return null;
  if (m[1]) return m[1].charCodeAt(0) - 0x2460 + 1;
  if (m[2]) return KANJI_NUM[m[2]] ?? Number(m[2].normalize("NFKC"));
  return m[3] === "最後" ? "last" : 1;
};

export type RefInput = {
  /** お客様の今の番の文（連投はつないだ物） */
  text: string;
  sent: ReadonlyArray<RefSent>;
  brought: ReadonlyArray<RefBrought>;
  /** 引用した通の文（LINE の引用・quoted_message_id で引いた物） */
  quotedText?: string | null;
  /** こちらの直前の通が送った物件の束か（last_send の手がかり） */
  lastStaffSentBundle?: boolean;
};

const tgt = (name: string, room: string | null | undefined): RefTarget => ({ name, room: (room ?? "").trim() || null });
const uniq = (ts: RefTarget[]) => ts.filter((t, i) => ts.findIndex((u) => u.name === t.name && u.room === t.room) === i);

export function resolveRefs(i: RefInput): RefResolve {
  const text = i.text ?? "";
  const items: RefItem[] = [];
  const sentSorted = [...i.sent].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
  const lastBundleNo = sentSorted.reduce((mx, s) => Math.max(mx, s.bundle_no ?? 0), 0);
  const lastBundle = sentSorted.filter((s) => (s.bundle_no ?? 0) === lastBundleNo && lastBundleNo > 0).sort((a, b) => (a.bundle_pos ?? 0) - (b.bundle_pos ?? 0));

  // ① URL（持ち込み）: ポータルの id で持ち込みの台帳に当てる。号室が引けなければ needs_room
  for (const u of text.match(URL_RE) ?? []) {
    const pid = portalIdOf(u);
    const hit = i.brought.find((b) => (pid && b.portal_id === pid.id) || (b.url && b.url === u));
    const name = hit?.name ?? hit?.image_name ?? null;
    items.push(name
      ? { word: "URL", kind: "brought", targets: [tgt(name, hit?.room)], clues: ["url"], certainty: hit?.room ? "high" : "low", ...(hit?.room ? {} : { note: "needs_room（URL の号室が引けない）" }) }
      : { word: "URL", kind: "brought", targets: [], clues: ["url"], certainty: "low", note: pid ? `needs_name（${pid.site} ${pid.id} が台帳に無い）` : "needs_name（ポータルの id が読めない）" });
  }
  // ② 画像（持ち込みの画像の読み取り）: 名前が空なら似た名前で当てる
  if (/\[画像\]|【画像】|画像/.test(text) || i.brought.some((b) => b.from === "image")) {
    for (const b of i.brought.filter((x) => x.from === "image")) {
      if (b.name) { items.push({ word: "画像", kind: "brought", targets: [tgt(b.name, b.room)], clues: ["image"], certainty: b.room ? "high" : "mid" }); continue; }
      const raw = b.image_name ?? "";
      const pool = [...i.sent.map((s) => ({ name: s.name, room: s.room })), ...i.brought.filter((x) => x.name).map((x) => ({ name: x.name!, room: x.room }))];
      const scored = raw ? pool.map((p) => ({ p, s: Math.max(nameSimilarity(raw, p.name), ...p.name.split(/\s+/).map((w) => nameSimilarity(raw, w))) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s) : [];
      items.push(scored.length
        ? { word: "画像", kind: "brought", targets: [tgt(scored[0].p.name, scored[0].p.room)], clues: ["image", "name"], certainty: scored[0].s >= 0.9 ? "high" : "mid", note: `読み取り「${raw}」を似た名前で当てた` }
        : { word: "画像", kind: "brought", targets: [], clues: ["image"], certainty: "low", note: raw ? `読み取り「${raw}」に当たる物件が無い` : "needs_name（画像の物件名が空）" });
    }
  }
  // ③ 指す言葉（ここ・あれ・上記・↑・何件目・送ってきてくれた）
  const dm = text.match(DEIXIS_RE) ?? text.match(OURS_RE) ?? text.match(NEW_RE);
  if (dm) {
    // 言葉で種類が決まらない時: 直前のこちらの通が束なら ours。束の何件目・↑・上記で、持ち込みが無く送った物件だけある時も ours（持ち込みもある時は決めない）
    const listWord = ORD_RE.test(text) || /↑|上記|上の/.test(text);
    let kind: RefKind | null = OURS_RE.test(text) ? "ours" : BROUGHT_RE.test(text) ? "brought" : NEW_RE.test(text) ? "new_arrival" : PREV_RE.test(text) ? "prev"
      : i.lastStaffSentBundle ? "ours" : listWord && i.sent.length && !i.brought.length ? "ours" : null;
    const clues: RefClue[] = [];
    let pool: RefSent[] = [];
    if (kind === "ours" || kind === "prev") { pool = kind === "prev" ? sentSorted.filter((s) => (s.bundle_no ?? 0) < lastBundleNo) : (lastBundle.length ? lastBundle : sentSorted); if (i.lastStaffSentBundle && kind === "ours") clues.push("last_send"); }
    if (kind === "new_arrival") pool = sentSorted.filter((s) => s.new_arrival);
    if (i.quotedText) { const q = sentSorted.filter((s) => i.quotedText!.includes(s.name)); if (q.length) { pool = q; clues.push("quote"); kind = kind ?? "ours"; } }
    // 名前の一致（文の中に送った物件の名前）
    const named = sentSorted.filter((s) => text.includes(s.name) || (s.name.length >= 4 && text.includes(s.name.slice(0, 4))));
    if (named.length) { pool = named; clues.push("name"); kind = kind ?? "ours"; }
    const ord = ordOf(text);
    if (ord != null && pool.length) { const p = ord === "last" ? pool[pool.length - 1] : pool.find((s) => s.bundle_pos === ord) ?? pool[ord - 1]; pool = p ? [p] : []; clues.push("bundle_order"); }
    const cm = text.match(COST_RE);
    if (cm && pool.length) {
      const cap = Number(cm[1].normalize("NFKC")) * 10_000;
      const withCost = pool.filter((s) => typeof s.estimate_initial_cost === "number");
      if (withCost.length) { pool = withCost.filter((s) => (s.estimate_initial_cost as number) <= cap); clues.push("cost_filter"); }
    }
    const targets = uniq(pool.map((s) => tgt(s.name, s.room)));
    const certainty: RefCertainty = !kind || !targets.length ? "low" : clues.some((c) => c === "quote" || c === "name" || c === "bundle_order" || c === "cost_filter") ? "high" : clues.includes("last_send") || targets.length === 1 ? "mid" : "low";
    items.push({ word: dm[0], kind, targets, clues, certainty, ...(cm && !clues.includes("cost_filter") && kind === "ours" ? { note: "needs_cost（送った物件の見積の初期費用が無い）" } : {}) });
  }
  return { items, refCount: refCountOf({ items, refCount: 0 }) };
}

/** 指す物の数（作業員5 の深さの札 refCount へ）＝解けた物件の数（物件名＋号室で重ねない）＋解けなかった指す言葉の数 */
export function refCountOf(r: RefResolve | null | undefined): number {
  if (!r) return 0;
  const keys = new Set<string>();
  let unresolved = 0;
  for (const it of r.items) { if (!it.targets.length) unresolved++; for (const t of it.targets) keys.add(`${t.name}|${t.room ?? ""}`); }
  return keys.size + unresolved;
}

/** 人に回す理由（作業員5 の「自信が無い時に人に回す段」へ・統括役の決め 11/13＝needs_name・needs_room の番はブレインが言い切らず、スタッフが確かめる）。
 *  名前は ref_needs_name・ref_needs_room（ref_resolve の印 needs_name・needs_room に ref_ を付けた物） */
export const REF_HANDOFF_REASONS = ["ref_needs_name", "ref_needs_room"] as const;
export type RefHandoffReason = typeof REF_HANDOFF_REASONS[number];
export function refHandoffReasons(r: RefResolve | null | undefined): RefHandoffReason[] {
  const out = new Set<RefHandoffReason>();
  for (const it of r?.items ?? []) { if (it.note?.startsWith("needs_name")) out.add("ref_needs_name"); if (it.note?.startsWith("needs_room")) out.add("ref_needs_room"); }
  return [...out];
}

/** ブレインの材料の1行（道の言葉は入れない・事実と印だけ） */
export function refResolveLine(r: RefResolve | null | undefined): string | null {
  if (!r || !r.items.length) return null;
  const KJ: Record<RefKind, string> = { ours: "こちらが送った物件", brought: "お客様が送ってきた物件（持ち込み）", new_arrival: "新着", prev: "前の話の物件" };
  const CJ: Record<RefCertainty, string> = { high: "確か", mid: "たぶん", low: "不確か（確かめる）" };
  return `【お客様の言葉が指す物】\n${r.items.map((it) => `- 「${it.word}」→ ${it.kind ? KJ[it.kind] : "どれか不明"}${it.targets.length ? `: ${it.targets.map((t) => `${t.name}${t.room ? ` ${t.room}` : ""}`).join("・")}` : ""}（手がかり ${it.clues.join("・") || "なし"}・${CJ[it.certainty]}${it.note ? `・${it.note}` : ""}${/^needs_(name|room)/.test(it.note ?? "") ? "・物件名や号室を言い切らず、スタッフが確かめる番" : ""}）`).join("\n")}`;
}

/** 記録の1行: "ours:2:high:cost_filter|brought:1:low:needs_room" */
export function refResolveDigest(r: RefResolve | null | undefined): string | null {
  if (!r || !r.items.length) return null;
  return r.items.map((it) => `${it.kind ?? "?"}:${it.targets.length}:${it.certainty}:${it.note?.match(/^needs_\w+/)?.[0] ?? it.clues.join("+")}`).join("|").slice(0, 120);
}
