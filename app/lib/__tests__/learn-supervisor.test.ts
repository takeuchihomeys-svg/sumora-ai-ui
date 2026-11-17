// 学習の統括が「判断」できるか（2026-11-14）
//
// 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく。必要ならテーブルを作るなどして強化していく」
//
// 実行: npx tsx app/lib/__tests__/learn-supervisor.test.ts
import {
  superviseLearn,
  isFalseKindConflict,
  applyLearnedMechanismsToTasks,
  isKnownSelectField,
  type SupervisorInput,
} from "../learn-supervisor";

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

console.log("\n■ ⑩ 統括が自分の矛盾を見つけて整理する（2026-11-14）");
{
  /**
   * 実際に起きた矛盾: 結論「渡してよい」＋材料85点なのに、材料つき記録は 303/4121（7%）。
   */
  const r = superviseLearn(base({ rows: 4121, with_ops: 303, guessed_opens: 13, opens: 13, weak: [] }));
  ok("材料が7%なら ready にしない（almost まで下げる）", r.verdict === "almost", r.verdict);
  ok("  上限をかけた理由を言える", !!r.self_check.capped_by && r.self_check.capped_by.includes("7%"), r.self_check.capped_by);
  ok("  自分の矛盾を見つけている（ok:false）", r.self_check.ok === false);
  ok("  「材料が7%なのに高得点」を指摘", r.self_check.issues.some((s) => s.includes("高すぎます")), r.self_check.issues);
  ok("  「開き方が全部推測」を指摘", r.self_check.issues.some((s) => s.includes("推測")), r.self_check.issues);

  /** 材料が十分なら ready のまま */
  const ok1 = superviseLearn(base({ rows: 100, with_ops: 60, weak: [] }));
  ok("材料が60%なら ready のまま", ok1.verdict === "ready", ok1.verdict);
  ok("  矛盾は無い", ok1.self_check.ok === true, ok1.self_check.issues);

  /** 材料ゼロは not_yet（unsafe ではない） */
  const z = superviseLearn(base({ rows: 1000, with_ops: 0, next: 0, points: 0, opens: 0, screens: 0, sequence: 0 }));
  ok("材料ゼロは not_yet", z.verdict === "not_yet", z.verdict);

  /** unsafe は上限で緩めない */
  const u = superviseLearn(base({ rows: 100, with_ops: 20, points: 0 }));
  ok("⚠ unsafe は材料の上限で緩めない", u.verdict === "unsafe", u.verdict);
}

console.log("\n■ ⑪ 人間らしさの再現が未完なら ready にしない（2026-11-16）");
{
  const bad = superviseLearn(base({
    human_like: {
      ops: 100, typedOnChoose: 0, clickedThenChanged: 2, changedWithoutClick: 4,
      changedWithoutClickFields: ["required_time", "rental_cost2"],
      withCursor: 48, withPoint: 20, rows: 100, handCursorClicks: 0, handCursorFields: [],
    },
  }));
  ok("直書き・カーソル不足なら almost", bad.verdict === "almost", bad.verdict);
  ok("  再現％を今日の結論に出す", bad.meeting.today.some((t) => t.includes("再現")), bad.meeting.today);
  ok("  上限理由に人間らしさ", !!bad.self_check.capped_by && bad.self_check.capped_by.includes("人間らしさ"), bad.self_check.capped_by);
  ok("  材料点を55以下に抑える（量の点で誤読させない）", bad.score.coverage <= 55, bad.score.coverage);
  ok("  人間として自動できるか: 不可", bad.meeting.today.some((t) => t.includes("人間として自動できるか: 不可")), bad.meeting.today);
  ok("  残り表示が未達の理由（直書きN）", bad.meeting.today.some((t) => /直書き[1-9]/.test(t) || t.includes("カーソル")), bad.meeting.today);
  ok("  学習の仕組みを根拠に持つ", bad.meeting.evidence.some((e) => e.label.includes("学習の仕組み")), bad.meeting.evidence.map((e) => e.label));

  const good = superviseLearn(base({
    human_like: {
      ops: 100, typedOnChoose: 0, clickedThenChanged: 10, changedWithoutClick: 0,
      withCursor: 80, withPoint: 60, rows: 100, handCursorClicks: 5, handCursorFields: ["印刷用PDF"],
    },
  }));
  ok("再現条件を満たせば ready", good.verdict === "ready", good.verdict);
  ok("  再現 100%", good.meeting.today.some((t) => t.includes("再現 100%")), good.meeting.today);
  ok("  人間として自動できるか: 可", good.meeting.today.some((t) => t.includes("人間として自動できるか: 可")), good.meeting.today);
}

