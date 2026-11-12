// app/lib/conductor-brief.ts — 番ごとの統括の指示書（CONDUCTOR_BRIEF・純関数・DB/LLM なし・作業員22・2026-11-12）
//
// 竹内さん 11/12「ブレインの統括の部分も具体的に判断できるように」「統括としての機能に足りていない部分や強化する部分あれば入れていく」
//   （親 P0 575a7cd5・8bfcdf60②下の役の答えを事実と照らして疑う・ea2a9405③自信を測って分からない時は正直に渡す）。
// 今の統括が出すのは名前（重点の種類・型の id・配分）だけで、具体の中身が無かった。今日できた部品を1つの具体の一覧にまとめる:
//   ① main     この番の主の要件（お客様の部分）……作業員21 の customer-part-types が入るまでは判断のブレインの依頼ごとの読み（turn_contract.asks）
//   ② facts    答えに使う事実と出所（会話・資料・会社の事実・一般）
//   ③ missing  足りない情報（作業員1 の INFO_KEYS・分かっていない／古い／材料が届いていない）
//   ④ open     照らし合わせの残り（作業員4 の exchange-ledger）
//   ⑤ type     型・確認の順番・なぜ（作業員16 の check-order）
//   ⑥ alloc    配分（conductor-allocation）
//   ⑦ combine  組と順番（作業員7 の組の表＝今は meta.two_message_plan_digest があればそれ）
//   ⑧ next     次の一手の具体（何を・どの強さで・いつ）……作業員7 の具体が入るまでは型の表 NEXT_MOVE_OF_TYPE
//   ⑨ aim      目的・押さえる要点（判断の根拠のメモ judge_basis の purpose・key_point と同じ名前）
//   ⑩ doubts   下の役の答えを事実と突き合わせた疑いの印（conductor-doubt の DOUBT_TABLE・種類ごとに何と何を突き合わせるか・なぜ・直しの多い順・決め直さない）
//   ⑪ sure     番の確かさ（conductor-doubt の SURE_CUES の重み・高・中・低）と人に回す線の案（HANDOFF_RULE）
// 決まり: どの欄も事実と名前だけ。返信か AIX かを決める言葉は入れない（疑いの印は道を読んで照らすが、道を変えない）。部品が無い欄は「未」。
// スイッチ: CONDUCTOR_BRIEF（既定 off＝何も足さない／shadow・on＝meta.conductor_brief と digest.cb に記録だけ）。
import { CHECK_ORDER_TYPES, CHECK_DEPTH, NEXT_MOVE_OF_TYPE, checkOrderById } from "./check-order";
import { buildDecidedLedger, type DecidedItem } from "./conductor-decided";
import { briefDoubts, briefSure, type BriefDoubt, type Sure, type SureCueKey } from "./conductor-doubt";
import type { InfoCell } from "./info-fill-map";
import type { OpenItem } from "./exchange-ledger";

