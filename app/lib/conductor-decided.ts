// app/lib/conductor-decided.ts — 統括が決めた事の1つの置き場（台帳）と、役ごとに「必ず届ける欄」の表・届いたかの確かめ・段階の語の寄せ（純関数・作業員22・2026-11-12）
//
// 作業員24 の統括の洗い出し・根A（統括役 11/12）: 統括の決めた事（重点・約束・段階・誘導先・継続の約束・こちら側の状態）が meta のあちこちにあり、
//   下の役への受け渡し（conductor-handoff の Handoff）に入っていない物がある（重点の種類と理由・keepPromise・依頼ごとの道と答え・潜在の4欄・近い番の意見・our_side_note）。
//   今の届いたかの確かめ（handoffChecks）は一番の要点の頭6字だけ。
// ここにある物:
//   ① DECIDED_KINDS と buildDecidedLedger … 決めた事を「種類・対象・理由・いつ」の1つの型で1つの台帳に（統括の指示書 conductor_brief.decided に入る）
//   ② MUST_DELIVER … 役ごとに必ず届ける欄（どこから・なぜ）。decidedNote が下の役のプロンプトに入れる1ブロック（既定 off・CONDUCTOR_DECIDED=on の時だけ使う口・配線は試験の後）
//   ③ deliveryCheck … 欄ごとに、渡した文に値が届いたか（頭6字でなく値の頭12字・空白と句読点を詰めて）
//   ④ 段階の語の寄せ … 3系統（conductor-focus の stageAt の日本語・conductor-priority の STAGE_WEIGHT の鍵・Handoff の checkpoint_stage）を customer-state の CustomerStage に寄せる
// 決まり: 台帳とブロックは決めた事の写し（決め直さない）。返信か AIX かは Handoff の決定（action）のまま・ここでは足さない。
import type { CustomerStage } from "./customer-state";
import type { ConductorRole } from "./conductor-handoff";

type Env = Record<string, string | undefined>;
export const conductorDecidedOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_DECIDED ?? "").trim().toLowerCase() === "on";

// ── ④ 段階の語の寄せ（customer-state が正）────────────────────────────────
/** conductor-focus.stageAt の日本語 → CustomerStage */
export const STAGE_FROM_FOCUS: Readonly<Record<string, CustomerStage>> = {
  初回: "first", やり取りの始め: "searching", 物件を送った後: "proposing", 見積書の後: "estimate_sent",
  内覧の案内の後: "viewing_arranging", 内覧の確定の後: "viewing_scheduled", 申込の後押しの後: "apply_prep",
};
/** brain の checkpoint_stage（Handoff の stage）→ CustomerStage（粗い5つ→代表の段階） */
export const STAGE_FROM_CHECKPOINT: Readonly<Record<string, CustomerStage>> = {
  hearing: "searching", proposing: "proposing", viewing: "viewing_arranging", applying: "applying", contract: "applying", // applying は両方の語彙にある同じ名前＝同じ段階に寄せる
};
/** 3系統のどれからでも CustomerStage へ（conductor-priority の STAGE_WEIGHT の鍵はもう CustomerStage） */
export function unifyStage(v: string | null | undefined): CustomerStage | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s in STAGE_FROM_FOCUS) return STAGE_FROM_FOCUS[s];
  if (s in STAGE_FROM_CHECKPOINT) return STAGE_FROM_CHECKPOINT[s];
  const all: CustomerStage[] = ["first", "searching", "proposing", "interested", "estimate_sent", "viewing_arranging", "viewing_scheduled", "viewed", "apply_prep", "applying", "won", "dropped"];
  return (all as string[]).includes(s) ? (s as CustomerStage) : null;
}

