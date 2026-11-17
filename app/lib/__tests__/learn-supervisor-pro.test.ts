/**
 * 統括Proまとめ層（画像flash／まとめPro）
 * 実行: npx tsx app/lib/__tests__/learn-supervisor-pro.test.ts
 */
import {
  buildSupervisorProPayload,
  mergeSupervisorPro,
  parseSupervisorPro,
  supervisorProModel,
  supervisorProTimeoutMs,
  SUPERVISOR_PRO_TIMEOUT_MS_DEFAULT,
  type SupervisorProEnrichment,
} from "../learn-supervisor-pro";
import type { SupervisorAdvice } from "../learn-supervisor";
import { shotLearnModel, SHOT_LEARN_DEFAULT_MODEL } from "../shot-learn-limit";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail ?? ""); }
}

const baseAdv = (): SupervisorAdvice => ({
  verdict: "almost",
  headline: "もう少し",
  actions: [],
  score: { coverage: 50, weak: 2, delta: null },
  block: null,
  lines: ["a"],
  meeting: {
    today: ["決定論の今日"],
    agenda: [{ priority: 1, topic: "課題A", why: "弱い", decide: "学ぶ" }],
    questions: [],
    evidence: [{ label: "完成度", value: "42%" }],
    learning_tasks: [{ kind: "photo_learn", what: "読む", why: "弱い", cost: "費用", limit: 20 }],
  },
  self_check: { ok: true, issues: [], capped_by: null },
});

console.log("■ 役割分担（モデル）");
ok("画像読みの既定は flash", SHOT_LEARN_DEFAULT_MODEL === "deepseek-flash");
ok("shotLearnModel は flash（DEEPSEEK_MODEL=Proでも）", shotLearnModel({ DEEPSEEK_MODEL: "deepseek-v4-pro" }) === "deepseek-flash");
ok("統括Proの既定は deepseek-v4-pro", supervisorProModel({}) === "deepseek-v4-pro");
ok("SUPERVISOR_PRO_MODEL で上書き", supervisorProModel({ SUPERVISOR_PRO_MODEL: "x" }) === "x");
ok("Pro待ち既定は180s（旧60s打ち切り防止）", SUPERVISOR_PRO_TIMEOUT_MS_DEFAULT === 180_000);
ok("supervisorProTimeoutMs 既定180s", supervisorProTimeoutMs({}) === 180_000);
ok("SUPERVISOR_PRO_TIMEOUT_MS で上書き", supervisorProTimeoutMs({ SUPERVISOR_PRO_TIMEOUT_MS: "120000" }) === 120_000);
ok("timeout 下限60s", supervisorProTimeoutMs({ SUPERVISOR_PRO_TIMEOUT_MS: "1000" }) === 60_000);

console.log("\n■ parse / merge（verdict を変えない）");
{
  const parsed = parseSupervisorPro('{"today":["Proの結論"],"link_gap":"束が拡張に届いていない","next_line":"拡張再読込","foundation_gaps":["カーソル記録","手の形"],"build_next":"通常でボタン1回録画","quality_up":"連携の層ができた","weak_fixes":[{"field":"city_code[]","gap":"17%","next":"flashで位置","layer":"flash","why":"位置未学習","how":"通常画像を読む","hypothesis":"aimが無い","toward100":"17→70"}],"bug_fixes":["区の外し直押し禁止"],"why_not_100":"再現35%","path_to_100":"手の形→位置→カーソル→自動1回"}');
  ok("parse できる", !!parsed && parsed.today[0] === "Proの結論", parsed);
  ok("土台の抜けを読む", !!parsed && parsed.foundation_gaps[0] === "カーソル記録", parsed);
  ok("弱点細分化を読む", !!parsed && parsed.weak_fixes[0].field === "city_code[]", parsed);
  ok("なぜ・どうしたらを読む", !!parsed && parsed.weak_fixes[0].why === "位置未学習" && parsed.weak_fixes[0].how === "通常画像を読む", parsed);
  ok("仮定に仮定が付く", !!parsed && /仮定/.test(String(parsed.weak_fixes[0].hypothesis || "")), parsed);
  ok("100%への道を読む", !!(parsed && parsed.path_to_100 && parsed.path_to_100.includes("手の形")), parsed);
  ok("変バグを読む", !!parsed && parsed.bug_fixes[0].includes("直押し"), parsed);
  const adv = baseAdv();
  const merged = mergeSupervisorPro(adv, parsed as SupervisorProEnrichment, { model: "deepseek-v4-pro" });
  ok("verdict は almost のまま", merged.verdict === "almost");
  ok("self_check は触らない", merged.self_check.ok === true);
  ok("learning_tasks の kind は残る", merged.meeting.learning_tasks?.[0]?.kind === "photo_learn");
  ok("today に Pro が先頭", merged.meeting.today[0] === "Proの結論");
  ok("役割分担の根拠がある", merged.meeting.evidence.some((e) => e.label.includes("役割分担")));
  ok("統括Proまとめの根拠がある", merged.meeting.evidence.some((e) => e.label.includes("統括Pro")));
  ok("足りない土台の根拠がある", merged.meeting.evidence.some((e) => e.label.includes("足りない土台")));
  ok("弱点細かい改善の根拠がある", merged.meeting.evidence.some((e) => e.label.includes("弱点の細かい改善")));
  ok("100%への道の根拠がある", merged.meeting.evidence.some((e) => e.label.includes("100%への道")));
  ok("なぜ100%でないかがある", merged.meeting.evidence.some((e) => e.label.includes("なぜ100%でないか")));
  ok("変バグ根拠がある", merged.meeting.evidence.some((e) => e.label.includes("変バグ")));
  ok("連携の穴が議題に", merged.meeting.agenda.some((a) => a.topic.includes("連携")));
  ok("土台議題がある", merged.meeting.agenda.some((a) => a.topic.includes("足りない土台")));
  ok("弱点議題がある", merged.meeting.agenda.some((a) => a.topic.includes("弱点細分化")));
}

