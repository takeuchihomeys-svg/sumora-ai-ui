// app/lib/__tests__/search-focus.test.ts — 会話画面の「🔍 物件検索」の印（純関数）
// 実行: npx tsx app/lib/__tests__/search-focus.test.ts
import { deviceOf, lastConditionChange, conditionWriterJa, FOCUS_TTL_MS, shouldPlaceAutoFocus, FOCUS_DEDUPE_MS } from "../search-focus";
import { focusClosingFrom } from "../search-focus-server";
import type { ClosingTargetState } from "../closing-target";
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

// 2026-10-07 AIX【物件を探す】を送った時の自動の印（二重に置かない）
const NOWMS = Date.parse("2026-10-07T05:00:00Z");
t("印が無い → 置く", shouldPlaceAutoFocus(null, NOWMS));
t("1分前に 🔍 で押された → 置かない（二重）", !shouldPlaceAutoFocus({ requested_at: "2026-10-07T04:59:00Z" }, NOWMS));
t("2分ちょうど → 置く", shouldPlaceAutoFocus({ requested_at: new Date(NOWMS - FOCUS_DEDUPE_MS).toISOString() }, NOWMS));
t("昨日の印 → 置き直す（一番上へ戻す）", shouldPlaceAutoFocus({ requested_at: "2026-10-06T05:00:00Z" }, NOWMS));
t("時刻が壊れている → 置く", shouldPlaceAutoFocus({ requested_at: "x" }, NOWMS));

// 決め手の条件 → 拡張に渡す形（H0N0KA. の形: 気に入った部屋より家賃−5千・ゆいと: カウンターキッチン）
const mk = (want: Record<string, unknown>, status: "active" | "partial" | "found", kind = "rent_lower"): ClosingTargetState => ({
  status, sentAfter: [],
  target: { v: "closing-target@2026-10-07", kind, kinds: [kind], evidence: "ただ家賃もう少し下がったりしないですよね", at: null, liked: true,
    favorite: { name: "バウスフラッツ新大阪", room: "1002" }, want, scope: "temporary", registerHints: [], rationale: "…「お客様の言葉」…" },
} as unknown as ClosingTargetState);
const cur = { rent_max: 80000, floor_plan: "1LDK", floor_area_min: null, walk_minutes: null, building_age: null, desired_area: "新大阪・東三国", preferences: null, area_mode: "station" };
const rentFc = focusClosingFrom(mk({ rentMaxTotal: 76000, floorPlans: ["1LDK"] }, "active"), cur);
t("家賃−5千 → 上書きは家賃の上限だけ（間取りは登録と同じ）", rentFc?.search_override?.rent_max === 76000 && rentFc?.search_override?.floor_plan === null, JSON.stringify(rentFc));
t("型の日本語・基準の部屋", rentFc?.kinds_ja.join() === "家賃" && rentFc?.favorite === "バウスフラッツ新大阪 1002");
t("お客様の言葉（evidence・rationale）は渡さない", !JSON.stringify(rentFc).includes("下がったり") && !JSON.stringify(rentFc).includes("お客様の言葉"));
t("見つかった像（found）→ null", focusClosingFrom(mk({ rentMaxTotal: 76000 }, "found"), cur) === null);
const eqFc = focusClosingFrom(mk({ equipment: [{ key: "counter_kitchen", label: "カウンターキッチン" }] }, "partial", "equipment"), cur);
t("設備だけ → 上書きなし・設備は帯へ", eqFc !== null && eqFc.search_override === null && eqFc.equipment.join() === "カウンターキッチン" && eqFc.kinds_ja.join() === "設備", JSON.stringify(eqFc));
t("登録と同じ値しか無い → null", focusClosingFrom(mk({ rentMaxTotal: 80000 }, "active"), cur) === null);
t("像なし → null", focusClosingFrom(null, cur) === null);
t("拡張の札に AIX物件を探す", ext.includes('f.device === "aix" ? "AIX物件を探す"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
