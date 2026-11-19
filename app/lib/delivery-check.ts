// app/lib/delivery-check.ts（scripts/lib/delivery-table.ts から移した・brain-core が読む） — 決めた事が書き手まで届いているかの表（純関数・LLM なし・DB なし・作業員22・2026-11-13）
//
// 竹内さん 11/13（統括役経由）「文の要素（押さえ 34%・潜在 27%・信頼 43%）の一番の根は、ブレインと統括が決めた事が書き手まで届いていない事」。
//   KB 2301dbf1（文の外れを4つに分け、決めた事を文の役まで必ず届ける）・5cf2d736（細分化した判断を文の構成まで1欄も落とさずに届ける）。
// 入力: 本番のブレインの meta（suggested_aix_meta）か、試験の答案の brain（planOf 済み）。
// 段: brain（ブレインの JSON・統括の記録に値がある）→ compose（文の統括の設計図の注記 sentencePlanNote）→ writer（書き手に渡る注記＝本質の帯 renderTurnContractNote＋設計図の注記）
//   → aix1（AIX の1通目＝AIX の統括に渡る物）→ aix2（AIX の2通目の材料に渡る物）。
//   書き手の段は generate-reply の tpoGuidanceNote と同じ物を同じ関数で作る（既定のスイッチ: COMPOSE_SENTENCE_PLAN は既定 on・COMPOSE_CONDUCTOR・BRAIN_COMPOSE_BLUEPRINT は既定 off）。
// 届かない理由の分け（統括役 11/13）: a＝欄そのものが無い／b＝欄はあるが渡す配線が無い／c＝渡しているが書き手の指示文で使われていない／d＝スイッチが off。
import { buildTurnContract, renderTurnContractNote } from "./turn-contract";
import { buildSentencePlan, readComposeContext, readSevenFields, readTurnUnderstanding, sentencePlanNote, latentKindOf } from "./compose-sentence-plan";

export type Stage = "brain" | "compose" | "writer" | "aix1" | "aix2";
export type Why = "a" | "b" | "c" | "d";
export type DeliveryField = {
  key: string; label: string;
  /** 値（無ければ null）。届いたかは、この値の頭（詰めて12字）が段の文に入っているかで見る */
  value: (m: Record<string, unknown>) => string | null;
  /** 静的な配線（コードを読んで決めた・段ごとに 届く／理由）。brain の段は値の有無で数える */
  wiring: Record<Exclude<Stage, "brain">, true | Why>;
  /** 届かない所の中身（なぜ） */
  why: string;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n = 80): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const asks = (m: Record<string, unknown>) => arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is Record<string, unknown> => !!a && !!str(a.quote));
const FACT_BASES = new Set(["conversation", "material", "company_fact", "general"]);
const BASIS_JA: Record<string, string> = { conversation: "会話", material: "資料", company_fact: "会社の事実", general: "一般" };