type Env = Record<string, string | undefined>;
export type BriefMode = "off" | "shadow";
export function conductorBriefMode(env: Env = typeof process !== "undefined" ? process.env : {}): BriefMode {
  const v = String(env.CONDUCTOR_BRIEF ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? "shadow" : "off";
}

/** 判断の本体で集めて meta に置く入力（CONDUCTOR_BRIEF の時だけ・他の部品のスイッチが off でも集める＝プロンプトには入れない） */
export type BriefInputs = {
  /** 申込までの地図の今の駅と、要る情報の埋まり具合（info-fill-map） */
  info?: { node: string | null; cells: InfoCell[] } | null;
  /** 照らし合わせの残りと、果たし済みのこちらの約束の鍵（exchange-ledger） */
  ledger?: { open: OpenItem[]; keptPromises: string[] } | null;
};

export const BRIEF_NONE = "未" as const;
type Missing<T> = T | typeof BRIEF_NONE;
export type BriefFact = { quote: string; value: string; from: string };
export type ConductorBrief = {
  main: Missing<{ from: "turn_contract"; items: Array<{ kind: string; quote: string; topic: string | null }> }>;
  facts: Missing<BriefFact[]>;
  missing: Missing<{ node: string | null; keys: Array<{ key: string; state: string }> }>;
  open: Missing<Array<{ kind: string; what: string; overdue: boolean }>>;
  type: Missing<{ id: string; check: string[]; why: string; depth: string }>;
  alloc: Missing<{ name: string; parts: string[] }>;
  combine: Missing<string>;
  next: Missing<{ dest: string; strength: string; timing: string; from: "type_table" }>;
  aim: { purpose: string | null; purposeFrom: "judge_basis" | "type_table" | null; keyPoint: Missing<string> };
  /** 統括が決めた事の1つの置き場（重点・約束・段階・誘導先・継続の約束・こちら側の状態・依頼ごとの道と答え／conductor-decided.ts） */
  decided: DecidedItem[];
  doubts: BriefDoubt[];
  /** 番の確かさ（conductor-doubt の SURE_CUES の重みの合計・人に回す線の案 handoff） */
  sure: { level: Sure; score: number; cues: SureCueKey[]; handoff: boolean };
  /** 作れなかった部品（欄の名前） */
  notYet: string[];
};

const FACT_BASES = new Set(["conversation", "material", "company_fact", "general"]);
const BASIS_JA: Record<string, string> = { conversation: "会話", material: "資料", company_fact: "会社の事実", general: "一般", judgement: "判断" };
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n = 60): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);


