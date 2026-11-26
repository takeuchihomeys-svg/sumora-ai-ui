// 2026-11-20: 動き方の手順書（束 → 手順書）の純関数を確かめる。DB も LLM も使わない。
// 実行: npx tsx app/lib/__tests__/action-playbook.test.ts
import {
  buildPlaybook, checkPlaybook, fnv1a, isPlaybookValue, normalizePlaybookSteps,
  judgeFlowSeriesProgress, PLAYBOOK_FLOW_SERIES, PLAYBOOK_BUILD_V,
  PLAYBOOK_SOLID_RUNS, PLAYBOOK_MAX_STEPS, PLAYBOOK_STALE_MS,
} from "../action-playbook";
import { SCENE_JA } from "../learn-flow-steps";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

// 束の実際の形に近い（区名・間取りは値＝手順に入らない）
const sceneFlows = [
  { scene: "area", runs: 6, ops: 81, steps: ["所在地絞り込み＋", "大阪市西区", "city_code[]", "確定してリストへ"], gap_ms: 66, variants: 4 },
  { scene: "cond", runs: 5, ops: 48, steps: ["rental_cost1", "2K", "room_layout_id[]"], gap_ms: 50, variants: 5 },
  { scene: "station", runs: 2, ops: 7, steps: ["沿線・駅絞り込み＋", "route_id[]"], gap_ms: null, variants: 1 },
  { scene: "other", runs: 9, ops: 3, steps: ["x"], gap_ms: null, variants: 1 }, // 場面が決まらない＝手順書に入れない
];
const points = { a: { n: 9, w: "checkbox", x: 0.1, y: 0.2 }, b: { n: 3, x: 0.3, y: 0.4 }, c: { n: 1, x: 0.5, y: 0.5 } };

console.log("■ 値の判定（手順から外すもの）");
{
  ok("区名は値", isPlaybookValue("大阪市西区") && isPlaybookValue("大阪市中央区"));
  ok("間取り・数字は値", isPlaybookValue("2K") && isPlaybookValue("3LDK") && isPlaybookValue("ワンルーム") && isPlaybookValue("30万"));
  ok("欄の名前は値ではない（確定してリストへ・絞り込み＋・city_code[]）", !isPlaybookValue("確定してリストへ") && !isPlaybookValue("所在地絞り込み＋") && !isPlaybookValue("city_code[]"));
  ok("飾り（左の・｜タグ）を落としてから判定", isPlaybookValue("左の大阪市西区｜label.one_city") && !isPlaybookValue("左の確定してリストへ｜span"));
  ok("末尾が区でも『設定・リスト・絞り込み』を含むのは値ではない", !isPlaybookValue("駅の設定へ進む") && !isPlaybookValue("区の絞り込み"));
  ok("金額・割合の選択肢は値（実データ: 初回総賃料50％月額1.5％）", isPlaybookValue("エステム保証初回総賃料50％月額1.5％") && isPlaybookValue("賃料10万円"));
}

console.log("■ 欄の名前（人が読む形・連続の畳み）");
{
  const n = normalizePlaybookSteps(["所在地絞り込み＋", "大阪市西区", "city_code[]", "大阪市中央区", "city_code[]", "確定してリストへ"]);
  ok("区名は手順から外れる", !n.steps.some((s) => /大阪市/.test(s)), n.steps.join(" > "));
  ok("city_code[] は『区の欄（チェック）』と読める", n.steps.includes("区の欄（チェック）"));
  ok("区を2回選んでも『区の欄』は1手（値を外してから同じ欄の連続を畳む）", n.steps.join(" > ") === "所在地絞り込みを開く > 区の欄（チェック） > 確定してリストへ", n.steps.join(" > "));
  ok("値を外した数を数える", n.values_dropped === 2, String(n.values_dropped));
  const d = normalizePlaybookSteps(["rental_cost1", "2K", "room_layout_id[]", "3LDK", "room_layout_id[]"]);
  ok("間取りの値を外し、同じ欄の連続は1つにする", d.steps.join(" > ") === "賃料（下限） > 間取りの欄（チェック）", d.steps.join(" > "));
  const u = normalizePlaybookSteps(["所在地絞り込み＋", "千林", "city_code[]"]);
  ok("分からない名前は『未分類』として残す（黙って消さない）", u.steps.some((s) => s.startsWith("未分類")) && u.unknown.length === 1, u.steps.join(" > "));
}

