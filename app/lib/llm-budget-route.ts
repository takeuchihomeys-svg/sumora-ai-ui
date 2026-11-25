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

export type BudgetRole = "brain" | "conductor" | "writer" | "final_check" | "light" | "learn";
export type BudgetRoleSpec = { model: string; fallbackToClaude: boolean; why: string };

/**
 * 係ごとの OpenAI のモデル（案・決めるのは統括役）。値段は llm-price.ALT_PRICES（公式 11/24）。
 *   ブレイン・統括・書き手・最終チェック: gpt-6.2-sol（$2/$0.10/$10）。Astra（$8/$0.40/$40）は4倍なので、試験で Sol の外れが多い時だけ（LLM_BUDGET_ROLE_MODELS で替える）
 *   軽い係（分類・判定・前処理）: gpt-6-luna（$0.10/$0.01/$0.50）
 *   失敗の時: 全部 Claude に戻す（下書きが出ないのを避ける・竹内さんの「下書きが出ないことは避ける」）
 */
export const BUDGET_ROLE_TABLE: Readonly<Record<BudgetRole, BudgetRoleSpec>> = {
  // 2026-11-25 竹内さんの決め（案 A）: brain は brain-sweep（裏の読み直し）の時だけ・本番のブレインは Claude のまま（budgetRoleOf の ctx.httpRoute で見る）
  brain: { model: "gpt-6.2-sol", fallbackToClaude: true, why: "brain-sweep の裏の読み直しだけ（お客様を待たせない）" },
  conductor: { model: "gpt-6.1-terra", fallbackToClaude: true, why: "統括の受け口・材料の取りまとめ（分類に近い）" },
  writer: { model: "gpt-6.2-sol", fallbackToClaude: true, why: "お客様に届く文・失敗は必ず Claude で書き直す" },
  final_check: { model: "gpt-6.1-terra", fallbackToClaude: true, why: "送る前の確かめ（文を書き直す revision は入れない）・止まると下書きが出ない" },
  light: { model: "gpt-6-luna", fallbackToClaude: true, why: "分類・判定・前処理（今 Haiku の係・量が多く安い物で足りる）" },
  learn: { model: "gpt-6.1-terra", fallbackToClaude: true, why: "学び・分類・判定（今 Sonnet・Opus の係・文の質に直接出ない）" },
};

/** 軽い係に入れる名札（判定・分類・前処理だけ。お客様に届く本文・物件の読み取りは入れない） */
export const LIGHT_ROUTES: ReadonlySet<string> = new Set([
  "resolve_area", "suggest_next_action", "classify_condition", "recommend_templates", "reply_example_learn", "reply_anatomy",
]);

/** 2026-11-25 竹内さんの決め（案 A）: 学び・分類・判定の名札（文の質に直接出ない）。今 Haiku の係は light（Luna）・Sonnet と Opus の係は learn（Terra） */
const LEARN_RE = /^(?:reply_example_learn|learn_|knowledge_bulk_judge|extract_estimate|resolve_area|classify_|aix_usage_gap_learn|aix_desk_(?:consult|command)|suggest_next_action|recommend_templates|reply_anatomy)/;
/** お客様に届く文を書く係・画像の読み・キャッシュを温める呼び出し（案 A は Claude のまま＝OpenAI に回さない） */
const KEEP_CLAUDE_RE = /vision|image|warm|^reply_generate|^aix_template|^property_|^final_check_revision|^aix_brain|^viewing_|^estimate_sheet|^cost_|^condition_hearing|^application_push|^followup_|^acknowledge_|^meeting_|^guarantor_|^phone_|^greeting_|^docs_request|^zenryoku_/;
/** 名札 → 係（表に無い名札は null＝Claude のまま）。ctx.httpRoute＝リクエストの経路・ctx.claudeModel＝元の Claude のモデル */
export function budgetRoleOf(routeName: string | null | undefined, ctx: { httpRoute?: string | null; claudeModel?: string | null; piiWriter?: boolean } = {}): BudgetRole | null {
  const n = String(routeName ?? "").trim();
  if (!n) return null;
  if (n.endsWith("_claude")) return null; // 名前で Claude に固定した部品
  // 個人情報の歯止めの番の書き手だけ（ctx.piiWriter・budgetPiiToOpenAIOn の時）
  if (ctx.piiWriter && (n === "reply_generate" || n === "reply_generate_flash")) return "writer";
  if (KEEP_CLAUDE_RE.test(n)) return null;
  if (n === "brain" || n.startsWith("brain_")) return /\/api\/cron\/brain-sweep/.test(String(ctx.httpRoute ?? "")) ? "brain" : null;
  const haiku = /haiku/.test(String(ctx.claudeModel ?? ""));
  if (n.startsWith("conductor_")) return "conductor";
  if (n.startsWith("final_check")) return haiku ? "light" : "final_check";
  if (LIGHT_ROUTES.has(n) || LEARN_RE.test(n)) return haiku ? "light" : "learn";
  return null;
}