console.log("\n■ payload は判断軸を抜く");
{
  const p = buildSupervisorProPayload(baseAdv());
  ok("verdict を含む", p.verdict === "almost");
  ok("tasks がある", Array.isArray(p.tasks) && (p.tasks as unknown[]).length === 1);
  const axes = p.axes as Record<string, string | null>;
  ok("axes.completion がある", !!axes && axes.completion === "42%");
  ok("axes に foundation キー", !!axes && "foundation" in axes);
  ok("axes に linkage キー", !!axes && "linkage" in axes);
  ok("axes に vision_link キー", !!axes && "vision_link" in axes);
  ok("axes に photo_kinds キー", !!axes && "photo_kinds" in axes);
  ok("axes に image_match キー", !!axes && "image_match" in axes);
}

console.log("\n■ parse が薄いと null／途中切れ救済");
{
  ok("空JSONは null", parseSupervisorPro("{}") === null);
  ok("ゴミは null", parseSupervisorPro("not json") === null);
  const thin = parseSupervisorPro('{"today":[],"link_gap":null,"next_line":null,"foundation_gaps":[],"build_next":null}');
  ok("全部空は null", thin === null);
  const cut = parseSupervisorPro('{"today":["完成度42"],"why_not_100":"再現が足りない","path_to_100":"手→位置→自動"');
  ok("途中切れでも why_not_100 を読む", !!cut && /再現/.test(String(cut.why_not_100 || "")), cut);
  ok("途中切れでも path_to_100 を読む", !!cut && /手/.test(String(cut.path_to_100 || "")), cut);
}

console.log("\n■ 再Enrichで二重にならない");
{
  const e1: SupervisorProEnrichment = {
    today: ["1回目"],
    link_gap: "穴A",
    next_line: "次A",
    foundation_gaps: ["土台A"],
    build_next: "作るA",
    quality_up: "質A",
    weak_fixes: [{ field: "a", gap: "g", next: "n", layer: "flash" }],
    bug_fixes: ["b1"],
    why_not_100: "まだ低い",
    path_to_100: "道A",
  };
  const e2: SupervisorProEnrichment = {
    today: ["2回目"],
    link_gap: "穴B",
    next_line: "次B",
    foundation_gaps: ["土台B"],
    build_next: "作るB",
    quality_up: "質B",
    weak_fixes: [{ field: "city_code[]", gap: "低", next: "読む", layer: "flash", why: "未学習", how: "flash", hypothesis: "仮定: aim不足", toward100: "低→70" }],
    bug_fixes: ["直押し禁止"],
    why_not_100: "再現不足",
    path_to_100: "位置→カーソル→自動",
  };
  const once = mergeSupervisorPro(baseAdv(), e1, { model: "m1" });
  const twice = mergeSupervisorPro(once, e2, { model: "m2" });
  const proEv = twice.meeting.evidence.filter((x) => /統括Proまとめ|足りない土台|土台を作る次手|役割分担/.test(x.label));
  const proAg = twice.meeting.agenda.filter((a) => /統括Pro/.test(a.topic));
  ok("まとめは1行", proEv.filter((x) => x.label === "統括Proまとめ").length === 1);
  ok("今日は2回目が先頭", twice.meeting.today[0] === "2回目");
  ok("議題の連携穴は1つ", proAg.filter((a) => a.topic.includes("連携の穴")).length === 1);
  ok("足りない土台の値は2回目", String(proEv.find((x) => x.label.includes("足りない土台"))?.value || "").includes("土台B"));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
