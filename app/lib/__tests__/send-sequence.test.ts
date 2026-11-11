import * as fs from "node:fs";
import { sendSequenceRule, sanitizeSendSequence, replyCountOf, sequenceAnnounce, currentStepOf, splitDraftParts, sendSequenceUiOn, SEND_SEQUENCE_FIELD } from "../send-sequence";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
ok(sendSequenceRule({}) === "", "既定 off は1字も足さない");
const r = sendSequenceRule({ TWO_MESSAGE_SEQUENCE: "on" });
ok(r.includes("send_sequence") && r.endsWith("\n") && !r.slice(0, -1).includes("\n"), "on で1行");
const seq = sanitizeSendSequence([{ slot: "reply", role: "受け止め＋答え" }, { slot: "aix", aix: "x" }, { slot: "reply", role: "誘い" }], "viewing_invite");
ok(!!seq && seq.length === 3 && seq[1].aix === "viewing_invite", "AIX のキーはブレインの最終の AIX");
ok(replyCountOf(seq) === 2, "返信の通数 2");
ok(sanitizeSendSequence([{ slot: "reply", role: "受け止め" }], null) === null, "返信1通だけは null（今の形のまま）");
ok(sanitizeSendSequence([{ slot: "reply" }, { slot: "aix" }], null)?.length === undefined, "aix が空なら AIX の通を外し、1通になる＝null");
ok(sanitizeSendSequence([{ slot: "reply" }, { slot: "reply" }], "estimate_sheet") === null, "ブレインが AIX なのに並びに無い＝null");
ok(sanitizeSendSequence([{ slot: "reply" }, { slot: "reply" }, { slot: "reply" }, { slot: "reply" }], null) === null, "返信4通は null");
ok(sanitizeSendSequence("x", null) === null, "形が崩れていれば null");
ok(sequenceAnnounce(seq)[1] === "2通目: AIX【内覧調整】", "アナウンスの AIX の名前");
ok(currentStepOf(seq, 1) === 1 && currentStepOf(seq, 3) === null, "送った数から今の通");
ok(splitDraftParts("1通目\n---\n2通目").length === 2, "下書きを --- で分ける");
ok(!sendSequenceUiOn("on", false) && sendSequenceUiOn("on", true) && !sendSequenceUiOn(undefined, true), "画面は on でも YUMA だけ");
ok(SEND_SEQUENCE_FIELD.startsWith("\"send_sequence\": [") && !SEND_SEQUENCE_FIELD.includes("`"), "出力の指定の欄（11/10: 欄が無く DeepSeek が出さなかった）");
// 配線: brain-core の出力の指定に on の時だけ足す
ok(fs.readFileSync("app/lib/brain-core.ts", "utf8").includes("sendSequenceOn() ? \", \" + SEND_SEQUENCE_FIELD"), "brain-core の出力の指定に配線");
// 11/11 分け方 v2（TWO_MESSAGE_SEQUENCE_SPLIT_V2）
ok(sendSequenceRule({ TWO_MESSAGE_SPLIT_V2: "on" } as Record<string, string>) === "" && sendSequenceRule({ TWO_MESSAGE_SEQUENCE_SPLIT_V2: "on" }) === "", "v2 も TWO_MESSAGE_SEQUENCE が off なら1字も足さない");
ok(sendSequenceRule({ TWO_MESSAGE_SEQUENCE: "on" }).includes("迷ったら1通") && !sendSequenceRule({ TWO_MESSAGE_SEQUENCE: "on", TWO_MESSAGE_SEQUENCE_SPLIT_V2: "on" }).includes("迷ったら1通"), "v2 は迷ったら1通を言わない・既定は今まで通り");
ok(["次の一歩", "1通に詰めない", "(RAR)", "(ARR)", "74%", "2通目が別の要件", "2通目が次の一歩"].every((w) => sendSequenceRule({ TWO_MESSAGE_SEQUENCE: "on", TWO_MESSAGE_SEQUENCE_SPLIT_V2: "on" }).includes(w)), "v2 は分ける番と竹内さんの実物");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("send-sequence: 全部 ok");
