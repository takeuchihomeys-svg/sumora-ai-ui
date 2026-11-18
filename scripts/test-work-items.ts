// scripts/work-items.ts の純関数のテスト（DB なし）。実行: npx tsx scripts/test-work-items.ts
import { stageMoveNeedsNote, doneCheckOf, isStage } from "./work-items";
let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "  ✓" : "  ✗"} ${n}`); if (!c) bad++; };
ok("段の名前", isStage("built_off") && !isStage("finished"));
ok("順に進むのは理由なしでよい", !stageMoveNeedsNote("built_off", "testing") && !stageMoveNeedsNote("testing", "passed"));
ok("戻る・止まる・やめるは理由が要る", stageMoveNeedsNote("passed", "building") && stageMoveNeedsNote("testing", "blocked") && stageMoveNeedsNote("todo", "dropped"));
ok("飛ばすのは理由が要る", stageMoveNeedsNote("todo", "on"));
const now = Date.parse("2026-11-18T12:00:00Z");
ok("off のまま7日", /7日/.test(doneCheckOf({ id: 1, title: "x", stage: "built_off", updated_at: "2026-11-11T12:00:00Z" }, now) ?? ""));
ok("off 3日は黙る", doneCheckOf({ id: 1, title: "x", stage: "built_off", updated_at: "2026-11-15T12:00:00Z" }, now) === null);
ok("on なのにコミット無し", /コミット/.test(doneCheckOf({ id: 1, title: "x", stage: "on", updated_at: "2026-11-18T11:00:00Z", commits: [] }, now) ?? ""));
ok("passed のまま3日", /悪化0/.test(doneCheckOf({ id: 1, title: "x", stage: "passed", updated_at: "2026-11-15T00:00:00Z" }, now) ?? ""));
console.log(bad ? `${bad} failed` : "all ok"); if (bad) process.exit(1);
import { cut, wellFormed } from "./unfinished-inventory";
{
  const ok2 = (n: string, c: boolean) => { console.log(`${c ? "  ✓" : "  ✗"} ${n}`); if (!c) process.exitCode = 1; };
  const s = "絵文字＝😊😌🌟";
  ok2("cut は絵文字を割らない", cut(s, 5) === "絵文字＝😊" && JSON.stringify(cut(s, 5)).includes("😊"));
  ok2("片割れを落とす", wellFormed(s.slice(0, 5)) === "絵文字＝" && wellFormed("a\uD83Db") === "ab" && wellFormed("😊") === "😊");
}