console.log("\n■ ⑫ 通常録画があれば完全再現へ—足りない土台を統括が出す（2026-11-16）");
{
  const r = superviseLearn(base({
    mode_counts: { normal: 2000, aix: 500 },
    human_like: {
      ops: 100, typedOnChoose: 0, clickedThenChanged: 2, changedWithoutClick: 3,
      changedWithoutClickFields: ["required_time"],
      withCursor: 48, withPoint: 20, rows: 100, handCursorClicks: 0, handCursorFields: [],
    },
    shot_gaps_normal: { total: 100, unlearnedBig: 20, unlearnedSmall: 10, learnedButEmpty: 0, learnedOk: 70, todo: 20 },
  }));
  ok("原則を根拠に出す", r.meeting.evidence.some((e) => e.label.includes("通常録画があれば完全再現")), r.meeting.evidence.map((e) => e.label));
  ok("土台の内訳を出す", r.meeting.evidence.some((e) => e.label.includes("通常録画→完全再現の土台")), r.meeting.evidence.map((e) => e.label));
  ok("議題に『通常録画はあるのに再現が未完』", r.meeting.agenda.some((a) => a.topic.includes("通常録画はあるのに")), r.meeting.agenda.map((a) => a.topic));
  ok("質を上げる循環を根拠に出す", r.meeting.evidence.some((e) => e.label.includes("質を上げる循環")), r.meeting.evidence.map((e) => e.label));
  ok("土台構築の課題が出る", (r.meeting.learning_tasks || []).some((t) => t.kind === "build_foundation"), r.meeting.learning_tasks);
  ok("土台の細分化を根拠に出す", r.meeting.evidence.some((e) => e.label.includes("土台の細分化")), r.meeting.evidence.map((e) => e.label));
  ok("弱所→学習→土台→細部の連動を出す", r.meeting.evidence.some((e) => e.label.includes("弱所発見→学習→土台→細部")), r.meeting.evidence.map((e) => e.label));
}

console.log("\n■ ⑬ 学習の仕組みを次手に効かせる（統括の学習能力・2026-11-16）");
{
  ok("既知select判定", isKnownSelectField("rental_cost2") && !isKnownSelectField("city_code[]"));
  ok("select/text誤割れを落とす", isFalseKindConflict(
    "kind_conflict_in_photo", "rental_cost2", "ops=select vision=text",
  ));
  ok("本物の種類割れは落とさない", !isFalseKindConflict(
    "kind_conflict_in_photo", "foo_bar", "ops=checkbox vision=text",
  ));

  const weakSkip = superviseLearn(base({
    weak: [
      { kind: "kind_conflict_in_photo", name: "rental_cost2", why: "select vs text" },
      { kind: "photo_vs_record", name: "required_time", why: "写真と記録が違う" },
    ],
  }));
  ok("誤割れは次手に出ない", !weakSkip.actions.some((a) => a.name === "rental_cost2"), weakSkip.actions.map((a) => a.name));
  ok("本物の弱所は次手に残る", weakSkip.actions.some((a) => a.name === "required_time"), weakSkip.actions.map((a) => a.name));

  const mech = applyLearnedMechanismsToTasks([
    {
      kind: "photo_learn",
      what: "自動の最新課題を、通常モードの最新画像から改善する（欄の種類・位置）",
      why: "課題欄: rental_cost2・required_time",
      cost: "費用",
      fields: ["rental_cost2", "required_time"],
    },
  ], { togglesOff: 6, togglesOn: 3 });
  ok("photo_learn に仕組み①を付ける", /操作のselect|selectをVision/.test(mech[0].why), mech[0].why);
  ok("外しがある時はくれあ型土台", mech.some((t) => t.kind === "build_foundation" && /くれあ|区/.test(t.what + t.why)), mech.map((t) => t.what));

  const unkOnly = applyLearnedMechanismsToTasks([], { togglesOff: 0, togglesOn: 0, togglesUnknown: 400 });
  ok("区別できない時は was/now 土台を出す", unkOnly.some((t) => /was\/now|区別できない/.test(t.what + t.why)), unkOnly);

  const full = superviseLearn(base({
    mode_counts: { normal: 2000, aix: 500 },
    toggles: { off: 6, on: 3, unknown: 0 },
    improve_from_normal: {
      what: "自動の最新課題を通常から改善",
      why: "課題欄: rental_cost2・required_time",
      how: "photo_learn",
      fields: ["rental_cost2", "required_time", "structured_date"],
    },
    shot_gaps_normal: { total: 100, unlearnedBig: 20, unlearnedSmall: 10, learnedButEmpty: 0, learnedOk: 70, todo: 20 },
    human_like: {
      ops: 100, typedOnChoose: 0, clickedThenChanged: 2, changedWithoutClick: 3,
      changedWithoutClickFields: ["required_time"],
      withCursor: 48, withPoint: 20, rows: 100, handCursorClicks: 0, handCursorFields: [],
    },
  }));
  const pl = (full.meeting.learning_tasks || []).find((t) => t.kind === "photo_learn");
  ok("実判断でも仕組み①が課題 why に入る", !!(pl && /操作のselect|selectをVision|位置・押し方/.test(pl.why + pl.what)), pl);
  ok("実判断でも仕組み②が土台に入る", (full.meeting.learning_tasks || []).some((t) =>
    t.kind === "build_foundation" && /くれあ|区|外す|前客/.test(t.what + t.why),
  ), full.meeting.learning_tasks);
  ok("仕組み①②の自己点検が通る（issuesに仕組み抜け無し）",
    !full.self_check.issues.some((s) => s.includes("仕組み①") || s.includes("仕組み②")),
    full.self_check.issues);
}

