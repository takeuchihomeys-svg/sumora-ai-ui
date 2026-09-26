// app/lib/llm-test-mode.ts
// テスト用の LLM の切り替え（ローカルの開発サーバ・scripts でだけ効く）。
//
// 2026-09-26 竹内「この形でおこなう」（テストの3段）:
//   テストの費用の大半はブレインではなく、generate-reply の中で1本ごとに動く Claude の判定・最終チェック・補助だった
//   （9/26 ローカル実測: ブレイン brain_fresh 1回 約$0.04／generate-reply の中の Sonnet 102回 約$1.4・Haiku 158回 約$0.5）。
//   ① 試行錯誤の段階 … LLM_TEST_MODE=deepseek-all で、ブレイン以外の Claude 呼び出しを全部 DeepSeek に回す
//   ② ブレインは DeepSeek にしない … 場面ごとに Claude で1回分析して保存・使い回す（scripts/yuma-brain-decision.ts の --cache）
//   ③ 最後の確かめ … LLM_TEST_MODE を外して開発サーバを起動し直す＝本番と同じ組み合わせ
//
// 【二重の鍵】本番（Vercel）では絶対に動かない:
//   鍵1: LLM_TEST_MODE=deepseek-all を明示しないと何もしない（値の書き間違いも何もしない）
//   鍵2: 実行環境が Vercel／NODE_ENV=production なら、鍵1が入っていても無視する（isTestModeAllowed）
//   → 本番の Vercel に誤って LLM_TEST_MODE が入っても、切り替えは起きず、今までの経路のまま。
//
// このファイルは純関数だけ（import なし）。llm-alt-provider（振り向け）と llm-usage-recorder（記録の印）の両方が読む。

export type EnvLike = Record<string, string | undefined>;

/** 今ある切り替えの名前（増やす時はここに足す） */
export type LlmTestMode = "deepseek-all";
export const LLM_TEST_MODES: ReadonlySet<LlmTestMode> = new Set<LlmTestMode>(["deepseek-all"]);

const truthy = (v: string | undefined) => {
  const s = (v ?? "").trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false";
};

/**
 * テスト用の切り替えを効かせてよい実行環境か（鍵2）。**本番・Vercel では必ず false**。
 *   ・VERCEL（Vercel のビルド・実行で "1"）／VERCEL_ENV（production / preview / development）／VERCEL_URL のどれかがある → false
 *     ※ 手元の .env.local に入っているのは VERCEL_OIDC_TOKEN だけ（VERCEL・VERCEL_ENV は無い）ので、手元の開発サーバは通る
 *   ・NODE_ENV=production（next start・本番ビルド）→ false（手元でも本番ビルドでは効かない＝安全側）
 *   ・AWS_LAMBDA_FUNCTION_NAME（Vercel の関数の実体）→ false
 * 開発サーバ（next dev＝NODE_ENV=development）と tsx の scripts（NODE_ENV 無し）だけが true。
 */
export function isTestModeAllowed(env: EnvLike): boolean {
  if (truthy(env.VERCEL)) return false;
  if ((env.VERCEL_ENV ?? "").trim() !== "") return false;
  if ((env.VERCEL_URL ?? "").trim() !== "") return false;
  if ((env.AWS_LAMBDA_FUNCTION_NAME ?? "").trim() !== "") return false;
  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") return false;
  return true;
}

/**
 * 今の切り替え（鍵1＋鍵2）。効かない時は null（＝今までどおり）。
 * 知らない値（書き間違い）も null。
 */
export function readTestMode(env: EnvLike): LlmTestMode | null {
  const raw = (env.LLM_TEST_MODE ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return null;
  if (!LLM_TEST_MODES.has(raw as LlmTestMode)) return null;
  if (!isTestModeAllowed(env)) return null;
  return raw as LlmTestMode;
}

/** LLM_TEST_MODE が入っているのに鍵2で止めた時の理由（起動ログに1回出す用）。止めていなければ null */
export function testModeBlockedReason(env: EnvLike): string | null {
  const raw = (env.LLM_TEST_MODE ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return null;
  if (!LLM_TEST_MODES.has(raw as LlmTestMode)) return `LLM_TEST_MODE=${raw} は知らない値（使えるのは ${[...LLM_TEST_MODES].join(", ")}）`;
  if (!isTestModeAllowed(env)) return "Vercel／NODE_ENV=production では LLM_TEST_MODE を無視する（本番の経路のまま）";
  return null;
}

/**
 * ブレインの呼び出しか（テスト用の切り替えの**対象外**）。
 * 2026-09-26 竹内「ブレインは DeepSeek にしない」＝ DeepSeek のブレインは判断が揺れる（設計知見「モデルを替える前に『揺れ』を測る」）。
 *   ・名札（x-sumora-llm-action）が brain で始まる: brain_fresh / brain_full / brain-warm / brain_fresh_claude
 *   ・名札が無く system の先頭で見分けた "brain"（ROUTE_MARKERS.brain＝スモラAI・会話全体の戦略）
 *   ・brain-core のセーブデータ（チェックポイント）作り: 名札も brain の語も無いので、system の先頭の語で見分ける
 *     （最終チェックの正解データになる物なので、Claude のまま作る）
 * ⚠ 見分けの語は実ファイルの文面に依存する → テスト（llm-test-mode.test.ts）が brain-core.ts と照合する
 */
export const TEST_MODE_BRAIN_SYSTEM_MARKERS = ["スモラAI", "会話全体の戦略", "LINE会話の記録係"] as const;

export function isBrainCall(routeName: string | null, systemHead: string | null): boolean {
  const name = (routeName ?? "").trim().toLowerCase();
  if (name.startsWith("brain")) return true;
  const head = (systemHead ?? "").slice(0, 200);
  return TEST_MODE_BRAIN_SYSTEM_MARKERS.some((m) => head.includes(m));
}

/** テスト用の切り替えで DeepSeek に回す呼び出しか（切り替えが効いていて、ブレインでない物） */
export function isTestModeTarget(mode: LlmTestMode | null, routeName: string | null, systemHead: string | null): boolean {
  if (mode !== "deepseek-all") return false;
  return !isBrainCall(routeName, systemHead);
}

/**
 * llm_usage_logs の env 列に入れる値。**テスト用の切り替えが効いている時だけ** "local:deepseek-all" のように印を付ける。
 *   本番（Vercel）は VERCEL_ENV（production / preview）のまま＝今までと同じ値。手元の普段の回は "local" のまま。
 *   ⚠ env="local" で数えている古い scripts（yuma-scene-gap-* 等）は、テスト用の切り替えの回を数えない（like 'local%' で数える）
 */
export function usageEnvLabel(env: EnvLike): string {
  const base = env.VERCEL_ENV ?? "local";
  const mode = readTestMode(env);
  return mode ? `${base}:${mode}` : base;
}
