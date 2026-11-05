// app/lib/brain-decision-ledger.ts — ブレインの判断の行（brain_decision_logs）に「結果の台帳」と結ぶための項目を足す（純関数・LLM なし）。
//   計画 memory/plan_outcome_ledger.md 段2（2026-10-08）: 今ある出力を残すだけ。判断の中身・文面は変えない。
//   列: building_key・room_no（判断した物件＝current_property を建物の鍵と号室に）・scene_key（ブレインの材料を絞る場面＝reply-scene）・brain_version（デプロイのコミット）
//   digest: tc（2択の表示）・pp（ピックアップの約束が残っている）・cp（会話の実態の段階）・cs（締めの戦略の頭 60字）
//   ※ scene_key は brain-scene の場面（reply-scene の ack/question/conditions…）。見張り（line_watch_turns.scene_key）の「AIX:〇〇／返信:〇〇」とは別の分け方
import { splitPropertyName } from "./customer-state";
import { resolveReplyScene } from "./reply-scene";
import { switchFingerprint, digestVerOn } from "./switch-fingerprint";

export type BrainDecisionLedgerCols = { building_key: string | null; room_no: string | null; scene_key: string | null; brain_version: string | null };

/** デプロイの版（Vercel のコミットの頭7字・無ければ local） */
export function brainVersionOf(env: Record<string, string | undefined>): string {
  const sha = (env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  return sha ? sha.slice(0, 7) : "local";
}

export function brainDecisionLedgerCols(meta: Record<string, unknown>, turnText: string | null | undefined, env: Record<string, string | undefined>): BrainDecisionLedgerCols {
  const prop = typeof meta.current_property === "string" ? meta.current_property : null;
  const ref = prop ? splitPropertyName(prop) : null;
  const text = String(turnText ?? "");
  return {
    building_key: ref?.buildingKey ?? null,
    room_no: ref?.room ?? null,
    scene_key: text.trim() ? resolveReplyScene({ customerText: text }).scene : null,
    brain_version: brainVersionOf(env),
  };
}

/** digest に足す短い項目（無い物は入れない） */
export function brainDecisionDigestExtra(meta: Record<string, unknown>, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): { tc?: boolean; pp?: boolean; cp?: string; cs?: string; st?: string; dc?: Record<string, unknown>; fs?: Record<string, unknown>; pr?: Record<string, unknown>; mm?: string[]; mx?: string[] } {
  const out: { tc?: boolean; pp?: boolean; cp?: string; cs?: string; st?: string; dc?: Record<string, unknown>; fs?: Record<string, unknown>; pr?: Record<string, unknown>; mm?: string[]; mx?: string[] } = {};
  // 2026-11-03 前回の提案の振り返り（rv）と今の段階（sg・次の番が「進んだか」を見る）
  if (meta.last_turn_review && typeof meta.last_turn_review === "object") (out as Record<string, unknown>).rv = meta.last_turn_review;
  if (typeof meta.customer_stage_now === "string" && meta.customer_stage_now) (out as Record<string, unknown>).sg = meta.customer_stage_now;
  if (Array.isArray(meta.material_read_misses) && meta.material_read_misses.length) out.mx = (meta.material_read_misses as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 10);
  // 2026-10-29 材料の自己申告（判断に要ったのに無かった物・記録だけ）。[] も「足りていた」として残す（申告の割合を数える）
  if (Array.isArray(meta.material_missing)) out.mm = (meta.material_missing as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5);
  // 2026-10-23 優先順位の段（BRAIN_PRIORITY_STEP=on の番だけ・項目の数・依頼の抜けを足した数・AIX とのそろえ・取り寄せた材料の id）
  if (meta.priority_step && typeof meta.priority_step === "object") out.pr = meta.priority_step as Record<string, unknown>;
  // 2026-10-29 AIX の統括（AIX_DESK_COMMAND が off でない番だけ）: 候補・選んだ鍵・別の要件・差し戻し・ブレインと違ったか＝毎晩2つの統括の食い違いを数える
  if (meta.aix_desk && typeof meta.aix_desk === "object") (out as Record<string, unknown>).ad = meta.aix_desk as Record<string, unknown>;
  // 2026-11-03 逆向きの相談（相談した数・AIX と決めた割合・スタッフと合ったかを毎晩数える）
  if (meta.aix_consult && typeof meta.aix_consult === "object") (out as Record<string, unknown>).ac = meta.aix_consult as Record<string, unknown>;
  // 読み直しの口に渡した物の短い形（"aix:鍵" / "promise" / "not_aix" / "reread" / "keep"）
  { const rc = meta.aix_recheck as { kind?: string; key?: string | null } | null | undefined; const ans = (meta.aix_consult as { answer?: string } | undefined)?.answer; const v = rc && rc.kind ? (rc.kind === "aix" ? `aix:${rc.key ?? ""}` : rc.kind) : ans === "keep" ? "keep" : null; if (v) (out as Record<string, unknown>).rc = v; }
  // 2026-10-15 追加の調査（brain-deep-check）をかけた番だけ（2回目の呼び出しの割合・変わった率を数える）
  if (meta.deep_check && typeof meta.deep_check === "object") out.dc = meta.deep_check as Record<string, unknown>;
  // 2026-10-22 慣れた事は速く・難しい事はじっくり（BRAIN_FAST_SLOW=on の番だけ・難しさ・戻り道・2回目の割れを数える）
  if (meta.fast_slow && typeof meta.fast_slow === "object") out.fs = meta.fast_slow as Record<string, unknown>;
  // 2026-11-03 版の記録: この判断が出た時のスイッチの組の指紋（中身は brain_switch_versions・BRAIN_DIGEST_VER=off で止める）
  if (digestVerOn(env)) { const fp = switchFingerprint(env); if (fp.n) (out as Record<string, unknown>).ver = { sw: fp.h }; } // 作業員2の設計 §4: ver.sw（他の版 rules・skill・model・ex は作る人が足す） // スイッチが1つも無い環境（テスト）は入れない
  // 2026-11-06 作業員4（弱い所 306）: 2択の印は tw（旧は tc=true で、turn_contract の道の数え digest.tc「n:rXpYaZnW」を上書きしていた）。読む側は tw か旧の tc===true
  if (meta.two_choice_mode === true) (out as Record<string, unknown>).tw = true;
  if (meta.pending_pickup === true) out.pp = true;
  if (typeof meta.checkpoint_stage === "string" && meta.checkpoint_stage.trim()) out.cp = meta.checkpoint_stage.trim().slice(0, 20);
  if (typeof meta.closing_strategy === "string" && meta.closing_strategy.trim()) out.cs = meta.closing_strategy.trim().slice(0, 60);
  // 2026-10-28 作業員5: ブレインの今の状況（turn_contract.situation）は記録に残っていなかった＝AIX の文の試験（exam-aix-text --snap）で
  //   その番の状況を写せず、AIX_CONTRACT_SITUATION を測れなかった。80字だけ残す（記録だけ・判断は変えない）。入れる BRAIN_DIGEST_SITUATION=on（既定 off）
  if (brainDigestSituationOn(env)) {
    const sit = (meta.turn_contract as { situation?: unknown } | null | undefined)?.situation;
    if (typeof sit === "string" && sit.trim()) out.st = Array.from(sit.trim()).slice(0, 80).join("");
  }
  return out;
}

/** digest にブレインの今の状況（turn_contract.situation・80字）を残すか（既定 off・BRAIN_DIGEST_SITUATION=on） */
export function brainDigestSituationOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_DIGEST_SITUATION ?? "").trim().toLowerCase() === "on";
}
