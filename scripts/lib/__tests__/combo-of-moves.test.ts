// 2026-11-13 作業員7b: 竹内さんの実送信から組を読む（scripts/lib/combo-of-moves.ts）。形は 12240（挨拶の返信→10秒後に AIX【条件ヒアリング】）・11408（AIX→4分後に AIX）等
import { takeuchiCombo } from "../combo-of-moves";
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
console.log(`combo-of-moves: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
