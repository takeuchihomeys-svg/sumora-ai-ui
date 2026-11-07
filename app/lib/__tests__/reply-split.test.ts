// 返信を2〜3通に分ける下書き（2026-11-07 作業員9・REPLY_SPLIT_WRITER）
// 実行: npx tsx app/lib/__tests__/reply-split.test.ts
import { splitReplyDraft, joinReplyDraft, replySplitWriterNote, replyCountOf, mapReplyParts, replySplitWriterOn } from "../reply-split";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const ON = { REPLY_SPLIT_WRITER: "on" };
t("既定 off", !replySplitWriterOn({}) && replySplitWriterNote(2, null, {}) === null);
t("1通なら1行を出さない", replySplitWriterNote(1, null, ON) === null);
const n2 = replySplitWriterNote(2, null, ON) ?? "";
t("2通: 役目と印", n2.includes("1通目＝受け止め＋答え") && n2.includes("2通目＝答えの続き・誘い・締め") && n2.includes("---"), n2);
const n3 = replySplitWriterNote(3, ["受け止め＋答え", "答えの続き", "誘い・締め"], ON) ?? "";
t("3通: send_sequence の役目を使う", n3.includes("3通目＝誘い・締め"), n3);
t("役目の数が合わなければ既定の役目", (replySplitWriterNote(2, ["a"], ON) ?? "").includes("1通目＝受け止め＋答え"));
t("通数: 無い・壊れは1・3に丸める", replyCountOf(null) === 1 && replyCountOf({ send_sequence_reply_count: "x" }) === 1 && replyCountOf({ send_sequence_reply_count: 5 }) === 3 && replyCountOf({ send_sequence_reply_count: 2 }) === 2);
// 実物の形（竹内さんの分けた番の形を伏せた物）
const draft = "かしこまりました！！\nこちらのお部屋、現在募集中となります😊！！\n---\nお近くのコインパーキングにお停め頂けます！！\nご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！";
const parts = splitReplyDraft(draft);
t("分ける: 2通", parts.length === 2 && parts[0].startsWith("かしこまりました") && parts[1].startsWith("お近くの"), parts);
t("印が無ければ1通", splitReplyDraft("はい😊！！\n何卒よろしくお願い致します！！").length === 1);
t("空の通は捨てる・前後の印も", splitReplyDraft("---\nA！！\n---\n\n---\nB！！\n---").join("|") === "A！！|B！！");
t("「----」や前後の空白も印", splitReplyDraft("A\n  ----  \nB").length === 2);
t("つなぎ直し", joinReplyDraft(["A", " B "]) === "A\n---\nB");
t("通ごとに当てる", mapReplyParts(draft, (p, i) => i === 0 ? p : p.toUpperCase()).split("\n---\n").length === 2);
t("1通なら丸ごと当てる", mapReplyParts("abc", (p) => p + "!") === "abc!");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
