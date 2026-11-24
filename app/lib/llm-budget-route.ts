// app/lib/llm-budget-route.ts — 月の Claude の使用額で、係ごとに Claude ⇄ OpenAI を振り分ける決まり（純関数・DB なし）
//
// 2026-11-24 作業員L（台帳 #670・竹内さん 11/24「Claude はあと $25 使ったら OpenAI に切り替えるのが理想」・統括役の仕様）
//   ・Claude の月の特典 $200・OpenAI の月の特典 $100（env CLAUDE_MONTH_CREDIT_USD・OPENAI_MONTH_CREDIT_USD）
//   ・今月の Claude の使用額 = 基準（竹内さんの画面の値 CLAUDE_SPEND_BASE_USD・その時刻 CLAUDE_SPEND_BASE_AT）
//       ＋ 基準の時刻より後の llm_usage_logs の Claude の行の費用（llm-price.claudeUsageUsd）× 補正 CLAUDE_COST_FACTOR（既定 1・Console と合わない分）
//     （11/24 10:19 の画面: 今月 $291.71）。基準が無い時は 月初からの行の合計 × 補正
//   ・切り替えの線 CLAUDE_SWITCH_AT_USD（既定は未設定＝切り替えない）。線を超えたら、係の表（BUDGET_ROLE_TABLE）にある係だけ OpenAI に回す
//   ・LLM_BUDGET_ROUTE: 既定 off（何もしない）／shadow（決めた結果をログに出すだけ・Claude のまま）／on（回す）
//   ・OpenAI の呼び出しが失敗した時に Claude に戻すかは係ごと（fallbackToClaude）。下書きが出ない事を避けるため、お客様に届く文の係は戻す
//   ・費用の数えは5分の控え（llm-budget-route-server.ts）。毎回 DB を数えない
// テスト: app/lib/__tests__/llm-budget-route.test.ts

type Env = Record<string, string | undefined>;

export type BudgetRole = "brain" | "conductor" | "writer" | "final_check" | "light";
export type BudgetRoleSpec = { model: string; fallbackToClaude: boolean; why: string };

/**
 * 係ごとの OpenAI のモデル（案・決めるのは統括役）。値段は llm-price.ALT_PRICES（公式 11/24）。
 *   ブレイン・統括・書き手・最終チェック: gpt-6.2-sol（$2/$0.10/$10）。Astra（$8/$0.40/$40）は4倍なので、試験で Sol の外れが多い時だけ（LLM_BUDGET_ROLE_MODELS で替える）
 *   軽い係（分類・判定・前処理）: gpt-6-luna（$0.10/$0.01/$0.50）
 *   失敗の時: 全部 Claude に戻す（下書きが出ないのを避ける・竹内さんの「下書きが出ないことは避ける」）
 */
export const BUDGET_ROLE_TABLE: Readonly<Record<BudgetRole, BudgetRoleSpec>> = {
  brain: { model: "gpt-6.2-sol", fallbackToClaude: true, why: "判断の核・試験で一致を測ってから" },
  conductor: { model: "gpt-6.2-sol", fallbackToClaude: true, why: "統括の受け口・材料の取りまとめ" },
  writer: { model: "gpt-6.2-sol", fallbackToClaude: true, why: "お客様に届く文・失敗は必ず Claude で書き直す" },
  final_check: { model: "gpt-6.2-sol", fallbackToClaude: true, why: "送る前の確かめ・止まると下書きが出ない" },
  light: { model: "gpt-6-luna", fallbackToClaude: true, why: "分類・判定・前処理（量が多く安い物で足りる）" },
};

/** 軽い係に入れる名札（判定・分類・前処理だけ。お客様に届く本文・物件の読み取りは入れない） */
export const LIGHT_ROUTES: ReadonlySet<string> = new Set([
  "resolve_area", "suggest_next_action", "classify_condition", "recommend_templates", "reply_example_learn", "reply_anatomy",
]);

/** 名札 → 係（表に無い名札は null＝Claude のまま） */
export function budgetRoleOf(routeName: string | null | undefined): BudgetRole | null {
  const n = String(routeName ?? "").trim();
  if (!n) return null;
  if (n.endsWith("_claude")) return null; // 名前で Claude に固定した部品
  if (n === "brain" || n.startsWith("brain_")) return "brain";
  if (n.startsWith("conductor_")) return "conductor";
  if (n === "reply_generate" || n === "reply_generate_flash") return "writer";
  if (n.startsWith("final_check")) return "final_check";
  if (LIGHT_ROUTES.has(n)) return "light";
  return null;
}

