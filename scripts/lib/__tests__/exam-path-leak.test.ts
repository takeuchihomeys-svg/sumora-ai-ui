// 2026-11-10 作業員8: D2 道の確かめ（exam-path-check）と D3 漏れの番人（exam-near-hook.nearLeak）
// 実行: npx tsx scripts/lib/__tests__/exam-path-leak.test.ts（env 不要・全 OK で exit 0）
import { pathCheck, touchedLinks } from "../exam-path-check";
import { nearLeak } from "../exam-near-hook";
import { CONDUCTOR_LINKS } from "../../../app/lib/conductor-linkage";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}

console.log("── D2 道の確かめ");
t("注の付いた files（brain-core.ts（…））も当たる", touchedLinks(["app/lib/brain-core.ts"], CONDUCTOR_LINKS).some((l) => l.id === "two_stage"));
const ts = pathCheck({ changed: ["app/lib/two-stage.ts"], links: CONDUCTOR_LINKS, markersById: { q1: ["decision:llm", "two_stage:pickup_unless_ack"], q2: ["decision:llm"], q3: null } });
t("2段を直した: 2段の印のある問題だけ通る・前の答え無しは別に数える", ts.verdict === "ok" && JSON.stringify(ts.passing) === '["q1"]' && JSON.stringify(ts.notPassing) === '["q2"]' && JSON.stringify(ts.noAnswer) === '["q3"]', ts);
const none = pathCheck({ changed: ["app/lib/two-stage.ts"], links: CONDUCTOR_LINKS, markersById: { q2: ["decision:llm"], q4: ["scene_net:viewing"] } });
t("どの問題も通らなければ none（知らせる）", none.verdict === "none", none);
t("brain の行だけに当たる直しは unknown（共用・道の確かめにならない）", pathCheck({ changed: ["app/lib/brain-need.ts"], links: CONDUCTOR_LINKS, markersById: { q1: ["decision:llm"] } }).verdict === "unknown");
t("表に無いファイルだけの直しは unknown", pathCheck({ changed: ["app/lib/unknown-x.ts"], links: CONDUCTOR_LINKS, markersById: { q1: [] } }).verdict === "unknown");
t("前の答えが1つも無ければ unknown", pathCheck({ changed: ["app/lib/two-stage.ts"], links: CONDUCTOR_LINKS, markersById: { q1: null } }).verdict === "unknown");

console.log("── D3 漏れの番人");
// 11/10 17:26Z の控え（q367 の元の番 2026-11-01T09:22:30.598Z が距離 8e-7 で返っていた）
const q367 = [{ source_key: "msg:d47f5659", distance: 8.1e-7, turn_at: "2026-11-01T09:22:30.598+00:00" }, { source_key: "msg:x", distance: 0.132, turn_at: "2026-10-20T00:00:00Z" }];
t("元の番そのもの（距離 0.01 未満）は漏れ", nearLeak("match_conductor_focus", JSON.stringify({ p_before: "2026-11-15T09:22:30Z" }), q367).leak);
t("元の番より後の時刻の番は漏れ", (() => { const r = nearLeak("match_conductor_turns", JSON.stringify({ p_before: "2026-11-01T09:22:30.598Z" }), [{ distance: 0.2, turn_at: "2026-11-02T00:00:00Z" }]); return r.leak && r.after === 1 && r.close === 0; })());
t("ふつうの答え（距離 0.1 以上・元の番より前）は漏れでない", !nearLeak("match_conductor_focus", JSON.stringify({ p_before: "2026-11-01T09:22:30.598Z" }), [{ distance: 0.099, turn_at: "2026-10-28T00:00:00Z" }]).leak);
t("近い番の読み以外の表は見ない", !nearLeak("takeuchi_compose_examples", "{}", [{ distance: 0 }]).leak);
t("頼みが読めない時は距離だけ見る", nearLeak("match_conductor_focus", "not-json", [{ distance: 0.001, turn_at: "2030-01-01T00:00:00Z" }]).close === 1);

console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed ? 1 : 0);
