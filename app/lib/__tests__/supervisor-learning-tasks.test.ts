// app/lib/__tests__/supervisor-learning-tasks.test.ts
// 2026-11-14 竹内さん
//   「逆に何の部分がたりていないのか」「必要な部分を統括が判断して学習すれば強化される」
//   「この考え方統括の部分で重要にする」
//
// 統括が**自分で「次に学ぶ事」を決める**（竹内さんが毎回指図しなくてよい形）事を固定する。
//   ① 順番は 無料で効く物が先 → お金がかかる物（写真）が後ろ
//   ② 材料は実データだけ（推測で課題を作らない）
//   ③ 写真は「撮れているのに学べていない」時だけ候補に出す・**必ず枚数上限**
//   ④ 判断は議題に残す（後から検証できる）
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/supervisor-learning-tasks.test.ts
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

type Task = { kind: string; what: string; why: string; cost: string; limit?: number };
const tasksOf = (r: ReturnType<typeof superviseLearn>): Task[] => r.meeting.learning_tasks || [];

const base = {
  rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
  weak: [] as Array<{ kind: string; name: string }>,
  mode_counts: { normal: 200 }, site_counts: { realpro: 200 },
  with_ops: 30, guessed_opens: 0, site: "all", shot_rows: 190,
};

console.log("■ ① 止まる場面が一番先（無料・現場に効く）");
{
  const r = superviseLearn({ ...base, stopped_scene: "検索を押す" });
  const t = tasksOf(r);
  ok("課題が出る", t.length > 0, t.map((x) => x.kind));
  ok("  ⚠ 先頭は fix_scene（止まる場面）", t[0]?.kind === "fix_scene", t.map((x) => x.kind));
  ok("  なぜ（止まる場面）を言う", (t[0]?.why || "").includes("検索を押す"), t[0]);
  ok("  費用は無料", (t[0]?.cost || "").includes("無料"), t[0]?.cost);
}

console.log("\n■ ② 手本が無い場面は「人が1回やる」（推測で動かさない）");
{
  const r = superviseLearn({ ...base, scene_missing: 1, scene_missing_names: "次のページへ" });
  const t = tasksOf(r);
  ok("need_human が出る", t.some((x) => x.kind === "need_human"), t.map((x) => x.kind));
  const nh = t.find((x) => x.kind === "need_human");
  ok("  どの場面か言う", (nh?.what || "").includes("次のページ"), nh);
  ok("  手本が無い場面は自動にできないと言う", (nh?.why || "").includes("手本が無い場面は自動にできない"), nh?.why);
}

console.log("\n■ ③ 写真は「撮れているのに学べていない」時だけ・上限つき");
{
  // 写真 95%・操作 15% → 差が大きい＝写真から読む候補
  const r = superviseLearn({ ...base, with_ops: 30, shot_rows: 190 });
  const t = tasksOf(r);
  const pl = t.find((x) => x.kind === "photo_learn");
  ok("photo_learn が出る", !!pl, t.map((x) => x.kind));
  ok("  ⚠ 枚数の上限がある（費用の歯止め）", pl?.limit === 20, pl);
  ok("  1枚ごとに費用がかかると言う", (pl?.cost || "").includes("費用"), pl?.cost);
  ok("  ⚠ 無料の物より後ろ", t.findIndex((x) => x.kind === "photo_learn") === t.length - 1, t.map((x) => x.kind));

  // 写真と操作の差が小さい（両方高い）→ 写真を読む候補にしない
  const r2 = superviseLearn({ ...base, with_ops: 180, shot_rows: 190 });
  const t2 = tasksOf(r2);
  ok("  ⚠ 既に学べている時は候補にしない", !t2.some((x) => x.kind === "photo_learn"), t2.map((x) => x.kind));
}

console.log("\n■ ④ 録画の経路（写真が少なく操作も少ない）");
{
  const r = superviseLearn({ ...base, with_ops: 30, shot_rows: 40 });
  const t = tasksOf(r);
  ok("fix_record が出る", t.some((x) => x.kind === "fix_record"), t.map((x) => x.kind));
  ok("  ⚠ 写真が少ない時は photo_learn を出さない（読む物が無い）", !t.some((x) => x.kind === "photo_learn"), t.map((x) => x.kind));
}

console.log("\n■ ⑤ 議題に残る（後から検証できる）");
{
  const r = superviseLearn({ ...base, stopped_scene: "所在地絞り込み", scene_missing: 1, scene_missing_names: "次のページへ" });
  const a = r.meeting.agenda.find((x) => x.topic.includes("次に学ぶ事"));
  ok("「次に学ぶ事（統括が決めた順）」が議題にある", !!a, r.meeting.agenda.map((x) => x.topic));
  ok("  順番が読める形で書いてある", /\d\.\s/.test(a?.why || ""), a?.why);
  ok("  優先度が高い（1）", a?.priority === 1, a?.priority);
}

console.log("\n■ ⑥ 材料が無ければ何も出さない（推測で課題を作らない）");
{
  const r = superviseLearn({
    ...base, with_ops: 180, shot_rows: 190, scene_missing: 0, stopped_scene: null,
  });
  const t = tasksOf(r);
  ok("課題が空（推測で作らない）", t.length === 0, t.map((x) => x.kind));
  ok("  「次に学ぶ事」の議題も出さない", !r.meeting.agenda.some((x) => x.topic.includes("次に学ぶ事")), r.meeting.agenda.map((x) => x.topic));
}

console.log("\n■ ⑦ 壊れない");
{
  ok("何も渡さなくても落ちない", !!superviseLearn({} as never).verdict);
  ok("shots が null でも落ちない", !!superviseLearn({ ...base, shot_rows: null as never }).verdict);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
