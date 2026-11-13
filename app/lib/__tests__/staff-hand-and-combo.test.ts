// 2026-11-13 作業員C: 組の違いの14日の監査（scripts/audit-combo-mismatch.ts）で分かった違いの直し
//   ① 土台: スタッフの手元にある物を材料の1行に（BRAIN_STAFF_HAND・既定 off）
//   ② 細分化: 組の表に手がかりを渡す配線（comboCuesFromMeta）と、物件を送る AIX → 一押しの返信・見積書 → 説明の返信の行（SEND_COMBO_TABLE・既定 off）
//   形はどれも元になった本番の番（竹内さん本人の番・会話 id の頭8字）から
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { staffHandLine, staffHandMaterialOn } from "../staff-hand-material";
import { comboCuesFromMeta, pickSendCombo, sendComboRecord } from "../send-combo-table";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${n}`); } else { fail++; console.log(`  NG  ${n}`); } };
const none = { pickup: false, estimate: false, confirm: false };

// ① 土台
t("① 既定 off", !staffHandMaterialOn({}) && staffHandMaterialOn({ BRAIN_STAFF_HAND: "on" }));
// 2d7548d5（11/09「はい！お願いいたします」→ 竹内さんは約束した4物件のリンクの AIX）: 送れる候補（pending）があった
const l1 = staffHandLine({ pickupReady: true, openTaskTypes: [], openPromises: { ...none, pickup: true } });
t("① 2d7548d5 送れる候補と約束を並べる", /送れる新しい候補あり/.test(l1) && /まだ果たしていない約束: ピックアップ/.test(l1) && /AIX で送る/.test(l1));
// a8c55dde（11/06 内覧後の「お手数おかけして」→ 竹内さんは確認の結果の AIX）: 確認の約束が開いていて、候補も pending
const l2 = staffHandLine({ pickupReady: true, openTaskTypes: ["property_check"], openPromises: { ...none, confirm: true } });
t("① a8c55dde 作業中の物件確認と確認の約束", /作業中: 物件確認（募集状況）/.test(l2) && /募集状況の確認/.test(l2));
// 65c2df5b（11/08 礼金の問い → 竹内さんはすぐ見積書の AIX）: 見積書のタスクが作業中
const l3 = staffHandLine({ pickupReady: null, openTaskTypes: ["estimate_sheet", "estimate_sheet"], openPromises: { ...none, estimate: true } });
t("① 65c2df5b 作業中の見積書（重ねない）", /作業中: 見積書／/.test(l3) && !/見積書・見積書/.test(l3) && !/送れる新しい候補/.test(l3));
t("① 何も無い番は出さない", staffHandLine({ pickupReady: false, openTaskTypes: [], openPromises: none }) === "");
t("① 確認の結果・金額そのものは言わない（記録に無い）", !/募集中|募集終了|円/.test(l1 + l2 + l3));

// ② 細分化（手がかりの読み）
const aix = (action: string, extra: Record<string, unknown> = {}) => ({ reply_mode: "aix", action, ...extra });
// ceaae459・6c9dd6b7・043502cc・eb4e5d3b・fff5b6a3（物件を送る AIX の後に「お送りさせて頂きましたお部屋の中でも特に〇〇がオススメ」の返信）
const ps = pickSendCombo({ type: null, route: "aix", cues: comboCuesFromMeta(aix("property_send")) });
t("② 物件を送る AIX → 一押しの返信", ps?.combo === "aix_then_reply" && /一押し/.test(ps.order));
// 969f0162・043502cc（見積書の AIX の後に「最大限割引しました初期費用の御見積書となります」＋保証会社の説明）
const es = pickSendCombo({ type: null, route: "aix", cues: comboCuesFromMeta(aix("estimate_sheet")) });
t("② 見積書 → 割引と保証会社の説明の返信", es?.combo === "aix_then_reply" && /保証会社/.test(es.order));
// cd0503c7・a8c55dde 11/06 05:54（確認の結果の AIX → 物件を送る AIX）: 約束が2つ開いていて結果が手元
const two = comboCuesFromMeta(aix("property_check_result", { action_ledger: { facts: { pickupPromisedUnfulfilled: true, confirmationPromisedUnfulfilled: true } }, now_vs_later: { ready_now: ["確認の結果"] } }));
t("② 約束2つ・結果が手元 の手がかり", two.twoOpenPromises === true && two.resultReady === true);
t("② → 確認の結果 → 物件の AIX", pickSendCombo({ type: null, route: "aix", cues: two })?.combo === "aix_then_aix");
// 8f705d16（おとり物件の説明 → 2通目）の形: 問いが2つ
const mt = comboCuesFromMeta({ reply_mode: "auto_reply", action: "", turn_contract: { asks: [{ kind: "question" }, { kind: "question" }] } });
t("② 問いが2つ → 返信→返信", mt.multiTopics === true && pickSendCombo({ type: null, route: "reply", cues: mt })?.combo === "reply_reply");
t("② 条件ヒアリング → 返信→すぐ AIX", pickSendCombo({ type: null, route: "aix", cues: comboCuesFromMeta(aix("condition_hearing")) })?.combo === "reply_then_aix_quick");
t("② 他の AIX は今まで通り AIX だけ", pickSendCombo({ type: null, route: "aix", cues: comboCuesFromMeta(aix("viewing_invite")) })?.combo === "aix_only");
t("② 返信の番は aixKind を持たない", comboCuesFromMeta({ reply_mode: "auto_reply", action: "property_send" }).aixKind === null);
t("② 既定 off は何も記録しない", sendComboRecord(aix("property_send"), comboCuesFromMeta(aix("property_send")), {}) === null && !!sendComboRecord(aix("property_send"), comboCuesFromMeta(aix("property_send")), { SEND_COMBO_TABLE: "shadow" }));

// 配線
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
const cb = readFileSync(join(__dirname, "..", "conductor-brief.ts"), "utf8");
t("配線: brain-core が手元の1行を足す", bc.includes("staffHandMaterialOn() && !isPostApplyStatus(convStatus)") && bc.includes("staffHandLine({ pickupReady: pickupReadyMaterial"));
t("配線: brain-core が組を meta.send_combo に記録（手がかりは meta から）", bc.includes("comboCuesFromMeta(mm)") && bc.includes("mm.send_combo ="));
t("配線: 行動台帳の約束2つを meta に", bc.includes("estimatePromisedUnfulfilled: brainLedger.facts.estimatePromisedUnfulfilled"));
t("配線: 統括の指示書も同じ手がかり", cb.includes("cues: { ...comboCuesFromMeta(m),"));
console.log(`staff-hand-and-combo: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
