// app/lib/exchange-ledger.ts — やり取りの照らし合わせ表（純関数・LLM なし・作業員4・2026-11-12）
//
// 竹内さん 11/12「送った事でもこのように足りていない部分あるか。ちゃんとこちらから送った部分と相手が送ってきた部分を照らし合わせられるように。統括の部分を強化する」
//   ① ここ数番のやり取りを部分に分けて並べる（こちら: 聞いた事・伝えた事実・約束・提案・誘い・送った物件・送った AIX／お客様: 問い・条件・不安・了承・日程・物件の持ち込み・反応）
//   ② 照らし合わせて残りを出す（こちらが聞いてまだ答えが無い／約束してまだ果たしていない／お客様が聞いてまだ答えていない／送った物件で反応が無い／伝わっていない）
//   ③ 今の番の「足りていない部分」として入口の統括とブレインに事実の一覧で渡す（道の言葉は入れない＝q057・q069 の教訓）
// 部分の語彙は our-part-types.ts（作業員16 の our-send-uptake・作業員1 の info-fill-map と同じ鍵）。
// 直前の1通の受け取られ方（our-send-uptake）・前の番の後にこちらがした事（conductor-our-side.staffSinceLine）とは役目が違う: ここは数番をまたいだ残り。
// スイッチ: CONDUCTOR_EXCHANGE_LEDGER=on（入口の統括の carryLine）／CONDUCTOR_EXCHANGE_LEDGER_BRAIN=on（ブレインの材料・道に触る所なので別スイッチ）。どちらも既定 off。

import { splitOurPartsFine, aixPart, splitTheirParts, OUR_PART_KIND_LABEL, EXPECT_LABEL, THEIR_PART_LABEL, type OurPart, type TheirPart } from "./our-part-types";
import { AIX_JA, pickJa, type OurSideMsg, type OurSideAix } from "./conductor-our-side";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export const exchangeLedgerOn = (env: Env = envOf()) => (env.CONDUCTOR_EXCHANGE_LEDGER ?? "").trim().toLowerCase() === "on";
export const exchangeLedgerBrainOn = (env: Env = envOf()) => (env.CONDUCTOR_EXCHANGE_LEDGER_BRAIN ?? "").trim().toLowerCase() === "on";

export const OPEN_KINDS = ["our_question_unanswered", "our_promise_unkept", "their_question_unanswered", "property_no_reaction", "not_conveyed"] as const;
export type OpenKind = typeof OPEN_KINDS[number];
export const OPEN_LABEL: Record<OpenKind, string> = {
  our_question_unanswered: "こちらが聞いてまだ答えが無い事",
  our_promise_unkept: "こちらが約束してまだ果たしていない事",
  their_question_unanswered: "お客様が聞いてまだこちらが答えていない事",
  property_no_reaction: "送った物件で反応がまだ無い物",
  not_conveyed: "伝えたのにもう一度聞かれた事（伝わっていない）",
};
export type OpenItem = { kind: OpenKind; what: string; at: string; overdue: boolean; expect?: string };
export type ExchangeLedger = { ours: OurPart[]; theirs: TheirPart[]; open: OpenItem[] };

const FULFIL: Record<string, { parts: RegExp; aix: RegExp }> = {
  "promise.estimate": { parts: /^fact\.estimate_amount$/, aix: /^estimate_sheet$/ },
  "promise.check": { parts: /^fact\.check_result$/, aix: /^(?:property_check_result|estimate_sheet)$/ },
  "promise.send_property": { parts: /^property\./, aix: /^property_(?:send|recommendation)$/ },
  "promise.search": { parts: /^property\./, aix: /^property_(?:send|recommendation)$/ },
  "promise.contact_day": { parts: /./, aix: /./ },
};
const INFO_Q = new Set(["area", "rent", "layout", "move_in", "size", "equipment"]);
const kw = (t: string) => (t.match(/[一-龠ァ-ヶー]{2,}/g) ?? []).filter((k) => !/させて|頂き|致し|お送り|ご確認|お部屋|部屋|物件|こちら|お世話|よろしく|ありがとう|ござい|でしょう|ですか|ますか/.test(k));
const overlaps = (a: string, b: string) => kw(a).some((k) => b.includes(k));

