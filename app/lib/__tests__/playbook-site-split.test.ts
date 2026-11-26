/**
 * 手順書のサイト分け（2026-11-26 竹内さん「手順書これでできてる？」）
 * itandi の手順書にリアプロ専用の手（並べ替え AD・印刷用PDF・高→低）が入っていた。ITANDI は並べ替えが無い。
 * ・itandi では載せない ・既定（site 未指定）・realpro は従来どおり載る ・読み出しの作り直しも site を見る
 * npx tsx app/lib/__tests__/playbook-site-split.test.ts
 */
import { buildPlaybook, checkPlaybook, refreshPlaybookIfStale, PLAYBOOK_BUILD_V } from "../action-playbook";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

const EMPTY = { points: {}, opens: {}, scene_flows: [] } as never;
const REALPRO_HAND = /印刷用PDF|並べ替え|高→低|span\.sort_detail/;

function sceneSteps(pb: ReturnType<typeof buildPlaybook>, scene: string): string[] {
  const sc = pb.scenes.find((s) => s.scene === scene);
  return sc ? sc.steps.map((t) => String(t)) : [];
}

// 1. itandi: 一覧・検索にリアプロの手が無い
{
  const pb = buildPlaybook(EMPTY, "itandi");
  const list = sceneSteps(pb, "list");
  const search = sceneSteps(pb, "search");
  assert(!list.some((t) => REALPRO_HAND.test(t)), "itandi の一覧にリアプロの手（並べ替え・PDF）が無い: " + list.join(" / "));
  assert(!search.some((t) => REALPRO_HAND.test(t)), "itandi の検索にリアプロの手（並べ替え）が無い: " + search.join(" / "));
  const rulesAll = pb.scenes.flatMap((s) => s.rules ?? []);
  assert(!rulesAll.includes("ad_sort_hover"), "itandi の場面に AD 並べ替えの決まりが付かない");
  console.log("  ✓ itandi: 一覧・検索にリアプロの手が無い");
}

// 2. realpro（明示）と既定（未指定）は従来どおり載る
{
  for (const pb of [buildPlaybook(EMPTY, "realpro"), buildPlaybook(EMPTY)]) {
    const list = sceneSteps(pb, "list");
    assert(list.some((t) => /印刷用PDF/.test(t)), "realpro の一覧に従来の並べ替え・PDF が載る");
    const search = sceneSteps(pb, "search");
    assert(search.some((t) => /並べ替え/.test(t)), "realpro の検索に従来の把握→並べ替えが載る");
  }
  console.log("  ✓ realpro・既定（未指定）は従来どおり");
}

// 3. 読み出しの作り直し（refreshPlaybookIfStale）も site を見る
{
  const bundle = { points: {}, opens: {}, scene_flows: [], playbook: { build_v: 14 } } as Record<string, unknown>;
  const it = refreshPlaybookIfStale(bundle, "itandi");
  assert(it.refreshed === true, "古い作り方の手順書は作り直す");
  const itPb = (it.bundle as { playbook: ReturnType<typeof buildPlaybook> }).playbook;
  assert(!sceneSteps(itPb, "list").some((t) => REALPRO_HAND.test(t)), "作り直した itandi にリアプロの手が無い");
  const rp = refreshPlaybookIfStale(bundle, "realpro");
  const rpPb = (rp.bundle as { playbook: ReturnType<typeof buildPlaybook> }).playbook;
  assert(sceneSteps(rpPb, "list").some((t) => /印刷用PDF/.test(t)), "作り直した realpro には従来どおり載る");
  console.log("  ✓ 作り直し（refreshPlaybookIfStale）も site で分かれる");
}

// 4. 作り方の版を上げた（古い手順書は全部作り直す対象）
assert(PLAYBOOK_BUILD_V >= 16, "作り方の版が 16 以上（itandi の直しを既存の束に当てるため）");
console.log("  ✓ 作り方の版 " + PLAYBOOK_BUILD_V);

