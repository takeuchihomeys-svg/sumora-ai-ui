// app/lib/conductor-todos.ts — 番ごとのやる事の一覧と考える力の配分を、判断の記録に残す（弱い所 275・作業員5・11/07・既定 off・純関数）
//   conductor-roles.ts の initTurnTodos・todoDigest・thinkBudget（KB P0 4b0d868e ②④）は作ってあったが、呼ぶ所が無かった。
//   ここは記録だけ（判断・文・呼ぶ LLM は変えない）。digest.td（やる事 済み/全部）・digest.tb（考える力の配分）。CONDUCTOR_TODOS=on で記録
import { initTurnTodos, todoDigest, thinkBudget } from "./conductor-roles";

type Env = Record<string, string | undefined>;
export const conductorTodosOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_TODOS ?? "").trim().toLowerCase() === "on";

const ROUTES = new Set(["reply", "promise", "aix", "none"]);
/** ブレインの答え（turn_contract の生の asks・最終の AIX・need）から、やる事の一覧の digest と考える力の配分 */
export function turnTodosRecord(o: { asks: unknown; finalAix: string | null; need: { difficulty?: string | null; confidence?: string | null; missing?: ReadonlyArray<string> } | null }): { td: string | null; tb: string } {
  const asks = (Array.isArray(o.asks) ? o.asks : []).map((a) => a as { quote?: unknown; route?: unknown })
    .filter((a) => typeof a?.quote === "string" && ROUTES.has(String(a.route)))
    .map((a) => ({ what: String(a.quote), route: String(a.route) as "reply" | "promise" | "aix" | "none" }));
  const todos = initTurnTodos({ asks, finalAction: o.finalAix ?? "reply", missing: o.need?.missing ?? [] });
  const b = thinkBudget(o.need);
  return { td: todoDigest(todos), tb: `${b.conductor}${b.thinkingTokens ? `:${b.thinkingTokens}` : ""}` };
}