console.log("■ 場面の手順（束の scene_flows から）");
{
  const pb = buildPlaybook({ generated_at: "2026-11-20T01:00:00Z", scene_flows: sceneFlows, points, opens: { x: { opens: "modal", n: 3, guessed: false } } });
  ok(
    "束の場面を先に・otherは外す・足りない search/list は注入で後ろに足す",
    pb.scenes.map((s) => s.scene).join(",").startsWith("area,cond,station")
      && pb.scenes.some((s) => s.scene === "search")
      && pb.scenes.some((s) => s.scene === "list")
      && !pb.scenes.some((s) => s.scene === "other"),
    pb.scenes.map((s) => s.scene).join(","),
  );
  ok("場面の名前は人が読む日本語（SCENE_JA）", pb.scenes[0].label === SCENE_JA.area && pb.scenes[0].label === "所在地絞り込み", pb.scenes[0].label);
  ok("3回以上は solid・2回以下は thin", pb.scenes[0].confidence === "solid" && pb.scenes[2].confidence === "thin");
  ok("solid の基準は検索3回以上", PLAYBOOK_SOLID_RUNS === 3);
  ok("手順は人が読む名前（区名なし）", pb.scenes[0].steps.join(" > ") === "所在地絞り込みを開く > 区の欄（チェック） > 確定してリストへ", pb.scenes[0].steps.join(" > "));
  ok("操作数・間・順番数を写す（順番は値を含む数のまま）", pb.scenes[0].ops === 81 && pb.scenes[0].gap_ms === 66 && pb.scenes[0].variants === 4);
  ok("押す位置: solid（3回以上）と thin（1〜2回）", pb.points.solid === 2 && pb.points.thin === 1, JSON.stringify(pb.points));
  ok("押すと開く欄の数", pb.opens_known === 1);
  ok("based_on は束の作成時刻", pb.based_on === "2026-11-20T01:00:00Z");
  ok("作り方の版が入る", pb.build_v >= 2);
}

console.log("■ 学んだ押す位置・開く欄を全部載せる（整理の抜け・推測の印）");
{
  const pb = buildPlaybook({
    generated_at: "2026-11-20T01:00:00Z", scene_flows: sceneFlows, points,
    opens: {
      update_date: { opens: "options", n: 0, guessed: true },
      rental_cost1: { opens: "options", n: 0, guessed: true },
      "検索｜span": { opens: "result", n: 4, guessed: false },
      town_code: { opens: "modal", n: 2 },
    },
    next: { pass: { n: 2 }, keyword: { n: 3 } },
  });
  ok("押す位置は学んだ物を全部載せる（票の多い順）", pb.positions.length === 3 && pb.positions[0].field === "a" && pb.positions[0].n === 9, JSON.stringify(pb.positions.map((p) => p.field)));
  ok("押す位置の確かさ（solid/thin）と座標", pb.positions[0].confidence === "solid" && pb.positions[2].confidence === "thin" && pb.positions[0].x === 0.1 && pb.positions[0].w === "checkbox");
  ok("推測の開く欄は『知っている』に数えない", pb.opens_known === 2 && pb.opens_guessed === 2, `${pb.opens_known}/${pb.opens_guessed}`);
  ok("推測の開く欄は一覧に残す（guessed の印つき）", pb.opens.some((o) => o.field === "update_date" && o.guessed === true));
  // 2026-11-27: 束の next は押す順番（次のページ送りではない）。次のページ送りは場面 next で判定する
  ok("束の next は押す順番として件数を出し、次のページ送りの学びが無ければ gaps に出す", pb.next_n === 2 && pb.gaps.some((g) => /次のページ送り（場面 next）はまだ学んでいない（束の next は押す順番の2件/.test(g)), pb.gaps.join(" / "));
  ok("押す位置が空だと gaps に出す", buildPlaybook({ scene_flows: sceneFlows }).gaps.some((g) => /押す位置が1つも無い/.test(g)));
}

