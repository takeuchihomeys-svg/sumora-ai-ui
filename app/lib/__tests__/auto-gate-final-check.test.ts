// 2026-11-12 作業員20 自動送信の関所が最終チェックを通っていない下書きを通す穴（台帳 auto-gate:passes-without-final-check）と、
// テンプレ最適化が最終チェックを通らない穴の安全の線（safetyLineIssues）。
// 実行: npx tsx app/lib/__tests__/auto-gate-final-check.test.ts
import { canAutoReply, type AutoReplyInput } from "../auto-reply-policy";
import { finalCheckStateOf, autoGateFinalCheckEnabled } from "../auto-gate-final-check";
import { safetyLineIssues } from "../final-check";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

const OK: AutoReplyInput = {
  autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null,
  draft: "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！",
  draftHasBlock: false, status: "proposing", hasPendingScheduled: false,
};
const FULL = { ok: true, issues: [], passes_completed: ["rule_check", "anomaly_scan", "context_check"], checked_text_hash: "abc" };

console.log("── 最終チェックの完走の証拠（finalCheckStateOf）");
t("結果が無い（null・最終チェックが走っていない）→ missing", finalCheckStateOf(null) === "missing");
t("オブジェクトでない → missing", finalCheckStateOf("ok") === "missing" && finalCheckStateOf([]) === "missing");
t("passes_completed が無い（ok だけ）→ incomplete", finalCheckStateOf({ ok: true, issues: [] }) === "incomplete");
t("2パスだけ → incomplete", finalCheckStateOf({ ...FULL, passes_completed: ["rule_check", "anomaly_scan"] }) === "incomplete");
t("空（テンプレ最適化の安全の線の結果）→ incomplete", finalCheckStateOf({ ...FULL, passes_completed: [] }) === "incomplete");
t("3パス完走 → ok", finalCheckStateOf(FULL) === "ok");
t("meta は数えない（2パス＋meta → incomplete）", finalCheckStateOf({ ...FULL, passes_completed: ["rule_check", "anomaly_scan", "meta"] }) === "incomplete");
t("本文の取り違え（hash）は既定では見ない", finalCheckStateOf(FULL, { draftHash: "zzz", env: {} }) === "ok");
t("AUTO_GATE_FC_HASH=on の時だけ hash の違いは stale", finalCheckStateOf(FULL, { draftHash: "zzz", env: { AUTO_GATE_FC_HASH: "on" } }) === "stale" && finalCheckStateOf(FULL, { draftHash: "abc", env: { AUTO_GATE_FC_HASH: "on" } }) === "ok");
t("スイッチ: 既定 on・off で止める", autoGateFinalCheckEnabled({}) === true && autoGateFinalCheckEnabled({ AUTO_GATE_FINAL_CHECK: "off" }) === false);

console.log("── 関所 canAutoReply（今の自動送信は off＝本番の動きは変わらない）");
t("今までの呼び出し（finalCheckState を渡さない）は挙動が同じ＝送る", canAutoReply(OK).ok);
t("自動送信が off の会話は、完走していなくても今までと同じ理由 auto_off で止まる", canAutoReply({ ...OK, autoSendEnabled: null, finalCheckState: "missing" }).reason === "auto_off");
t("ok → 送る", canAutoReply({ ...OK, finalCheckState: "ok" }).ok);
for (const s of ["missing", "incomplete", "stale"] as const) {
  const v = canAutoReply({ ...OK, finalCheckState: s });
  t(`on にした時 ${s} → 止まる（理由 final_check_${s}）`, !v.ok && v.reason === `final_check_${s}`);
}
t("block は今までどおり final_check_block が先", canAutoReply({ ...OK, draftHasBlock: true, finalCheckState: "missing" }).reason === "final_check_block");

console.log("── テンプレ最適化の安全の線（safetyLineIssues・本文は変えない）");
t("普通のテンプレ文は何も出ない", safetyLineIssues("〇〇さん、お世話になっております！！".replace("〇〇", "YUMA") + "\nご内覧のご案内をさせて頂きます😊！！").length === 0);
t("スモラ（ブランド名）→ BANNED_WORD", safetyLineIssues("スモラの担当です").some((i) => i.code === "BANNED_WORD" && i.evidence === "スモラ" && i.severity === "block"));
t("プレースホルダ 〇〇 → BANNED_WORD", safetyLineIssues("〇〇さんお世話になっております").some((i) => i.code === "BANNED_WORD"));
t("名無しの権兵衛さん → NAME_PLACEHOLDER", safetyLineIssues("名無しの権兵衛さんお世話になっております").some((i) => i.code === "NAME_PLACEHOLDER"));
t("システム語（<<<・JSON）→ SYSTEM_MARKER_LEAK", safetyLineIssues("お送りします<<<END").some((i) => i.code === "SYSTEM_MARKER_LEAK") && safetyLineIssues('{"reply":"x"}').some((i) => i.code === "SYSTEM_MARKER_LEAK"));
t("作業メモの行 → SYSTEM_MARKER_LEAK", safetyLineIssues("かしこまりました！！\n条件を取り込んで再ピックアップ宣言する場面です。").some((i) => i.code === "SYSTEM_MARKER_LEAK"));
t("文体の語（承知いたしました）は見ない", safetyLineIssues("承知いたしました").length === 0);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
