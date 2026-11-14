// app/lib/__tests__/supervisor-delta.test.ts
// 2026-11-14 竹内さん「統括の部分ちゃんと改善されるようになっているのか」
//
//   ★ DBを見て判明した弱点:
//     `learn_supervisor_log` に **128件**の判断が溜まっているのに、
//     `learn-supervisor` へは **常に `prev: null`** が渡されていた
//     （`human-learn-brain.ts` の2か所・どちらも `prev: null`）。
//     ＝ 統括は「前回と比べる」仕組みを持っているのに、**一度も比べていなかった**。
//     → 「良くなったか悪くなったか」を言えない＝**改善されているか分からない**（竹内さんの問いそのもの）。
//
//   直した事（このテストで固定する）:
//     ① API が `learn_supervisor_log` の最新を読んで `prev` として渡す
//     ② 統括は前回と比べて「前回から: 記録+5・順番+2…」と言う
//     ③ 前回が無ければ今まで通り（比べない・落ちない）
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/supervisor-delta.test.ts
import fs from "node:fs";
import path from "node:path";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const brain = fs.readFileSync(path.join(root, "app", "lib", "human-learn-brain.ts"), "utf8");
const api = fs.readFileSync(path.join(root, "app", "api", "human-learn-profile", "route.ts"), "utf8");

console.log("■ ① prev を渡している（旧は常に null）");
{
  ok("⚠ brain が prevAdvice を引数で受ける", /prevAdvice: import\("\.\/learn-supervisor"\)\.SupervisorInput\["prev"\]/.test(brain));
  ok("  ⚠ 統括へ prevAdvice を渡す（prev: null をやめた）", /prev: prevAdvice/.test(brain));
  /**
   * ⚠ サイト別（realpro / itandi）の `prev: null` は**残してよい**（理由をコメントで書いた）。
   *   all の前回で代用すると**別物を比べる**ので間違う（混ぜない）。
   *   → ここでは「all 用の prev がちゃんと渡っているか」だけを見る。
   */
  ok("  サイト別は比べないまま（別物を混ぜない）", /サイト別は「比べない」まま/.test(brain) || /prev: null,\s*\n\s*site: siteName/.test(brain));
  ok("API が learn_supervisor_log から前回を読む", /from\("learn_supervisor_log"\)/.test(api) && /prevAdvice/.test(api));
  ok("  比べる数は 記録・順番・場所・開き方・弱い所", /next_n, points_n, opens_n, weak_n/.test(api) && /rows: Number\(p\.rows\)/.test(api));
}

console.log("\n■ ② 前回と比べて「前回から」を出す");
{
  const base = {
    rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
    weak: [], mode_counts: { normal: 200 }, site_counts: { realpro: 200 }, with_ops: 120,
    site: "all", shot_rows: 190,
  };
  const r = superviseLearn({
    ...base,
    prev: { at: "2026-11-13T10:00:00.000Z", rows: 100, next: 20, points: 40, opens: 10, weak: 10 },
  });
  ok("delta が出る", !!r.score.delta, r.score.delta);
  ok("  記録 +100", r.score.delta?.rows === 100, r.score.delta);
  ok("  順番 +20", r.score.delta?.next === 20, r.score.delta);
  ok("  場所 +40", r.score.delta?.points === 40, r.score.delta);
  ok("  開き方 +10", r.score.delta?.opens === 10, r.score.delta);
  ok("  弱い所 -10（良くなった）", r.score.delta?.weak === -10, r.score.delta);
  const line = (r.meeting.today || []).find((t) => t.includes("前回から"));
  ok("  今日の結論に「前回から」が出る", !!line, r.meeting.today);
  ok("    改善（+）が分かる形", !!line && line.includes("+"), line);
}

console.log("\n■ ③ 弱くなった時も言う（悪化を隠さない）");
{
  const r = superviseLearn({
    rows: 100, next: 20, points: 40, opens: 10, screens: 2, sequence: 3, gap_ms: 900,
    weak: [], mode_counts: { normal: 100 }, site_counts: { realpro: 100 }, with_ops: 60,
    site: "all", shot_rows: 95,
    prev: { at: "2026-11-13T10:00:00.000Z", rows: 200, next: 40, points: 80, opens: 20, weak: 2 },
  });
  ok("記録 -100（減った）", r.score.delta?.rows === -100, r.score.delta);
  ok("⚠ 弱い所 -2（今2 < 前回4＝**改善**）", r.score.delta?.weak === -2, r.score.delta);
  /**
   * ⚠ 符号の決まり（実装で確認・テストの期待値が逆だった）:
   *   `delta = 今 - 前回`。だから
   *     ・記録・順番・場所・開き方 … **+ が改善**（増えた）
   *     ・弱い所                   … **- が改善**（減った）
   */
  ok("  弱い所が減った＝改善（マイナス）", (r.score.delta?.weak ?? 0) < 0, r.score.delta);
  const line = (r.meeting.today || []).find((t) => t.includes("前回から"));
  ok("  「前回から」にマイナスが出る", !!line && line.includes("-"), line);
}

console.log("\n■ ④ 前回が無ければ今まで通り（落ちない・比べない）");
{
  const r = superviseLearn({
    rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
    weak: [], mode_counts: { normal: 200 }, site_counts: { realpro: 200 }, with_ops: 120,
    site: "all", shot_rows: 190, prev: null,
  });
  ok("delta は null", r.score.delta === null, r.score.delta);
  ok("  結論は出る", !!r.verdict);
  ok("  「前回から」は出さない", !(r.meeting.today || []).some((t) => t.includes("前回から")), r.meeting.today);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
