/**
 * 2026-11-27 徹底改善の防衛単体テスト:
 *   1. human-motion-sanitize: ゴミ欄名(input/iframe/-----/#[object ...]/路線・駅選択都道府県)とサイト外混入、爆発点(n>5000@0.5,0.5)、scene_flows汚染を確実に除去
 *   2. learnPoints: 累計再送による爆発点(n=87,091,200 @ 0.5,0.5)があっても実測座標が勝ち、1行上限50で保護される
 *   3. action-playbook (realpro/itandi): list 4手目「印刷用PDF」誤判定修正、guide aim/opens 引当、route_id[]/station_id[]/city_code[] 集約、entry sanitize
 *   4. shot-learn: 日本語間取り(左の2LDK｜label)やステップボタン(確定してリストへ｜span)の誤警報を抑止、ゴミ(input/iframe/-----)除外
 *   5. latest-learn-loop: challenge fields から "-----" / "input" を除外
 *   6. learn-bundle-preserve: syncSupervisorSceneFlows が supervisor / supervisor_by_site.realpro と scene_flows を同期
 *   7. chrome-extension ソース配線検証:
 *      - popup.js + background.js: 単発自動リセットが autoFillAfter で iframe 消滅耐性を持つ
 *      - human-learn-record.js / human-learn-upload.js: 増分 _sessionPoints 分離・U(uploadDelta)・ストレージ浄化・_ringAt 廃止
 *      - human-learn.js: directText / fieldName / stageOf / uiCounts のガード
 * 実行: npx tsx app/lib/__tests__/playbook-and-motion-hardening.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isAllowedMotionFieldName, sanitizeBundleForSite } from "../human-motion-sanitize";
import { learnPoints } from "../human-learn-brain";
import { buildPlaybook, PLAYBOOK_BUILD_V } from "../action-playbook";
import { findWeakPoints, isLearnableName } from "../shot-learn";
import { summarizeLatestAutoChallenges } from "../latest-learn-loop";
import { syncSupervisorSceneFlows } from "../learn-bundle-preserve";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail))); }
}

console.log("■ 1. human-motion-sanitize（ゴミ・他サイト・爆発・scene_flows汚染除去）");
{
  ok("realpro で input/iframe/id/----- が落ちる", ["input", "iframe", "id", "-----", "路線・駅選択都道府県北海", "#[object HTMLInputElement]"].every((x) => !isAllowedMotionFieldName(x, "realpro")));
  ok("realpro で ITANDI 列(floor_area_amount:gteq / station_walk_minutes:lteq / #_r_5r_｜input.css-vm8hlm)が落ちる", ["floor_area_amount:gteq", "station_walk_minutes:lteq", "structure_type:in", "#_r_5r_｜input.css-vm8hlm"].every((x) => !isAllowedMotionFieldName(x, "realpro")));
  ok("realpro の本物キー(印刷用PDF｜img / 左の高→低｜span.sort_detail / city_code[])は通る", ["印刷用PDF｜img", "左の高→低｜span.sort_detail", "city_code[]", "分"].every((x) => isAllowedMotionFieldName(x, "realpro")));
  ok("itandi でリアプロ専用(transportation_id / required_time / 沿線・駅絞り込み＋)が落ちる", ["transportation_id", "required_time", "沿線・駅絞り込み＋", "駅の設定へ進む"].every((x) => !isAllowedMotionFieldName(x, "itandi")));

  const dirtyBundle: Record<string, unknown> = {
    points: {
      "input": { n: 2100, x: 0.5, y: 0.5 },
      "city_code[]": { n: 6854238, x: 0.5, y: 0.5 },
      "rent:lteq": { n: 22, x: 0.18, y: 0.12 },
      "#_r_5r_｜input.css-vm8hlm": { n: 900, x: 0.5, y: 0.5 },
    },
    scene_flows: [
      { scene: "station", runs: 5, ops: 10, steps: ["沿線・駅絞り込み＋", "駅の設定へ進む"] },
      { scene: "search", runs: 5, ops: 5, steps: ["リスト検索"] },
    ],
  };
  const res = sanitizeBundleForSite(dirtyBundle, "itandi");
  const pts = dirtyBundle.points as Record<string, unknown>;
  const sfs = dirtyBundle.scene_flows as Array<{ scene: string; steps: string[] }>;
  ok("sanitizeBundleForSite(itandi): ゴミ・爆発・他サイトポイントが消える", res.removed >= 3 && !pts["input"] && !pts["city_code[]"] && !!pts["rent:lteq"], { removed: res.removed, keys: Object.keys(pts) });
  ok("sanitizeBundleForSite(itandi): itandi 内のリアプロ station 手順と空になった場面が消える", sfs.length === 1 && sfs[0].scene === "search");
}

console.log("■ 2. learnPoints（爆発点から本物の実測位置を守る）");
{
  const rows = [
    {
      site: "realpro",
      point_fields: {
        "city_code[]": { n: 6854238, x: 0.5, y: 0.5, w: "checkbox", by: "human" },
        "#_r_10f_｜input.css-vm8hlm": { n: 87091200, x: 0.5, y: 0.5, w: "text", by: "human" },
        "input": { n: 300, x: 0.5, y: 0.5 },
      },
    },
    {
      site: "realpro",
      point_fields: {
        "city_code[]": { n: 4, x: 0.28, y: 0.44, w: "checkbox", by: "human" },
        "rental_cost2": { n: 800, x: 0.18, y: 0.12, w: "select", by: "human" },
      },
    },
  ];
  const pts = learnPoints(rows, { site: "realpro" });
  ok("爆発した city_code[] (n=685万@0.5,0.5) に本物実測 (0.28,0.44) が勝つ", pts["city_code[]"]?.x === 0.28 && pts["city_code[]"]?.y === 0.44, pts["city_code[]"]);
  ok("1行あたりの n が 500 でキャップされる", pts["rental_cost2"]?.n === 500, pts["rental_cost2"]);
  ok("ITANDI キー・ゴミキーが learnPoints(realpro) から落ちる", !pts["#_r_10f_｜input.css-vm8hlm"] && !pts["input"]);
}

console.log("■ 3. action-playbook（build_v18・印刷用PDF・aim引き当て・one_line集約）");
{
  const pb = buildPlaybook({
    generated_at: "2026-11-27T00:00:00Z",
    scene_flows: [
      { scene: "station", runs: 5, ops: 20, steps: ["沿線・駅絞り込み＋", "route_id[]", "駅の設定へ進む", "station_id[]"], variants: 1 },
    ],
    points: {
      "左の高→低｜span.sort_detail": { n: 8, x: 0.11, y: 0.3, w: "button" },
      "印刷用PDF｜a.print": { n: 63, x: 0.48, y: 0.51, w: "button" },
      "左の検索｜span": { n: 5, x: 0.62, y: 0.67, w: "button" },
      "確定してリストへ｜span": { n: 4, x: 0.52, y: 0.64, w: "button" },
      "左の所在地絞り込み＋｜span": { n: 6, x: 0.25, y: 0.33, w: "button" },
      "御堂筋線｜label.one_line": { n: 4, x: 0.31, y: 0.49, w: "checkbox" },
      "梅田｜label.one_station": { n: 4, x: 0.27, y: 0.52, w: "checkbox" },
      "#_r_5r_｜input.css-vm8hlm": { n: 900, x: 0.5, y: 0.5 },
    },
    opens: {
      "左の所在地絞り込み＋｜span": { opens: "modal", n: 4, guessed: false },
    },
  }, "realpro");

  ok("PLAYBOOK_BUILD_V が 18 以上", PLAYBOOK_BUILD_V >= 18 && pb.build_v === PLAYBOOK_BUILD_V);
  ok("positions に ITANDI キーが混ざらない", !pb.positions.some((p) => /#_r_/.test(p.field)));
  const listSc = pb.scenes.find((s) => s.scene === "list");
  const step4 = listSc?.detail[3];
  ok("list 4手目が '印刷用PDF' で aim がある", step4?.field === "印刷用PDF" && step4?.aim?.x === 0.48 && step4?.aim?.y === 0.51, step4);
  const step3 = listSc?.detail[2];
  ok("list 3手目(高→低) に実測 aim がある", step3?.aim?.x === 0.11 && step3?.aim?.y === 0.3, step3);
  const searchSc = pb.scenes.find((s) => s.scene === "search");
  ok("search 1手目に実測 aim がある", searchSc?.detail[0]?.aim?.x === 0.62, searchSc?.detail[0]);
  const areaSc = pb.scenes.find((s) => s.scene === "area");
  ok("area 開く・確定に実測 aim / opens がある", areaSc?.detail[0]?.aim?.x === 0.25 && areaSc?.detail[0]?.opens === "modal" && areaSc?.detail[2]?.aim?.x === 0.52, areaSc?.detail);
  const stSc = pb.scenes.find((s) => s.scene === "station");
  ok("station の route_id[] / station_id[] が label.one_line / one_station から集約 aim を得る", stSc?.detail[1]?.aim?.x === 0.31 && stSc?.detail[3]?.aim?.x === 0.27, stSc?.detail);
}

console.log("■ 4. shot-learn & latest-learn-loop（誤警報抑止・ゴミ除外）");
{
  const w = findWeakPoints(
    { input: { n: 5 }, "-----": { n: 2 } } as never,
    [
      { name: "左の2LDK｜label", kind: "checkbox" },
      { name: "左の2LDK｜label", kind: "click" },
      { name: "確定してリストへ｜span", kind: "button" },
      { name: "確定してリストへ｜span", kind: "other" },
      { name: "左の次｜td.pager", kind: "button" },
      { name: "左の次｜td.pager", kind: "other" },
      { name: "更新日", kind: "select" },
      { name: "更新日", kind: "checkbox" },
      { name: "賃料", kind: "select" },
      { name: "賃料", kind: "text" },
    ] as never,
    [],
  );
  ok("誤警報(日本語間取り・ステップother・更新日・賃料)・ゴミ(input/-----)が weak に出ない", w.length === 0, w);
  ok("isLearnableName が input/iframe/id/----- を弾く", !isLearnableName("input") && !isLearnableName("iframe") && !isLearnableName("-----"));

  const ch = summarizeLatestAutoChallenges([
    {
      created_at: new Date().toISOString(),
      mode: "aix",
      shot_key: "k1",
      shot_ops: [
        { k: "change", f: "-----", t: 100 },
        { k: "change", f: "input", t: 200 },
        { k: "change", f: "rental_cost2", t: 300 },
      ],
    },
  ]);
  ok("latestAutoChallenge が ----- と input を課題欄に出さない", !ch.fields.includes("-----") && !ch.fields.includes("input") && ch.fields.includes("rental_cost2"), ch.fields);
}

console.log("■ 5. syncSupervisorSceneFlows（統括と scene_flows の同期）");
{
  const b: Record<string, unknown> = {
    scene_flows: [
      { scene: "station", runs: 198, ops: 411, steps: ["沿線・駅絞り込み＋", "route_id[]", "駅の設定へ進む", "station_id[]"], gap_ms: 1000, variants: 1 },
    ],
    supervisor: {
      meeting: {
        evidence: [{ label: "場面: 沿線・駅絞り込み", value: "198回・手本411手（transportation_id → required_time）" }],
      },
    },
    supervisor_by_site: {
      realpro: {
        meeting: {
          evidence: [{ label: "場面: 沿線・駅絞り込み", value: "198回・手本411手（transportation_id → required_time）" }],
        },
      },
    },
  };
  const n = syncSupervisorSceneFlows(b, "realpro");
  const ev = ((b.supervisor as { meeting: { evidence: Array<{ value: string }> } }).meeting.evidence[0]).value;
  const evRp = ((b.supervisor_by_site as { realpro: { meeting: { evidence: Array<{ value: string }> } } }).realpro.meeting.evidence[0]).value;
  ok("syncSupervisorSceneFlows が supervisor と supervisor_by_site.realpro の両方を開く手順で同期する", n === 2 && ev.includes("駅の設定へ進む") && evRp.includes("駅の設定へ進む"), { n, ev, evRp });
}

console.log("■ 6. Chrome 拡張ソースコード検証（単発リセットリロード耐性・n爆発防止・opensバグ修正）");
{
  const EXT = path.join(process.cwd(), "chrome-extension");
  const pop = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const rec = fs.readFileSync(path.join(EXT, "human-learn-record.js"), "utf8");
  const up = fs.readFileSync(path.join(EXT, "human-learn-upload.js"), "utf8");
  const hl = fs.readFileSync(path.join(EXT, "human-learn.js"), "utf8");

  ok("popup.js: 単発自動リセット時に autoFillAfter を渡し、dispatchedByBg なら二重送信しない", pop.includes("autoFillAfter:") && pop.includes("!_dispatchedByBg") && pop.indexOf("axlx_pending_auto_send") < pop.indexOf("axlx-reset-before-fill"));
  ok("background.js: axlx-reset-before-fill が autoFillAfter を受けリロード後に axlx-realnetpro-autofill を送る", bg.includes("msg.autoFillAfter") && bg.includes("axlx-realnetpro-autofill") && bg.includes("dispatched: dispatched"));
  ok("human-learn-record.js: 増分 _sessionPoints 分離・uploadDelta 送信・_ringAt 廃止", rec.includes("_sessionPoints") && rec.includes("U(uploadDelta") && !rec.includes("_ringAt") && rec.includes("e.type === \"click\""));
  ok("human-learn-upload.js: _clampMotionForUpload による上限・サイトガード", up.includes("_clampMotionForUpload"));
  ok("human-learn.js: directText 複数要素ガード・iframe除外・getClientRects 判定", hl.includes("querySelectorAll(\"input,select,button,a,label,li\").length > 3") && hl.includes("getClientRects") && hl.includes("iframe"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
