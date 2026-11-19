// 積む時点の点検（exam-preflight）と材料の欄の穴（exam-material-gaps）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-preflight.test.ts（全 PASS で exit 0）
import { preflightAdd, preflightOn, splitToCap, unsolvableFromObs, stoppedForBaseIds, type PreflightInput } from "../exam-preflight";
import { materialGapsOf } from "../exam-material-gaps";
import { weaknessHitsFromMisses } from "../exam-miss-stage";
import { splitWorse, samePathAll } from "../exam-conductor-core";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const base: PreflightInput = { runner: "brain-exam", cwd: "C:/w/exam-night", hasEnvFile: true, fallbackCwd: null, ids: ["q1", "q2", "q3"], guards: ["q3"], planUsd: 0.5, capUsd: 0.8, reps: { q1: 2, q2: 2, q3: 1 }, unitUsd: 0.035, unsolvable: {} };

// 今の流れを壊さない: 普通の依頼（鍵あり・上限内・解ける問題・守りあり）は積む・知らせも無い
{
  const r = preflightAdd(base);
  ok("普通の依頼は積む", r.go && !r.blocks.length && !r.warns.length, JSON.stringify(r));
  ok("点検は既定 on・off で止める", preflightOn({}) && !preflightOn({ EXAM_ADD_PREFLIGHT: "off" }));
  ok("tsc・tsc-remote は点検しない", preflightAdd({ ...base, runner: "tsc-remote", hasEnvFile: false }).go);
  ok("掘り（--dig）は比べの数と守りを見ない", preflightAdd({ ...base, ids: ["q1"], guards: [], dig: true }).go && !preflightAdd({ ...base, ids: ["q1"], guards: [], dig: true }).warns.length);
  ok("1問だけの依頼（守りなし）は数の線で止めない", preflightAdd({ ...base, ids: ["q1"], guards: [] }).go);
}
// ① 鍵が無い → 積まない・exam-night に替える案
{
  const r = preflightAdd({ ...base, hasEnvFile: false, fallbackCwd: "C:/w/exam-night" });
  ok("鍵が無いと積まない", !r.go && /\.env\.local/.test(r.blocks[0]));
  ok("替える案に exam-night", r.hints.some((h) => h.includes("--cwd=C:/w/exam-night")));
  ok("cmd の依頼も鍵を見る", !preflightAdd({ ...base, runner: "cmd", hasEnvFile: false }).go);
}
// ② 前も今も解けない問題 → 積まない・外した --only の案
{
  const r = preflightAdd({ ...base, unsolvable: { q2: "申込の門で外れた" } });
  ok("解けない問題は外して積む（まるごと止めない）", r.go && r.drop.join(",") === "q2" && r.warns.some((w) => w.includes("q2")));
  ok("比べられる問題を返す", r.comparable.join(",") === "q1,q3");
}
{
  const r = preflightAdd({ ...base, neverPassed: { q1: "直近の記録 4回とも不合格" } });
  ok("一度も合格していない問題は積むが知らせる（直す狙いの問題を止めない）", r.go && r.warns.some((w) => w.includes("q1")));
}
// ③ 比べられる問題が少ない
{
  const r = preflightAdd({ ...base, ids: ["q1", "q2"], guards: [], unsolvable: { q1: "x", q2: "y" } });
  ok("両方で解ける問題が0なら積まない", !r.go && r.blocks.some((b) => b.includes("比べた問題が少なく")));
}
// ④ 上限を超える → 分け方と上限の案
{
  const r = preflightAdd({ ...base, planUsd: 0.91, capUsd: 0.8 });
  ok("上限を超えると積まない", !r.go && r.blocks.some((b) => b.includes("$0.91")));
  ok("上限の案（切り上げ）", r.hints.some((h) => h.includes("--cap-usd=1.0")));
  ok("揺れる問題の案", r.hints.some((h) => h.includes("q1×2")));
  const parts = splitToCap(["a", "b", "c", "d"], { a: 4, b: 4, c: 1, d: 1 }, 0.035, 0.3);
  ok("上限に入る分け方（安い順に詰める）", parts.length === 3 && parts[0].join(",") === "c,d" && parts.flat().length === 4, JSON.stringify(parts));
  ok("上限が無い依頼は上限を見ない", preflightAdd({ ...base, planUsd: 9, capUsd: null }).go);
}
// ⑤ 守りが無い → 積むが知らせる
{
  const r = preflightAdd({ ...base, guards: [] });
  ok("守りが無いのは積んで知らせる", r.go && r.warns.some((w) => w.includes("守り")));
}
// 揺れの記録から解けない問題
{
  ok("4回とも不合格は解けない", unsolvableFromObs([{ sig: "AIX:x|✕" }, { sig: "AIX:x|✕" }, { sig: "返信|✕" }, { sig: "返信|✕" }]) !== null);
  ok("1回でも合格なら解ける", unsolvableFromObs([{ sig: "AIX:x|✕" }, { sig: "AIX:x|○" }, { sig: "返信|✕" }, { sig: "返信|✕" }]) === null);
  ok("記録が少なければ決めない", unsolvableFromObs([{ sig: "返信|✕" }]) === null);
}
// 夜の基準に入れる: 流す前に止まった依頼の問題
{
  const now = Date.parse("2026-11-15T12:00:00Z");
  const ids = stoppedForBaseIds([
    { label: "a", verdict: "流す前に止めた: 前を作る分 $0.6 が上限", at: "2026-11-15T01:00:00Z", only: "q1,q2" },
    { label: "b", verdict: "悪化0", at: "2026-11-15T01:00:00Z", only: "q9" },
    { label: "c", verdict: "流す前に止めた: x", at: "2026-11-10T01:00:00Z", only: "q8" },
  ], { nowMs: now });
  ok("止まった依頼（直近2日）の問題だけ", ids.join(",") === "q1,q2", ids.join(","));
}
// 材料の欄の穴
{
  const g = materialGapsOf([
    { id: "q1", ledger: { inserted: { aix_usage_logs: 18, sent_properties: 0 }, errors: [] }, brain: { turn_contract: { asks: [{ kind: "question", about: "cost", basis: "none", route: "reply" }, { kind: "feeling", about: "x", basis: "conversation", route: "reply" }] } }, inputDiff: { firstChanged: "brain_full" } },
  ], { id: "q1", ledger: { aix_usage_logs: new Array(18).fill({}), sent_properties: [{}, {}] } });
  ok("台帳の写しの不足", g.some((x) => x === "台帳の写しが足りない: sent_properties 0/2"), JSON.stringify(g));
  ok("答えの出所なし", g.some((x) => x.startsWith("答えの出所が無い: question・cost")));
  ok("出所のある依頼は数えない", !g.some((x) => x.includes("feeling")));
  ok("最初に入力が違った呼び出し", g.some((x) => x.includes("brain_full")));
  ok("お客様の文（quote）は入れない", !JSON.stringify(g).includes("quote"));
  const g2 = materialGapsOf([{ id: "q1" }, { id: "q1", ledger: { inserted: {}, errors: [{}] } }], null);
  ok("回が2つ以上なら回の数を付ける", g2.length === 1 && g2[0].includes("（1/2回）"), JSON.stringify(g2));
  const hits = weaknessHitsFromMisses("lab", [{ id: "q1", n: 2, stage: "two_stage", markers: ["two-stage:check"], line: "x", reps: [1] }], { gapsOf: () => ["台帳の写しが足りない: sent_properties 0/2"] });
  ok("弱い所の台帳の行に材料の穴を問題ごとに", hits.length === 1 && JSON.stringify(hits[0].evidence.material_gaps) === JSON.stringify({ q1: ["台帳の写しが足りない: sent_properties 0/2"] }), JSON.stringify(hits));
  const hits0 = weaknessHitsFromMisses("lab", [{ id: "q1", n: 2, stage: "two_stage", markers: ["two-stage:check"], line: "x", reps: [1] }], {});
  ok("穴が無い・gapsOf が無い時は今まで通り（material_gaps を付けない）", hits0.length === 1 && hits0[0].evidence.material_gaps === undefined);
}
// 揺れる問題で道が同じなら判定の揺れ（穴4）
{
  const row = (id: string, rep: number, pass: boolean, code: string) => ({ id, rep, score: { pass }, path: { code } });
  const base = [row("q1", 1, true, "AIX:x"), row("q1", 2, true, "AIX:x"), row("q1", 3, true, "AIX:x"), row("q1", 4, true, "AIX:x")];
  const cur = [row("q1", 1, false, "AIX:x"), row("q1", 2, false, "AIX:x"), row("q1", 3, false, "AIX:x"), row("q1", 4, true, "AIX:x")];
  const w = splitWorse(cur, base, new Set(["q1"]));
  ok("揺れる問題で道が全部同じ＝判定の揺れ（確かな悪化にしない）", w.sure.length === 0 && w.flake.length === 1 && w.flake[0].why.includes("道は前も今も同じ"), JSON.stringify(w));
  const cur2 = cur.map((r, k) => (k < 3 ? { ...r, path: { code: "返信" } } : r));
  ok("道が変わったら今まで通り確かな悪化", splitWorse(cur2, base, new Set(["q1"])).sure.length === 1);
  ok("揺れない問題は今まで通り確かな悪化", splitWorse(cur, base, new Set()).sure.length === 1);
  process.env.EXAM_WORSE_PATH_SAME = "off";
  ok("止めると今まで通り", splitWorse(cur, base, new Set(["q1"])).sure.length === 1);
  delete process.env.EXAM_WORSE_PATH_SAME;
  ok("道の記録が無い回があれば同じと言い切らない", !samePathAll("q1", [{ id: "q1", rep: 1 }], base));
}
console.log(fail ? `FAIL ${fail}（PASS ${pass}）` : `ALL PASS ${pass}`);
process.exit(fail ? 1 : 0);
