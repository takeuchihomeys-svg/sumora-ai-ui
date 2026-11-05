// app/lib/switch-fingerprint.ts — 版の記録（2026-11-03 作業員1・土台の8つ）: 本番のスイッチの組み合わせの指紋
//
// なぜ: 「1週間見る」「段階で広げる」には、各判断がどのスイッチの組で出たかが要る。brain_version（コミット）だけでは
//   Vercel の環境変数だけを変えた日（スイッチの on/off）を区別できない。
// 何を: 判断・挙動のスイッチ（名前が BRAIN_ AIX_ REPLY_ … で始まる・値が短い on/off/数）だけを並べて短い指紋（8字）にする。
//   鍵・URL・トークンらしい名前と長い値は入れない（指紋にも表にも出さない）。
// どこに: brain_decision_logs.digest.ver.sw（brain-decision-ledger の brainDecisionDigestExtra）＝判断ごと／
//   指紋→中身の対応は brain_switch_versions（5分ごとの cron/ops-anomaly が同じデプロイの環境から upsert・初めて見た時刻と最後に見た時刻）
// 止める: BRAIN_DIGEST_VER=off（digest に入れない）

// 2026-11-05 作業員9（弱い所 323）: 統括・文・夜の線のスイッチが本番で on か off かを見られるよう、名前の頭を足した
//   （CONDUCTOR_ 入口の統括・TWO_ 2通の組み合わせと2段・FLASH_／WRITER_ 書き手・MGMT_ 管理会社の時間の線・TAKEUCHI_ 竹内さんの書き方・EXAMPLE_ 手本・TURN_CONTRACT 本質の帯）。
//   足すと指紋（ハッシュ）が変わる＝brain_switch_versions に新しい行が1つ増える（前の行は残る）
export const SWITCH_PREFIXES = ["BRAIN_", "AIX_", "REPLY_", "SENT_", "EXHAUSTED_", "SITUATION_", "SCREENING_", "STALE_", "SEND_", "PROGRESS_", "DATE_", "COMPOSE_", "SECOND_", "LLM_ALT_ACTIONS", "FINAL_CHECK", "DRAFT_", "OPS_ANOMALY_",
  "CONDUCTOR_", "TWO_", "FLASH_", "WRITER_", "MGMT_", "TAKEUCHI_", "EXAMPLE_", "TURN_CONTRACT"];
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|URL|ENDPOINT|WEBHOOK|DSN/i;
/** 値がスイッチの形（on/off/shadow・数・語の並び。LLM_ALT_ACTIONS の印の並びは長い＝300字まで・空白なし）だけ */
const SWITCH_VALUE = /^[\w.,:=@/-]{1,300}$/;

/** 画面側から読まれても壊れないよう node:crypto を使わない（FNV-1a 32bit・8字） */
export function fnv1a(s: string): string { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }
export function switchEntries(env: Record<string, string | undefined>): Array<[string, string]> {
  return Object.entries(env)
    .filter(([k, v]) => v !== undefined && SWITCH_PREFIXES.some((p) => k.startsWith(p)) && !SECRET_NAME.test(k) && SWITCH_VALUE.test(String(v).trim()))
    .map(([k, v]) => [k, String(v).trim()] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));
}
export function switchFingerprint(env: Record<string, string | undefined>): { h: string; n: number; text: string } {
  const e = switchEntries(env);
  const text = e.map(([k, v]) => `${k}=${v}`).join("\n");
  return { h: fnv1a(text), n: e.length, text };
}
export function digestVerOn(env: Record<string, string | undefined>): boolean { return String(env.BRAIN_DIGEST_VER ?? "").trim().toLowerCase() !== "off"; }