// ── ① 決めた事の台帳 ───────────────────────────────────────
export const DECIDED_KINDS = ["focus", "promise", "stage", "lead", "keep", "our_side", "ask"] as const;
export type DecidedKind = typeof DECIDED_KINDS[number];
export const DECIDED_LABEL: Record<DecidedKind, string> = {
  focus: "重点", promise: "約束", stage: "段階", lead: "誘導先", keep: "継続の約束", our_side: "こちら側の状態", ask: "依頼ごとの道と答え",
};
export type DecidedWhen = "now" | "later" | "open";
export type DecidedItem = { kind: DecidedKind; target: string; reason: string | null; when: DecidedWhen; from: string };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n = 60): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const ROUTE_JA: Record<string, string> = { reply: "答える", promise: "約束", aix: "スタッフの番", none: "触れない" };

/** meta（判断の後）から決めた事を1つの台帳に。値は写すだけ（決め直さない） */
export function buildDecidedLedger(meta: Record<string, unknown> | null | undefined, o: { openPromises?: ReadonlyArray<string> } = {}): DecidedItem[] {
  const m = meta ?? {};
  const out: DecidedItem[] = [];
  const cf = obj(m.conductor_focus);
  if (str(cf?.focus, 20)) out.push({ kind: "focus", target: str(cf!.focus, 20)!, reason: str(cf?.why, 60), when: "now", from: "conductor_focus" });
  if (cf?.keepPromise === true) out.push({ kind: "keep", target: "継続の約束を1つ添える", reason: "relationKeep（条件の番・新着を頼まれた・近い番の過半数）", when: "now", from: "conductor_focus.keepPromise" });
  const stage = unifyStage(str(m.checkpoint_stage, 20));
  if (stage) out.push({ kind: "stage", target: stage, reason: `checkpoint_stage:${str(m.checkpoint_stage, 20)}`, when: "now", from: "checkpoint_stage" });
  for (const a of arr(obj(m.turn_contract)?.asks).map(obj)) {
    if (!a || !str(a.quote, 40)) continue;
    const route = String(a.route ?? "");
    out.push({ kind: "ask", target: `${str(a.quote, 30)}→${ROUTE_JA[route] ?? route}${str(a.answer, 40) ? `：${str(a.answer, 40)}` : ""}`, reason: str(a.basis, 20), when: route === "promise" ? "later" : "now", from: "turn_contract.asks" });
    if (route === "promise" && str(a.answer, 60)) out.push({ kind: "promise", target: str(a.answer, 60)!, reason: str(a.quote, 30), when: "later", from: "turn_contract.asks" });
  }
  for (const p of o.openPromises ?? []) out.push({ kind: "promise", target: p.slice(0, 60), reason: "まだ果たしていない", when: "open", from: "open_promises" });
  const at = obj(m.appeal_timing);
  if (at && at.kind !== "none" && str(at.kind, 12)) out.push({ kind: "lead", target: str(at.kind, 12)!, reason: str(at.reason, 60), when: "now", from: "appeal_timing" });
  if (str(m.our_side_note, 80)) out.push({ kind: "our_side", target: str(m.our_side_note, 80)!, reason: null, when: "now", from: "our_side_note" });
  return out;
}
export const decidedDigest = (items: ReadonlyArray<DecidedItem>) => DECIDED_KINDS.map((k) => `${k[0]}${items.filter((x) => x.kind === k).length}`).join("");