export type BudgetMode = "off" | "shadow" | "on";
export type BudgetConfig = {
  mode: BudgetMode;
  switchAtUsd: number | null;
  baseUsd: number | null;
  baseAt: string | null;
  /** 2026-11-25 竹内さん「次の $200 の特典が入るのは 12/10」: 使用額の区切りの日（毎月この日の JST 0時から・CLAUDE_CREDIT_RESET_DAY・既定 10） */
  resetDay: number;
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
export const CLAUDE_SWITCH_AT_USD_DEFAULT = 316.71;
/**
 * 2026-11-25 竹内さんの決め（11/25 昼）「申込以降や審査関係も OpenAI に回って大丈夫」（OpenAI の共有＝学習は無効にした）: 線を超えている間、
 *   個人情報の歯止めで Claude にしていた番（申込以降・時刻の線・審査の事情・申込の値）を OpenAI に回す。DeepSeek には今まで通り回さない（この口は OpenAI だけ）。
 *   既定 on・LLM_BUDGET_PII_TO_OPENAI=off で今の「Claude のまま」に戻る。書き手（reply_generate）はこの番だけ OpenAI の書き手の版（Sol medium＋v2-note）
 */
export const budgetPiiToOpenAIOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.LLM_BUDGET_PII_TO_OPENAI ?? "").trim().toLowerCase() !== "off";
export const BUDGET_PII_WRITER_PROFILE = "openai-writer-v2-note-med";
export const CLAUDE_SPEND_BASE_USD_DEFAULT = 291.71;
export const CLAUDE_SPEND_BASE_AT_DEFAULT = "2026-11-24T01:19:00Z";
export function readBudgetConfig(env: Env = typeof process !== "undefined" ? process.env : {}): BudgetConfig {
  const m = String(env.LLM_BUDGET_ROUTE ?? "").trim().toLowerCase();
  const models: Partial<Record<BudgetRole, string>> = {};
  for (const part of String(env.LLM_BUDGET_ROLE_MODELS ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => (x ?? "").trim());
    if (k && v && k in BUDGET_ROLE_TABLE) models[k as BudgetRole] = v;
  }
  // 2026-11-25: 本番の env は統括役から見えない＝基準の既定をコードに（11/24 10:19 JST の Console $291.71）。基準が今の区切りの中にある時だけ効く
  const baseAt = String(env.CLAUDE_SPEND_BASE_AT ?? "").trim() || CLAUDE_SPEND_BASE_AT_DEFAULT;
  return {
    // 2026-11-25 竹内さんの決め（11/25 昼）: 既定 on（=off で止まる・=shadow は決めるだけ）。線の既定は 11/24 10:19 の画面 $291.71＋$25＝$316.71
    mode: m === "off" ? "off" : m === "shadow" ? "shadow" : "on",
    switchAtUsd: numOr(env.CLAUDE_SWITCH_AT_USD, CLAUDE_SWITCH_AT_USD_DEFAULT),
    baseUsd: numOr(env.CLAUDE_SPEND_BASE_USD, CLAUDE_SPEND_BASE_USD_DEFAULT),
    baseAt: baseAt && Number.isFinite(Date.parse(baseAt)) ? new Date(baseAt).toISOString() : null,
    resetDay: Math.min(28, Math.max(1, Math.round(numOr(env.CLAUDE_CREDIT_RESET_DAY, 10) ?? 10))),
    factor: numOr(env.CLAUDE_COST_FACTOR, 1) ?? 1,
    claudeCreditUsd: numOr(env.CLAUDE_MONTH_CREDIT_USD, 200) ?? 200,
    openaiCreditUsd: numOr(env.OPENAI_MONTH_CREDIT_USD, 100) ?? 100,
    models,
  };
}

