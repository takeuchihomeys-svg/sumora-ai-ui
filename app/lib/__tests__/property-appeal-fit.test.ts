// 2026-10-08 竹内さん②③④「刺さっているか」を基準に: すぐ来られない番で、かなり刺さっている → 先に抑える提案／そうでなければ内覧調整（AIX）・撮影して送る（AIX）
// お客様の発言は実物（scripts/audit-appeal-fit-hold.ts・365日・名前は伏せ字）。線の根拠は property-appeal-fit.ts の APPEAL_FIT_LINES の注釈
// 実行: npx tsx app/lib/__tests__/property-appeal-fit.test.ts
import { readAppealReaction, resolvePropertyAppealFit } from "../property-appeal-fit";
import { resolveAppealFromConversation, resolveDelayKind } from "../appeal-timing";
import { buildCircumstancesNote, extractCircumstances, validCircumstances } from "../customer-circumstances";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`「${sub}」が無い: ${s.slice(0, 300)}`); }
function hasNot(s: string, sub: string) { if (s.includes(sub)) throw new Error(`「${sub}」が入った: ${s.slice(0, 300)}`); }

const T0 = Date.parse("2026-10-06T03:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const STAR = { sender: "staff", text: "🌟ララプレイス〇〇 402号室\n\n〇〇さんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください😌！！", createdAt: at(0) };

// fb8ab8d5 9/7（人＝先に抑える提案＋室内撮影・申込に届いた）
const FB = ["ありがとうございます🙇🏻‍♀️\n\nまた時間ある時にじっくり見させてもらいます🤲🏻", "条件など含め好条件で気になるのですが内見などはできますか？？", "今月前半結構予定詰まってて🥲"];
// bfd172e6 7/13（人＝来週以降で内覧調整）
const BF = ["では、今週は内覧に行けないです"];

it("反応の点: fb8ab8d5（前向き・内覧の希望・3分で返事）→ 3点・かなり刺さっている", () => {
  const r = readAppealReaction(FB.map((t, k) => ({ text: t, createdAt: at(3 + k) })), { sentAt: at(0) });
  eq([r.appraisal, r.viewingWish, r.points], [true, true, 3]);
  eq(resolvePropertyAppealFit({ reaction: r }).level, "strong");
});
it("反応の点: bfd172e6「では、今週は内覧に行けないです」（早い返事だけ）→ 1点・そこそこ", () => {
  const r = readAppealReaction(BF.map((t) => ({ text: t, createdAt: at(1) })), { sentAt: at(0) });
  eq(r.points, 1);
  eq(resolvePropertyAppealFit({ reaction: r }).level, "medium");
});
it("懸念の言葉の誤読をしない（「埋まる可能性高いですかね」「出張で厳しいです」）", () => {
  for (const t of ["今見てる物件埋まる可能性高いですかね", "明日から15日までお仕事の出張で厳しいです💦"]) eq(readAppealReaction([{ text: t, createdAt: at(10) }]).negative, false, t);
  eq(readAppealReaction([{ text: "家賃がちょっと高いですね", createdAt: at(10) }]).negative, true);
});
it("採点が外れ寄り（weak）は反応だけでは刺さっていると言わない（365日: 外れ寄り 60番・14会話で申込 0）／申込の意思は別", () => {
  const pickup = { verdict: "pass", reason_codes: ["FIT_ALL", "RENT_SLIGHTLY_OVER"] };
  const r = readAppealReaction(FB.map((t, k) => ({ text: t, createdAt: at(3 + k) })), { sentAt: at(0) });
  eq(resolvePropertyAppealFit({ pickup, reaction: r }).level, "medium");
  eq(resolvePropertyAppealFit({ pickup, reaction: readAppealReaction([{ text: "ここに決めたいです、申込したいです", createdAt: at(5) }]) }).level, "strong");
});
it("すぐ来られない理由の型: 出張中（日付なし）・遠方＝fixed／予定が詰まって＝busy／今週は無理・来週出張＝short", () => {
  const now = T0;
  const v = (t: string) => validCircumstances(extractCircumstances([{ text: t, createdAt: at(1) }], T0), now);
  eq(resolveDelayKind("現在出張中のため、そちらへ伺うことができません", v("現在出張中のため、そちらへ伺うことができません"), now), "fixed");
  eq(resolveDelayKind("今広島に住んでいて、内見が難しい状況です", v("今広島に住んでいて、内見が難しい状況です"), now), "fixed");
  eq(resolveDelayKind("今月前半結構予定詰まってて🥲", v("今月前半結構予定詰まってて🥲"), now), "busy");
  eq(resolveDelayKind("では、今週は内覧に行けないです", v("では、今週は内覧に行けないです"), now), "short");
  eq(resolveDelayKind("来週出張で行けないです", v("来週出張で行けないです"), now), "short");
});
const conv = (cust: string[], gapMin: number) => [STAR, ...cust.map((t, k) => ({ sender: "customer", text: t, createdAt: at(gapMin + k) }))];
it("訴求（会話から）: fb8ab8d5 予定が詰まって×かなり刺さっている → 抑える提案＋撮影は AIX", () => {
  const r = resolveAppealFromConversation({ msgs: conv(FB, 3), aixLogs: [{ aixType: "property_recommendation", at: at(0) }] });
  eq(r?.input.delayKind, "busy"); eq(r?.verdict.kind, "apply");
  has(String(r?.verdict.note), "かなり刺さっている"); has(String(r?.verdict.note), "撮影");
});
it("訴求（会話から）: bfd172e6 今週は無理×そこそこ → 抑える提案は入れない・来週以降で内覧調整（AIX）", () => {
  const r = resolveAppealFromConversation({ msgs: conv(BF, 1), aixLogs: [{ aixType: "property_recommendation", at: at(0) }] });
  eq(r?.input.delayKind, "short"); eq(r?.verdict.kind, "none");
  has(String(r?.verdict.note), "抑える提案（申込の訴求）は入れない"); has(String(r?.verdict.note), "AIX【内覧調整】");
});
it("予定が詰まって×反応が薄い → 撮影して送る（AIX）→ 気に入ってから抑える", () => {
  const r = resolveAppealFromConversation({ msgs: conv(["今月前半結構予定詰まってて🥲"], 600), aixLogs: [{ aixType: "property_recommendation", at: at(0) }] });
  eq(r?.verdict.kind, "none"); has(String(r?.verdict.note), "一度室内撮影しお送りさせて頂きます");
});
it("出張中（日付なし）は今まで通り抑える提案（竹内さん①・刺さり具合で分けない）", () => {
  const r = resolveAppealFromConversation({ msgs: conv(["内覧したいのですが、現在出張中のため、そちらへ伺うことができません"], 600), aixLogs: [{ aixType: "property_recommendation", at: at(0) }] });
  eq(r?.input.delayKind, "fixed"); eq(r?.verdict.kind, "apply");
});
it("PROPERTY_APPEAL_FIT=off で旧（今週は無理でも抑える提案）", () => {
  process.env.PROPERTY_APPEAL_FIT = "off";
  try {
    const r = resolveAppealFromConversation({ msgs: conv(["ここ気になります！でも今週は内覧に行けないです"], 1), aixLogs: [{ aixType: "property_recommendation", at: at(0) }] });
    eq(r?.verdict.kind, "apply");
  } finally { delete process.env.PROPERTY_APPEAL_FIT; }
});
it("お客様の事情の注記: 予定が詰まって（日付なし）は刺さり具合で抑える提案か撮影が先かを分ける／CIRCUMSTANCE_BUSY_BY_APPEAL=off で旧", () => {
  const v = validCircumstances(extractCircumstances([{ text: "今月前半結構予定詰まってて🥲", createdAt: at(1) }], T0), T0);
  const n = buildCircumstancesNote(v, { nowMs: T0, scene: "viewing" });
  has(n, "かなり刺さっている物件なら"); has(n, "一度室内を撮影してお送りし");
  process.env.CIRCUMSTANCE_BUSY_BY_APPEAL = "off";
  try { hasNot(buildCircumstancesNote(v, { nowMs: T0, scene: "viewing" }), "かなり刺さっている物件なら"); } finally { delete process.env.CIRCUMSTANCE_BUSY_BY_APPEAL; }
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