console.log("\n■ ⑭ 細かく学ぶ・統括の学習力を仕組みで測る（2026-11-16）");
{
  const r = superviseLearn(base({
    mode_counts: { normal: 2000, aix: 500 },
    toggles: { off: 0, on: 0, unknown: 400 },
    latest_auto_challenge: {
      line: "押さず変化 required_time・rental_cost2",
      fields: ["required_time", "rental_cost2", "city_code[]"],
      changedNoClick: ["required_time"],
      retries: ["city_code[]"],
    },
    improve_from_normal: {
      what: "自動の最新課題を通常から改善",
      why: "課題欄あり",
      how: "photo_learn",
      fields: ["required_time", "rental_cost2", "city_code[]"],
    },
    shot_gaps_normal: { total: 100, unlearnedBig: 20, unlearnedSmall: 10, learnedButEmpty: 0, learnedOk: 70, todo: 20 },
    human_like: {
      ops: 100, typedOnChoose: 0, clickedThenChanged: 2, changedWithoutClick: 3,
      changedWithoutClickFields: ["required_time"],
      withCursor: 48, withPoint: 20, rows: 100, handCursorClicks: 0, handCursorFields: [],
    },
  }));
  ok("細かく学ぶ根拠がある", r.meeting.evidence.some((e) => e.label.includes("細かく学ぶ")), r.meeting.evidence.map((e) => e.label));
  ok("統括の学習力を出す", r.meeting.today.some((t) => t.includes("統括の学習力")) || r.meeting.evidence.some((e) => e.label.includes("統括の学習力")), r.meeting.today);
  ok("仕組みに⑥細かく学ぶが入る", r.meeting.evidence.some((e) => e.label.includes("学習の仕組み") && /細かく学ぶ|⑥/.test(e.value)), r.meeting.evidence.find((e) => e.label.includes("学習の仕組み")));
  ok("細かい学習課題が載る", (r.meeting.learning_tasks || []).some((t) =>
    /細かく学ぶ|was\/now|位置・押し方|欄を細かく|精度/.test(t.what + t.why),
  ), r.meeting.learning_tasks);
  ok("精度根拠がある", r.meeting.evidence.some((e) => e.label.includes("精度")), r.meeting.evidence.map((e) => e.label));
  ok("仕組み⑧精度連携が入る", r.meeting.evidence.some((e) => e.label.includes("学習の仕組み") && /精度|⑧/.test(e.value)));
  ok("完成度根拠がある", r.meeting.evidence.some((e) => e.label.includes("自動モード完成度")), r.meeting.evidence.map((e) => e.label));
  ok("今日に完成度が出る", r.meeting.today.some((t) => t.includes("自動モード完成度")), r.meeting.today);
  ok("完成度の学習ヒントがある", r.meeting.today.some((t) => t.includes("完成度↑")) || r.meeting.agenda.some((a) => /完成度↑/.test(a.decide)), r.meeting.today);
}

console.log("\n■ ⑮ 精度上げと一連の連携（段階5では自動が先）");
{
  const r = superviseLearn(base({
    mode_counts: { normal: 2000, aix: 500 },
    audits: { runs: 20, finished: 7, abandoned: 13, finish_rate: 35, stalled_at: [{ stage: "検索", n: 10 }] },
    improve_loop: {
      improve_line: "1✓ 2✓ 3✓ 4✓ 5✗ 6✗",
      bottleneck_n: 5,
      bottleneck: "5.自動で使う: 新束のあと自動が無い",
      next_n: 5,
      next_kind: "need_auto_run",
      steps: [
        { n: 1, name: "写真", ok: true, detail: "" },
        { n: 2, name: "操作", ok: true, detail: "" },
        { n: 3, name: "束", ok: true, detail: "" },
        { n: 4, name: "拡張", ok: true, detail: "" },
        { n: 5, name: "自動", ok: false, detail: "新束のあと無し" },
        { n: 6, name: "効果", ok: false, detail: "未測" },
      ],
    },
    latest_auto_challenge: {
      line: "課題あり",
      fields: ["rental_cost2", "required_time"],
      changedNoClick: ["required_time"],
      retries: [],
    },
    human_like: {
      ops: 100, typedOnChoose: 0, clickedThenChanged: 2, changedWithoutClick: 2,
      changedWithoutClickFields: ["required_time"],
      withCursor: 48, withPoint: 20, rows: 100, handCursorClicks: 0, handCursorFields: [],
    },
    shot_gaps_normal: { total: 50, unlearnedBig: 10, unlearnedSmall: 5, learnedButEmpty: 0, learnedOk: 35, todo: 10 },
  }));
  const prec = r.meeting.evidence.find((e) => e.label.includes("精度"));
  ok("精度に連携: 自動が先", !!(prec && /自動|段階5|連携/.test(prec.value)), prec?.value);
  const first = (r.meeting.learning_tasks || [])[0];
  ok("先頭課題は一連側（自動/拡張/反映）", !!(first && /need_auto_run|need_ext_reload|reflect_auto/.test(first.kind)), first);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
