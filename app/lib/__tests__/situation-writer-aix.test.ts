// app/lib/__tests__/situation-writer-aix.test.ts — 2026-11-21 作業員K2（SITUATION_WRITER_NOTE_AIX）
//   実行: npx tsx app/lib/__tests__/situation-writer-aix.test.ts
import { situationWriterNoteAix, situationWriterNoteAixOn, ourItemsWriterLines, ourItemsWriterNoteOn, ourItemsReplyNote } from "../situation-writer-aix";
import type { SnOurItem } from "../situation-now";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const item = (n: number, kind: string, text: string, answered: boolean | null = null): SnOurItem => ({ item_id: `2026-11-20T0${n}:00:00Z#0`, at: `2026-11-20T0${n}:00:00Z`, kind, label: kind, text, expect: "answer", answered, ask_id: null, src: "messages" as never, sure: "high" as never });
t("既定 off", !situationWriterNoteAixOn({}) && situationWriterNoteAixOn({ SITUATION_WRITER_NOTE_AIX: "on" }));
t("記録が無ければ空", situationWriterNoteAix(null, Date.now()) === "" && situationWriterNoteAix({}, Date.now()) === "");
const items = [item(1, "promise", "南堀江周辺からピックアップしてお送りさせて頂きます"), item(2, "question", "ご入居のご予定はいつ頃でしょうか", true), item(3, "invite", "ご都合よろしいお日にちにご案内させて頂きます", false)];
const lines = ourItemsWriterLines(items);
t("古い順に種類と中身・聞いた事と誘いは答えの有無", lines.length === 3 && /^- 約束「南堀江/.test(lines[0]) && /（お客様は答えた）/.test(lines[1]) && /（まだ答えが無い）/.test(lines[2]), lines);
t("最大の件数で切る（新しい方を残す）", ourItemsWriterLines([...Array(9)].map((_, i) => item(i, "fact", `事実${i}`)), 6).length === 6 && /事実8/.test(ourItemsWriterLines([...Array(9)].map((_, i) => item(i, "fact", `事実${i}`)), 6).at(-1) ?? ""));
const note = situationWriterNoteAix({ our_items: items }, Date.parse("2026-11-20T10:00:00Z"));
t("塊の見出しと項目", /【こちらが前に伝えた事/.test(note) && /約束「南堀江/.test(note), note);
t("返信の書き手の塊: 既定 off・項目がある時だけ", !ourItemsWriterNoteOn({}) && ourItemsWriterNoteOn({ OUR_ITEMS_WRITER_NOTE: "on" }) && ourItemsReplyNote(null) === "" && /誘い「ご都合よろしい/.test(ourItemsReplyNote({ our_items: items })));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
