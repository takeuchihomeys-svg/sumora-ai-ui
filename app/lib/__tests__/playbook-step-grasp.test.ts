/**
 * 手ごとの「押したことの把握」と、要る時だけの手（町・構造）（build_v 37）
 * 2026-11-27 竹内さん「手ごとに押したことの把握を流れの地図から付ける・町と構造も手に足す（入れ物を先に直す）」
 *   形: 町・構造は「その客に要る時だけ行う手」（毎回の手ではない）。管理費は毎回の手。
 *   入れ物: 録画の手（PlaybookStep）に grasp／when／from を持たせ、地図の押す物（playbookStep）と結ぶ。
 * 構造を見る: 置く位置（区の後ろ・確定の前）／要る時だけの印／録画に在れば足さない／ITANDI に混ざらない／
 *             地図の欄名が実在する／拡張が1手目の字で一覧・次ページを見分ける所を壊さない。
 * npx tsx app/lib/__tests__/playbook-step-grasp.test.ts
 */
import * as fs from "fs";
import * as path from "path";
import { buildPlaybook, flowPressesForPlaybook, normalizePlaybookSteps, PLAYBOOK_FIELD_JA, PLAYBOOK_BUILD_V, PLAYBOOK_MARKER_RE } from "../action-playbook";
import { checkPresses, LOOP_FLOW_NODES, pressLine } from "../loop-flow-map";

let n = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  n++;
}

type Flow = { scene: string; runs: number; ops: number; variants: number; steps: string[] };
const flow = (scene: string, steps: string[]): Flow => ({ scene, runs: 5, ops: steps.length * 5, variants: 1, steps });
const bundleOf = (flows: Flow[]) => ({ points: {}, opens: {}, scene_flows: flows, generated_at: "2026-11-27T00:00:00Z" }) as never;

const BASE = [
  flow("area", ["所在地絞り込み＋", "city_code[]", "確定してリストへ"]),
  flow("station", ["沿線・駅絞り込み＋", "route_id[]", "駅の設定へ進む", "station_id[]", "確定してリストへ"]),
  flow("cond", ["update_date", "rental_cost2", "include_common_fee", "room_layout_id[]"]),
  flow("search", ["検索"]),
  flow("next", ["次"]),
];

const pressOf = (button: string) => {
  for (const node of LOOP_FLOW_NODES) for (const p of node.presses || []) if (p.button === button) return p;
  throw new Error("地図に押す物が無い: " + button);
};

assert(PLAYBOOK_BUILD_V >= 37, "build_v は 37 以上");

// 1. 地図の形: 手順書と結んだ欄名は PLAYBOOK_FIELD_JA に実在する（録画の欄名と結べる）。要る時だけの手は必ず結ぶ
{
  const linked = flowPressesForPlaybook();
  assert(linked.length >= 8, "地図の押す物のうち手順書と結んだ物が 8 以上: " + linked.length);
  for (const p of linked) {
    for (const f of p.playbookStep.fields) assert(f in PLAYBOOK_FIELD_JA, `地図の欄名「${f}」（${p.button}）が PLAYBOOK_FIELD_JA に在る`);
    if (p.playbookStep.after) assert(p.playbookStep.after in PLAYBOOK_FIELD_JA, `after「${p.playbookStep.after}」が実在する`);
  }
  for (const b of ["町（ピンポイント）", "構造"]) {
    const p = pressOf(b);
    assert(!!p.playbookStep?.when, `${b} は要る時だけの手（when が在る）`);
  }
  assert(!pressOf("管理費・共益費込み").playbookStep?.when, "管理費は毎回の手（when が無い）");
  assert(checkPresses().length === 0, "今の地図は点検を通る: " + checkPresses().join(" / "));
  // 悪い地図を止める: 手順書と結ばない押す物・毎回の手に after
  const bad = LOOP_FLOW_NODES.map((node) => node.id !== "fill" ? node : {
    ...node,
    presses: (node.presses || []).map((p) => p.button === "構造" ? { ...p, playbookStep: undefined }
      : p.button === "管理費・共益費込み" ? { ...p, playbookStep: { ...p.playbookStep!, after: "rental_cost2" } } : p),
  });
  const errs = checkPresses(bad);
  assert(errs.some((e) => /「構造」\s*が手順書の手と結ばれていない/.test(e)), "結ばれていない押す物を止める: " + errs.join(" / "));
  assert(errs.some((e) => /「管理費・共益費込み」\s*は毎回の手なのに after/.test(e)), "毎回の手の after を止める: " + errs.join(" / "));
  console.log("  ✓ 地図: 結んだ欄名が実在・町/構造は要る時だけ・管理費は毎回・悪い地図を止める");
}

