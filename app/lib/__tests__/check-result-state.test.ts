// 空室確認の結果が手元にあるか（2026-11-23 作業員G・#615）
// 実行: npx tsx app/lib/__tests__/check-result-state.test.ts
import { checkResultState, checkResultStateOn, checkResultStateText } from "../check-result-state";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const now = Date.parse("2026-11-23T08:00:00Z");
const t = (min: number, status: string, result: string | null, type = "property_check") => ({ task_type: type, status, created_at: new Date(now - min * 60_000).toISOString(), result, resolved_at: result ? new Date(now - 1 * 60_000).toISOString() : null });

ok("タスクが無い → none", checkResultState([], now).state === "none" && checkResultStateText(checkResultState([], now)) === "");
const p = checkResultState([t(30, "pending", null)], now);
ok("開いていて結果なし → pending・30分", p.state === "pending" && p.openSinceMin === 30);
ok("pending の1行は AIX【物件確認した】の番と書く", /AIX【物件確認した】/.test(checkResultStateText(p)) && /返信で結果を作らない/.test(checkResultStateText(p)));
ok("結果あり → on_hand", checkResultState([t(60, "done", "available")], now).state === "on_hand");
ok("新しいタスクが開いていれば古い結果より pending", checkResultState([t(200, "done", "taken"), t(10, "pending", null)], now).state === "pending");
ok("新しいタスクに結果があれば on_hand", checkResultState([t(200, "pending", null), t(10, "done", "available")], now).state === "on_hand");
ok("物件送付のタスクは見ない", checkResultState([t(5, "pending", null, "property_send")], now).state === "none");
ok("完了で結果なし（AIX 以外で閉じた）→ none（作らない）", checkResultState([t(5, "done", null)], now).state === "none");
ok("既定 off", checkResultStateOn({}) === false && checkResultStateOn({ CHECK_RESULT_STATE: "on" }) === true);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
