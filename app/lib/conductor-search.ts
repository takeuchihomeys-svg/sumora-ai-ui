// app/lib/conductor-search.ts — 統括と連携した検索の1か所（純関数・DB/LLM なし）
//
// 2026-11-04 竹内さん（「RAG 検索もブレインと連携した RAG 検索、AIX-META と連携した RAG 検索のように」・KB P1 41dadfe6「基準は竹内さんだけ」）:
//   ① どの手本の倉庫を引くかを統括メタで決める（要らない倉庫は引かない）
//   ② 引いた後の絞り込みと並べ替えを統括メタで行う（場面・段階・一番の要点）。問いの文には混ぜない（d65330ad）
//   ③ 2番目以降の番は、前の番の要点とまだのやる事を問いの後ろに1行（carryQueryLine）
//   ④ 担当ごとに上位の数件だけ渡す
//   ⑤ 引いた手本の id と、どのメタの値で絞ったかを記録する（digest.cs）
//   ⑥ 竹内さん本人の手本を先に（writer=takeuchi）。足りない時だけ他を補い、補った事を記録する（基準にはしない）
// 各倉庫の引き口（判断の手本・竹内さんの文の手本・ナレッジ・AIX の札・2通目の手本・送付の記録）は今のままで、この1か所が「どれを引くか」と「並べ方」を決める。
// 切替: CONDUCTOR_SEARCH（既定 shadow＝今の引き口のまま、統括メタならこう引いた、を記録だけ）。テスト: app/lib/__tests__/conductor-search.test.ts
import type { ConductorRole } from "./conductor-handoff";
import { storesFor, rerankByMeta, carryQueryLine, type ConductorMeta, type MetaStore } from "./conductor-meta";

type Env = Record<string, string | undefined>;
export type SearchMode = "off" | "shadow" | "on";
export function conductorSearchMode(env: Env = typeof process !== "undefined" ? process.env : {}): SearchMode {
  const v = (env.CONDUCTOR_SEARCH ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}

/** 担当ごとに渡す上位の件数 */
const TOP_K: Partial<Record<ConductorRole, number>> = { line: 3, compose: 3, writer: 3, aix_desk: 3, second: 2, fetch: 5 };

export type SearchPlan = { role: ConductorRole; stores: MetaStore[]; topK: number; querySuffix: string };
/** 引き方の計画（問いの文はお客様の発言・状況のまとめのまま。後ろに足すのは前の番の1行だけ） */
export function searchPlan(meta: ConductorMeta, role: ConductorRole): SearchPlan {
  return { role, stores: meta.stores[role] ?? storesFor(role, meta.scene), topK: TOP_K[role] ?? 3, querySuffix: carryQueryLine(meta) };
}

export type SearchHit = { id: string; store: MetaStore; score?: number; scene?: string | null; stage?: string | null; text?: string | null; writer?: string | null };
export type SearchPick = { hits: SearchHit[]; takeuchiN: number; filledByOthers: number; digest: string };
/** 引いた物を、竹内さん本人を先に・統括メタで並べ替え・上位 k 件に（他の書き手で補った数も返す） */
export function pickHits(all: ReadonlyArray<SearchHit>, meta: ConductorMeta, plan: SearchPlan, mainPoint?: string | null): SearchPick {
  const inStores = all.filter((h) => plan.stores.includes(h.store));
  const tk = rerankByMeta(inStores.filter((h) => h.writer === "takeuchi"), meta, mainPoint ?? null, plan.topK);
  const rest = tk.length < plan.topK ? rerankByMeta(inStores.filter((h) => h.writer !== "takeuchi"), meta, mainPoint ?? null, plan.topK - tk.length) : [];
  const hits = [...tk, ...rest];
  const ids = hits.map((h) => `${h.store.slice(0, 2)}:${h.id.slice(0, 8)}`).join(",");
  return { hits, takeuchiN: tk.length, filledByOthers: rest.length, digest: `${plan.role}|${plan.stores.join("+") || "-"}|tk${tk.length}${rest.length ? `+o${rest.length}` : ""}|${ids}` };
}

/** 今の引き口が引いた物と、統括メタの計画とのずれ（shadow の記録）: 計画に無い倉庫を引いた／計画の倉庫を引かなかった */
export function storeDiff(planStores: ReadonlyArray<MetaStore>, usedStores: ReadonlyArray<MetaStore>): { extra: MetaStore[]; missing: MetaStore[] } {
  return { extra: usedStores.filter((s) => !planStores.includes(s)), missing: planStores.filter((s) => !usedStores.includes(s)) };
}
