// app/lib/rules-overlay.ts — 学習ルール（ai_prompt_rules）の見直しを DB を変えずに試す「重ね（overlay）」（テストの会話だけ・サーバー専用）
//
// 2026-10-08 竹内さんの決めた順「8巡目を本番に入れる → 段1を YUMA のテストだけで切り替えられるように → YUMA で前後比較 → … → 問題なければ流す」。
//   6巡目の testFlags.rules_r6 は返信生成の fetchPromptRules だけを差し替えた。9巡目（rules-review-r9.ts）は global・永久・BOUNDARY・AIX の各 action に及び、
//   ルールは返信生成・最終チェック・ブレイン（【絶対ルール】＝global 永久・【線引き】＝BOUNDARY-*・行動の候補のルール）・AIX（aix/action のルール注入）・
//   次の一手の予想の前置き の全部に届く。経路ごとに引数を通すと漏れる（＝前後比較が半分だけ切り替わって静かに壊れる）ので、
//   **ルールを読む所（prompt-rules.ts の queryRuleRows・brain-core の3クエリ・suggest-next-action の BOUNDARY）が1つの箱を見る**形にした。
//   箱は AsyncLocalStorage（deepseek-scope.ts と同じく globalThis に1つ・別の束でも同じ箱を見る）。
//
//   ・箱を開けるのは generate-reply / aix/action の POST（runInRulesOverlayScope）。重ねを置くのは本文を読んだ後、テストの会話（isTestConversation）・
//     本番の環境でない（VERCEL_ENV なし）・testFlags.rules_r9 が on / stage2 の時だけ（resolveTestRulesOverlay）。
//   ・スクリプト（ブレインを直接呼ぶ）は runWithRulesOverlay(ov, fn) で包む。
//   ・本番の既定の動きは変わらない（箱が無い／重ねが null の時は何もしない＝今の DB のまま）。
//
//   上限（limit）のあるクエリは「上限＋無効にする本数」を読んでから外して上限で切る＝SQL で無効にした後と同じ並び・同じ件数（空いた枠に入る次のルールまで）。
//   設計知見 d25645f2【汎用】「学習ルールを無効にする前に、上限で切られていたルールが空いた枠に入る事まで含めて試す」。
import { AsyncLocalStorage } from "node:async_hooks";
import { RULES_REVIEW_R9, type R9Decision } from "./rules-review-r9";

export type RulesOverlay = {
  /** 記録用の名前（r9-on / r9-stage2） */
  label: string;
  /** 無効にする rule_key */
  retireKeys: ReadonlySet<string>;
  /** 書き換える rule_key → 新しい rule_text */
  textOverrides: Readonly<Record<string, string>>;
};

export type RulesR9Mode = "off" | "on" | "stage2";

/** testFlags.rules_r9 の値を読む（off＝今の DB・on＝段1・stage2＝段1＋段2）。それ以外は null */
export function parseRulesR9Flag(v: unknown): RulesR9Mode | null {
  return v === "off" || v === "on" || v === "stage2" ? v : null;
}

/**
 * 9巡目の一覧から重ねを作る。on＝段1（stage 省略か 1）、stage2＝段1＋段2。ask（竹内さんに聞く）は入れない。off は null（今の DB のまま）。
 * ※段1の SQL の ④掃除（どこにも届いていない -gr／WEEKLY p<8）は動きが変わらないので重ねに入れない。
 */
export function buildR9Overlay(mode: RulesR9Mode, list: ReadonlyArray<R9Decision> = RULES_REVIEW_R9): RulesOverlay | null {
  if (mode === "off") return null;
  const maxStage = mode === "stage2" ? 2 : 1;
  const act = list.filter((d) => (d.stage ?? 1) <= maxStage && d.verdict !== "ask");
  return {
    label: mode === "stage2" ? "r9-stage2" : "r9-on",
    retireKeys: new Set(act.filter((d) => d.verdict === "retire").map((d) => d.key)),
    textOverrides: Object.fromEntries(act.filter((d) => d.verdict === "edit" && d.newText).map((d) => [d.key, d.newText!])),
  };
}

/** 上限のあるクエリで多めに読む本数（無効にする本数ぶん。重ねが無ければ 0） */
export function overlayExtraLimit(ov: RulesOverlay | null | undefined): number {
  return ov ? ov.retireKeys.size : 0;
}

/**
 * 行に重ねを当てる（純関数）: 無効の行を外し・書き換えの行の文を差し替え・limit があれば先頭から limit 件に切る。
 * rule_key の無い行（select に rule_key が無い等）はそのまま残す（外せない＝呼び出し側で rule_key を読む）。
 */
export function applyRulesOverlay<T extends { rule_key?: string | null; rule_text: string | null }>(
  rows: ReadonlyArray<T>,
  ov: RulesOverlay | null | undefined,
  limit?: number,
): T[] {
  if (!ov) return typeof limit === "number" ? rows.slice(0, limit) : [...rows];
  const out: T[] = [];
  for (const r of rows) {
    const k = r.rule_key ?? "";
    if (k && ov.retireKeys.has(k)) continue;
    const t = k ? ov.textOverrides[k] : undefined;
    out.push(t !== undefined ? { ...r, rule_text: t } : r);
    if (typeof limit === "number" && out.length >= limit) break;
  }
  return out;
}

// ── 箱（AsyncLocalStorage・globalThis に1つ）──
type Box = { overlay: RulesOverlay | null };
const KEY = "__sumoraRulesOverlay";
function store(): AsyncLocalStorage<Box> {
  const g = globalThis as unknown as Record<string, AsyncLocalStorage<Box> | undefined>;
  if (!g[KEY]) g[KEY] = new AsyncLocalStorage<Box>();
  return g[KEY]!;
}

/** 箱を開けて fn を走らせる（重ねはまだ無い＝ setRulesOverlay で置くまで今の DB のまま） */
export function runInRulesOverlayScope<T>(fn: () => T): T {
  return store().run({ overlay: null }, fn);
}

/** 重ねを置いて fn を走らせる（スクリプト用。ov=null は今の DB のまま） */
export function runWithRulesOverlay<T>(ov: RulesOverlay | null, fn: () => T): T {
  return store().run({ overlay: ov }, fn);
}

/** 今の箱に重ねを置く（箱の外では何もしない） */
export function setRulesOverlay(ov: RulesOverlay | null): void {
  const b = store().getStore();
  if (b) b.overlay = ov;
}

/** 今の重ね（無ければ null） */
export function currentRulesOverlay(): RulesOverlay | null {
  return store().getStore()?.overlay ?? null;
}

/**
 * テストの重ねを決める（ルートが本文を読んだ後に呼ぶ）。テストの会話・本番でない環境・rules_r9 が on/stage2 の時だけ重ねを返す。
 * isTest は呼び出し側が isTestConversation(conversationId) を渡す（ここは依存を持たない）。
 */
export function resolveTestRulesOverlay(flag: unknown, isTest: boolean, env: Record<string, string | undefined> = process.env): RulesOverlay | null {
  if (!isTest || env.VERCEL_ENV) return null;
  const mode = parseRulesR9Flag(flag);
  return mode ? buildR9Overlay(mode) : null;
}
