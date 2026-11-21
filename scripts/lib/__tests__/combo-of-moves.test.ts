// 2026-11-13 作業員7b: 竹内さんの実送信から組を読む（scripts/lib/combo-of-moves.ts）。形は 12240（挨拶の返信→10秒後に AIX【条件ヒアリング】）・11408（AIX→4分後に AIX）等
import { takeuchiCombo, assignAixKinds, comboMatches } from "../combo-of-moves";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) pass++; else { fail++; console.error("NG", n); } };
const t0 = Date.parse("2026-11-08T04:00:00Z"), s = (sec: number) => t0 + sec * 1000;
ok("返信だけ", takeuchiCombo(t0, [{ at: s(60), aix: false, writer: "takeuchi" }]) === "reply_only");
ok("返信→10秒後に AIX＝組", takeuchiCombo(t0, [{ at: s(60), aix: false, writer: "takeuchi" }, { at: s(70), aix: true, writer: "takeuchi" }, { at: s(71), aix: true, writer: "takeuchi" }]) === "reply_then_aix_quick");
ok("約束の返信→1時間後に AIX＝2段", takeuchiCombo(t0, [{ at: s(60), aix: false, writer: "takeuchi" }, { at: s(3660), aix: true, writer: "takeuchi" }]) === "promise_then_aix_later");
ok("返信→返信（5分以内）", takeuchiCombo(t0, [{ at: s(60), aix: false, writer: "takeuchi" }, { at: s(200), aix: false, writer: "takeuchi" }]) === "reply_reply");
ok("AIX（画像の続きはまとめる）→返信", takeuchiCombo(t0, [{ at: s(60), aix: true, writer: "takeuchi" }, { at: s(61), aix: true, writer: "takeuchi" }, { at: s(300), aix: false, writer: "takeuchi" }]) === "aix_then_reply");
ok("AIX→4分後に別の AIX", takeuchiCombo(t0, [{ at: s(60), aix: true, writer: "takeuchi" }, { at: s(330), aix: true, writer: "takeuchi" }]) === "aix_then_aix");
ok("AIX だけ", takeuchiCombo(t0, [{ at: s(60), aix: true, writer: "takeuchi" }]) === "aix_only");
ok("お客様の次の発言で切る", takeuchiCombo(t0, [{ at: s(60), aix: false, writer: "takeuchi" }, { at: s(100), aix: false, writer: null, customer: true }, { at: s(130), aix: true, writer: "takeuchi" }]) === "reply_only");
ok("何も無い番は null", takeuchiCombo(t0, []) === null);
// 2026-11-19 作業員M（台帳 #404）: オススメ＋ピックアップの束は1つの AIX
ok("束（ピックアップ→4分後にオススメ）は AIX だけ", takeuchiCombo(t0, [{ at: s(60), aix: true, writer: "takeuchi", aixKind: "property_send" }, { at: s(300), aix: true, writer: "takeuchi", aixKind: "property_recommendation" }]) === "aix_only");
ok("束の後に返信＝AIX → 返信", takeuchiCombo(t0, [{ at: s(60), aix: true, writer: "takeuchi", aixKind: "property_send" }, { at: s(300), aix: true, writer: "takeuchi", aixKind: "property_recommendation/x" }, { at: s(400), aix: false, writer: "takeuchi" }]) === "aix_then_reply");
ok("種類が違う AIX は AIX → AIX のまま", takeuchiCombo(t0, [{ at: s(60), aix: true, writer: "takeuchi", aixKind: "property_check_result" }, { at: s(300), aix: true, writer: "takeuchi", aixKind: "property_send" }]) === "aix_then_aix");
ok("種類が付いていなければ今まで通り", takeuchiCombo(t0, [{ at: s(60), aix: true, writer: "takeuchi" }, { at: s(300), aix: true, writer: "takeuchi" }]) === "aix_then_aix");
{
  const ms = assignAixKinds([{ at: s(60), aix: true, writer: "takeuchi" }, { at: s(70), aix: false, writer: "takeuchi" }], [{ at: s(30), aixType: "property_send" }, { at: s(9999), aixType: "estimate_sheet" }]);
  ok("AIX の通に近い記録の種類を付ける（返信の通には付けない）", ms[0].aixKind === "property_send" && ms[1].aixKind === undefined);
}
ok("組の一致: 同じ組", comboMatches("aix_then_reply", "aix_then_reply"));
ok("組の一致: 2段と返信だけは、竹内さんの AIX が48時間以内に後で来た時だけ同じ", comboMatches("promise_then_aix_later", "reply_only", { laterAixWithinMs: 20 * 3_600_000 }) && !comboMatches("promise_then_aix_later", "reply_only", {}) && !comboMatches("promise_then_aix_later", "reply_only", { laterAixWithinMs: 60 * 3_600_000 }));
ok("組の一致: 逆向き（返信だけ→2段）や他の組は違う", !comboMatches("reply_only", "promise_then_aix_later", { laterAixWithinMs: 1 }) && !comboMatches("aix_only", "aix_then_reply") && !comboMatches(null, "reply_only"));
console.log(`combo-of-moves: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