export type BudgetMode = "off" | "shadow" | "on";
export type BudgetConfig = {
  mode: BudgetMode;
  switchAtUsd: number | null;
  baseUsd: number | null;
  baseAt: string | null;
  factor: number;
  claudeCreditUsd: number;
  openaiCreditUsd: number;
  models: Partial<Record<BudgetRole, string>>;
};
const numOr = (v: string | undefined, d: number | null): number | null => {
  const s = String(v ?? "").trim();
  if (!s) return d;
  const n = Number(s);
  return Number.isFinite(n) ? n : d;
};
export function readBudgetConfig(env: Env = typeof process !== "undefined" ? process.env : {}): BudgetConfig {
  const m = String(env.LLM_BUDGET_ROUTE ?? "").trim().toLowerCase();
  const models: Partial<Record<BudgetRole, string>> = {};
  for (const part of String(env.LLM_BUDGET_ROLE_MODELS ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => (x ?? "").trim());
    if (k && v && k in BUDGET_ROLE_TABLE) models[k as BudgetRole] = v;
  }
  const baseAt = String(env.CLAUDE_SPEND_BASE_AT ?? "").trim();
  return {
    mode: m === "on" ? "on" : m === "shadow" ? "shadow" : "off",
    switchAtUsd: numOr(env.CLAUDE_SWITCH_AT_USD, null),
    baseUsd: numOr(env.CLAUDE_SPEND_BASE_USD, null),
    baseAt: baseAt && Number.isFinite(Date.parse(baseAt)) ? new Date(baseAt).toISOString() : null,
    factor: numOr(env.CLAUDE_COST_FACTOR, 1) ?? 1,
    claudeCreditUsd: numOr(env.CLAUDE_MONTH_CREDIT_USD, 200) ?? 200,
    openaiCreditUsd: numOr(env.OPENAI_MONTH_CREDIT_USD, 100) ?? 100,
    models,
  };
}

/** 数え始めの時刻: 基準の時刻が今月なら基準から・無ければ月初（UTC・Console の月と同じ） */
export function spendWindowStart(cfg: Pick<BudgetConfig, "baseAt" | "baseUsd">, nowMs: number): { since: string; useBase: boolean } {
  const d = new Date(nowMs);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const baseMs = cfg.baseAt ? Date.parse(cfg.baseAt) : NaN;
  if (cfg.baseUsd != null && Number.isFinite(baseMs) && baseMs >= monthStart && baseMs <= nowMs) return { since: new Date(baseMs).toISOString(), useBase: true };
  return { since: new Date(monthStart).toISOString(), useBase: false };
}

/** 今月の Claude の使用額（基準＋基準の後の行の費用×補正） */
export function claudeMonthSpendUsd(cfg: Pick<BudgetConfig, "baseUsd" | "factor">, o: { useBase: boolean; sinceUsd: number }): number {
  return (o.useBase ? cfg.baseUsd ?? 0 : 0) + o.sinceUsd * cfg.factor;
}

export type BudgetDecision = { route: "claude" | "openai"; role: BudgetRole | null; model: string | null; fallbackToClaude: boolean; reason: string; shadow: boolean };

/** 係ごとの振り分け（mode が off・線が無い・表に無い名札・線の手前は Claude） */
export function budgetDecision(routeName: string | null | undefined, spendUsd: number | null, cfg: BudgetConfig): BudgetDecision {
  const role = budgetRoleOf(routeName);
  const claude = (reason: string): BudgetDecision => ({ route: "claude", role, model: null, fallbackToClaude: true, reason, shadow: false });
  if (cfg.mode === "off") return claude("LLM_BUDGET_ROUTE=off");
  if (cfg.switchAtUsd == null) return claude("CLAUDE_SWITCH_AT_USD が無い");
  if (!role) return claude("表に無い名札");
  if (spendUsd == null || !Number.isFinite(spendUsd)) return claude("使用額が読めない");
  if (spendUsd < cfg.switchAtUsd) return claude(`使用額 $${spendUsd.toFixed(2)} < 線 $${cfg.switchAtUsd}`);
  const spec = BUDGET_ROLE_TABLE[role];
  const d: BudgetDecision = { route: "openai", role, model: cfg.models[role] ?? spec.model, fallbackToClaude: spec.fallbackToClaude, reason: `使用額 $${spendUsd.toFixed(2)} ≥ 線 $${cfg.switchAtUsd}`, shadow: cfg.mode === "shadow" };
  return d;
}

/** 毎朝の1枚の1行: 今月の使用額と月末の見込み（日割り）。特典の残り */
export function monthSpendLine(o: { provider: string; spendUsd: number; creditUsd: number; nowMs: number }): { provider: string; spendUsd: number; forecastUsd: number; creditUsd: number; overCredit: boolean } {
  const d = new Date(o.nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const frac = Math.min(Math.max((o.nowMs - start) / (end - start), 1e-6), 1);
  const forecast = o.spendUsd / frac;
  return { provider: o.provider, spendUsd: Math.round(o.spendUsd * 100) / 100, forecastUsd: Math.round(forecast * 100) / 100, creditUsd: o.creditUsd, overCredit: forecast > o.creditUsd };
}