// 2. リアプロ: 録画の手に把握が付き、町は区の後ろ・確定の前に、構造は条件の末尾に「要る時だけ」で足される
{
  const pb = buildPlaybook(bundleOf(BASE), "realpro");
  for (const sc of pb.scenes) assert(sc.detail.length === sc.steps.length, `${sc.scene}: 手の数と細部の数が同じ`);

  const area = pb.scenes.find((s) => s.scene === "area")!;
  const fields = area.detail.map((d) => d.field);
  const iCity = fields.indexOf("city_code[]");
  const iTown = fields.indexOf("town_code[]");
  const iConf = fields.lastIndexOf("確定してリストへ");
  assert(iCity >= 0 && iTown === iCity + 1 && iConf > iTown, `町は区のすぐ後ろ・確定の前: ${fields.join(" → ")}`);
  const town = area.detail[iTown];
  assert(town.from === "map" && town.when === pressOf("町（ピンポイント）").playbookStep!.when, "町は地図から足した要る時だけの手");
  assert(town.grasp === pressLine(pressOf("町（ピンポイント）")), "町の把握は地図の文そのまま");
  assert(area.steps[iTown].startsWith("町字の欄（チェック）（お客さんに町（ピンポイント）がある時だけ）。押したことの把握（町（ピンポイント））"), "町の手の文 = 名前（条件）。把握: " + area.steps[iTown].slice(0, 80));
  const open = area.detail.find((d) => d.field === "所在地絞り込み＋")!;
  assert(open.grasp === pressLine(pressOf("所在地絞り込み")) && !open.when && !open.from, "所在地を開く（録画の手）に把握・条件なし");
  assert(area.detail[iConf].grasp === pressLine(pressOf("確定してリストへ")), "確定に把握");

  const cond = pb.scenes.find((s) => s.scene === "cond")!;
  const last = cond.detail[cond.detail.length - 1];
  assert(last.field === "structured_type[]" && last.from === "map" && !!last.when, "構造は条件の末尾に要る時だけの手で足す");
  const fee = cond.detail.find((d) => d.field === "include_common_fee")!;
  assert(fee.grasp === pressLine(pressOf("管理費・共益費込み")) && !fee.when && !fee.from, "管理費（録画の手）に把握・条件なし");
  assert(cond.detail.filter((d) => d.grasp).length === 2, "条件で把握が付くのは管理費・構造だけ（賃料などは地図に押す物が無い）");

  const station = pb.scenes.find((s) => s.scene === "station")!;
  assert(station.detail.find((d) => d.field === "駅の設定へ進む")?.grasp === pressLine(pressOf("駅の設定へ進む")), "駅の設定へ進むに把握");
  assert(!station.detail.some((d) => d.field === "town_code[]" || d.from === "map"), "駅の場面に町を足さない（町は所在地の場面だけ）");

  const next = pb.scenes.find((s) => s.scene === "next")!;
  assert(next.detail[0].grasp === pressLine(pressOf("次へ")), "次のページへに把握");

  // 検索は固定ガイド①が同じ把握を持つ → 録画の「検索を押す」は差し替わり、同じ文を二重にしない
  const search = pb.scenes.find((s) => s.scene === "search")!;
  const g = pressLine(pressOf("検索"));
  assert(search.steps.filter((t) => t.indexOf(g) >= 0).length <= 1, "検索の把握の文は場面に1回まで");

  // 抜けの文: 地図から足した手は「押す位置を学んでいない」に数えず、別の行で正直に出す
  assert(pb.gaps.some((x) => /所在地.*録画に無く流れの地図から足した要る時だけの手 1件（町字の欄（チェック））/.test(x)), "所在地の抜けに地図から足した町が出る: " + pb.gaps.filter((x) => /地図から/.test(x)).join(" / "));
  assert(!pb.gaps.some((x) => /押す位置を学んでいない手.*町字の欄/.test(x)), "地図から足した町は押す位置の抜けに数えない");
  console.log("  ✓ リアプロ: 手ごとの把握・町は区の後ろ・構造は末尾（要る時だけ）・二重にしない・抜けは別の行");
}

// 3. 録画に町・構造が在れば足さない（録画の手に条件と把握を付けるだけ）
{
  const flows = BASE.map((f) => f.scene === "area" ? flow("area", ["所在地絞り込み＋", "city_code[]", "town_code[]", "確定してリストへ"])
    : f.scene === "cond" ? flow("cond", ["rental_cost2", "structured_type[]", "include_common_fee"]) : f);
  const pb = buildPlaybook(bundleOf(flows), "realpro");
  const area = pb.scenes.find((s) => s.scene === "area")!;
  assert(area.detail.filter((d) => d.field === "town_code[]").length === 1, "町は1手だけ（二重に足さない）");
  const town = area.detail.find((d) => d.field === "town_code[]")!;
  assert(!town.from && !!town.when && !!town.grasp, "録画の町に条件と把握が付く（地図から足した印は無い）");
  const cond = pb.scenes.find((s) => s.scene === "cond")!;
  const st = cond.detail.find((d) => d.field === "structured_type[]")!;
  assert(cond.detail.indexOf(st) === 1 && !st.from && !!st.when, "録画の構造は録画の位置のまま・条件付き");
  assert(!pb.gaps.some((x) => /地図から足した/.test(x)), "録画に在れば地図から足した抜けは出ない");
  console.log("  ✓ 録画に在る町・構造は足さず、条件と把握だけ付ける");
}

