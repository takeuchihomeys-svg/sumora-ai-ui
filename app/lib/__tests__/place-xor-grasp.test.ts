/**
 * 所在地／沿線駅 XOR（並行しない・どちらか一方）の決定論テスト
 * npx tsx app/lib/__tests__/place-xor-grasp.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_RULES, judgeRulesOnAudit, type AuditStep } from "../auto-procedure-rules";
import {
  applyPlaceXorSuppress,
  decidePlaceXor,
  isPlaceXorViolation,
  placeXorLabel,
} from "../place-xor";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

const page = readFileSync(join(process.cwd(), "chrome-extension/page-script.js"), "utf8");
const audit = readFileSync(join(process.cwd(), "chrome-extension/search-audit.js"), "utf8");
const man = JSON.parse(readFileSync(join(process.cwd(), "chrome-extension/manifest.json"), "utf8"));

console.log("■ 版・決まり・配線");
{
  assert(String(man.version) >= "2.8.215", "ext>=2.8.215 今=" + man.version);
  assert(AUTO_RULES.some((r) => r.id === "place_xor_grasp"), "決まり place_xor_grasp");
  assert(page.includes('"_axApplyPlaceXor"') || page.includes("function _axApplyPlaceXor") || page.includes("_axApplyPlaceXor"), "_axApplyPlaceXor");
  assert(page.includes("_axApplyPlaceXor"), "marker _axApplyPlaceXor in page");
  assert(page.includes('"place_xor_grasp"'), "RULES_DONE");
  assert(page.includes('place_xor"') || page.includes("place_xor"), "印 place_xor");
  assert(/place_xor/.test(audit), "search-audit KEEP/RULE に place_xor");
  assert(page.includes("並行しない"), "文:並行しない");
  console.log("  ✓ 版・決まり・配線OK");
}

console.log("■ 決定表（入れる側は常に1つ）");
{
  assert(decidePlaceXor({ area_mode: "ward", city_codes: ["27128"] }) === "area", "ward明示→area");
  assert(decidePlaceXor({ area_mode: "ward", station_names: ["梅田"], city_codes: [] }) === "station", "ward希望だが区無し・駅あり→station");
  assert(decidePlaceXor({ area_mode: "station", station_names: ["弁天町"] }) === "station", "station明示");
  assert(decidePlaceXor({ area_mode: "station", city_codes: ["27128"], station_names: [] }) === "area", "station希望だが駅無し・区あり→area");
  // auto: 両方埋まっても区優先＝所在地だけ（並行しない）
  const both = decidePlaceXor({
    city_codes: ["27128"],
    station_names: ["野田"],
    route_ids: ["1"],
  });
  assert(both === "area", "auto両軸→area（駅と並行しない） got=" + both);
  assert(decidePlaceXor({ station_names: ["梅田"] }) === "station", "auto駅のみ");
  assert(decidePlaceXor({ route_ids: ["12"] }) === "route", "auto沿線のみ");
  assert(decidePlaceXor({}) === "none", "空→none");
  console.log("  ✓ 決定表OK");
}

console.log("■ 負け軸抹消（XOR suppress）");
{
  const r = applyPlaceXorSuppress({
    city_codes: ["27128"],
    station_names: ["野田", "福島"],
    route_ids: ["1"],
    detail_ward: "西区",
  });
  assert(r.mode === "area", "mode area");
  assert((r.cond.station_names || []).length === 0, "駅消す");
  assert((r.cond.route_ids || []).length === 0, "沿線消す");
  assert(r.drop.some((d) => /沿線・駅/.test(d)), "drop文言");
  assert(/所在地/.test(r.label), "label所在地");

  const s = applyPlaceXorSuppress({
    area_mode: "station",
    city_codes: ["27128"],
    station_names: ["弁天町"],
    detail_ward: "西区",
  });
  assert(s.mode === "station", "station mode");
  assert((s.cond.city_codes || []).length === 0, "区消す");
  assert(s.cond.detail_ward == null, "detail消す");
  assert(s.drop.some((d) => /所在地/.test(d)), "drop所在地");
  console.log("  ✓ suppressOK label=" + r.label + " / " + s.label);
}

console.log("■ 混在は違反");
{
  assert(isPlaceXorViolation(2, 3) === true, "混在");
  assert(isPlaceXorViolation(2, 0) === false, "区のみOK");
  assert(isPlaceXorViolation(0, 5) === false, "駅のみOK");
  assert(isPlaceXorViolation(0, 0) === false, "なしOK");
  console.log("  ✓ 違反判定OK");
}

console.log("■ 監査 verify（place_xor 印）");
{
  const okSteps: AuditStep[] = [
    { k: "page:fill_start", d: "ward" },
    { k: "page:place_xor", d: placeXorLabel("area") + "（並行しない・どちらか一方）" },
    { k: "page:location", d: "area" },
  ];
  const judged = judgeRulesOnAudit(
    okSteps,
    AUTO_RULES.filter((r) => r.id === "place_xor_grasp"),
  );
  const row = judged.find((x) => x.id === "place_xor_grasp");
  assert(!!row && row.result === "ok", "place_xor_grasp ok: " + JSON.stringify(row));

  const miss: AuditStep[] = [{ k: "page:fill_start", d: "x" }];
  const j2 = judgeRulesOnAudit(miss, AUTO_RULES.filter((r) => r.id === "place_xor_grasp"));
  const row2 = j2.find((x) => x.id === "place_xor_grasp");
  // onlyIf に place_xor が無いので no_data（印無しで ng にしない＝途中止まりを誤罰しない）
  assert(!!row2 && row2.result === "no_data", "印無しは no_data: " + JSON.stringify(row2));
  console.log("  ✓ verifyOK");
}

console.log("place-xor-grasp.test OK");