/** ここ数番（お客様の塊 turns 個・days 日まで）を部分に分けて照らし合わせる */
export function buildExchangeLedger(o: { msgs: ReadonlyArray<OurSideMsg>; aix: ReadonlyArray<OurSideAix>; nowMs: number; turns?: number; days?: number }): ExchangeLedger {
  const turns = o.turns ?? 4, sinceMs = o.nowMs - (o.days ?? 7) * 864e5;
  const asc = [...o.msgs].filter((m) => Date.parse(m.created_at) <= o.nowMs && Date.parse(m.created_at) >= sinceMs).sort((a, b) => a.created_at.localeCompare(b.created_at));
  // 窓の始まり: 後ろからお客様の塊を turns 個数えた所
  let blocks = 0, start = 0;
  for (let i = asc.length - 1; i >= 0; i--) {
    if (asc[i].sender === "customer" && (i === 0 || asc[i - 1].sender !== "customer")) { blocks++; if (blocks > turns) { start = i + 1; while (start < asc.length && asc[start].sender === "customer") start++; break; } }
  }
  const win = asc.slice(start);
  const winStart = win[0]?.created_at ?? new Date(sinceMs).toISOString();
  const ours: OurPart[] = [], theirs: TheirPart[] = [];
  for (const m of win) {
    if (m.sender === "customer") theirs.push(...splitTheirParts(m.text ?? "", m.created_at));
    else if (m.sender === "staff" && !m.is_aix_generated && m.text && !/^\[(?:画像|動画)\]$/.test(m.text)) ours.push(...splitOurPartsFine(m.text, m.created_at));
  }
  for (const a of o.aix) {
    const at = a.sent_at ?? a.created_at;
    if (at >= winStart && Date.parse(at) <= o.nowMs) ours.push(aixPart(a.aix_type, a.check_pattern ? pickJa(a.check_pattern) : null, at, AIX_JA[a.aix_type] ?? a.aix_type));
  }
  ours.sort((a, b) => a.at.localeCompare(b.at));
  const after = <T extends { at: string }>(xs: T[], at: string) => xs.filter((x) => x.at > at);
  const overdue = (p: { at: string; dueHours: number }) => o.nowMs - Date.parse(p.at) > p.dueHours * 36e5;
  const open: OpenItem[] = [];

  for (const p of ours) {
    const later = after(theirs, p.at);
    if (p.kind === "question" || p.key === "aix.condition_hearing") {
      const sub = p.key.split(".")[1];
      const met = p.expect === "schedule" ? later.some((t) => t.kind === "schedule")
        : p.expect === "property" ? later.some((t) => t.kind === "property_bring" || t.kind === "reaction")
        : INFO_Q.has(sub) ? later.some((t) => t.conditionKeys.includes(sub))
        : p.key === "aix.condition_hearing" ? later.some((t) => t.kind === "condition")
        : later.some((t) => t.kind !== "accept");
      if (!met) open.push({ kind: "our_question_unanswered", what: `${p.label}（${OUR_PART_KIND_LABEL[p.kind]}・期待した反応は${EXPECT_LABEL[p.expect]}）`, at: p.at, overdue: overdue(p), expect: p.expect });
    } else if (p.kind === "promise") {
      const f = FULFIL[p.key];
      const done = !!f && after(ours, p.at).some((q) => q.kind !== "promise" && (f.parts.test(q.key) || (q.kind === "aix" && f.aix.test(q.key.slice(4)))));
      if (!done) open.push({ kind: "our_promise_unkept", what: p.label, at: p.at, overdue: overdue(p) });
    }
  }
  // 送った物件（文の物件・物件の AIX）の最後の1つに反応が無いか
  const lastProp = [...ours].reverse().find((p) => p.kind === "property" || /^aix\.(?:property_send|property_recommendation|property_check_result|estimate_sheet)$/.test(p.key));
  if (lastProp && !after(theirs, lastProp.at).some((t) => t.kind !== "accept")) open.push({ kind: "property_no_reaction", what: lastProp.label, at: lastProp.at, overdue: overdue(lastProp) });
  // お客様の問い: 後にこちらの部分が無い／重なる言葉の無い物
  // 今の番（最後のお客様の塊）の問いは入口が読む今の一通なので、ここは前の番に残った問いだけ
  const lastStaffAt = [...win].reverse().find((m) => m.sender === "staff")?.created_at ?? "";
  for (const t of theirs.filter((x) => (x.kind === "question" || x.kind === "worry") && x.at < lastStaffAt)) {
    const laterOurs = win.filter((m) => m.sender === "staff" && m.created_at > t.at);
    const laterAix = after(ours, t.at).some((p) => p.kind === "aix");
    const answered = laterOurs.some((m) => overlaps(t.text, m.text ?? "")) || laterAix;
    if (!answered) open.push({ kind: "their_question_unanswered", what: `${THEIR_PART_LABEL[t.kind]}「${t.text.slice(0, 30)}」`, at: t.at, overdue: laterOurs.length > 0 });
  }
  // 伝えたのにもう一度聞かれた（今の番の問いも見る）
  for (const t of theirs.filter((x) => x.kind === "question")) {
    const earlierFact = ours.find((p) => p.at < t.at && (p.kind === "fact" || p.kind === "aix") && t.kind === "question" && overlaps(p.text, t.text));
    if (earlierFact) open.push({ kind: "not_conveyed", what: `${earlierFact.label}（前に伝えた）→「${t.text.slice(0, 24)}」`, at: t.at, overdue: false });
  }
  return { ours, theirs, open };
}

const hm = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 36e5); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

/** 入口の統括・ブレインに渡す事実の一覧（道の言葉なし）。残りが無ければ空文字 */
export function exchangeLedgerLine(l: ExchangeLedger, max = 5): string {
  if (!l.open.length) return "";
  const ours = [...new Set(l.ours.map((p) => `${OUR_PART_KIND_LABEL[p.kind]}（${p.label}）`))].slice(-6).join("・");
  const theirs = [...new Set(l.theirs.map((t) => THEIR_PART_LABEL[t.kind]))].join("・");
  const rest = l.open.slice(0, max).map((x) => `${OPEN_LABEL[x.kind]}: ${x.what}（${hm(x.at)}${x.overdue ? "・期限を過ぎた" : ""}）`).join("／");
  return `やり取りの照らし合わせ（ここ数番・事実）: こちらが送った部分＝${ours || "なし"}／お客様が送ってきた部分＝${theirs || "なし"}。残り: ${rest}`;
}
