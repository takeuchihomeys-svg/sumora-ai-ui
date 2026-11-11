// app/lib/__tests__/aix-second-brain-plan.test.ts — AIX の2通目の組み立て（npx tsx で回す）。番は竹内さんの実際の2通目の形（伏せ済み）
import { planAixSecond, secondPlanNote, aixSecondBrainPlanOn, type SecondPlanInput } from "../aix-second-brain-plan";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const ON = { AIX_SECOND_BRAIN_PLAN: "on" };
const base = (o: Partial<SecondPlanInput> = {}): SecondPlanInput => ({ sentCount: 1, listedDaysAgo: null, roomState: null, wishGaps: [], campaigns: [], sizeWords: [], onlyOne: false, independentGuarantor: false, brain: { mood: null, latent: null, hitPoint: null, viewingPlanned: null, hurry: false }, ...o });

t("既定 off", !aixSecondBrainPlanOn({}) && planAixSecond(base(), {}) === null && secondPlanNote(null) === null);
// #0 ピックアップの後・1部屋のみ・礼金0円キャンペーン・刺さっている → 宣言＋キャンペーン＋申込
const p0 = planAixSecond(base({ sentCount: 5, onlyOne: true, campaigns: ["礼金0円"], sizeWords: [], brain: { mood: "刺さっている", latent: null, hitPoint: null, viewingPlanned: null, hurry: false } }), ON)!;
t("#0 型: 送った中から・キャンペーン・1部屋のみで申込", p0.opening === "pick_from_sent" && p0.barrier[0].includes("礼金0円") && p0.closing === "apply" && p0.closingNote.includes("1部屋のみ"), p0);
// #23 新着・今月末退去予定・審査の不安・独立系
const p23 = planAixSecond(base({ listedDaysAgo: 2, roomState: "vacating", roomStateWhen: "今月末退去予定", independentGuarantor: true, brain: { mood: "普通の依頼", latent: "screening", hitPoint: null, viewingPlanned: null, hurry: false } }), ON)!;
t("#23 型: 退去予定の新着・独立系の1文・ご査収", p23.opening === "new_listing" && p23.openingNote.includes("今月末退去予定で1件新着") && p23.barrier.some((b) => b.includes("独立系")) && p23.closing === "receipt", p23);
// #24 完成前（内覧まだ）→ 申込
const p24 = planAixSecond(base({ roomState: "under_construction", roomStateWhen: "12月", brain: { mood: "普通の依頼", latent: null, hitPoint: null, viewingPlanned: null, hurry: false } }), ON)!;
t("#24 型: 完成前は内覧まだ・申込", p24.opening === "not_viewable_yet" && p24.openingNote.includes("12月完成予定") && p24.closing === "apply", p24);
// #17 希望の上限を超える・内覧の予定がある → ずれを先に・併せて案内
const p17 = planAixSecond(base({ wishGaps: [{ field: "rent", text: "ご上限" }], sizeWords: ["2LDK約50㎡"], brain: { mood: "内覧したい", latent: null, hitPoint: null, viewingPlanned: "日曜日", hurry: false } }), ON)!;
t("#17 型: ずれを先に・併せて案内", p17.opening === "wish_gap" && p17.closing === "viewing_together" && p17.closingNote.includes("併せて日曜日"), p17);
// 新着ではない1件 → 新着と書かない（#22 の創作の直し）・刺さっている＝内覧の扉＋お気軽に
const p22 = planAixSecond(base({ listedDaysAgo: 20, sizeWords: ["リビング9.38帖"], brain: { mood: "刺さっている", latent: null, hitPoint: "カウンターキッチン", viewingPlanned: null, hurry: false } }), ON)!;
t("新着でない時は新着と書かない・広さと刺さっている点を軸に", p22.opening !== "new_listing" && p22.rules.some((r) => r.includes("「新着」と書かない")) && p22.axis[0] === "カウンターキッチン" && p22.axis.includes("リビング9.38帖") && p22.closing === "viewing", p22);
const note = secondPlanNote(p0) ?? "";
t("注記", note.startsWith("【2通目の組み立て") && note.includes("1文目:") && note.includes("締め:"), note);

console.log(`aix-second-brain-plan: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
