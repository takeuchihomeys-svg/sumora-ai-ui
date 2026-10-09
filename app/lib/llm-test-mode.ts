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
// このファイルは純関数だけ（import は test-conversations の定数だけ）。llm-alt-provider（振り向け）と llm-usage-recorder（記録の印）の両方が読む。
import { isTestOnlyConversation } from "./test-conversations";

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
 * ブレインの呼び出しか（**2026-10-01 からは切り替えの対象**・見分けは記録・説明用に残す）。
 * 2026-09-26 竹内「ブレインは DeepSeek にしない」＝ DeepSeek のブレインは判断が揺れる（設計知見「モデルを替える前に『揺れ』を測る」）。
 * → 2026-10-01 竹内「ブレインの API もテストの時は DeepSeek・方向確定してからクロード」で置き換え（isTestModeTarget の説明）。
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

/**
 * テスト用の切り替えで DeepSeek に回す呼び出しか。
 *
 * 2026-10-01 竹内「テスト行う際必ずこのやりかた（ブレインのぶぶん）読むようにしたらいける。1～4すべて改善する」:
 *   旧はブレイン（brain_fresh / brain_full / 戦略の整理 / セーブデータ）を外していたので、LLM_ALT_ACTIONS に書き忘れた
 *   戦略の整理・セーブデータ・取り直し（brain_fresh_claude）が**黙って Claude に行っていた**（10/01 の env=local:deepseek-all で Claude 46回）。
 *   → deepseek-all は**ブレインも含めて全部** DeepSeek（竹内 10/01「ブレインの API もテストの時は DeepSeek・方向確定してからクロード」）。
 *     Claude に行く呼び出しは出口で止める（strictClaudeBlockReason・LLM_TEST_ALLOW_CLAUDE に書いた名前だけ通す）。
 *     最後の確かめは LLM_TEST_FINAL_CLAUDE=1（本番と同じ組み合わせ）で別に走らせる。
 */
export function isTestModeTarget(mode: LlmTestMode | null, _routeName: string | null, _systemHead: string | null): boolean {
  return mode === "deepseek-all";
}

// ── 2026-10-01 テストの3つの歯止め（厳密な DeepSeek・最後の Claude は明示・YUMA だけ）──────────────────────────
// 竹内「テスト行う際必ずこのやりかた（ブレインのぶぶん）読むようにしたらいける。1～4すべて改善する。設計知見と協力して改善する」
//   手順書: memory/test_protocol_brain.md（テストの前に必ず読む）
//   ① deepseek-all の間は Claude に行く呼び出しを**黙って通さず止める**（例外を投げ、日本語で何をすればよいかを書く）
//   ② 最後の Claude の確かめは LLM_TEST_FINAL_CLAUDE=1 を付けた時だけ（本番と同じ組み合わせ・env 列は local:final-claude）
//   ③ どちらの間も、会話 ID が YUMA 以外の LLM 呼び出しは断る（10/01 に和樹さんの会話で3回呼んでいた）
// 本番（Vercel・NODE_ENV=production）では isTestModeAllowed が false なので、ここは全部「何もしない」になる。

const YUMA_ID = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // test-conversations.ts の YUMA_CONVERSATION_ID と同じ（テストで一致を固定）

/** 最後の Claude の確かめか（LLM_TEST_FINAL_CLAUDE=1・本番では必ず false） */
export function readFinalClaude(env: EnvLike): boolean {
  return truthy(env.LLM_TEST_FINAL_CLAUDE) && isTestModeAllowed(env);
}

/**
 * 今のテストの種類。deepseek-all（試行錯誤・厳密）／final-claude（最後の確かめ）／null（テストではない＝今までどおり）。
 * 両方が付いていたら安い方（deepseek-all）を採る＝黙って Claude を使わない側に倒す（スクリプトの共通の入口は両方付きを止める）
 */
export type LlmTestRun = "deepseek-all" | "final-claude";
export function readTestRun(env: EnvLike): LlmTestRun | null {
  if (readTestMode(env) === "deepseek-all") return "deepseek-all";
  if (readFinalClaude(env)) return "final-claude";
  return null;
}

/**
 * 最後の確かめ（final-claude）を本番と同じモデルにそろえる。本番（Vercel）は CLAUDE_SONNET_MODEL=claude-sonnet-5-5・CLAUDE_SONNET55_ACTIONS=*（10/01 の本番の行は Sonnet が全部 5.5）
 * だが .env.local には無く、手元の最後の確かめが Sonnet 5 で走っていた（10/01 実測）。どちらも書かれていない時だけ本番の値を入れる。入れた時は説明の1行を返す
 */
export function applyFinalClaudeProductionModels(env: EnvLike): string | null {
  if (readTestRun(env) !== "final-claude") return null;
  if ((env.CLAUDE_SONNET_MODEL ?? "").trim() || (env.CLAUDE_SONNET55_ACTIONS ?? "").trim()) return null;
  env.CLAUDE_SONNET_MODEL = "claude-sonnet-5-5";
  env.CLAUDE_SONNET55_ACTIONS = "*";
  return "[llm-test-mode] 最後の確かめ: 本番と同じく Sonnet を 5.5 に（CLAUDE_SONNET_MODEL=claude-sonnet-5-5・CLAUDE_SONNET55_ACTIONS=*）";
}

