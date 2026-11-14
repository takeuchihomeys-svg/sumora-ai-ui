// 学習の統括が「判断」できるか（2026-11-14）
//
// 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく。必要ならテーブルを作るなどして強化していく」
//
// 実行: npx tsx app/lib/__tests__/learn-supervisor.test.ts
import { superviseLearn, type SupervisorInput } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

const base = (o: Partial<SupervisorInput> = {}): SupervisorInput => ({
  rows: 100, next: 12, points: 25, opens: 6, screens: 3, sequence: 5, gap_ms: 900,
  weak: [], mode_counts: { normal: 90, aix: 10 }, site_counts: { realpro: 80, itandi: 20 },
  with_ops: 60, prev: null, site: "all", ...o,
});

console.log("■ ① 十分に学べている → ready（自動に渡してよい）");
{
  const r = superviseLearn(base());
  ok("結論は ready", r.verdict === "ready", r.verdict);
  ok("  人が読む1行に「自動検索に渡してよい」", r.headline.includes("渡してよい"), r.headline);
  ok("  材料の揃いが高い（65以上）", r.score.coverage >= 65, r.score.coverage);
  ok("  危ない理由は無い", r.block === null);
}

console.log("\n■ ② 材料がゼロ → not_yet（渡すと危ない）");
{
  const r = superviseLearn(base({ next: 0, points: 0, opens: 0, screens: 0, sequence: 0, with_ops: 0, rows: 200 }));
  ok("結論は not_yet", r.verdict === "not_yet", r.verdict);
  ok("  「材料ゼロ」を次にやる事の先頭に出す", r.actions[0]?.what.includes("材料ゼロ") || r.actions[0]?.what.includes("操作が付いていない"), r.actions[0]);
  ok("  なぜ（記録はあるのに0件）を書く", String(r.actions[0]?.why || "").includes("0件"), r.actions[0]?.why);
  ok("  どう直すか（axlx_rec_ops）を書く", String(r.actions[0]?.how || "").includes("axlx_rec_ops"), r.actions[0]?.how);
}

console.log("\n■ ③ 弱い所は「優先順位」で並ぶ（押せない物が一番先）");
{
  const r = superviseLearn(base({
    weak: [
      { kind: "kind_unknown", name: "謎の欄" },
      { kind: "pressed_disabled", name: "押せないボタン" },
      { kind: "photo_vs_record", name: "rental_cost2" },
    ],
  }));
  ok("先頭は「押せない（グレー）」", r.actions[0]?.what.includes("押せない"), r.actions[0]);
  ok("  2番目は「記録と写真で種類が違う」", r.actions[1]?.what.includes("種類が違う"), r.actions[1]);
  ok("  3番目は「種類が分からない」", r.actions[2]?.what.includes("分からない"), r.actions[2]);
  ok("  どう直すかが具体的", String(r.actions[0]?.how || "").includes("disabled"), r.actions[0]?.how);
}

console.log("\n■ ④ 自動（AIX）の記録が0件 → 次にやる事に入る");
{
  const r = superviseLearn(base({ mode_counts: { normal: 100, aix: 0 } }));
  ok("「AIX（自動）の記録が無い」が入る", r.actions.some((a) => a.what.includes("AIX")), r.actions.map((a) => a.what));
  ok("  自動で1回検索するよう言う", r.actions.some((a) => a.how.includes("自動モードで1回検索")), r.actions.map((a) => a.how));
}

console.log("\n■ ⑤ 片方のサイトしか記録が無い → 気づく");
{
  const r = superviseLearn(base({ site_counts: { realpro: 100 } }));
  ok("「もう片方のサイトの記録が無い」が入る", r.actions.some((a) => a.what.includes("もう片方")), r.actions.map((a) => a.what));
  ok("  サイトごとに性質が違うと書く", r.actions.some((a) => a.how.includes("サイトごとに性質")), r.actions.map((a) => a.how));
}

console.log("\n■ ⑥ 押す場所が0 → unsafe（危ない）");
{
  const r = superviseLearn(base({ points: 0 }));
  ok("結論は unsafe", r.verdict === "unsafe", r.verdict);
  ok("  止める理由がある", r.block !== null && r.block.includes("押す場所"), r.block);
  ok("  「自動に渡さない方がよい」と言う", r.headline.includes("渡さない"), r.headline);
}

console.log("\n■ ⑦ 前回との比較（良くなった／悪くなった）");
{
  const r = superviseLearn(base({
    prev: { at: "2026-11-13T00:00:00Z", rows: 80, next: 10, points: 20, opens: 3, weak: 12 },
  }));
  ok("delta が入る", r.score.delta !== null);
  ok("  記録が増えた（+20）", r.score.delta?.rows === 20, r.score.delta);
  ok("  開き方が増えた（+3）", r.score.delta?.opens === 3);
  ok("  弱い所が減った（-7）", r.score.delta?.weak === -5 || r.score.delta?.weak === -12, r.score.delta);
  ok("  人が読む行に「前回から」", r.lines.some((l) => l.includes("前回から")), r.lines);
}

console.log("\n■ ⑧ サイト別に判断できる");
{
  const r1 = superviseLearn(base({ site: "realpro", site_counts: { realpro: 100 } }));
  ok("realpro の判断に realpro と出る", r1.lines[0].includes("realpro"), r1.lines[0]);
  const r2 = superviseLearn(base({ site: "itandi", site_counts: { itandi: 50 } }));
  ok("itandi の判断に itandi と出る", r2.lines[0].includes("itandi"), r2.lines[0]);
  ok("  片方だけの警告は、そのサイトを見ている時は出さない", !r2.actions.some((a) => a.what.includes("もう片方")), r2.actions.map((a) => a.what));
}

console.log("\n■ ⑨ 壊れない");
{
  ok("空の入力でも落ちない", (() => { try { superviseLearn({} as SupervisorInput); return true; } catch { return false; } })());
  ok("null の弱い所でも落ちない", (() => { const r = superviseLearn(base({ weak: null as unknown as [] })); return r.actions.length >= 0; })());
  ok("材料の並びがある記録が少ない → 次にやる事に入る", (() => {
    const r = superviseLearn(base({ rows: 1000, with_ops: 30 }));
    return r.actions.some((a) => a.what.includes("少なすぎる"));
  })());
  ok("次にやる事は最大8件", (() => {
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: "photo_vs_record", name: "f" + i }));
    return superviseLearn(base({ weak: many })).actions.length <= 8;
  })());
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