/** 数え始めの時刻: 基準の時刻が今月なら基準から・無ければ月初（UTC・Console の月と同じ） */
/** 2026-11-25 使用額の区切りの始め: 毎月 resetDay 日の JST 0時（今より前で一番近い日）。既定 10日＝特典の入る日 */
export function creditPeriodStartMs(resetDay: number, nowMs: number): number {
  const J = 9 * 3_600_000;
  const j = new Date(nowMs + J);
  let start = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), resetDay) - J;
  if (start > nowMs) start = Date.UTC(j.getUTCFullYear(), j.getUTCMonth() - 1, resetDay) - J;
  return start;
}
export function spendWindowStart(cfg: Pick<BudgetConfig, "baseAt" | "baseUsd"> & { resetDay?: number }, nowMs: number): { since: string; useBase: boolean } {
  // 区切り: 特典の入る日（resetDay・既定 10日）。暦の月初ではない（竹内さん 11/25「次の $200 は 12/10」）
  const periodStart = creditPeriodStartMs(cfg.resetDay ?? 10, nowMs);
  const baseMs = cfg.baseAt ? Date.parse(cfg.baseAt) : NaN;
  if (cfg.baseUsd != null && Number.isFinite(baseMs) && baseMs >= periodStart && baseMs <= nowMs) return { since: new Date(baseMs).toISOString(), useBase: true };
  return { since: new Date(periodStart).toISOString(), useBase: false };
}

/** 今月の Claude の使用額（基準＋基準の後の行の費用×補正） */
export function claudeMonthSpendUsd(cfg: Pick<BudgetConfig, "baseUsd" | "factor">, o: { useBase: boolean; sinceUsd: number }): number {
  return (o.useBase ? cfg.baseUsd ?? 0 : 0) + o.sinceUsd * cfg.factor;
}

export type BudgetDecision = { route: "claude" | "openai"; role: BudgetRole | null; model: string | null; fallbackToClaude: boolean; reason: string; shadow: boolean };

/** 係ごとの振り分け（mode が off・線が無い・表に無い名札・線の手前は Claude） */
export function budgetDecision(routeName: string | null | undefined, spendUsd: number | null, cfg: BudgetConfig, ctx: { httpRoute?: string | null; claudeModel?: string | null; partial?: boolean; piiWriter?: boolean } = {}): BudgetDecision {
  const role = budgetRoleOf(routeName, ctx);
  const claude = (reason: string): BudgetDecision => ({ route: "claude", role, model: null, fallbackToClaude: true, reason, shadow: false });
  if (cfg.mode === "off") return claude("LLM_BUDGET_ROUTE=off");
  if (cfg.switchAtUsd == null) return claude("CLAUDE_SWITCH_AT_USD が無い");
  if (!role) return claude("表に無い名札");
  if (spendUsd == null || !Number.isFinite(spendUsd)) return claude("使用額が読めない");
  // 2026-11-25 読み切れていない時（partial・1回の読みは 50頁まで）の決め: 「超えた」と見なす（回す）。理由: 足した額は下限（読めた分だけ）で、
  //   線の手前に見えても本当は超えている事がある。回すのは書き手以外の係だけで、失敗は Claude に戻る＝回しすぎても下書きは止まらない。逆に回し損ねると特典を超えて払う
  if (spendUsd < cfg.switchAtUsd && !ctx.partial) return claude(`使用額 ${spendUsd.toFixed(2)} < 線 ${cfg.switchAtUsd}`);
  const spec = BUDGET_ROLE_TABLE[role];
  const d: BudgetDecision = { route: "openai", role, model: cfg.models[role] ?? spec.model, fallbackToClaude: spec.fallbackToClaude, reason: spendUsd < cfg.switchAtUsd ? `使用額 ${spendUsd.toFixed(2)}（読み切れていない＝下限）・超えたと見なす` : `使用額 ${spendUsd.toFixed(2)} ≥ 線 ${cfg.switchAtUsd}`, shadow: cfg.mode === "shadow" };
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
