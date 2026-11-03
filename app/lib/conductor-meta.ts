// app/lib/conductor-meta.ts — 統括メタ（番の最初に1つだけ書く記録）・統括メタと連携した検索の倉庫の選び／並べ替え・材料の1か所の配り口（純関数・DB/LLM なし）
//
// 2026-11-04 竹内さん（KB P1「統括を人間の脳の形に」「AIX-META の作りを手本に」「統括と連携した検索」）・設計案 conductor-brain-shape.md 追記4。
//   第1段（この版）: 決まった計算で統括メタを作り、last_brain_meta.conductor_meta と digest.cm に残すだけ（本番の文と判断は変えない）。
//   入口の DeepSeek の読み・担当を絞る・材料の配り口を実際に使うのは次の段（了承の後）。
// 決まり（AIX-META の手本）:
//   ・値は決まった言葉だけ（列挙の型・normalize で列挙に無い値は捨てる・0699d95d）
//   ・RAG の問いの文にメタの言葉を混ぜない。絞り込みと並べ替えにだけ使う（d65330ad）
//   ・2番目以降の番は、前の番のメタの要点とまだのやる事を問いに足す（da714016）
//   ・分析の言葉を本文の素材にしない（3b99af61）＝書き手にはメタを渡さない
// 切替: CONDUCTOR_META（既定 shadow＝記録だけ・off で止める）。テスト: app/lib/__tests__/conductor-meta.test.ts
import type { ReplyScene } from "./reply-scene";
import type { ConductorRole } from "./conductor-handoff";
import { NEED_TOOLS, type NeedTool } from "./brain-need";

type Env = Record<string, string | undefined>;
export type ConductorMetaMode = "off" | "shadow" | "on";
export function conductorMetaMode(env: Env = typeof process !== "undefined" ? process.env : {}): ConductorMetaMode {
  const v = (env.CONDUCTOR_META ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}

/** 手本・材料の倉庫（統括メタで、どれを引くかを決める） */
export const META_STORES = ["judge_examples", "takeuchi_compose", "knowledge", "aix_cards", "second_examples", "sent_properties", "design_kb"] as const;
export type MetaStore = typeof META_STORES[number];

export type ConductorMeta = {
  v: 1;
  /** この番のお客様の発言の時刻（鮮度の鍵） */
  turnAt: string | null;
  scene: ReplyScene;
  stage: string | null;
  /** 動かす担当（候補の網・決まった計算） */
  roles: ConductorRole[];
  /** 呼ばずに済む担当 */
  skipped: ConductorRole[];
  /** 引く倉庫（担当ごと） */
  stores: Partial<Record<ConductorRole, MetaStore[]>>;
  /** 要る材料（NEED_TOOLS の名前だけ） */
  need: NeedTool[];
  /** 前の番の要点・まだのやる事（2番目以降の番の問いに足す） */
  carry: { mainPoint: string | null; pending: string[] } | null;
  confidence: "high" | "mid" | "low";
  source: "rule";
  /** 2026-11-04 ② 材料の1か所の配り口: 担当ごとに配る事実の数（記録だけ・事実の帳面から materialFor で） */
  materials?: Partial<Record<ConductorRole, number>>;
};

const LIGHT_SCENES: ReadonlySet<ReplyScene> = new Set(["ack"]);
/** 担当ごとに引く倉庫（要らない倉庫は引かない） */
export function storesFor(role: ConductorRole, scene: ReplyScene): MetaStore[] {
  switch (role) {
    case "line": return LIGHT_SCENES.has(scene) ? [] : ["judge_examples", "knowledge"];
    case "aix_desk": return ["aix_cards"];
    case "second": return ["second_examples"];
    case "compose": case "writer": return ["takeuchi_compose"];
    case "fetch": return scene === "property_share" || scene === "conditions" ? ["sent_properties"] : [];
    default: return [];
  }
}

export function buildConductorMeta(o: {
  scene: ReplyScene; stage: string | null; turnAt: string | null;
  roles: { call: ConductorRole[]; skip: ConductorRole[] };
  need?: ReadonlyArray<string> | null;
  prevMeta?: Record<string, unknown> | null;
  openPromises?: ReadonlyArray<string>;
}): ConductorMeta {
  const need = [...new Set((o.need ?? []).filter((x): x is NeedTool => (NEED_TOOLS as readonly string[]).includes(String(x))))];
  const call: ConductorRole[] = ["line", ...o.roles.call.filter((r) => r !== "line")];
  const stores: ConductorMeta["stores"] = {};
  for (const r of call) { const s = storesFor(r, o.scene); if (s.length) stores[r] = s; }
  const prevMain = typeof o.prevMeta?.main_point === "string" ? (o.prevMeta.main_point as string) : null;
  const pending = [...(o.openPromises ?? [])].slice(0, 3);
  return {
    v: 1, turnAt: o.turnAt, scene: o.scene, stage: o.stage, roles: call, skipped: o.roles.skip, stores, need,
    carry: prevMain || pending.length ? { mainPoint: prevMain, pending } : null,
    confidence: LIGHT_SCENES.has(o.scene) ? "high" : need.length ? "low" : "mid",
    source: "rule",
  };
}

/** 2番目以降の番の問いに足す1行（問いの文はお客様の発言・状況のまとめのまま・これは後ろに足すだけ） */
export function carryQueryLine(m: ConductorMeta | null | undefined): string {
  if (!m?.carry) return "";
  return [m.carry.mainPoint ? `前の番の要点: ${m.carry.mainPoint}` : "", m.carry.pending.length ? `まだのやる事: ${m.carry.pending.join("・")}` : ""].filter(Boolean).join("／");
}

/** 引いた後の並べ替え（メタは問いに混ぜず、ここで使う）。場面が同じ・段階が同じ・要点の語を含む物を上に */
export function rerankByMeta<T extends { scene?: string | null; stage?: string | null; text?: string | null; score?: number }>(items: ReadonlyArray<T>, m: ConductorMeta, mainPoint?: string | null, topK = 3): T[] {
  const core = (mainPoint ?? "").replace(/[\s、。・「」]/g, "").slice(0, 6);
  return items.map((x, i) => ({ x, i, s: (x.score ?? 0) + (x.scene === m.scene ? 0.2 : 0) + (m.stage && x.stage === m.stage ? 0.1 : 0) + (core && String(x.text ?? "").replace(/\s/g, "").includes(core) ? 0.1 : 0) }))
    .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, topK).map((v) => v.x);
}

