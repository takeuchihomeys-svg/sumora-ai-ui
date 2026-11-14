// app/lib/__tests__/search-audit-late-finish.test.ts
// 2026-11-14 竹内さん「いま一番効く3つ（実測）ここの部分もデータ見たら改善できる」
//   「録画しているからそれみるのと、リアプロの部分みればちゃんと理解して改善できる」
//
// 実測（7日・search_audits）:
//   abandoned 254件 / finished 60件。**abandoned 254件すべて result が空**。
//   操作の記録を読むと、最後に押したのは 17回とも `click:検索`（所在地では止まっていない）。
//   押した時刻 07:55:05 → 20分後の 08:15:07 に捨てられていた。
//
// 原因（2つ。どちらも直した）:
//   ① **2つの上限が同じ20分で競争**していた:
//        拡張の1回の上限 PASS_DEADLINE_MS.realnetpro = 20分
//        サーバーの見回り STALL_MINUTES = 20分
//      → サーバーが先に「止まった」にしていた（結果を読み終える前）。
//      → STALL_MINUTES を 35分に（拡張の上限より必ず長く）。
//   ② 見回りが先に `abandoned` にした回に**本物の finished が後から届いても捨てて**いた
//      （旧: `row.status !== "started"` なら何もしない）。だから result が空のまま。
//      → 遅れて届いた finished は `abandoned` → `finished` に**上げ直す**（3時間以内）。
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/search-audit-late-finish.test.ts
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const srv = read("app/lib/search-audit-server.ts");
/** コメント行を除いた実際のコード（説明文に同じ言葉が出るので誤判定しない） */
const code = srv.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① サーバーの見回りは拡張の上限より長い（同じ長さで競争させない）");
{
  const m = code.match(/STALL_MINUTES\s*=\s*(\d+)/);
  ok("STALL_MINUTES がある", !!m, m && m[0]);
  const stall = m ? Number(m[1]) : 0;
  ok("  20分より長い（拡張の PASS_DEADLINE と同点にしない）", stall > 20, stall);
  ok("  35分（結果を読み終える余裕を残す）", stall === 35, stall);
  // 拡張側の上限（実物から読む）
  const snap = read("chrome-extension/snapshot-core.js");
  const pm = snap.match(/realnetpro:\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
  ok("  拡張のリアプロの上限が読める", !!pm, pm && pm[0]);
  const extMin = pm ? Number(pm[1]) : 0;
  ok("  ⚠ サーバー > 拡張（逆になると検索中に捨てる）", stall > extMin, { stall, extMin });
}

console.log("\n■ ② 遅れて届いた finished で abandoned を上げ直す");
{
  ok("abandoned を finished に上げ直す分岐がある", /reviveFromAbandoned/.test(code));
  ok("  上げ直す時は「abandoned の時だけ」当てる（二重に数えない）", /eq\(\s*"status"\s*,\s*"abandoned"\s*\)/.test(code));
  ok("  3時間より古い回は上げ直さない（夜通しの記録を混ぜない）", /LATE_FINISH_MAX_MS/.test(code) && /3\s*\*\s*3600_000/.test(code));
  ok("  既に finished の2通目は今まで通り数えない", /row\.status !== "started"/.test(code));
}

console.log("\n■ ③ 止まった場所を「最後に押した操作」で見る（手数が多い場面ではない）");
{
  const flow = read("app/lib/learn-flow-steps.ts");
  const fcode = flow.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
  ok("lastSceneOf がある", /export function lastSceneOf/.test(fcode));
  ok("  後ろから探す（最後に触った場面）", /for \(let i = list\.length - 1; i >= 0; i--\)/.test(fcode));
  const route = read("app/api/human-learn-profile/route.ts");
  const rcode = route.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
  ok("  止まった場所は lastSceneOf で数える", /lastSceneOf\(ops\)/.test(rcode));
  ok("  ⚠ 手数が多い順（learnSceneFlows(...)[0]）を止まった場所に使っていない", !/learnSceneFlows\(\[ops\][^)]*\)\[0\]/.test(rcode));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
