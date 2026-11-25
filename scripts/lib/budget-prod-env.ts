// scripts/lib/budget-prod-env.ts — 毎朝の1枚の「API の使用額」の切り替えの状態を、手元の env ではなく本番のスイッチの組（prod-env.json）で読む（純関数・2026-11-25 作業員L・統括役の頼み）
//   11/25 18:43 の 1枚に「LLM_BUDGET_ROUTE=off」と出た＝手元の env／古い作業ツリーで読んでいた（本番は既定 on・OpenAI に回している）。
//   使用額の数え（monthSums）と切り替えの決め（readBudgetConfig）に同じ env を渡す＝本番の振り分け（budgetDecisionFor）と同じ数になる
import { join } from "node:path";
import { examCacheRoot } from "./llm-cassette";
import { readProdEnvCache } from "./exam-prod-env";

/** 使用額と切り替えの名前（これだけは手元の env を捨てて本番の値＝無ければコードの既定にする） */
export const BUDGET_ENV_RE = /^(LLM_BUDGET_|CLAUDE_SPEND_|CLAUDE_SWITCH_|CLAUDE_CREDIT_|CLAUDE_MONTH_CREDIT_|CLAUDE_COST_FACTOR|OPENAI_ALLOWANCE_|OPENAI_STOP_SHARE|OPENAI_CREDIT_|OPENAI_MONTH_CREDIT_)/;

export function budgetEnvFrom(local: Record<string, string | undefined>, prod: Record<string, string> | null): { env: Record<string, string | undefined>; dropped: string[]; from: "prod" | "local" } {
  if (!prod) return { env: local, dropped: [], from: "local" };
  const env: Record<string, string | undefined> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(local)) { if (BUDGET_ENV_RE.test(k)) { if (prod[k] !== v) dropped.push(k); } else env[k] = v; }
  for (const [k, v] of Object.entries(prod)) if (BUDGET_ENV_RE.test(k)) env[k] = v;
  return { env, dropped: dropped.sort(), from: "prod" };
}

/** 本番の控え（exam-queue/prod-env.json）。無ければ null＝手元の env のまま */
export function readBudgetProdEnv(file = join(examCacheRoot(), "exam-queue", "prod-env.json")): { env: Record<string, string>; hash: string; lastSeenAt: string | null } | null {
  const c = readProdEnvCache(file);
  return c ? { env: c.env, hash: c.hash, lastSeenAt: c.lastSeenAt ?? null } : null;
}
