// 2026-11-15 作業員H（案A・907c74b4）: AIX【物件確認した】で選んだ確認の型 → line_tasks.result（TASK_RESULT_FROM_AIX・既定 off）と、
//   ブレインの【空室確認の回答結果（確定事実）】の段が読めるようになる事を、元の番の形（aix_usage_logs の 60日の実物の値の組）で確かめる。LLM も DB も使わない。
// 実行: npx tsx app/lib/__tests__/task-result-from-aix.test.ts
import { readFileSync } from "node:fs";
import { taskResultFromAix, taskResultFromAixOn, buildCheckResultsText } from "../task-result-from-aix";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }
const PCR = "property_check_result";

ok("既定 off", taskResultFromAixOn({}) === false && taskResultFromAixOn({ TASK_RESULT_FROM_AIX: "on" }));
ok("募集中（available・1件・99回の形）→ available", taskResultFromAix({ aixType: PCR, checkPattern: "available", propStatuses: ["available"], propertyNames: ["サンプル本町 502"] })?.result === "available");
ok("募集中が2件そろう（36回の形）→ available", taskResultFromAix({ aixType: PCR, checkPattern: "available", propStatuses: ["available", "available"] })?.result === "available");
ok("募集終了（unavailable・物件ごとの値なし・36回の形）→ taken", taskResultFromAix({ aixType: PCR, checkPattern: "unavailable", propStatuses: null })?.result === "taken");
ok("check_pattern は募集中でも物件の値が募集終了（12回の形）→ 物件の値で taken", taskResultFromAix({ aixType: PCR, checkPattern: "available", propStatuses: ["unavailable"] })?.result === "taken");
{
  const r = taskResultFromAix({ aixType: PCR, checkPattern: "available", propStatuses: ["alternative"], propertyNames: ["サンプル天満"] });
  ok("別の部屋が募集（alternative）→ taken＋メモ", r?.result === "taken" && /別の部屋が募集中/.test(r?.note ?? "") && /サンプル天満/.test(r?.note ?? ""), JSON.stringify(r));
}
ok("退去予定（vacating）→ move_out_planned", taskResultFromAix({ aixType: PCR, checkPattern: "available", propStatuses: ["vacating"] })?.result === "move_out_planned");
ok("2番手 → second_position", taskResultFromAix({ aixType: PCR, checkPattern: "second", propStatuses: null })?.result === "second_position");
ok("物件ごとに割れた（募集中＋募集終了）→ 付けない", taskResultFromAix({ aixType: PCR, checkPattern: "available", propStatuses: ["available", "unavailable", "available"] }) === null);
ok("室内写真・管理会社の条件（mgmt_equipment）→ 付けない", taskResultFromAix({ aixType: PCR, checkPattern: "interior_photo", propStatuses: ["interior_photo"] }) === null && taskResultFromAix({ aixType: PCR, checkPattern: "mgmt_equipment", propStatuses: null }) === null);
ok("物件確認した 以外の AIX → 付けない", taskResultFromAix({ aixType: "estimate_sheet", checkPattern: "available", propStatuses: ["available"] }) === null);

// ブレインの段: 結果が付いた完了タスクがあると【空室確認の回答結果（確定事実）】が出る（付かない今は出ない＝0/247 の状態）
{
  const before = buildCheckResultsText([{ task_type: "property_check", status: "completed", result: null, result_note: null }]);
  ok("今（結果なし）: 段は出ない", before === "");
  const r = taskResultFromAix({ aixType: PCR, checkPattern: "unavailable", propStatuses: ["unavailable"], propertyNames: ["サンプル本町 502"] });
  const after = buildCheckResultsText([{ task_type: "property_check", status: "completed", result: r?.result ?? null, result_note: r?.note ?? null }]);
  ok("AIX から結果が付くと: 段が出る（申込済み・埋まった・物件名つき）", /【空室確認の回答結果（確定事実）】/.test(after) && /物件確認（空室確認）: 申込済み・埋まった（サンプル本町 502：募集終了）/.test(after), after);
}
{
  const route = readFileSync("app/api/line-tasks/complete/route.ts", "utf8"), page = readFileSync("app/page.tsx", "utf8"), bc = readFileSync("app/lib/brain-core.ts", "utf8");
  ok("配線: 画面の AIX 送信の後の完了が確認の型を渡す", /source: "aix", aix_type: aixModalType, check_pattern: meta\?\.checkPattern/.test(page));
  ok("配線: line-tasks/complete が結果の無い AIX の完了に型から結果を付ける（スイッチの時だけ）", /!result && source === "aix" && taskResultFromAixOn\(\)/.test(route));
  ok("配線: ブレインの段は同じ関数（buildCheckResultsText）", /const checkResultsText = buildCheckResultsText\(allTasks\)/.test(bc));
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