export function buildConductorBrief(meta: Record<string, unknown> | null | undefined): ConductorBrief {
  const m = meta ?? {};
  const inputs = (obj(m.conductor_brief_inputs) ?? {}) as BriefInputs;
  const notYet: string[] = [];
  const asks = arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is Record<string, unknown> => !!a);

  // ① 主の要件
  const main: ConductorBrief["main"] = asks.length
    ? { from: "turn_contract", items: asks.slice(0, 4).map((a) => ({ kind: str(a.kind, 12) ?? "?", quote: str(a.quote, 40) ?? "", topic: str(a.topic, 20) })) }
    : BRIEF_NONE;
  notYet.push("customer_part");
  if (main === BRIEF_NONE) notYet.push("main");

  // ② 答えに使う事実（出所つき）
  const factAsks = asks.filter((a) => FACT_BASES.has(String(a.basis)) && str(a.answer));
  const facts: ConductorBrief["facts"] = asks.length ? factAsks.slice(0, 4).map((a) => ({ quote: str(a.quote, 30) ?? "", value: str(a.answer, 60)!, from: BASIS_JA[String(a.basis)] ?? String(a.basis) })) : BRIEF_NONE;
  notYet.push("fact_id");
  if (facts === BRIEF_NONE) notYet.push("facts");

  // ③ 足りない情報
  const info = inputs.info ?? null;
  const missing: ConductorBrief["missing"] = info ? { node: info.node, keys: info.cells.filter((c) => c.state !== "known").map((c) => ({ key: c.key, state: c.state })) } : BRIEF_NONE;
  if (missing === BRIEF_NONE) notYet.push("missing");

  // ④ 照らし合わせの残り
  const ledger = inputs.ledger ?? null;
  const open: ConductorBrief["open"] = ledger ? ledger.open.slice(0, 5).map((o) => ({ kind: o.kind, what: o.what.slice(0, 40), overdue: o.overdue })) : BRIEF_NONE;
  if (open === BRIEF_NONE) notYet.push("open");

  // ⑤ 型・確認の順番・なぜ
  const typeId = typeof m.check_order_type === "string" ? m.check_order_type : null;
  const t = typeId ? checkOrderById(typeId) : null;
  const type: ConductorBrief["type"] = t ? { id: t.id, check: [...t.check], why: t.why.slice(0, 80), depth: `${CHECK_DEPTH[t.id]?.base ?? "?"}${CHECK_DEPTH[t.id]?.via ? `+${CHECK_DEPTH[t.id]!.via}` : ""}` } : BRIEF_NONE;
  if (type === BRIEF_NONE) notYet.push("type");

  // ⑥ 配分
  const ca = obj(m.conductor_allocation);
  const alloc: ConductorBrief["alloc"] = ca && typeof ca.name === "string" && Array.isArray(ca.parts) ? { name: ca.name, parts: (ca.parts as unknown[]).map(String) } : BRIEF_NONE;
  if (alloc === BRIEF_NONE) notYet.push("alloc");

  // ⑦ 組と順番
  const combine: ConductorBrief["combine"] = str(m.two_message_plan_digest, 40) ?? BRIEF_NONE;
  if (combine === BRIEF_NONE) notYet.push("combine");

  // ⑧ 次の一手（型の表・作業員7 の具体は未）
  const nm = t ? NEXT_MOVE_OF_TYPE[t.id]?.usual : null;
  const next: ConductorBrief["next"] = nm ? { dest: nm.dest, strength: nm.strength, timing: nm.timing, from: "type_table" } : BRIEF_NONE;
  notYet.push("next_concrete");

  // ⑨ 目的・要点（判断の根拠のメモと同じ名前）
  const jb = obj(m.judge_basis);
  const jbPurpose = str(jb?.purpose, 20);
  const keyPoint = str(jb?.key_point, 50) ?? str(jb?.keyPoint, 50);
  const aim: ConductorBrief["aim"] = jbPurpose ? { purpose: jbPurpose, purposeFrom: "judge_basis", keyPoint: keyPoint ?? BRIEF_NONE } : t ? { purpose: t.priority[0] ?? null, purposeFrom: "type_table", keyPoint: keyPoint ?? BRIEF_NONE } : { purpose: null, purposeFrom: null, keyPoint: keyPoint ?? BRIEF_NONE };
  if (aim.keyPoint === BRIEF_NONE) notYet.push("key_point");

  // ⑩ 疑いの印（下の役の答えを事実と突き合わせる・決め直さない）
  const doubts = briefDoubts(m, { asks, ledger, info, typeId });
  // ⑪ 確かさ
  const sure = briefSure(m, { doubts, info, typeId });
  // ⑫ 決めた事の台帳（作業員24 の根A）
  const decided = buildDecidedLedger(m, { openPromises: (ledger?.open ?? []).filter((o) => o.kind === "our_promise_unkept").map((o) => o.what) });
  return { main, facts, missing, open, type, alloc, combine, next, aim, decided, doubts, sure, notYet };
}

/** digest.cb の1行（判断の根拠と同じ名前: type・purpose・missing・open・doubt・sure） 例 "T4|p:confirm_promise|m:2|o:1|f:1|d:fact_missed|s:mid!|未:7"（! は人に回す線の案に当たった） */
export function conductorBriefDigest(v: unknown): string | null {
  const b = obj(v) as unknown as ConductorBrief | null;
  if (!b || !b.sure) return null;
  const n = (x: unknown) => (x === BRIEF_NONE ? "未" : Array.isArray(x) ? String(x.length) : x && typeof x === "object" && Array.isArray((x as { keys?: unknown }).keys) ? String((x as { keys: unknown[] }).keys.length) : "?");
  const ty = b.type === BRIEF_NONE ? "未" : b.type.id.split("_")[0];
  return [
    ty, `p:${b.aim?.purpose ?? "?"}`, `m:${n(b.missing)}`, `o:${n(b.open)}`, `f:${n(b.facts)}`,
    b.doubts.length ? `d:${b.doubts.map((d) => d.kind).join(",")}` : "d:-", `s:${b.sure.level}${b.sure.handoff ? "!" : ""}`, `未:${b.notYet.length}`,
  ].join("|").slice(0, 120);
}

/** 型の一覧（テスト用・型の表にある id だけ） */
export const BRIEF_TYPE_IDS: readonly string[] = CHECK_ORDER_TYPES.map((x) => x.id);
