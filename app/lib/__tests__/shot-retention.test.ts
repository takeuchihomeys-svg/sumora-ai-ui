// 2026-11-20 竹内さん（写真の保存期間）「自動モードの未読だけ14日で消す・読んだ写真と通常は残す」
import { retentionDays, pickExpiredShots, SHOT_RETENTION_DAYS, SHOT_RETENTION_MODES } from "../shot-retention";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log("✓", name); } else { fail++; console.log("✗", name, detail === undefined ? "" : JSON.stringify(detail)); }
};

const now = Date.UTC(2026, 11, 5, 18, 50); // 2026-12-05 18:50 UTC（JST 12/6 3:50）
const days = retentionDays(now);
ok("保存は14日", SHOT_RETENTION_DAYS === 14);
ok("消す対象は自動（aix・ai）だけ", SHOT_RETENTION_MODES.join() === "aix,ai");
ok("撮って14日を丸ごと過ぎた日から（12/5 なら 11/20 が最新）", days[0] === "2026-11-20", days);
ok("14日以内（11/21〜）は入らない", !days.some((d) => d >= "2026-11-21"), days);
ok("10日さかのぼって取りこぼしを拾う", days.length === 10 && days[9] === "2026-11-11", days);

const keys = [
  "2026-11-20/aix/run_a/x-1.jpg",
  "2026-11-20/aix/run_a/x-2.jpg",
  "2026-11-20/ai/run_b/x-3.jpg",
  "2026-11-20/aix/x-4.jpg",
  "2026-11-20/normal/run_c/x-5.jpg",
  "2026-11-20/staff/run_d/x-6.jpg",
  "2026-11-20/x-7.jpg",
  "2026-11-20/aix/run_a",
];
const learned = new Set(["2026-11-20/aix/run_a/x-2.jpg"]);
const got = pickExpiredShots(keys, learned);
ok("自動の未読だけ消す", got.join() === "2026-11-20/aix/run_a/x-1.jpg,2026-11-20/ai/run_b/x-3.jpg,2026-11-20/aix/x-4.jpg", got);
ok("読んだ写真は残す", !got.includes("2026-11-20/aix/run_a/x-2.jpg"));
ok("通常・スタッフは残す", !got.some((k) => /\/(normal|staff)\//.test(k)));
ok("旧形式（モード不明）は残す", !got.includes("2026-11-20/x-7.jpg"));
ok("フォルダ名は消さない", !got.includes("2026-11-20/aix/run_a"));
ok("mode 名の途中一致で消さない（aixx 等）", pickExpiredShots(["2026-11-20/aixx/r/x.jpg", "2026-11-20/brain_aix/r/x.jpg"], new Set()).length === 0);

void (async () => {
  const fs = await import("fs");
  const path = await import("path");
  const root = path.join(__dirname, "../../..");
  const src = fs.readFileSync(path.join(root, "app/lib/shot-retention.ts"), "utf8");
  ok("サーバー専用の鍵が無ければ消さない", /if \(!serviceKey\) return \{ \.\.\.res, skipped:/.test(src));
  ok("消えた物だけ数える（権限無しは空で返る）", /removed \+= \(r\.data \?\? \[\]\)\.length/.test(src));
  ok("表の行は消さない（Storage の remove だけ）", !/from\("human_motion_learn"\)[\s\S]{0,80}\.(delete|update)\(/.test(src));
  const vj = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  ok("毎日 JST 3:50（UTC 18:50）に動く", vj.crons.some((c: { path: string; schedule: string }) => c.path === "/api/cron/shot-retention" && c.schedule === "50 18 * * *"));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