// 5. itandi（2026-11-26 手順書の残り）: リアプロの決まり・流れ・追加ガイド・確定の文言を載せない
const NOW = new Date().toISOString();
const ITBUNDLE = { points: {}, opens: {}, scene_flows: [], generated_at: NOW } as never;
const RP_TEXT = /160×高さ30|幅160|30秒以上|確定してリストへ|並べ替え|印刷用PDF|高→低|span\.sort_detail|ペット/;
{
  const pb = buildPlaybook(ITBUNDLE, "itandi");
  assert(pb.site === "itandi", "itandi の手順書は site=itandi");
  assert(pb.rules.length === 0, "itandi の手順書に自動の決まり（リアプロ用）を載せない");
  assert(pb.scenes.every((s) => s.rules.length === 0), "itandi の場面に決まりの印を付けない");
  const allText = [
    ...pb.scenes.flatMap((s) => s.steps.concat(s.detail.map((d) => d.step))),
    ...pb.flow_series.map((p) => p.label),
    ...pb.extra_guides.flatMap((g) => [g.label, ...g.steps]),
  ].map(String);
  const bad = allText.filter((t) => RP_TEXT.test(t));
  assert(bad.length === 0, "itandi の文言にリアプロの手が無い: " + bad.join(" / "));
  assert(!pb.flow_series.some((p) => p.id === "sort_ad"), "itandi の一連の流れに並べ替えの段が無い");
  assert(pb.extra_guides.map((g) => g.id).join(",") === "clear,switch", "itandi の追加ガイドは clear・switch だけ（ペットは載せない）");
  // 外しは itandi の実際の順（打つ欄→チェック→チップ×）
  const clear = pb.extra_guides.find((g) => g.id === "clear")!.steps.join(" ");
  assert(/チップ.*×.*1つずつ/.test(clear) && /打つ欄/.test(clear), "itandi の外しはチップを1つずつ×で外す");
  // itandi の一連の流れは全段に実際の点検印（page: / dl:）が揃っている
  assert(
    pb.flow_series.every((p) => p.grasp.length > 0 && p.grasp.every((g) => /^(page:|dl:)/.test(g))),
    "itandi の一連の流れの全段に page:/dl: 点検印がある",
  );
  assert(!pb.gaps.some((g) => /点検の印が無い段（把握できない）/.test(g)), "全段に印が揃えば把握できない段は出ない");
  assert(pb.gaps.some((g) => /決まりは、このリアプロ/.test(g)), "itandi の決まりは別と gaps に出す");
  // 点検（checkPlaybook）は itandi で「決まりが空」を誤って出さない
  const issues = checkPlaybook(pb, Date.parse(NOW));
  assert(!issues.some((i) => /自動の決まりが手順書に入っていない/.test(i)), "itandi は決まりが空でも点検に引っかからない: " + issues.join(" / "));
  assert(!issues.some((i) => /一連の流れに必須段が無い/.test(i)), "itandi の必須段が揃う: " + issues.join(" / "));
  console.log("  ✓ itandi: リアプロの決まり・流れ・追加ガイド・確定の文言が無い（自動の決まりは空で点検も通る）");
}

// 6. realpro は従来どおり（決まり・並べ替え・リセット幅の手が載る）
{
  const pb = buildPlaybook(ITBUNDLE, "realpro");
  assert(pb.site === "realpro", "realpro の手順書は site=realpro");
  assert(pb.rules.length > 0, "realpro は自動の決まりを載せる");
  assert(pb.flow_series.some((p) => p.id === "sort_ad"), "realpro の一連の流れに並べ替えの段がある");
  assert(pb.extra_guides.map((g) => g.id).join(",") === "clear,switch,pet", "realpro の追加ガイドは clear・switch・pet");
  assert(pb.extra_guides[0].steps.some((t) => /幅160×高さ30/.test(t)), "realpro の外しはリセット幅160×高さ30");
  console.log("  ✓ realpro: 従来どおり（決まり・並べ替え・リセットの手）");
}

// 7. 版違い（作り方 15 の itandi 手順書）は読み出しで作り直される
{
  const old = { points: {}, opens: {}, scene_flows: [], generated_at: NOW, playbook: { build_v: 15, rules_v: "x", site: undefined } } as Record<string, unknown>;
  const r = refreshPlaybookIfStale(old, "itandi");
  assert(r.refreshed === true, "作り方 15 の itandi 手順書は作り直す");
  const pb = (r.bundle as { playbook: ReturnType<typeof buildPlaybook> }).playbook;
  assert(pb.site === "itandi" && pb.rules.length === 0, "作り直した itandi は決まり無し");
  console.log("  ✓ 作り方 15 の itandi 手順書は読み出しで作り直す");
}

// 8. 実物の欄名の分類（itandi の未分類だった間取りのチェック欄・実データ実在欄）
{
  const bundleCond = {
    points: {},
    opens: {},
    generated_at: NOW,
    scene_flows: [
      { scene: "cond", runs: 3, ops: 6, steps: ["room_layout:in", "rent:lteq", "rent:gteq", "option_id:all_in", "building_name:match", "keyword"], variants: 1 },
      { scene: "area", runs: 3, ops: 2, steps: ["所在地で絞り込み", "小窓の確定"], variants: 1 },
      { scene: "station", runs: 3, ops: 1, steps: ["路線・駅で絞り込み"], variants: 1 },
      { scene: "search", runs: 3, ops: 1, steps: ["リスト検索"], variants: 1 },
    ],
  };
  const pb = buildPlaybook(bundleCond as never, "itandi");
  const sc = pb.scenes.find((s) => s.scene === "cond")!;
  assert(sc.steps.join(" ").includes("間取りの欄（チェック）") && sc.unknown.length === 0, "room_layout:in は間取りの欄（未分類にしない）: " + sc.steps.join(" / "));
  assert(pb.scenes.every((s) => s.unknown.length === 0), "itandi 実データの実在欄は未分類にしない: " + pb.scenes.map((s) => s.unknown.join(",")).join(" / "));
  console.log("  ✓ room_layout:in・itandi 実在欄は未分類ではない");
}

console.log("playbook-site-split.test OK");
