// 試験の時だけ書き手の材料を残す口（2026-11-06 作業員9・EXAM_DUMP_WRITER_PROMPT）
// 実行: npx tsx app/lib/__tests__/exam-writer-dump.test.ts
import { writerDumpOn, messagesToText, dumpWriterPrompt } from "../exam-writer-dump";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
t("既定 off", !writerDumpOn({}));
t("スイッチだけ（試験の印なし＝本番）では動かない", !writerDumpOn({ EXAM_DUMP_WRITER_PROMPT: "on" }));
t("Vercel では試験の印があっても動かない", !writerDumpOn({ EXAM_DUMP_WRITER_PROMPT: "on", LLM_TEST_MODE: "deepseek-all", VERCEL: "1" }));
t("試験の印＋スイッチで動く", writerDumpOn({ EXAM_DUMP_WRITER_PROMPT: "on", LLM_TEST_MODE: "deepseek-all" }));
const m = messagesToText([{ content: "sys", _getType: () => "system" }, { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], _getType: () => "human" }]);
t("材料を役と文に直す", m[0].role === "system" && m[0].text === "sys" && m[1].text === "a\nb");
(async () => {
  const r = await dumpWriterPrompt({ conversationId: "x", messages: [] }, { EXAM_DUMP_WRITER_PROMPT: "on" });
  t("本番（試験の印なし）は書かない", r === null);
  console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
})();
