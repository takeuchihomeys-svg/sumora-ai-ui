// 2026-11-24 作業員A: 積む前の「試験の値打ちの表」の計算（scripts/lib/exam-worth.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-worth.test.ts（env 不要・全 OK で exit 0）
import { roomOf, weightOf, worthRow, rankWorth, costOf, parseCandidateLine, parseCandidateBlocks, worthGate } from "../exam-worth";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}
const off = new Map([["q1", { pass: 0, n: 4 }], ["q2", { pass: 2, n: 4 }], ["q3", { pass: 4, n: 4 }]]);
const r = roomOf(["q1", "q2", "q3", "q9"], off);
t("余地は過半数の回で外れている問題だけ（半分合格の揺れは数えない）・off の答えが無い問題は別", r.room === 1 && r.roomIds[0] === "q1" && r.unknown.join(",") === "q9", r);
const spec = [
  { id: "q1", type: "返信かAIXか", source: "竹内さんの番" }, { id: "q2", type: "返信かAIXか", source: "竹内さんの番" },
  { id: "q3", type: "AIXの種類", source: "竹内さんの番" }, { id: "q4", type: "AIXの種類", source: "作業員が作った" },
];
t("重み: 竹内さん本人の番から作った問題の中の型の割合の平均", weightOf(["q1"], spec) === 0.667 && weightOf(["q3"], spec) === 0.333 && weightOf(["q1", "q3"], spec) === 0.5);
t("費用: 問題の数×off と on×段の単価", costOf(5, "brain") === 0.8 && costOf(5, "draft") === 1.2);
const a = worthRow({ key: "a", switch: "A", stage: "brain", eff: ["q1"], guards: ["q3"], off, spec });
const z = worthRow({ key: "z", switch: "Z", stage: "brain", eff: ["q2", "q3"], guards: [], off, spec });
const u = worthRow({ key: "u", switch: "U", stage: "brain", eff: ["q9"], guards: [], off, spec });
const n = worthRow({ key: "n", switch: "N", stage: "brain", eff: [], guards: [], off, spec });
t("余地あり＝積む・値打ちは 余地×重み÷費用", a.mark === "積む" && a.score === Math.round((1 * 0.667 / 0.32) * 1000) / 1000, a);
t("効く問題が今の off で全部合格（揺れも含めて過半数は合格）＝積まない（余地0）", z.mark === "積まない（余地0）" && z.score === 0);
t("off の答えが無い＝余地不明（積まないにしない）", u.mark === "off の答えが無い（余地不明）");
t("問題の当て先なし", n.mark === "問題の当て先なし");
t("並び: 積む → 余地不明 → 当て先なし → 積まない", rankWorth([z, n, u, a]).map((x) => x.key).join("") === "aunz");
const c = parseCandidateLine("  1. ROUTE_TO_BRIEF（--stage=draft・ROUTE_TO_BRIEF=on だけ）: 効く q022・q144・q363／守り q065・q425");
t("候補の行から効く・守り・段・スイッチを拾う", !!c && c.eff.join(",") === "q022,q144,q363" && c.guards.join(",") === "q065,q425" && c.stage === "draft" && c.switches.includes("ROUTE_TO_BRIEF"), c);
const c2 = parseCandidateLine("  - -pick（ACK_PICKUP_AIX_PATH=on）: 効く q089・新5426／守り q071・新6675（17問）");
t("新しい問題（新5426）は new5426", !!c2 && c2.eff.includes("new5426") && c2.guards.includes("new6675"), c2);
t("効くの無い行は拾わない", parseCandidateLine("- 費用の見込み: 約 $2") === null);

// 11/24 夜: 守りを効く側に読む穴（APPLY_READINESS_WIDE の実際の行）
const hole = parseCandidateLine("- APPLY_READINESS_WIDE（作業員L）: 決めに行く番（P の見逃しの番）を効く問題、守り q065・q425・q406・q057 で off/on");
t("「…を効く問題、守り q…」は守りを効く側に読まない（効くが空なら拾わない）", hole === null, hole);
const mix = parseCandidateLine("- X_SW: 効く q001・q002、守り q003・q004");
t("同じ行の「効く … 守り …」は守りの手前で切る", !!mix && mix.eff.join(",") === "q001,q002" && mix.guards.join(",") === "q003,q004", mix);
// 新しい書式
const bl = parseCandidateBlocks([
  "### 今夜の組",
  "- 組: a-ack-aix-1123-pick（ACK_PICKUP_AIX_PATH=on・--stage=brain）",
  "  - 効く: q448・新5426・新848",
  "  - 守り: q089・q112・q125",
  "- 組: ROUTE_TO_BRIEF（ROUTE_TO_BRIEF=on・--stage=draft）",
  "  - 守り: q065",
  "  - 効く：q022・q449",
  "## 次の見出し",
  "  - 効く: q999",
]);
t("新しい書式: 組ごとに効く・守り・スイッチ・段（行の順は問わない・全角コロン可）", bl.length === 2 && bl[0].eff.join(",") === "q448,new5426,new848" && bl[0].guards.join(",") === "q089,q112,q125" && bl[0].switches[0] === "ACK_PICKUP_AIX_PATH" && bl[0].stage === "brain" && bl[1].eff.join(",") === "q022,q449" && bl[1].guards.join(",") === "q065" && bl[1].stage === "draft", bl);
t("見出しの後の「効く:」は前の組に入れない", !bl.some((b) => b.eff.includes("q999")));
t("効くが無い組は拾わない", parseCandidateBlocks(["- 組: X（X_SW=on）", "  - 守り: q001"]).length === 0);
// 関所
const offg = new Map([["q1", { pass: 4, n: 4 }], ["q2", { pass: 1, n: 4 }]]);
t("関所: 効く問題が全部 off で過半数合格＝止める", worthGate(["q1"], offg).block);
t("関所: 余地がある＝積む", !worthGate(["q1", "q2"], offg).block);
t("関所: off の答えが無い問題がある＝余地不明で積む", !worthGate(["q1", "q9"], offg).block);
t("関所: 効く問題が無い＝見ない", !worthGate([], offg).block);
console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed ? 1 : 0);
