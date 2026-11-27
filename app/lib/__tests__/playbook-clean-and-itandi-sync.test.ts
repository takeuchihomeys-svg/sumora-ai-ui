/**
 * 2026-11-27 徹底監査改善の総合検証テスト:
 *   1. 値セル（147,000円｜td.text_right / 1.5ヶ月｜td.text_right）・巨大表（div.main_table）・履歴ボタン（button.history_btn）・生CSSハッシュ単体（input.css-1j76uus）の除去
 *   2. ITANDI 実DB (#2836) 汚染源（#2514 由来のリアプロ 60項目）の一掃と、本物 ITANDI 欄の完全維持
 *   3. shots.learned 画面位置（source: "screen"）の buildPlaybook 活用と itandi-field-aliases の連携（checkPlaybook 問題 0件）
 *   4. learn-bundle-preserve / learn-shots-carry / bundle-write-prepare による他サイト汚染遮断・独立 rules_up_to
 *   5. search-audit.js の dl:send_bar_show 畳み込み実動作＆itandi-page-script.js の手順書読込/リアルタイム保存
 * 実行: npx tsx app/lib/__tests__/playbook-clean-and-itandi-sync.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { isAllowedMotionFieldName, sanitizeBundleForSite, sanitizeLearnedForSite } from "../human-motion-sanitize";
import { buildPlaybook, checkPlaybook, PLAYBOOK_BUILD_V } from "../action-playbook";
import { checkItandiRulesInCode, ITANDI_RULES_REVIEWED_UP_TO, rulesReviewedUpToFor, rulesVersionFor } from "../auto-itandi-rules";
import { AUTO_RULES_REVIEWED_UP_TO } from "../auto-procedure-rules";
import { applyItandiBundleAliasExpansion } from "../itandi-field-aliases";
import { learnFromShots } from "../shot-learn";
import { buildHumanLearnBundle, compactBundle } from "../human-learn-brain";
import { superviseLearn } from "../learn-supervisor";
import { syncSupervisorImproveLoop } from "../learn-bundle-preserve";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail))); }
}

console.log("■ 1. 値セル・巨大コンテナ・履歴ボタン・生CSSハッシュ単体の除外");
{
  const garbage = [
    "147,000円｜td.text_right",
    "1.5ヶ月｜td.text_right",
    "65.3㎡｜td.text_right",
    "左の大阪2棟3戸並べ替え更新｜div.main_table",
    "img→button.history_btn",
    "button.history_btn",
    "#top_free",
    "#main_form",
    "input.css-1j76uus",
    "div.css-abc123",
  ];
  for (const g of garbage) {
    ok(`ゴミ除外(realpro): ${g}`, !isAllowedMotionFieldName(g, "realpro"));
    ok(`ゴミ除外(itandi): ${g}`, !isAllowedMotionFieldName(g, "itandi"));
  }
  const keepLabelled = [
    "左のリスト検索｜button.css-2d2om2-Butt",
    "左の次｜td.pager",
    "印刷用PDF｜a.print",
    "左の高→低｜span.sort_detail",
  ];
  ok("realpro の正規操作ラベルは残る", keepLabelled.slice(1).every((x) => isAllowedMotionFieldName(x, "realpro")));
  ok("itandi の正規ラベル付き CSS ボタン(左のリスト検索｜button.css-...)は残る", isAllowedMotionFieldName("左のリスト検索｜button.css-2d2om2-Butt", "itandi"));

  const pbRp = buildPlaybook({
    generated_at: "2026-11-27T00:00:00Z",
    points: {
      "147,000円｜td.text_right": { n: 60, x: 0.5, y: 0.5, w: "other" },
      "1.5ヶ月｜td.text_right": { n: 30, x: 0.5, y: 0.5, w: "other" },
      "左の大阪2棟3戸並べ替え更新｜div.main_table": { n: 13, x: 0.4, y: 0.4, w: "other" },
      "button.history_btn": { n: 500, x: 0.5, y: 0.5, w: "button" },
      "#top_free": { n: 500, x: 0.5, y: 0.5, w: "other" },
      "rental_cost2": { n: 20, x: 0.2, y: 0.3, w: "select" },
    },
  }, "realpro");
  ok("buildPlaybook(realpro): 値セル・div.main_table・history_btn・#top_free が positions に出ない",
    pbRp.positions.length === 1 && pbRp.positions[0].field === "rental_cost2", pbRp.positions);
}

console.log("\n■ 2. ITANDI shots.learned からのリアプロ亡霊一掃＆本物 ITANDI 項目維持");
{
  const realproGhostsInItandi = [
    "マップ検索", "印刷用PDF", "印刷用PDF｜img", "即入物件で絞り込み", "管理会社絞り込み",
    "5部屋まで表示", "全部屋を表示", "表示棟数", "沿線リセット", "市区郡リセット",
    "詳細な地域の設定へ進む", "都道府県の設定", "所在地絞り込み", "所在地を絞り込み",
    "沿線・駅絞り込み＋", "区を選ぶ", "沿線を選ぶ", "駅を選ぶ", "one_station",
    "one_line", "one_city", "one_town", "駅からの移動手段", "移動手段",
    "賃料下限", "下限賃料", "賃料上限", "上限賃料", "スタジオタイプ",
    "左の次｜td.pager", "左の高→低｜span.sort_detail", "高→低", "問合せ履歴",
    "建物ごと", "部屋ごと", "閲覧履歴", "並べ替え", "ピンポイント", "広げて検索",
    "大阪環状線", "駅名から絞り込み", "PDF出力", "表示件数", "×とじる",
    "リセット", "最後", "最初", "変更", "クリア", "絞り込み", "とじる", "路線", "駅",
  ];
  const genuineItandiFields = [
    "所在地で絞り込み", "路線・駅で絞り込み", "リスト検索", "検索", "管理会社",
    "駅徒歩", "物件名（カナ検索可）", "部屋番号", "バス乗車時間を含む", "申込みを除く",
    "すべて選択", "全選択", "1R", "1K", "2LDK", "メゾネット", "フリーワード",
    "敷金・礼金なし", "管理費・共益費含む", "駐車場料金を含む", "更新日",
    "rent:lteq", "station_walk_minutes:lteq", "building_name:match", "room_layout:in",
    "左のリスト検索｜button.css-2d2om2-Butt",
  ];
  ok("ITANDI でリアプロ亡霊 53種が全て落ちる", realproGhostsInItandi.every((x) => !isAllowedMotionFieldName(x, "itandi")),
    realproGhostsInItandi.filter((x) => isAllowedMotionFieldName(x, "itandi")));
  ok("ITANDI で本物 ITANDI 26種が全て残る", genuineItandiFields.every((x) => isAllowedMotionFieldName(x, "itandi")),
    genuineItandiFields.filter((x) => !isAllowedMotionFieldName(x, "itandi")));

  // #2514 の混載配列（リアプロ高票が混在する配列）では共通高票（賃料 n=1022 等）もパージされ、本物 n<=15 だけ残る
  const rawLearnedPolluted = {
    form: [
      ...realproGhostsInItandi.map((name, i) => ({ name, kind: "button", n: 1000 + i, x: 0.2, y: 0.2 })),
      { name: "賃料", kind: "select", n: 1022, x: 0.07, y: 0.76 },
      { name: "面積", kind: "select", n: 1005, x: 0.07, y: 0.92 },
      { name: "敷金・礼金なし", kind: "checkbox", n: 1568, x: 0.04, y: 0.87 },
      { name: "フリーワード", kind: "text", n: 1369, x: 0.08, y: 0.62 },
      ...genuineItandiFields.slice(0, 10).map((name, i) => ({ name, kind: "button", n: 10 + (i % 5), x: 0.08, y: 0.4 + i * 0.03 })),
      { name: "input.css-1j76uus", kind: "text", n: 5, x: 0.1, y: 0.1 },
    ],
  };
  const cleaned = sanitizeLearnedForSite(rawLearnedPolluted, "itandi");
  const keptNames = new Set(((cleaned.learned?.form || []) as Array<{ name: string }>).map((x) => x.name));
  ok("sanitizeLearnedForSite(itandi): #2514混載配列からリアプロ亡霊＋同世代高票(賃料/面積/敷金・礼金なし/フリーワード)を一掃し、本物 ITANDI 10件だけ残る",
    keptNames.size === 10 && genuineItandiFields.slice(0, 10).every((x) => keptNames.has(x)) && !keptNames.has("賃料") && !keptNames.has("敷金・礼金なし"),
    { kept: [...keptNames], removed: cleaned.removed });

  // 一方、綺麗な ITANDI 配列では将来 n=500 に育った共通名も1件も落ちない
  const cleanFutureItandi = {
    form: [
      { name: "所在地で絞り込み", kind: "button", n: 500, x: 0.08, y: 0.49 },
      { name: "賃料", kind: "select", n: 300, x: 0.09, y: 0.55 },
      { name: "敷金・礼金なし", kind: "checkbox", n: 200, x: 0.05, y: 0.7 },
    ],
  };
  const cleanedFuture = sanitizeLearnedForSite(cleanFutureItandi, "itandi");
  ok("sanitizeLearnedForSite(itandi): リアプロ混入が無い綺麗な配列では高票(n=200〜500)も無傷で残る",
    cleanedFuture.removed === 0 && (cleanedFuture.learned?.form?.length ?? 0) === 3, cleanedFuture);
}

console.log("\n■ 3. buildPlaybook(itandi) の shots.learned 活用＆別名展開＆checkPlaybook 整合");
{
  const bundle: Record<string, unknown> = {
    generated_at: "2026-11-27T01:00:00Z",
    points: {
      "input.css-1j76uus": { n: 3, x: 0.5, y: 0.5, w: "text" },
      "左の検索｜span": { n: 2, x: 0.45, y: 0.5, w: "button" },
    },
    shots: {
      learned: {
        form: [
          { name: "マップ検索", kind: "button", n: 1611, x: 0.1, y: 0.1 },
          { name: "所在地で絞り込み", kind: "button", n: 14, x: 0.08, y: 0.49 },
          { name: "路線・駅で絞り込み", kind: "button", n: 14, x: 0.08, y: 0.56 },
          { name: "駅徒歩", kind: "select", n: 12, x: 0.12, y: 0.65 },
          { name: "物件名（カナ検索可）", kind: "text", n: 14, x: 0.15, y: 0.72 },
          { name: "リスト検索", kind: "button", n: 5, x: 0.14, y: 0.31 },
          { name: "すべて選択", kind: "button", n: 5, x: 0.21, y: 0.22 },
        ],
      },
    },
    scene_flows: [
      { scene: "area", runs: 4, ops: 4, steps: ["所在地で絞り込み"], variants: 1 },
      { scene: "station", runs: 4, ops: 4, steps: ["路線・駅で絞り込み"], variants: 1 },
      { scene: "cond", runs: 4, ops: 8, steps: ["station_walk_minutes:lteq", "building_name:match"], variants: 1 },
      { scene: "search", runs: 4, ops: 4, steps: ["リスト検索"], variants: 1 },
    ],
  };
  sanitizeBundleForSite(bundle, "itandi");
  applyItandiBundleAliasExpansion(bundle);
  const pb = buildPlaybook(bundle as never, "itandi");

  ok("PLAYBOOK_BUILD_V が 19 以上", PLAYBOOK_BUILD_V >= 19 && pb.build_v === PLAYBOOK_BUILD_V);
  ok("ITANDI rules_up_to が独立の ITANDI_RULES_REVIEWED_UP_TO", pb.rules_up_to === ITANDI_RULES_REVIEWED_UP_TO && rulesReviewedUpToFor("itandi") === ITANDI_RULES_REVIEWED_UP_TO);
  ok("points.solid + points.thin === positions.length", pb.points.solid + pb.points.thin === pb.positions.length, { points: pb.points, posLen: pb.positions.length });
  ok("マップ検索・input.css-1j76uus は手順書 positions に残らない",
    !pb.positions.some((p) => /マップ検索|input\.css-1j76uus/.test(p.field)), pb.positions);
  ok("shots.learned 由来の screen 位置が positions に入る（所在地で絞り込み・駅徒歩 等）",
    pb.positions.some((p) => p.field === "所在地で絞り込み" && p.source === "screen" && p.x === 0.08 && p.y === 0.49), pb.positions);
  const condSc = pb.scenes.find((s) => s.scene === "cond");
  ok("ITANDI 別名経由で cond の station_walk_minutes:lteq と building_name:match に画面座標 aim が付く",
    condSc?.detail[0]?.aim?.x === 0.12 && condSc?.detail[1]?.aim?.x === 0.15, condSc?.detail);
  const areaSc = pb.scenes.find((s) => s.scene === "area");
  ok("area の 所在地で絞り込み に solid aim (n=14) が付く", areaSc?.detail[0]?.aim?.n === 14 && areaSc?.detail[0]?.aim?.confidence === "solid", areaSc?.detail);

  // checkPlaybook 自体は ITANDI の欠けた流れ(list/next/handoff)以外は数値整合エラーゼロ
  const pbCheck = checkPlaybook(pb);
  ok("checkPlaybook(pb): 押す位置数の食い違い・値残存・未搭載ルールエラーなし",
    !pbCheck.some((m) => /押す位置の数が合わない|自動の決まり|作り方が古い|座標の無い/.test(m)), pbCheck);

  // 同一座標・同票数のコピー統合（駅徒歩・徒歩分数・分が1代表に畳まれ、別名引きは維持される）＆route_id[]重複なし
  const rpDup = buildPlaybook({
    generated_at: "2026-11-27T01:00:00Z",
    points: {
      "label.one_line": { n: 6, x: 0.4, y: 0.5, w: "label" },
      "沿線・駅絞り込み＋": { n: 4, x: 0.1, y: 0.2, w: "button" },
    },
    shots: {
      learned: {
        form: [
          { name: "沿線・駅絞り込み", kind: "button", n: 500, x: 0.08, y: 0.28 },
          { name: "route_id[]", kind: "button", n: 500, x: 0.08, y: 0.28 },
          { name: "路線", kind: "button", n: 500, x: 0.08, y: 0.28 },
          { name: "one_station", kind: "button", n: 500, x: 0.08, y: 0.28 },
        ],
      },
    },
    scene_flows: [{ scene: "station", runs: 4, ops: 4, steps: ["沿線・駅絞り込み＋", "route_id[]"], variants: 1 }],
  } as never, "realpro");
  const coordDupes = rpDup.positions.filter((p) => p.source === "screen" && p.x === 0.08 && p.y === 0.28);
  const routePos = rpDup.positions.filter((p) => p.field === "route_id[]");
  ok("buildPlaybook: 同一座標の screen 別名増殖が1代表に畳まれ、route_id[] は aggDefs と重複しない",
    coordDupes.length === 1 && routePos.length === 0 && rpDup.scenes[0]?.detail[1]?.aim?.source === "alias",
    { coordDupes, routePos, detail: rpDup.scenes[0]?.detail });
}

console.log("\n■ 3.5. learnFromShots(site) の誤サイト写真丸ごとスキップ & compactBundle(itandi) のリアプロ別名遮断");
{
  const shots = [
    // リアプロ写真が誤って site=itandi 行に入っていたケース（徒歩・検索も丸ごと落ちるべき）
    { mode: "normal", shot_learn: { screen: "result", fields: [{ name: "マップ検索", kind: "button", x: 0.08, y: 0.06 }, { name: "閲覧履歴", kind: "button", x: 0.08, y: 0.16 }, { name: "徒歩", kind: "select", x: 0.06, y: 0.34 }] } },
    // 本物の ITANDI 写真
    { mode: "normal", shot_learn: { screen: "form", fields: [{ name: "所在地で絞り込み", kind: "button", x: 0.08, y: 0.49 }, { name: "駅徒歩", kind: "text", x: 0.03, y: 0.68 }] } },
  ];
  const lf = learnFromShots(shots, { mode: "normal", site: "itandi" });
  ok("learnFromShots(site=itandi): 相手サイト欄を含む写真(id=21929型)は共通名「徒歩」ごと丸ごと除外",
    !lf.screens.result && (lf.screens.form?.fields?.length ?? 0) === 2, lf.screens);

  const built = compactBundle(buildHumanLearnBundle([
    {
      site: "itandi",
      mode: "normal",
      created_at: "2026-11-27T01:00:00Z",
      point_fields: { "賃料": { x: 0.09, y: 0.55, n: 5, w: "select" }, "所在地で絞り込み": { x: 0.08, y: 0.49, n: 5, w: "button" } },
      shot_learn: { screen: "form", fields: [{ name: "賃料", kind: "select", x: 0.09, y: 0.55 }, { name: "駅徒歩", kind: "text", x: 0.03, y: 0.68 }] },
    },
  ] as never, Date.now(), null, null, { site: "itandi" }), { site: "itandi" });
  const ptKeys = Object.keys(built.points);
  const ldNames = (built.shots?.learned?.form || []).map((f: { name?: unknown }) => String(f.name || ""));
  ok("compactBundle(itandi): リアプロ別名(rental_cost1/2, required_time)を作らず ITANDI 別名(rent:lteq, station_walk_minutes:lteq)のみ展開",
    !ptKeys.some((k) => /rental_cost|required_time/.test(k)) && ptKeys.includes("rent:lteq") && ldNames.includes("station_walk_minutes:lteq") && !ldNames.some((k) => /rental_cost|required_time/.test(k)),
    { ptKeys, ldNames });
}

console.log("\n■ 4. search-audit.js の dl:send_bar_show 畳み込み実動作＆コード整合");
{
  const root = path.join(__dirname, "../../..");
  const saSrc = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
  const ctx: { window: Record<string, unknown>; self: Record<string, unknown> } = { window: {}, self: {} };
  ctx.window = ctx as unknown as Record<string, unknown>;
  ctx.self = ctx as unknown as Record<string, unknown>;
  vm.runInNewContext(saSrc, ctx);
  const SA = ctx.self.AxlxSearchAudit as { pushStep: (steps: Array<Record<string, unknown>>, k: string, d: string | null, now?: number) => Array<Record<string, unknown>> };
  let steps: Array<Record<string, unknown>> = [];
  steps = SA.pushStep(steps, "page:page_ver", "2.8.311", 1000);
  steps = SA.pushStep(steps, "page:playbook_seen", "ok", 1010);
  for (let i = 0; i < 80; i++) {
    steps = SA.pushStep(steps, "dl:send_bar_show", "cust1", 2000 + i * 100);
  }
  const barSteps = steps.filter((s) => s.k === "dl:send_bar_show");
  ok("search-audit: dl:send_bar_show 80連続が 1段(n=80) に畳まれる", barSteps.length === 1 && barSteps[0].n === 80 && steps.length === 3, { len: steps.length, bar: barSteps[0] });

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
  const itIssues = checkItandiRulesInCode({
    itandiPage: fs.readFileSync(path.join(root, "chrome-extension/itandi-page-script.js"), "utf8"),
    itandiBulk: fs.readFileSync(path.join(root, "chrome-extension/itandi-bulk-dl.js"), "utf8"),
    manifestVersion: manifest.version,
    searchAudit: saSrc,
  });
  ok("checkItandiRulesInCode(拡張版+searchAudit 含む): 不備 0件", itIssues.length === 0, itIssues);
  ok("AUTO_RULES_REVIEWED_UP_TO === ITANDI_RULES_REVIEWED_UP_TO === manifest.version",
    AUTO_RULES_REVIEWED_UP_TO === manifest.version && ITANDI_RULES_REVIEWED_UP_TO === manifest.version,
    { rp: AUTO_RULES_REVIEWED_UP_TO, it: ITANDI_RULES_REVIEWED_UP_TO, man: manifest.version });
  ok("rulesVersionFor('itandi') !== rulesVersionFor('realpro')", rulesVersionFor("itandi") !== rulesVersionFor("realpro"));
}

console.log("\n■ 5. 統括の偽 read_count=0 解消 & 引き継ぎ後 syncSupervisorImproveLoop（段階3偽停止解消）");
{
  const adv = superviseLearn({
    rows: 100,
    with_ops: 80,
    bundle_reflect: { read_count: 3, read_at: "2026-11-27T01:00:00Z", auto_after: false },
    shot_bytes: { in_storage: 871, n: 100 },
    shot_gaps_normal: { total: 50, unlearnedBig: 10, unlearnedSmall: 0, learnedButEmpty: 0, learnedOk: 40, todo: 10 },
    photo_kinds: { select: 10, button: 10 },
    image_match: { imageFields: 20, withScreenPos: 15, matched: 10, solidPos: 10 },
    foundation_audit: { ok: 33, total: 65, missing: [{ id: "F6_auto_after_bundle" }] },
  } as never);
  const thinkEv = adv.meeting.evidence.find((e) => e.label === "統括Pro思考骨格（足りない→強化→改善）")?.value || "";
  const constEv = adv.meeting.evidence.find((e) => e.label === "改善する仕組みの構築")?.value || "";
  ok("superviseLearn(read=3): Pro思考骨格が read_count=0 と誤診せず『新束後の自動1回』等を指す",
    !/read_count=0|学んだ結果を拡張が読んでいない/.test(thinkEv) && /新束後の自動1回/.test(thinkEv),
    thinkEv);
  ok("superviseLearn(read=3): 改善する仕組みの構築が『学んだのに拡張が読んでいない』を出さない",
    !/学んだのに拡張が読んでいない/.test(constEv),
    constEv);

  const mockBundle: Record<string, unknown> = {
    source: { with_ops: 854 },
    bundle_reflect: { read_count: 3, read_at: "2026-11-27T01:00:00Z", auto_after: false },
    latest_auto_challenge: { fields: ["rental_cost1"] },
    challenge_missing_in_bundle: ["rental_cost1", "unknown_field_not_learned"],
    shots: {
      in_storage: 871,
      learned: {
        form: [
          { name: "賃料", x: 0.1, y: 0.5, n: 10 },
          { name: "rental_cost1", x: 0.1, y: 0.5, n: 5 },
          { name: "間取り", x: 0.2, y: 0.5, n: 4 },
        ],
      },
    },
    supervisor: {
      meeting: {
        evidence: [
          { label: "学習→自動の連携", value: "1.写真Storage保存✓ → 2.操作・押した位置✓ → 3.束の画面位置✗ → 4.拡張が束を読む✓ → 5.自動で使う✗ ／止: 3.束の画面位置（画面位置 35欄（n≥3 0））", guessed: true },
          { label: "連携のボトルネック", value: "3.束の画面位置: 画面位置 35欄（n≥3 0）", guessed: true },
          { label: "改善までの一連", value: "1.写真Storage保存✓ → 2.操作・押した位置✓ → 3.束の画面位置✗ → 4.拡張が束を読む✓ → 5.自動で使う✗ → 6.効果確認✗ ／止: 3.束の画面位置（画面位置 35欄（n≥3 0））", guessed: true },
        ],
        agenda: [
          { priority: 0, topic: "改善までの一連: 段階3で停止", why: "古い行", decide: "何か" },
        ],
      },
    },
  };
  const chg = syncSupervisorImproveLoop(mockBundle, "realpro");
  const evAfter = ((mockBundle.supervisor as { meeting: { evidence: Array<{ label: string; value: string }> } }).meeting.evidence);
  const agAfter = ((mockBundle.supervisor as { meeting: { agenda: Array<{ topic: string; why: string }> } }).meeting.agenda);
  const loopRow = evAfter.find((e) => e.label === "改善までの一連")?.value || "";
  const bnRow = evAfter.find((e) => e.label === "連携のボトルネック")?.value || "";
  ok("syncSupervisorImproveLoop: 引き継ぎ後の solid=3 を反映して段階3✗→段階5止(自動で使う)へ同期",
    chg > 0 && /3\.束の画面位置✓/.test(loopRow) && /止: 5\.自動で使う/.test(loopRow) && /5\.自動で使う/.test(bnRow),
    { loopRow, bnRow });
  ok("syncSupervisorImproveLoop: agenda の段階3も段階5へ更新 & challenge_missing から習得済み rental_cost1 を除外",
    agAfter[0]?.topic === "改善までの一連: 段階5で停止"
      && Array.isArray(mockBundle.challenge_missing_in_bundle)
      && !(mockBundle.challenge_missing_in_bundle as string[]).includes("rental_cost1")
      && (mockBundle.challenge_missing_in_bundle as string[]).includes("unknown_field_not_learned"),
    { ag: agAfter[0], missing: mockBundle.challenge_missing_in_bundle });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