console.log("■ 足りない場面・迷い・薄さ・分からない欄（gaps）");
{
  const pb = buildPlaybook({ scene_flows: sceneFlows });
  ok(
    "録画にある area は missing に出さない／search は注入されるので missing から外れる",
    !pb.missing.includes("area") && !pb.missing.includes("search") && pb.scenes.some((s) => s.scene === "search"),
    pb.missing.join(","),
  );
  ok("薄い場面を gaps に出す", pb.gaps.some((g) => /沿線・駅絞り込み：検索2回だけ/.test(g)), pb.gaps.join(" / "));
  ok("other（場面が決まらない）は『学んでいない場面』に入れない", !pb.missing.includes("other") && !pb.gaps.some((g) => /その他/.test(g)));
  ok("順番が複数あるのは『値を含む数・型は未確定』と書く（迷いと言い切らない）", pb.gaps.some((g) => /所在地絞り込み：順番4通り（区名・間取りなど値の違いを含む数/.test(g)), pb.gaps.join(" / "));
  ok("学んでいない場面は gaps に文で残す", pb.gaps.some((g) => /まだ学んでいない場面/.test(g)));
  const u = buildPlaybook({ scene_flows: [{ scene: "area", runs: 4, ops: 9, steps: ["千林", "city_code[]"], variants: 1 }] });
  ok("分からない欄が gaps に出る", u.gaps.some((g) => /欄の名前が分からないもの（千林）/.test(g)), u.gaps.join(" / "));
}

console.log("■ 手順の長さの上限");
{
  const long = [{ scene: "list", runs: 4, ops: 30, steps: Array.from({ length: 40 }, (_, i) => `s${i}`), gap_ms: 10, variants: 1 }];
  const pb = buildPlaybook({ scene_flows: long });
  ok(`手順は先頭 ${PLAYBOOK_MAX_STEPS} 件まで`, pb.scenes[0].steps.length === PLAYBOOK_MAX_STEPS);
}

console.log("■ 版（同じ束＝同じ版・中身が変われば版も変わる）");
{
  const a = buildPlaybook({ generated_at: "t1", scene_flows: sceneFlows, points });
  const b = buildPlaybook({ generated_at: "t1", scene_flows: sceneFlows, points });
  const c = buildPlaybook({ generated_at: "t1", scene_flows: [{ ...sceneFlows[0], runs: 7 }, ...sceneFlows.slice(1)], points });
  ok("同じ束から同じ版", a.version === b.version && /^[0-9a-f]{8}$/.test(a.version));
  ok("場面の回数が変われば版も変わる", a.version !== c.version);
  ok("fnv1a は決まった値（既知の入力）", fnv1a("") === "811c9dc5" && fnv1a("a") === "e40c292c", fnv1a("a"));
}

