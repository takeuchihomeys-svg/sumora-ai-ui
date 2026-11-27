// app/lib/switch-stage.ts — スイッチを段階（rollout の stageOn）で読む読み口（2026-11-27 作業員A・#813 の続き）
//
// 竹内さんの決め 11/27「段階で読む形に移して、悪化したら自動で戻す（推奨）・env は書き換えない」。
//   これから on にする部品は env の "on" ではなく stagedOn で読む。夜の見張り（rollout-watch）が悪化を見たら rollout_overrides に1段下を書き、ここがそれを読む。
// 番ごとの入れ物: ブレイン（analyzeConversation）と generate-reply の入口で prepareSwitchStage(会話 id) を1回呼ぶ。
//   入れ物には会話 id と rollout_overrides（1分の控え）が入る。stagedOn は同期のまま入れ物を読む（今の xOn(env) の形を崩さない）。
// 落とし所（統括役の条件 11/27 ①）: 表が読めない（DB の失敗・時間切れ・鍵が無い・画面）時は表を空にする＝今と同じ env だけの答え。
//   表の読みは PREPARE_TIMEOUT_MS で打ち切り、返信やブレインを待たせない。1番につき1回（入れ物に入っていれば読まない）。
// 今と同じ答えになる理由: rollout.stageOf は `<NAME>=on` を all・`=off` を off と読み、表が空で `<NAME>_STAGE` が無ければ env だけで決まる。
//   既定 on の部品（`!== "off"`）は defaultStage=all で、既定 off の部品（`=== "on"`）は defaultStage=off で、今の読み手と同じ答え（テストで env の組すべてを比べる）。
import { AsyncLocalStorage } from "node:async_hooks";
import { stageOn, loadRolloutOverrides, type RolloutOverride, type Stage } from "./rollout";

type Env = Record<string, string | undefined>;
export type SwitchStageCtx = { conversationId: string | null; overrides: RolloutOverride[]; loadedAt: number; fellBack: boolean };
const als = new AsyncLocalStorage<SwitchStageCtx>();
export const PREPARE_TIMEOUT_MS = 300;

/** 段階で読む名簿（rollout-watch が見張る・移した順に足す）。defaultStage はコードの既定（今の読み手の既定と同じにする） */
export const STAGED_SWITCHES: ReadonlyArray<{ name: string; defaultStage: Stage; codeDefaultOnDay?: string }> = [
  // 2026-11-27 移す1・2本目（統括役の条件: 明日の push で本番に出して1日見てから残りを移す）。どちらも env=on（brain_switch_versions に 11/03 から）＝all に上がった日は版の記録から
  { name: "BRAIN_RAG_STATE_FILTER", defaultStage: { kind: "all" } },
  { name: "BRAIN_DIGEST_SITUATION", defaultStage: { kind: "all" } },
  // 2026-11-27 今日作った既定 off の部品（stage-coverage の点検で「新しいスイッチを env だけで読む」と出た物・on にした時に夜の見張りが戻せるように）
  { name: "AFTER_DECISION_RECORDS", defaultStage: { kind: "off" } },
  { name: "PICKUP_SPEC_SHARED", defaultStage: { kind: "off" } },
  { name: "SEARCH_CONDITION_VIEW", defaultStage: { kind: "off" } },
  { name: "SHADOW_REACH", defaultStage: { kind: "off" } }, // #823 影の届き（記録だけ）
  { name: "CHECK_NOW_POSSIBLE_LINE", defaultStage: { kind: "off" } }, // #821 今確かめられるか
  { name: "PICKUP_FIT_NOW_LINE", defaultStage: { kind: "off" } }, // #821 送れる候補が今の条件にも合うか
  { name: "PENDING_CHECK_ANSWERED_GUARD", defaultStage: { kind: "off" } }, // #829 文で答えた確認タスクを確認中から外す（generate-reply）
];

/** コードの既定を on にした部品の「版の変わり目」（その既定が入った commit の日・JST）。brain_switch_versions に出ない物の all に上がった日 */
export function codeDefaultOnDayOf(name: string): string | null {
  return STAGED_SWITCHES.find((r) => r.name === name)?.codeDefaultOnDay ?? null;
}

/** 表を読む（時間切れ・失敗は空＝env だけ）。純粋に近い形で試せるように読み手を渡せる */
export async function loadOverridesSafe(load: () => Promise<RolloutOverride[]> = () => loadRolloutOverrides(), timeoutMs = PREPARE_TIMEOUT_MS): Promise<{ rows: RolloutOverride[]; fellBack: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<null>((res) => { timer = setTimeout(() => res(null), timeoutMs); });
    const rows = await Promise.race([load().catch(() => null), timeout]);
    return rows ? { rows, fellBack: false } : { rows: [], fellBack: true };
  } catch { return { rows: [], fellBack: true }; } finally { if (timer) clearTimeout(timer); }
}

/** 番の入口で1回: 会話 id と表を読んで入れ物の中身を作る（同じ番の中で2回目は読まず今の物を返す）。
 *  入れ物に入れるのは呼んだ側で enterSwitchStage(await loadSwitchStageCtx(id)) と書く（async の関数の中の enterWith は await の後だと呼んだ側に届かないため） */
export async function loadSwitchStageCtx(conversationId: string | null | undefined, load?: () => Promise<RolloutOverride[]>): Promise<SwitchStageCtx> {
  const cur = als.getStore();
  if (cur && cur.conversationId === (conversationId ?? null)) return cur;
  const { rows, fellBack } = await loadOverridesSafe(load);
  return { conversationId: conversationId ?? null, overrides: rows, loadedAt: Date.now(), fellBack };
}
/** 呼んだ関数のこの後の流れ（await の先も含む）で stagedOn が ctx を読む */
export function enterSwitchStage(ctx: SwitchStageCtx): SwitchStageCtx { als.enterWith(ctx); return ctx; }
/** テスト・台本用: 入れ物の中で fn を回す */
export function runWithSwitchStage<T>(ctx: SwitchStageCtx, fn: () => T): T { return als.run(ctx, fn); }
export function currentSwitchStage(): SwitchStageCtx | null { return als.getStore() ?? null; }

/** 段階で読む（同期）。入れ物が無い所（テスト・台本・画面）は会話 id 無し・表は空＝env だけの答え（今と同じ） */
export function stagedOn(name: string, env: Env = typeof process !== "undefined" ? process.env : {}, defaultStage: Stage = { kind: "off" }): boolean {
  const ctx = als.getStore();
  return stageOn(name, ctx?.conversationId ?? null, env, ctx?.overrides ?? [], defaultStage);
}
export const STAGE_ALL: Stage = { kind: "all" };
export const STAGE_OFF: Stage = { kind: "off" };
