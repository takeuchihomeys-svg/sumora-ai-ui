// app/lib/__tests__/appeal-plan.test.ts — 2026-11-15 作業員K
//   実行: npx tsx app/lib/__tests__/appeal-plan.test.ts
import { buildAppealPlan, ctaToStrengthAim, timingToStrengthAim, comparePlanToText, appealPlanReadOn } from "../appeal-plan";
import { appealRecordFromText } from "../appeal-record";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra ?? ""); } };

t("スイッチ既定 off", !appealPlanReadOn({}) && appealPlanReadOn({ APPEAL_PLAN_READ: "on" }));
t("締めの読み替え: 内覧 → 案内する×内覧", (() => { const x = ctaToStrengthAim({ kind: "viewing" }); return x.strength === "invite" && x.aim === "viewing"; })());
t("締めの読み替え: 申込 → 強く押す×申込", (() => { const x = ctaToStrengthAim({ kind: "apply" }); return x.strength === "strong" && x.aim === "apply"; })());
t("締めの読み替え: ご査収 → 扉だけ", (() => { const x = ctaToStrengthAim({ kind: "receipt" }); return x.strength === "door" && x.aim === "door"; })());
t("締めの判断が無い → 押さない", ctaToStrengthAim(null).aim === "none");
t("appeal-timing（H の形）: 内覧 must → 案内する・suggest → 扉だけ・avoid → 押さない", timingToStrengthAim({ kind: "viewing", level: "must" }).strength === "invite" && timingToStrengthAim({ kind: "viewing", level: "suggest" }).strength === "door" && timingToStrengthAim({ kind: "viewing", level: "avoid" }).aim === "none");
t("締めが無い番は appeal-timing を使う", buildAppealPlan({ surface: "reply", nowIso: "2026-11-15T08:00:00Z", timing: { kind: "apply", level: "must" } }).from.strengthAim === "appeal_timing");

const now = "2026-11-15T08:00:00Z";
const p = buildAppealPlan({
  surface: "aix_second", nowIso: now, cta: { kind: "viewing" },
  candidates: [{ topic: "zero_deposit", from: "facts" }, { topic: "spacious", from: "second_rank" }, { topic: "zero_deposit", from: "star_reason" }],
  wants: [{ key: "low_initial", from: "conditions" }],
  situation: { sent: [{ at: "2026-11-15T07:30:00Z", aix: "property_recommendation" }, { at: "2026-11-14T08:00:00Z", aix: "estimate_sheet" }], promises_open: [] },
  roomState: ["退去予定"],
});
t("候補は網のまま（同じ話題は1回）・推す点はブレインが選ぶまで空", p.candidates.length === 2 && p.points.length === 0 && p.from.points === "none");
t("前の訴求からの間（物件オススメの送信から）", p.sinceLastAppealH === 0.5);
t("答える依頼の id（要件の帳面と同じ id）は渡した物だけ・重複は1つ", p.answersAsk.length === 0 && buildAppealPlan({ surface: "reply", nowIso: now, answersAsk: ["a1", "a1", "a2"] }).answersAsk.join(",") === "a1,a2");
t("今推す理由: 部屋の状況", p.whyNow.includes("退去予定"));
const chosen = buildAppealPlan({ surface: "aix_second", nowIso: now, cta: { kind: "viewing" }, chosen: ["low_initial", "spacious"], wants: [{ key: "low_initial", from: "conditions" }] });
t("ブレインの選び → 推す点と希望に応える点", chosen.points.length === 2 && chosen.why.length === 1 && chosen.from.points === "brain");

const text = "お送りさせて頂きましたお部屋の中でも特に〇〇 302号室は初期費用を抑えられて7.5帖とお広めです！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
const c = comparePlanToText(chosen, appealRecordFromText(text, { surface: "aix_second", writer: "ai" }));
t("計画どおり: 強さ・狙う返事が同じ", c.strengthSame && c.aimSame, c);
const c2 = comparePlanToText(chosen, appealRecordFromText("お手隙の際にご査収ください😊！！", { surface: "aix_second", writer: "ai" }));
t("計画と違う: 内覧の計画にご査収の文", !c2.aimSame && !c2.strengthSame);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
