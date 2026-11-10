// 送る物の並びの採点（scripts/lib/send-seq-score.ts）
// 実行: npx tsx scripts/lib/__tests__/send-seq-score.test.ts（自己完結。全 PASS で exit 0）
import { seqOfStaffText, wantSeqOf, brainSeqOf, seqMatch, replyCountMatch, draftPartCount, seqStats, sendSeqSummary, rawSeqOf, type SeqRow } from "../send-seq-score";

let fail = 0, pass = 0;
function eq(name: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++; else { fail++; console.error(`✗ ${name}\n   得: ${JSON.stringify(a)}\n   期: ${JSON.stringify(b)}`); }
}

// 実送信から（q390 の形: 返信 → AIX【条件ヒアリング】→ 返信）
eq("RAR", seqOfStaffText("はい！！\n何卒よろしくお願い致します！！\n―\n【AIX】（YUMAさんご希望のお部屋探しご条件）\n①ご入居時期\n―\nYUMAさんご希望のご条件をお送りいただきましたら…"), "RAR");
eq("AIX の画像と文は1つの A", seqOfStaffText("【AIX】[画像]\n―\n【AIX】【ハイツ 202号室】\n初期費用：178,090円\n―\nご確認よろしくお願い致します！！"), "AR");
eq("手で送った画像だけの通は数えない", seqOfStaffText("[画像]\n―\nこちらのお部屋です！！"), "R");
eq("返信2通", seqOfStaffText("かしこまりました！！\n―\nはい！！\n明日ご連絡させて頂きます！！"), "RR");
eq("空は正解なし", seqOfStaffText(""), null);
eq("null も正解なし", seqOfStaffText(null), null);
eq("AIX が間で2回は2つ", seqOfStaffText("【AIX】a\n―\nb\n―\n【AIX】c"), "ARA");

// 正解: 札が先
eq("札が先", wantSeqOf({ tags: ["送る物の並び", "並び:RR"], staffText: "a\n―\nb\n―\nc" }), { seq: "RR", from: "札" });
eq("札が無ければ実送信", wantSeqOf({ tags: ["x"], staffText: "【AIX】a\n―\nb" }), { seq: "AR", from: "実送信" });
eq("札の形が崩れていれば実送信", wantSeqOf({ tags: ["並び:?"], staffText: "a" }), { seq: "R", from: "実送信" });
eq("どちらも無い", wantSeqOf({ tags: [], staffText: "" }), null);

// ブレイン
eq("send_sequence", brainSeqOf({ send_sequence: [{ slot: "reply" }, { slot: "aix" }, { slot: "reply" }] }), { seq: "RAR", recorded: true });
eq("無ければ AIX の番は A", brainSeqOf({ reply_mode: "aix", action: "viewing_invite" }), { seq: "A", recorded: false });
eq("reply_mode=aix でも action が空なら R", brainSeqOf({ reply_mode: "aix", action: "" }), { seq: "R", recorded: false });
eq("返信は R", brainSeqOf({ reply_mode: "auto_reply" }), { seq: "R", recorded: false });
eq("2択", brainSeqOf({ two_choice_mode: true, reply_mode: "auto_reply" }), { seq: "R|A", recorded: false });
eq("null", brainSeqOf(null), { seq: "R", recorded: false });

// 一致
eq("一致", seqMatch("RAR", "RAR"), true);
eq("2択は R でも A でも", [seqMatch("R", "R|A"), seqMatch("A", "R|A"), seqMatch("AR", "R|A")], [true, true, false]);
eq("返信の通数", [replyCountMatch("RAR", "RR"), replyCountMatch("AR", "R"), replyCountMatch("A", "R|A")], [true, true, true]);
eq("下書きの通数", [draftPartCount("a\n---\nb"), draftPartCount("a"), draftPartCount(null), draftPartCount("a\r\n---\r\nb\n---\nc")], [2, 1, 0, 3]);

// まとめ
const rows: SeqRow[] = [
  { id: "q1", want: "R", from: "実送信", got: "R", recorded: false, draft: "a" },
  { id: "q2", want: "R", from: "実送信", got: "RR", recorded: true, draft: "a\n---\nb" },
  { id: "q3", want: "RAR", from: "札", got: "RAR", recorded: true, draft: null },
  { id: "q4", want: "RR", from: "札", got: "R", recorded: false, draft: "a" },
  { id: "q5", want: "A", from: "実送信", got: "R|A", recorded: false, draft: null },
];
const st = seqStats(rows);
eq("一致の数", st.match, 3);
eq("通数の一致", st.countMatch, 3); // q1・q3・q5（q2 は 2≠1・q4 は 1≠2）
eq("1通の番を割った", st.overSplit.map((x) => x.id), ["q2"]);
eq("2通以上の番を1通に", st.underSplit.map((x) => x.id), ["q4"]);
eq("2通以上の番", [st.multiN, st.multiHit], [2, 1]);
eq("返信2通以上の番の下書き", [st.multiReplyN, st.draftSplit, st.draftHave], [2, 0, 1]);
eq("send_sequence を出した", st.recorded, 2);
const pct = (a: number, b: number) => `${a}/${b}`;
const line = sendSeqSummary(rows, pct);
eq("要約の頭", line.startsWith("送る物の並び（回 5・正解は札 2／実送信 3・ブレインが send_sequence を出した 2）: 一致 3/5"), true);
eq("割った問題が出る", line.includes("q2=RR（正解 R）"), true);
eq("行が無ければ空", sendSeqSummary([], pct), "");

// 本質（LLM の最初）の並び
eq("raw の send_sequence", rawSeqOf({ send_sequence: [{ slot: "reply" }, { slot: "aix" }] }), "RA");
eq("raw に並びが無く aix あり", rawSeqOf({ aix: "estimate_sheet" }), "A");
eq("raw に aix 無し", [rawSeqOf({ aix: null }), rawSeqOf({ aix: "none" }), rawSeqOf(null)], ["R", "R", null]);
const st2 = seqStats([{ id: "a", want: "RR", from: "札", got: "R", recorded: false, draft: null, raw: "RR" }, { id: "b", want: "RAR", from: "札", got: "R", recorded: false, draft: null, raw: "RA" }, { id: "c", want: "R", from: "実送信", got: "R", recorded: false, draft: null }]);
eq("本質の一致", [st2.rawN, st2.rawMatch, st2.rawMultiN, st2.rawMultiHit], [2, 1, 2, 1]);
eq("要約に本質の一致", sendSeqSummary([{ id: "a", want: "RR", from: "札", got: "R", recorded: false, draft: null, raw: "RR" }], pct).includes("本質（LLM の最初の並び）の一致 1/1"), true);
console.log(`send-seq-score: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