console.log("■ 検査（checkPlaybook）");
{
  const now = Date.parse("2026-11-20T12:00:00Z");
  const fresh = buildPlaybook({ generated_at: "2026-11-20T01:00:00Z", scene_flows: sceneFlows, points });
  ok("新しい束で手順が正しければ問題なし", checkPlaybook(fresh, now).length === 0, checkPlaybook(fresh, now).join(" / "));
  const old = buildPlaybook({ generated_at: "2026-11-10T01:00:00Z", scene_flows: sceneFlows, points });
  ok("古い束は『古い』と出す", checkPlaybook(old, now).some((x) => /束が古い/.test(x)));
  ok("古い判定の基準は36時間", PLAYBOOK_STALE_MS === 36 * 3600 * 1000);
  const unk = buildPlaybook({ generated_at: "2026-11-20T01:00:00Z", scene_flows: [{ scene: "area", runs: 4, ops: 9, steps: ["千林"], variants: 1 }] });
  ok("未分類の欄は検査で出す", checkPlaybook(unk, now).some((x) => /未分類の欄 1件/.test(x)));
  const zero = buildPlaybook({ generated_at: "2026-11-20T01:00:00Z", scene_flows: [{ scene: "station", runs: 487, ops: 9633, steps: ["沿線・駅絞り込みを開く"] }] });
  ok("順番の数が無い（0）は『0通り』と読まず、gaps と検査に出す（実データ: itandi 487回で0）", zero.gaps.some((g) => /順番の数が束に入っていない/.test(g)) && checkPlaybook(zero, now).some((x) => /順番の数が0/.test(x)));
  /**
   * ★ build_v10〜: 空／薄い束でも連続客用に area/cond/search/list を注入する。
   *   旧「場面が0」は注入後は出ない → 注入場面＋薄いガイド gaps を確かめる。
   */
  const empty = buildPlaybook({});
  ok(
    "空の束でも連続客用の場面が注入される（area/cond/search/list）",
    ["area", "cond", "search", "list"].every((sc) => empty.scenes.some((s) => s.scene === sc)),
    empty.scenes.map((s) => s.scene).join(","),
  );
  ok(
    "空の束の検査で作り方・決まり・一連の抜けを出す（場面0固定ではない）",
    checkPlaybook(empty, now).length >= 1,
    checkPlaybook(empty, now).join(" / "),
  );
  const leak = buildPlaybook({ generated_at: "2026-11-20T01:00:00Z", scene_flows: [{ scene: "cond", runs: 4, ops: 9, steps: ["2K"], variants: 1 }] });
  ok(
    "値だけの cond は注入ガイド手順が載る／または手順空を検査",
    leak.scenes.find((s) => s.scene === "cond")!.steps.length > 0
      || checkPlaybook(leak, now).some((x) => /手順が空/.test(x)),
  );
}

console.log("■ 空の束でも壊れない");
{
  const e = buildPlaybook({});
  ok(
    "空の束 → 注入場面あり・版が付く・before_clear が一連にある",
    e.scenes.length >= 4 && e.version.length === 8 && e.flow_series.some((p) => p.id === "before_clear"),
    `scenes=${e.scenes.length}`,
  );
  ok("空でも版が付く", e.version.length === 8);
}

console.log("■ 一連の流れ（flow_series・build_v8）");
ok("作り方に sort_ad 段", PLAYBOOK_FLOW_SERIES.some((p) => p.id === "sort_ad"));
{
  const pb = buildPlaybook({ generated_at: "2026-11-22T01:00:00Z", scene_flows: sceneFlows, points });
  ok("作り方の版は7以上", PLAYBOOK_BUILD_V >= 7 && pb.build_v >= 7);
  ok("flow_series が載る", Array.isArray(pb.flow_series) && pb.flow_series.length >= 8, String(pb.flow_series?.length));
  ok("必須段がある", ["before_clear", "clear_then_fill", "after_clear", "after_confirm", "after_search", "list", "handoff"].every((id) => pb.flow_series.some((p) => p.id === id)));
  ok("定数 PLAYBOOK_FLOW_SERIES と同じ長さ", pb.flow_series.length === PLAYBOOK_FLOW_SERIES.length);
  const j0 = judgeFlowSeriesProgress([]);
  ok("印が無いと last=null", j0.last === null && !j0.ok);
  const j1 = judgeFlowSeriesProgress([
    { k: "page:guide_phase_after_clear" },
    { k: "page:guide_phase_after_confirm" },
    { k: "page:guide_phase_after_search" },
  ]);
  ok("検索把握まで到達すると ok", j1.ok && j1.last === "after_search", j1.why);
  ok("検査で flow_series 必須", !checkPlaybook(pb).some((x) => /flow_series/.test(x)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
