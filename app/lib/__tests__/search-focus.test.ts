// app/lib/__tests__/search-focus.test.ts — 会話画面の「🔍 物件検索」の印（純関数）
// 実行: npx tsx app/lib/__tests__/search-focus.test.ts
import { deviceOf, lastConditionChange, conditionWriterJa, FOCUS_TTL_MS } from "../search-focus";
import * as fs from "fs";
import * as path from "path";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

t("iPhone はスマホ", deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)") === "phone");
t("Android はスマホ", deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile") === "phone");
t("Windows の Chrome は PC", deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141") === "pc");
t("UA 無しは PC", deviceOf(null) === "pc");

// H0N0KA. の形: 18:21「もう少し家賃上げて良いので、新大阪、東三国」「もう少し広いと」→ P4 が家賃・エリア・広さを同じ発言で書いた
const rows = [
  { changed_field: "rent_max", old_value: "70000", new_value: "80000", source_message_id: "p4:11111111-1111-1111-1111-111111111111", created_at: "2026-10-06T09:21:30Z" },
  { changed_field: "desired_area", old_value: "淀川区", new_value: "新大阪・東三国", source_message_id: "p4:11111111-1111-1111-1111-111111111111", created_at: "2026-10-06T09:21:29Z" },
  { changed_field: "floor_area_min", old_value: null, new_value: "25", source_message_id: "p4:22222222-2222-2222-2222-222222222222", created_at: "2026-10-06T09:21:10Z" },
  { changed_field: "rent_max", old_value: "65000", new_value: "70000", source_message_id: "screen_edit", created_at: "2026-10-01T03:00:00Z" },
];
const lc = lastConditionChange(rows);
t("一番新しい束（2分以内）だけ", JSON.stringify(lc?.fields.map((f) => f.field)) === JSON.stringify(["rent_max", "desired_area", "floor_area_min"]), JSON.stringify(lc));
t("同じ列は一番新しい値（家賃 7万→8万）", lc?.fields[0].old === "70000" && lc?.fields[0].new === "80000");
t("日本語のラベル", lc?.fields.map((f) => f.label).join("・") === "家賃の上限・希望エリア・広さ");
t("書き手は p4 → LINE から自動", lc?.writer === "p4" && conditionWriterJa(lc?.writer) === "LINE から自動");
t("履歴なし → null", lastConditionChange([]) === null);
t("画面編集", conditionWriterJa("screen_edit") === "画面で編集");

// 拡張の TTL と同じ値（2か所の線がずれない）
const ext = fs.readFileSync(path.join(__dirname, "../../../chrome-extension/search-focus.js"), "utf8");
t("拡張の TTL と同じ 24時間", FOCUS_TTL_MS === 24 * 60 * 60 * 1000 && /var TTL_MS = 24 \* 60 \* 60 \* 1000;/.test(ext));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