export const DELIVERY_FIELDS: readonly DeliveryField[] = [
  { key: "focus", label: "重点と理由", value: (m) => { const c = obj(m.conductor_focus); return str(c?.focus, 20) ? `${str(c!.focus, 20)}${str(c?.why, 40) ? `＝${str(c?.why, 40)}` : ""}` : null; },
    wiring: { compose: true, writer: true, aix1: "b", aix2: "b" }, why: "文の統括の注記（統括の重点）で書き手に届く。AIX の統括・2通目へは渡す配線が無い" },
  { key: "focus_sub", label: "重点の下の種類（作業員5 の focus_sub）", value: (m) => str(obj(m.conductor_focus)?.focus_sub, 20),
    wiring: { compose: "a", writer: "a", aix1: "a", aix2: "a" }, why: "欄が作業員5 の CONDUCTOR_FOCUS_SUB でこれから足される（今の main に無い）" },
  { key: "promise", label: "約束（この番の確かめる・送る約束の中身）", value: (m) => { const p = asks(m).find((a) => a.route === "promise" && str(a.answer)); return p ? str(p.answer, 60) : null; },
    wiring: { compose: true, writer: true, aix1: "b", aix2: "c" }, why: "本質の帯で書き手に届く。2通目は自前の約束の読み（openPromises）で、この番の約束の中身は使わない" },
  { key: "asks", label: "依頼ごとの道と答え", value: (m) => { const a = asks(m)[0]; return a ? str(a.quote, 30) : null; },
    wiring: { compose: true, writer: true, aix1: "b", aix2: true }, why: "本質の帯で書き手に届く・2通目はこの AIX で受ける依頼だけ（buildBrainBundleNote）" },
  { key: "fact_source", label: "答えに使う事実の出所（会話・資料・会社の事実）", value: (m) => { const a = asks(m).find((x) => FACT_BASES.has(String(x.basis)) && str(x.answer)); return a ? BASIS_JA[String(a.basis)] : null; },
    wiring: { compose: "c", writer: "c", aix1: "b", aix2: "b" }, why: "答えの値は本質の帯に出るが、出所（basis）は帯の文に書かれない＝書き手はどの事実で答えるかを知らない" },
  { key: "our_side", label: "こちら側の状態（もう送った・約束した・確かめ済み）", value: (m) => { const t = str(m.our_side_note, 400); return t ? t.split("\n").map((x) => x.trim()).filter(Boolean)[0] ?? null : null; },
    wiring: { compose: "d", writer: "d", aix1: "b", aix2: "b" }, why: "OUR_SIDE_TO_COMPOSE が既定 off（on なら設計図の注記に届く）" },
  { key: "latent_feeling", label: "潜在の気持ち（どんな気持ちで）", value: (m) => str(obj(obj(m.latent_read)?.feeling)?.what, 30) ?? str(obj(obj(obj(m.turn_read)?.latent)?.feeling)?.what, 30) ?? str(obj(m.three_layer)?.worry, 40),
    wiring: { compose: true, writer: true, aix1: "b", aix2: "c" }, why: "設計図の注記（潜在・奥の心配）で届く。欄は BRAIN_SEVEN_FIELDS・TURN_READ=on の時だけ濃い。2通目の訴求の判断は latent_intent だけ読む" },
  { key: "latent_kind", label: "潜在の下の種類（審査・先に取られる・費用・入居日…）", value: (m) => { const w = str(obj(obj(m.latent_read)?.feeling)?.what, 60) ?? str(obj(m.three_layer)?.worry, 60) ?? str(obj(obj(m.customer_mindset)?.anxiety)?.target, 20); return w ? latentKindOf(w) : null; },
    wiring: { compose: "c", writer: "c", aix1: "b", aix2: "b" }, why: "設計図の従の行は潜在の中身の文（what）だけを出し、種類（kind）は文の中身がある時は書かない" },
  { key: "hooked", label: "刺さった所（送った物件のどの点）", value: (m) => { const u = arr(m.our_send_uptake).map(obj).find((x) => x?.hook === "hooked"); return u ? str(u.point, 20) : null; },
    wiring: { compose: "b", writer: "b", aix1: "b", aix2: "b" }, why: "our_send_uptake は判断のブレインの事実の欄（BRAIN_OUR_SEND_UPTAKE 既定 off）で、文の統括へは渡していない（BRAIN_FIELD_ROUTE=other）" },
  { key: "near", label: "近い番の意見（竹内さんの似た番）", value: (m) => str(m.near_opinion, 60),
    wiring: { compose: "b", writer: "b", aix1: "b", aix2: "b" }, why: "近い番の意見は判断のブレインの材料だけ（BRAIN_FIELD_ROUTE=none）" },
  { key: "aim", label: "目的と中期（この番の目的・次の2〜3番の狙い）", value: (m) => { const t = obj(m.turn_aims); return str(t?.turnAim, 30) ?? str(t?.midAim, 40); },
    wiring: { compose: "d", writer: "d", aix1: "b", aix2: "b" }, why: "BRAIN_TURN_AIMS・TURN_AIMS_AFTER が既定 off。on でも Handoff 経由で構成のブレイン（BRAIN_COMPOSE_BLUEPRINT 既定 off）にしか行かない" },
];

const squash = (s: string) => s.normalize("NFKC").replace(/[\s、。・「」（）()／/：:→＝]/g, "");
/** 書き手に渡る注記（generate-reply の本質の帯＋設計図の注記と同じ関数で作る） */
export function writerNoteOf(meta: Record<string, unknown>): { compose: string; writer: string } {
  const tc = renderTurnContractNote(buildTurnContract({ brain: meta.turn_contract as never, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] }));
  let plan = "";
  try { plan = sentencePlanNote(buildSentencePlan(readTurnUnderstanding(meta), readSevenFields(meta), { ctx: readComposeContext(meta) })); } catch { plan = ""; }
  return { compose: plan, writer: [tc, plan].filter(Boolean).join("\n") };
}
/** 1番の欄ごとの判定（値が無い＝no_value・届いた＝ok・届かない＝静的の理由） */
export function deliveryOfTurn(meta: Record<string, unknown>): Record<string, Record<Stage, "ok" | "no_value" | Why>> {
  const notes = writerNoteOf(meta);
  const out: Record<string, Record<Stage, "ok" | "no_value" | Why>> = {};
  for (const f of DELIVERY_FIELDS) {
    const v = f.value(meta);
    const row = { brain: v ? "ok" : "no_value" } as Record<Stage, "ok" | "no_value" | Why>;
    for (const st of ["compose", "writer", "aix1", "aix2"] as const) {
      if (!v) { row[st] = "no_value"; continue; }
      const w = f.wiring[st];
      if (w !== true) { row[st] = w; continue; }
      if (st === "compose" || st === "writer") row[st] = squash(notes[st]).includes(squash(v).slice(0, 12)) ? "ok" : "c";
      else row[st] = "ok";
    }
    out[f.key] = row;
  }
  return out;
}
export type DeliveryTally = Record<string, Record<Stage, { ok: number; noValue: number; a: number; b: number; c: number; d: number }>>;
export function tallyDelivery(metas: ReadonlyArray<Record<string, unknown>>): DeliveryTally {
  const t: DeliveryTally = {};
  for (const m of metas) for (const [k, row] of Object.entries(deliveryOfTurn(m))) for (const [st, v] of Object.entries(row) as Array<[Stage, string]>) {
    const c = ((t[k] ??= {} as DeliveryTally[string])[st] ??= { ok: 0, noValue: 0, a: 0, b: 0, c: 0, d: 0 });
    if (v === "ok") c.ok++; else if (v === "no_value") c.noValue++; else c[v as Why]++;
  }
  return t;
}
export function formatDelivery(t: DeliveryTally, n: number): string {
  const L = [`欄 | 値あり/${n} | 文の統括 | 書き手 | AIX 1通目 | AIX 2通目`];
  for (const f of DELIVERY_FIELDS) {
    const r = t[f.key]; if (!r) continue;
    const cell = (st: Stage) => { const c = r[st]; const has = n - c.noValue; if (!has) return "-"; const miss = (["a", "b", "c", "d"] as const).filter((w) => c[w]).map((w) => `${w}${c[w]}`).join(" "); return `${c.ok}/${has}${miss ? `（${miss}）` : ""}`; };
    L.push(`${f.label} | ${n - r.brain.noValue} | ${cell("compose")} | ${cell("writer")} | ${cell("aix1")} | ${cell("aix2")}`);
  }
  return L.join("\n");
}

