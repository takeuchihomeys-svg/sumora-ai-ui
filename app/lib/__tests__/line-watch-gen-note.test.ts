// app/lib/__tests__/line-watch-gen-note.test.ts — 保存した下書きの見張りの控え（LINE_WATCH_GEN_NOTE・2026-10-28）
//   実行: npx tsx app/lib/__tests__/line-watch-gen-note.test.ts
import { lineWatchGenNoteOn, generatedDraftSummary, mergeWatchMaterials } from "../line-watch-materials";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };
t("既定は off", !lineWatchGenNoteOn({}));
t("on で入る", lineWatchGenNoteOn({ LINE_WATCH_GEN_NOTE: "on" }));
t("off は off", !lineWatchGenNoteOn({ LINE_WATCH_GEN_NOTE: "off" }));
const s = generatedDraftSummary("かしこまりました！！\n確認させて頂きます！！", "manual");
t("本文・字数・呼び出し元", s.text === "かしこまりました！！\n確認させて頂きます！！" && s.chars === 22 && s.caller === "manual", s);
t("本文は 2000 字まで", (generatedDraftSummary("あ".repeat(3000), "auto").text as string).length === 2000);
const big = mergeWatchMaterials(null, [
  { source: "reply", key: "generated", summary: generatedDraftSummary("い".repeat(2000), "auto"), at: "x" },
  { source: "suppressed", key: "draft", summary: { text: "う".repeat(2000), reason: "r", chars: 2000 }, at: "x" },
  { source: "brain", key: "blocks", summary: { chars: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i + 1])) }, at: "x" },
]);
t("大きすぎる時は生成の控えを縮める", (big.reply.generated as { text: string }).text.length <= 600, (big.reply.generated as { text: string }).text.length);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
