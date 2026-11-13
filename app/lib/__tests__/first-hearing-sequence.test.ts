// 2026-11-13 作業員7b: AIX【条件ヒアリング】の番は 返信→AIX→フォームの案内（決まった文）（FIRST_HEARING_SEQUENCE・既定 off）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hearingSendSequence, firstHearingSequenceOn, writerReplyCountOf, replyCountOf, sequenceAnnounce, HEARING_FORM_NOTE } from "../send-sequence";
import { replyCountOf as splitReplyCountOf } from "../reply-split";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
const ON = { FIRST_HEARING_SEQUENCE: "on" };
ok(firstHearingSequenceOn({}) && !firstHearingSequenceOn({ FIRST_HEARING_SEQUENCE: "off" }) && hearingSendSequence("condition_hearing", { FIRST_HEARING_SEQUENCE: "off" }) === null, "既定 on（11/13 束の試験で悪化0）・off は並びを作らない");
const s = hearingSendSequence("condition_hearing", ON)!;
ok(!!s && s.map((x) => (x.slot === "aix" ? "A" : "R")).join("") === "RAR", "on: 返信→AIX→返信");
ok(s[1].aix === "condition_hearing" && s[2].text === HEARING_FORM_NOTE && !s[0].text, "AIX は条件ヒアリング・3通目は決まった文");
ok(hearingSendSequence("condition_hearing/whatever", ON) !== null && hearingSendSequence("property_send", ON) === null && hearingSendSequence(null, ON) === null, "条件ヒアリングの番だけ");
ok(writerReplyCountOf(s) === 1 && replyCountOf(s) === 2, "書き手が書くのは1通（決まった文は数えない）");
ok(splitReplyCountOf({ send_sequence_reply_count: writerReplyCountOf(s) }) === 1, "書き手の分け目の1行は出ない（通数1）");
ok(sequenceAnnounce(s)[2].includes("決まった文"), "アナウンスに決まった文と出る");
ok(!/鈴木|竹内|〇〇/.test(HEARING_FORM_NOTE) && HEARING_FORM_NOTE.includes("ご入力ください😌"), "スタッフの名前・伏せ字を入れない");
// 配線: brain-core の meta に入れる所
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
ok(bc.includes("hearingSendSequence(finalAix ?? null)") && bc.includes("send_sequence_reply_count: writerReplyCountOf(hs)") && bc.includes("sendSequenceOn() && !hearingSendSequence(finalAix ?? null)"), "brain-core の配線（ヒアリングの並びが TWO_MESSAGE_SEQUENCE より先）");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("first-hearing-sequence: 全部 ok");
