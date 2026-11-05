// app/lib/__tests__/turn-elapsed.test.ts（npx tsx app/lib/__tests__/turn-elapsed.test.ts）
import { turnElapsed, turnElapsedLine, elapsedPreferredSide, turnElapsedOn } from "../turn-elapsed";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log("FAIL", n); } };
const at = "2026-10-28T09:32:00Z", base = Date.parse(at);
t("既定 off", !turnElapsedOn({}) && turnElapsedOn({ TURN_ELAPSED_TWO_CHOICE: "on" }));
// 8931（見積書・62分）: 60分を過ぎて見積の AIX を押した後
const e1 = turnElapsed(at, base + 62 * 60_000, [{ aix_type: "estimate_sheet", created_at: "2026-10-28T10:30:00Z" }]);
t("60分を過ぎて確かめの準備が有る → 先の側は AIX", !!e1 && e1.overLine && e1.prepared && elapsedPreferredSide(e1) === "aix");
// 10415（9分・約束の返信）
const e2 = turnElapsed(at, base + 9 * 60_000, []);
t("60分より前 → 約束の返信", !!e2 && !e2.overLine && elapsedPreferredSide(e2) === "reply");
// 60分を過ぎても準備が無い（10360・119分・約束の返信）
const e3 = turnElapsed(at, base + 119 * 60_000, [{ aix_type: "estimate_sheet", created_at: "2026-10-28T08:00:00Z" }]);
t("60分を過ぎても今の番の後に準備が無ければ約束の返信（前の番の AIX は数えない）", !!e3 && e3.overLine && !e3.prepared && elapsedPreferredSide(e3) === "reply");
t("材料の1行は答えを書かず経過と準備だけ", /119分/.test(turnElapsedLine(e3!)) && /していない/.test(turnElapsedLine(e3!)) && turnElapsedLine(e1!).includes("始めている"));
t("時刻が読めなければ null", turnElapsed(null, base, []) === null && elapsedPreferredSide(null) === "reply");
console.log(`turn-elapsed: ${pass} pass / ${fail} fail`); if (fail) process.exit(1);
