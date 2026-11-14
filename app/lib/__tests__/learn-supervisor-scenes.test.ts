// app/lib/__tests__/learn-supervisor-scenes.test.ts
// 2026-11-14 竹内さん
//   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
//   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
//
//   → 統括が**場面ごと**に「手本があるか／順番が毎回違わないか／どこで止まるか」を話す事を固定する。
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/learn-supervisor-scenes.test.ts
import { superviseLearn } from "../learn-supervisor";
import { learnSceneFlows } from "../learn-flow-steps";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const base = {
  rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
  weak: [] as Array<{ kind: string; name: string }>,
  mode_counts: { normal: 200 }, site_counts: { realpro: 200 },
  // ⚠ 入力の名前は `with_ops`（camelCase の withOps ではない。実装で発覚）
  with_ops: 120, guessed_opens: 0,
  site: "all", shot_rows: 190,
};

const H = (k: string, t: number) => ({ k, t, by: "human" });

console.log("■ ① 場面ごとの手順を根拠に出す");
{
  const flows = learnSceneFlows([
    [H("change:city_code[]", 1000), H("change:town_code[]", 3000), H("click:go_search", 5000)],
    [H("change:city_code[]", 1000), H("change:town_code[]", 3000), H("click:go_search", 5000)],
  ]);
  const r = superviseLearn({ ...base, scene_flows: flows });
  const labels = r.meeting.evidence.map((e) => e.label);
  ok("所在地の根拠が出る", labels.some((l) => l.includes("所在地")), labels);
  ok("検索の根拠が出る", labels.some((l) => l.includes("検索を押す")), labels);
  const area = r.meeting.evidence.find((e) => e.label.includes("所在地"));
  ok("  順番が読める形で出る", !!area && area.value.includes("city_code[]"), area);
}

console.log("\n■ ② 手本が無い場面を議題にする（学べていないと言う）");
{
  // 所在地だけ人がやった記録（条件・検索・物件・次のページは手本なし）
  const flows = learnSceneFlows([[H("change:city_code[]", 1000), H("change:town_code[]", 3000)]]);
  const r = superviseLearn({
    ...base, scene_flows: flows,
    scene_missing: 4, scene_missing_names: "条件（賃料・間取り・徒歩など）・検索を押す・検索結果（物件の取得）・次のページへ",
  });
  const topics = r.meeting.agenda.map((a) => a.topic);
  ok("「手本が無い場面がある」が議題に出る", topics.some((t) => t.includes("手本が無い場面")), topics);
  ok("  どの場面かを言う", r.meeting.agenda.some((a) => a.why.includes("次のページ")), r.meeting.agenda);
  ok("  竹内さんに聞く", r.meeting.questions.some((q) => q.q.includes("手本")), r.meeting.questions.map((q) => q.q));
  /**
   * ⚠ 選択肢は3つまでなので「次のページ」（4番目の場面）は入らない。
   *   代わりに**質問文**に全部の場面名が出ていることを確かめる（竹内さんが読める）。
   */
  const q = r.meeting.questions.find((x) => x.q.includes("手本が1件もありません"));
  ok("  質問文に無い場面が全部出る（次のページを含む）", !!q && q.q.includes("次のページ"), q);
  ok("  選択肢に無い場面を1つ以上出す", !!q && (q.options || []).some((o) => o.includes("を人が1回やる")), q);
}

console.log("\n■ ③ 順番が毎回違う場面を議題にする（迷い）");
{
  // 4回とも違う順番（実際に迷っている形）。所在地の3つの手を並べ替える
  const mk = (order: string[]) => order.map((k, i) => H(k, 1000 + i * 500));
  const T = ["change:city_code[]", "change:town_code[]", "click:大阪市西区"];
  const flows = learnSceneFlows([
    mk([T[0], T[1], T[2]]),
    mk([T[1], T[0], T[2]]),
    mk([T[2], T[0], T[1]]),
    mk([T[1], T[2], T[0]]),
  ]);
  const r = superviseLearn({ ...base, scene_flows: flows });
  const topics = r.meeting.agenda.map((a) => a.topic);
  ok("「順番が毎回違う」が議題に出る", topics.some((t) => t.includes("順番が毎回違う")), topics);
  ok("  迷いの疑いと言う", r.meeting.agenda.some((a) => a.why.includes("毎回違") || a.why.includes("迷い")), r.meeting.agenda);
}

console.log("\n■ ④ 止まった場面を名指しする");
{
  const r = superviseLearn({ ...base, stopped_scene: "所在地絞り込み" });
  const topics = r.meeting.agenda.map((a) => a.topic);
  ok("止まる場面を議題に出す", topics.some((t) => t.includes("止まる回が多い") && t.includes("所在地")), topics);
  const ev = r.meeting.evidence.find((e) => e.label.includes("止まった回"));
  ok("  根拠にも出す", !!ev && ev.value.includes("所在地"), ev);
}

console.log("\n■ ⑤ 場面の材料が無くても今まで通り動く（壊れない）");
{
  const r = superviseLearn({ ...base });
  ok("結論が出る", !!r.verdict);
  ok("場面の根拠は出さない", !r.meeting.evidence.some((e) => e.label.startsWith("場面:")), r.meeting.evidence.map((e) => e.label));
  ok("「手本が無い場面」で混乱しない", !r.meeting.agenda.some((a) => a.topic.includes("手本が無い場面")), r.meeting.agenda.map((a) => a.topic));
  const r2 = superviseLearn({ ...base, scene_flows: null, scene_missing: 0, stopped_scene: null });
  ok("null を渡しても落ちない", !!r2.verdict);
}

console.log("\n■ ⑥ 優先順位（止まっている＞手本が無い）");
{
  const flows = learnSceneFlows([[H("change:city_code[]", 1000)]]);
  const r = superviseLearn({
    ...base, scene_flows: flows, scene_missing: 1, scene_missing_names: "次のページへ",
    audits: { runs: 20, finished: 4, abandoned: 16, finish_rate: 20, stalled_at: [{ stage: "所在地絞り込み", n: 10 }] },
  });
  const first = r.meeting.agenda[0];
  ok("先頭は「実際の検索が止まっている」", !!first && first.topic.includes("止まって"), r.meeting.agenda.map((a) => a.topic));
  ok("  手本が無い場面はその後ろ", r.meeting.agenda.some((a) => a.topic.includes("手本が無い")), r.meeting.agenda.map((a) => a.topic));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
