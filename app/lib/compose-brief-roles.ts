// app/lib/compose-brief-roles.ts — 統括の指示書（meta.conductor_brief）の役目ごとの欄を、文の設計図の行と書き手への注記に渡す（COMPOSE_BRIEF_ROLES・既定 off・純関数）
//   作業員10・2026-11-13（統括役「briefForRole の役目ごとの欄を文の統括と書き手のプロンプトに渡す配線。next_concrete も、つなぎと締めの行の材料に」）
//
// ■ 何をするか
//   ① 文の統括（compose-plan-rows-v2 の buildPlanRowsV2）: 次の一手の具体（next_concrete.steps の先頭）を、つなぎ・締めの行の材料（uses）にする
//      - つなぎ: 何を（item）を aim.next に。物件名・日時は作らない（next_concrete が材料の言葉だけを持つ）
//      - 締め: お客様の言った時期（when.at=customer かつ word）がある時は their_timing にしてその言葉で結ぶ。他は aim.next_when に
//   ② 書き手: 行ごとに、その役目に要る指示書の欄だけ（作業員16 の briefForRole・decided-subfields の役目の表が正）を短い1行で添える
// ■ 決まり: 道（返信か AIX か）は変えない。指示書が無い・欄が「未」の時は何も足さない。値は指示書の値のまま（文は写さない）
import { briefForRole, BRIEF_NONE, type ConductorBrief } from "./conductor-brief";
import type { SubRole } from "./decided-subfields";
import type { PlanRowV2 } from "./compose-plan-rows-v2";
import type { ConcreteStep } from "./next-move-concrete";

type Env = Record<string, string | undefined>;
export function composeBriefRolesOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_BRIEF_ROLES ?? "").trim().toLowerCase() === "on";
}
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const briefOf = (meta: unknown): ConductorBrief | null => (obj(obj(meta)?.conductor_brief) as unknown as ConductorBrief | null) ?? null;

/** 指示書の次の一手の具体の先頭の1歩（無い・未なら null） */
export function nextStepOf(meta: unknown): ConcreteStep | null {
  const nc = briefOf(meta)?.next_concrete;
  if (!nc || nc === BRIEF_NONE || !Array.isArray(nc.steps)) return null;
  return nc.steps[0] ?? null;
}

/** ① つなぎ・締めの行に次の一手の具体を材料として足す（行の中身を書き換えるのはここだけ・行を新しく立てない） */
export function applyNextConcreteToRows(rows: PlanRowV2[], meta: unknown): void {
  const st = nextStepOf(meta);
  if (!st) return;
  const nc = briefOf(meta)!.next_concrete as Exclude<ConductorBrief["next_concrete"], typeof BRIEF_NONE | undefined>;
  for (const r of rows) {
    if (r.role === "bridge") {
      if (st.item && st.what !== "none" && st.what !== "wait_contact" && !r.uses.some((u) => u.field === "aim.next")) r.uses.push({ field: "aim.next", value: st.item });
      r.stand.push(`next_concrete:${nc.from}`);
    } else if (r.role === "close") {
      if (st.when.at === "customer" && st.when.word) {
        if (r.sub !== "their_timing") { r.sub = "their_timing"; r.uses = [{ field: "latent.expect", value: st.when.word }]; r.how = "お客様の言った時期で結ぶ（例: 〇〇のご連絡お待ちしております）"; }
      } else if (!r.uses.some((u) => u.field === "aim.next_when")) r.uses.push({ field: "aim.next_when", value: st.when.word ?? st.when.at });
      r.stand.push(`next_concrete:${nc.from}`);
    }
  }
}

/** 指示書の欄の短い言い方（値のまま・長さを切る） */
const cut = (s: unknown, n = 40) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
function sectionLine(k: string, v: unknown): string | null {
  const o = obj(v);
  const a = Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : [];
  switch (k) {
    case "main": return o && Array.isArray(o.items) ? `主の要件: ${(o.items as unknown[]).map(obj).map((x) => cut(x?.quote, 24)).join("・")}` : null;
    case "facts": return a.length ? `事実: ${a.slice(0, 3).map((x) => `${cut(x.value, 30)}（${cut(x.from, 8)}${x.certainty ? `・${x.certainty}` : ""}）`).join("・")}` : null;
    case "split": return a.length ? `今言える／確認: ${a.slice(0, 2).map((x) => `${cut(x.now ?? "-", 20)}／${cut(x.check ?? "-", 20)}`).join("・")}` : null;
    case "missing": return o && Array.isArray(o.keys) ? `足りない: ${(o.keys as unknown[]).map(obj).slice(0, 4).map((x) => cut(x?.key, 16)).join("・")}` : null;
    case "fetch": return a.length ? `取りに行く先: ${a.slice(0, 3).map((x) => `${cut(x.label, 16)}→${cut(x.to, 10)}`).join("・")}` : null;
    case "open": return a.length ? `開いている約束: ${a.slice(0, 3).map((x) => cut(x.what, 24)).join("・")}` : null;
    case "type": return o ? `型: ${cut(o.id, 30)}` : null;
    case "order": return o ? `先に: ${cut(o.first, 16)}（${cut(o.why_tag, 16)}）` : null;
    case "combine": return o ? `組: ${cut(o.combo, 30)}` : null;
    case "next": return o ? `次の一手: ${cut(o.dest, 16)}・${cut(o.strength, 10)}` : null;
    case "next_concrete": { const s = o && Array.isArray(o.steps) ? (o.steps as unknown[]).map(obj).filter((x): x is Record<string, unknown> => !!x) : []; return s.length ? `次の一手の具体: ${s.slice(0, 2).map((x) => `${cut(x.item, 24)}（${cut(obj(x.when)?.word ?? obj(x.when)?.at, 10)}）`).join("・")}` : null; }
    case "aim": return o ? `目的: ${cut(o.purpose ?? "-", 20)}${o.mid && o.mid !== BRIEF_NONE ? `・中期: ${cut(o.mid, 20)}` : ""}` : null;
    default: return null;
  }
}
/** 役目ごとに要る欄だけの1行（briefForRole） */
export function briefLineForRole(meta: unknown, role: SubRole): string | null {
  const b = briefOf(meta);
  if (!b) return null;
  const parts = Object.entries(briefForRole(b, role)).map(([k, v]) => sectionLine(k, v)).filter((x): x is string => !!x);
  return parts.length ? parts.join("／").slice(0, 220) : null;
}
/** ② 書き手への注記: 設計図の行ごとの役目に要る指示書の欄（on の時だけ・同じ役目は1回） */
export function briefRolesNote(rows: ReadonlyArray<PlanRowV2>, meta: unknown, env?: Env): string {
  if (!composeBriefRolesOn(env) || !rows.length || !briefOf(meta)) return "";
  const seen = new Set<string>();
  const L: string[] = [];
  for (const r of rows) {
    if (seen.has(r.role)) continue; seen.add(r.role);
    const line = briefLineForRole(meta, r.role as SubRole);
    if (line) L.push(`  ${r.role}: ${line}`);
  }
  return L.length ? `- 統括の指示書（行の役目ごとに要る欄だけ・値はそのまま使い、無い事は足さない）:\n${L.join("\n")}` : "";
}