/** 設計図の注記が空の番（主の行が無い＝書き手に重点・潜在の行が届かない）を、道（スタッフの番か）で分ける */
export function emptyPlanStats(metas: ReadonlyArray<Record<string, unknown>>): { empty: number; emptyStaff: number; emptyReply: number; n: number } {
  let empty = 0, emptyStaff = 0;
  for (const m of metas) {
    if (writerNoteOf(m).compose) continue;
    empty++;
    if (m.reply_mode !== "auto_reply" && typeof m.action === "string" && m.action) emptyStaff++;
  }
  return { empty, emptyStaff, emptyReply: empty - emptyStaff, n: metas.length };
}

// ── 届いたかの確かめ（DELIVERY_CHECK=shadow・既定 off）: 欄ごと・下の欄ごとに書き手まで届いたか ─────────────
import { SUB_FIELDS } from "./decided-subfields";
type Env = Record<string, string | undefined>;
export const deliveryCheckMode = (env: Env = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" => { const v = (env.DELIVERY_CHECK ?? "").trim().toLowerCase(); return v === "shadow" || v === "on" ? "shadow" : "off"; };
/** 下の欄の親の欄 → 届き方の表（DELIVERY_FIELDS）のどの欄で書き手まで届いたかを見るか */
export const SUB_PARENT: Readonly<Record<string, string>> = {
  focus: "focus", fact: "asks", latent: "latent_feeling", near: "near", our_side: "our_side", hooked: "hooked", aim: "aim",
};
/** 下の欄ごとの出所の名前（書き手の注記にこの言葉が入っていれば、その下の欄まで届いた）。無い下の欄は親の欄の届きで数える */
const SUB_PROBE: Readonly<Record<string, RegExp>> = {
  "fact.source": /［出所: /, "fact.certainty": /［出所: [^］]*(言い切れる|基本的に|確認が要る)/, "latent.concern": /潜在の下の種類/, "latent.reason": /なぜ /, "latent.expect": /この依頼での想定 /,
  "near.why": /件中 \d+件|件のうち \d+件/, "near.move": /最初の一手は|近い番の意見/,
};
export type DeliveryCheck = { fields: Record<string, "ok" | "no_value" | "a" | "b" | "c" | "d">; subs: Record<string, "ok" | "no_value" | "x">; rate: string; subRate: string };
export function deliveryCheckOf(meta: Record<string, unknown>): DeliveryCheck {
  const row = deliveryOfTurn(meta);
  const fields = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.writer])) as DeliveryCheck["fields"];
  const writer = writerNoteOf(meta).writer;
  const subs: DeliveryCheck["subs"] = {};
  for (const f of SUB_FIELDS) {
    if (!f.value(meta)) { subs[f.sub] = "no_value"; continue; }
    const probe = SUB_PROBE[f.sub];
    const parent = fields[SUB_PARENT[f.field] ?? ""];
    subs[f.sub] = probe ? (probe.test(writer) ? "ok" : "x") : parent === "ok" ? "ok" : "x";
  }
  const has = Object.values(fields).filter((v) => v !== "no_value"), sHas = Object.values(subs).filter((v) => v !== "no_value");
  return { fields, subs, rate: `${has.filter((v) => v === "ok").length}/${has.length}`, subRate: `${sHas.filter((v) => v === "ok").length}/${sHas.length}` };
}
/** digest.dv の1行: 欄の届き/値あり・下の欄の届き/値あり 例 "4/7|9/15" */
export const deliveryDigest = (v: unknown): string | null => { const d = v && typeof v === "object" ? (v as DeliveryCheck) : null; return d && d.rate ? `${d.rate}|${d.subRate}` : null; };