/** 材料の1か所の配り口: 担当ごとに渡す帳面の事実の種類（表に無い物は渡さない） */
const ROLE_FACT_KINDS: Partial<Record<ConductorRole, ReadonlyArray<string>>> = {
  line: ["stage", "property", "viewing", "promise", "done", "memo", "plan", "worry", "emotion"],
  aix_desk: ["property", "promise", "done", "viewing"],
  compose: ["stage", "worry", "plan"],
  writer: ["stage", "worry"],
  second: ["property", "worry"],
};
export function materialFor<F extends { kind: string }>(role: ConductorRole, facts: ReadonlyArray<F>): F[] {
  const kinds = ROLE_FACT_KINDS[role];
  return kinds ? facts.filter((f) => kinds.includes(f.kind)) : [];
}

/** ② 担当ごとに配る材料の数（統括・判断・AIX の統括・文に同じ帳面から配る）。記録だけの段では数だけを残す */
export function materialsByRole<F extends { kind: string }>(roles: ReadonlyArray<ConductorRole>, facts: ReadonlyArray<F>): Partial<Record<ConductorRole, number>> {
  const out: Partial<Record<ConductorRole, number>> = {};
  for (const r of new Set<ConductorRole>(["line", "aix_desk", ...roles])) out[r] = materialFor(r, facts).length;
  return out;
}

/** 統括メタに配った材料の数を足す */
export function withMaterials<F extends { kind: string }>(m: ConductorMeta, facts: ReadonlyArray<F>): ConductorMeta {
  return facts.length ? { ...m, materials: materialsByRole(m.roles, facts) } : m;
}

/** digest.cm（短い形）: "場面|担当|倉庫の数|自信" */
export function conductorMetaDigest(m: ConductorMeta | null | undefined): string | null {
  if (!m) return null;
  const roleShort: Record<string, string> = { line: "ln", aix_desk: "ad", compose: "cp", writer: "wr", check: "ck", fetch: "fe", deep: "dp", second: "s2" };
  const storesN = Object.values(m.stores).reduce((a, s) => a + (s?.length ?? 0), 0);
  return `${m.scene}|${m.roles.map((r) => roleShort[r] ?? r).join(",")}|st${storesN}|${m.confidence[0]}`;
}