// 4. ITANDI: 地図（リアプロの流れ）の把握・条件・足した手を付けない
{
  const it = buildPlaybook(bundleOf([
    flow("area", ["所在地で絞り込み", "小窓の確定"]),
    flow("cond", ["rent:lteq", "structure_type:in"]),
    flow("search", ["リスト検索"]),
  ]), "itandi");
  for (const sc of it.scenes) {
    for (const d of sc.detail) assert(!d.grasp && !d.when && !d.from, `itandi ${sc.scene}「${d.step}」に地図の把握・条件・足した印が無い`);
    assert(!sc.detail.some((d) => d.field === "town_code[]" || d.field === "structured_type[]"), `itandi ${sc.scene} にリアプロの町・構造の欄が無い`);
  }
  assert(!JSON.stringify(it.scenes).includes("押したことの把握（町"), "itandi の場面に町の把握が無い");
  console.log("  ✓ ITANDI に混ざらない");
}

// 5. 拡張が1手目の字で一覧・次ページを見分ける所（bulk-dl.js _pbListNext）を壊さない
{
  const pb = buildPlaybook(bundleOf(BASE), "realpro");
  for (const sc of pb.scenes) {
    const first = String(sc.steps[0] ?? "");
    if (sc.scene !== "list") assert(!/印刷用pdf|pdf/i.test(first), `${sc.scene} の1手目に PDF の字が無い: ${first.slice(0, 60)}`);
    if (sc.scene !== "next") assert(!/次のページ|次へ|pager/i.test(first), `${sc.scene} の1手目に次ページの字が無い: ${first.slice(0, 60)}`);
  }
  console.log("  ✓ 1手目の字の見分けを壊さない");
}

// 6. 拡張が録画へ渡す点検の印（押す物でない名前）は手順書の手にしない（2026-11-27 束 2868: 一覧＝["次タスクAPI結果"]）
{
  const src = fs.readFileSync(path.join(__dirname, "../../../chrome-extension/page-script.js"), "utf8");
  const labelsOf = (head: string): string[] => {
    const i = src.indexOf(head);
    assert(i >= 0, `page-script.js に ${head} が在る`);
    const body = src.slice(i, src.indexOf("};", i));
    return Array.from(body.matchAll(/\w+:\s*"([^"]+)"/g)).map((m) => m[1]);
  };
  const labels = Array.from(new Set([...labelsOf("var _STEP_JA = {"), ...labelsOf("var _STEP_JA2 = {")]));
  assert(labels.length >= 90, "印の表を読めた: " + labels.length);
  // 押す・選ぶ・外す操作そのもの（録画の手として残す）
  const OPERATIONS = new Set([
    "所在地絞り込み", "区を選ぶ", "地域の設定へ進む", "町字を選ぶ", "確定してリストへ",
    "沿線・駅絞り込み", "沿線を選ぶ", "駅の設定へ進む", "駅を選ぶ", "沿線の設定へ戻る",
    "ペット可を外す", "ペット可を選ぶ", "ペット操作後に確定してリストへ",
    "駅を外す", "沿線を外す", "駅のあと沿線を外す", "外しのため駅の設定へ進む",
  ]);
  for (const l of labels) {
    const marker = PLAYBOOK_MARKER_RE.test(l);
    assert(marker !== OPERATIONS.has(l), `「${l}」は印か操作のどちらか一方に仕分ける（印=${marker}・操作=${OPERATIONS.has(l)}）`);
  }
  for (const op of OPERATIONS) assert(labels.includes(op), `操作の一覧「${op}」は page-script の表に実在する`);

  const pb = buildPlaybook(bundleOf([...BASE.filter((f) => f.scene !== "next"), flow("list", ["次タスクAPI結果"]), flow("next", ["左の次｜td.pager", "完了済:検索"])]), "realpro");
  const all = pb.scenes.flatMap((s) => s.steps);
  assert(!all.some((t) => /未分類|次タスク|完了済/.test(t)), "点検の印は手にならない: " + all.filter((t) => /未分類|次タスク|完了済/.test(t)).join(" / "));
  assert(!pb.gaps.some((g) => /欄の名前が分からない/.test(g)), "点検の印は「欄の名前が分からない」に出ない");
  const norm = normalizePlaybookSteps(["所在地絞り込み＋", "次タスクAPI結果", "city_code[]", "流れ台帳", "確定してリストへ"]);
  assert(norm.steps.join(" > ") === "所在地絞り込みを開く > 区の欄（チェック） > 確定してリストへ" && norm.steps.length === norm.fields.length && !norm.unknown.length, "印を落としても並びと欄名は揃う: " + norm.steps.join(" > "));
  console.log("  ✓ 録画に混ざる点検の印（_STEP_JA/_STEP_JA2）は手にしない・新しい名前は仕分けを求める");
}

console.log(`playbook-step-grasp: ${n} 件 OK`);