/** LLM_TEST_ALLOW_CLAUDE=extract_estimate,brain_fresh のように、deepseek-all の間でも Claude に通してよい名札（画像の読み取り等）。"*"・"all" は受け付けない */
export function readAllowClaude(env: EnvLike): Set<string> {
  return new Set(String(env.LLM_TEST_ALLOW_CLAUDE ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "*" && s !== "all"));
}

/**
 * deepseek-all の間に Claude に行こうとした呼び出しを止める理由（通してよい時は null）。純関数。
 *   action … 名札（x-sumora-llm-action）。名札が無い時は呼び出し側が "classify" 等の見分けた名前を渡す
 *   why    … なぜ Claude に行くのか（画像つき・申込以降・時刻の線の印なし 等）
 */
export function strictClaudeBlockReason(env: EnvLike, o: { action: string | null; why: string; route?: string | null }): string | null {
  if (readTestRun(env) !== "deepseek-all") return null;
  const name = (o.action ?? "").trim() || "(名札なし)";
  if (readAllowClaude(env).has(name)) return null;
  return `[llm-test-mode] ⛔ LLM_TEST_MODE=deepseek-all の間に Claude へ行こうとした呼び出しを止めました（名札: ${name}${o.route ? `・経路: ${o.route}` : ""}・理由: ${o.why}）。` +
    `\n  どうするか: ①DeepSeek で回したいなら理由を直す（YUMA が申込以降扱いなら status_manual_back_at を最新に／画像つきは DeepSeek に送れない）` +
    `\n            ②この名札だけ Claude で回してよいなら起動コマンドに LLM_TEST_ALLOW_CLAUDE=${name === "(名札なし)" ? "<名札>" : name} を足す（費用は報告に書く）` +
    `\n            ③最後の確かめなら LLM_TEST_MODE を外して LLM_TEST_FINAL_CLAUDE=1 で起動し直す` +
    `\n  手順書: memory/test_protocol_brain.md`;
}

/**
 * テストの間（deepseek-all／final-claude）に、テスト用の会話以外で LLM を呼ぼうとした時の断りの文（テスト用の会話・会話なし・テストでない時は null）。
 * 2026-10-09 竹内さん承認: YUMA に加えて LINE につながっていないテスト専用の会話（YUMA2〜YUMA5＝test-conversations の TEST_ONLY_CONVERSATION_IDS）も通す。
 *   本物のお客様の会話・スタッフ同士の会話は今まで通り断る。
 */
export function testConversationRefusal(env: EnvLike, conversationId: string | null | undefined, what = "LLM の呼び出し"): string | null {
  const run = readTestRun(env);
  if (!run) return null;
  const id = String(conversationId ?? "").trim();
  if (!id || id === YUMA_ID || isTestOnlyConversation(id)) return null;
  return `[llm-test-mode] ⛔ テスト（${run}）の間は YUMA（${YUMA_ID}）とテスト専用の会話（YUMA2〜・test-conversations.ts）以外の会話で${what}をしません（会話 ${id}）。` +
    `\n  お客様の会話を試したい時は scripts/replay-brain-readonly.ts --copy-to-yuma で伏せ字にして YUMA の場面に写してから。手順書: memory/test_protocol_brain.md`;
}

/** 出口で止めた時に投げる例外（呼び出し側が fail-open で飲み込んでも、止めた事は globalThis の控えとログに残る） */
export class LlmTestBlockedError extends Error {
  constructor(message: string) { super(message); this.name = "LlmTestBlockedError"; }
}
const BLOCKED_KEY = "__sumoraLlmTestBlocked";
/** 止めた事を控える（スクリプトの共通の入口が最後に数えて、0 でなければ失敗で終わる）＋ログに必ず1行 */
export function noteTestBlocked(message: string): LlmTestBlockedError {
  const g = globalThis as unknown as Record<string, string[] | undefined>;
  (g[BLOCKED_KEY] ??= []).push(message.split("\n")[0]);
  console.error(message);
  return new LlmTestBlockedError(message.split("\n")[0]);
}
export function testBlockedLog(): string[] {
  return [...((globalThis as unknown as Record<string, string[] | undefined>)[BLOCKED_KEY] ?? [])];
}

/**
 * llm_usage_logs の env 列に入れる値。**テストの間だけ** "local:deepseek-all"／"local:final-claude" のように印を付ける。
 *   本番（Vercel）は VERCEL_ENV（production / preview）のまま＝今までと同じ値。手元の普段の回は "local" のまま。
 *   ⚠ env="local" で数えている古い scripts（yuma-scene-gap-* 等）は、テストの回を数えない（like 'local%' で数える）
 */
export function usageEnvLabel(env: EnvLike): string {
  const base = env.VERCEL_ENV ?? "local";
  const run = readTestRun(env);
  return run ? `${base}:${run}` : base;
}