// ── ② 役ごとに必ず届ける欄（Handoff にまだ入っていない物）──────────────────────────
export type DeliverField = { key: string; label: string; value: (m: Record<string, unknown>) => string | null; why: string };
const latentLine = (m: Record<string, unknown>) => {
  const l = obj(m.latent_read);
  if (!l) return null;
  const parts = [str(obj(l.part)?.point, 30), str(obj(l.feeling)?.what, 30), str(l.want, 30), str(l.fact, 30)].filter(Boolean);
  return parts.length ? parts.join("・") : null;
};
const asksLine = (m: Record<string, unknown>) => {
  const xs = arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is Record<string, unknown> => !!a && !!str(a.quote, 30));
  return xs.length ? xs.slice(0, 4).map((a) => `${str(a.quote, 24)}→${ROUTE_JA[String(a.route)] ?? String(a.route ?? "?")}${str(a.answer, 30) ? `：${str(a.answer, 30)}` : ""}`).join("／") : null;
};
export const DELIVER_FIELDS: Readonly<Record<string, DeliverField>> = {
  focus: { key: "focus", label: "重点の種類と理由", value: (m) => { const c = obj(m.conductor_focus); return str(c?.focus, 20) ? `${str(c!.focus, 20)}${str(c?.why, 40) ? `（${str(c?.why, 40)}）` : ""}` : null; }, why: "重点に沿って書く・AIX を選ぶため（今は文の統括の材料にだけ届く）" },
  keep: { key: "keep", label: "継続の約束を添えるか", value: (m) => (obj(m.conductor_focus)?.keepPromise === true ? "継続の約束を1つ添える" : null), why: "添える・添えないは統括が決めた（書き手が足し引きしない）" },
  asks: { key: "asks", label: "依頼ごとの道と答え", value: asksLine, why: "依頼ごとに答える・約束・後で果たすが決まっている（書き手が依頼を落とさない・AIX の統括が別の依頼で選ばない）" },
  latent: { key: "latent", label: "潜在の4欄", value: latentLine, why: "どの部分に・どんな気持ちで・何が欲しいか（竹内さんの7つの欄）" },
  near: { key: "near", label: "近い番の意見", value: (m) => str(m.near_opinion, 80), why: "似た番で竹内さんがどうしたか（AIX の統括の札選び）" },
  our_side: { key: "our_side", label: "こちら側の状態", value: (m) => str(m.our_side_note, 80), why: "こちらが送った物・約束の状態（同じ物を重ねない）" },
};
/** 役ごとの必ず届ける欄（line は統括自身・fetch・deep は決めた事を受け取らない） */
export const MUST_DELIVER: Readonly<Record<ConductorRole, readonly string[]>> = {
  line: [],
  aix_desk: ["focus", "asks", "near", "our_side"],
  compose: ["focus", "keep", "asks", "latent", "our_side"],
  writer: ["focus", "keep", "asks", "our_side"],
  check: ["asks"],
  fetch: [],
  deep: ["focus", "asks"],
  second: ["focus", "latent"],
};
/** 下の役のプロンプトに入れる1ブロック（handoffNote の後ろに足す形・値の無い欄は書かない）。既定 off（CONDUCTOR_DECIDED=on の時だけ呼ぶ側が使う） */
export function decidedNote(meta: Record<string, unknown>, role: ConductorRole): string {
  const lines = MUST_DELIVER[role].map((k) => { const f = DELIVER_FIELDS[k]; const v = f.value(meta); return v ? `${f.label}: ${v}` : null; }).filter(Boolean);
  return lines.length ? `【統括が決めた事（必ず読む・決め直さない）】\n${lines.join("\n")}` : "";
}

// ── ③ 届いたかの確かめ（欄ごと）────────────────────────────────
const squash = (s: string) => s.replace(/[\s、。・「」（）()／/：:→]/g, "");
export type DeliveryState = "ok" | "missing" | "no_value";
/** 渡した文（handoffNote＋decidedNote 等）に、役の必ず届ける欄の値が届いたか。値の頭12字（詰めた後）が入っていれば ok */
export function deliveryCheck(meta: Record<string, unknown>, role: ConductorRole, delivered: string): Record<string, DeliveryState> {
  const text = squash(delivered);
  const out: Record<string, DeliveryState> = {};
  for (const k of MUST_DELIVER[role]) {
    const v = DELIVER_FIELDS[k].value(meta);
    if (!v) { out[k] = "no_value"; continue; }
    const head = squash(v).slice(0, 12);
    out[k] = head && text.includes(head) ? "ok" : "missing";
  }
  return out;
}
export const deliveryDigest = (r: Record<string, DeliveryState>) => Object.entries(r).map(([k, v]) => `${k}:${v === "ok" ? "o" : v === "missing" ? "x" : "-"}`).join(",");
