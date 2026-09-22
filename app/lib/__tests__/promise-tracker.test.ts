// お客様との約束の追跡・場面の材料（何卒・絵文字）（2026-09-22 竹内「①かしこまりました・何卒 ②絵文字 ③約束」）
// 実行: npx tsx app/lib/__tests__/promise-tracker.test.ts（全 PASS で exit 0）
import { promiseSentences, promiseKind, trackPromises, buildPromiseBrainNote, PROMISE_DEADLINE_RE } from "../promise-tracker";
import { customerSceneOf, buildSentShapeNoteAll, buildCustomerSceneStyleNote } from "../sent-shape";
import { isConditionFormMessage } from "../reply-context";
import { isShortAckOnly } from "../previous-send-note";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (!String(actual).includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} in ${JSON.stringify(String(actual).slice(0, 300))}`); },
  };
}
const deps = { isConditionForm: isConditionFormMessage, isShortAck: isShortAckOnly };
const H = 3600_000;
const NOW = Date.parse("2026-09-22T12:00:00Z");
const at = (hAgo: number) => new Date(NOW - hAgo * H).toISOString();

// ── 約束の取り出し（実送信の文）──
it("実送信の約束「9月30日に…募集状況をご連絡させて頂きます」は期限つきのご連絡", () => {
  const s = promiseSentences("はい！！\n9月30日に一度9月30日時点での募集状況をご連絡させて頂きます！！\nお気軽にご連絡ください！！");
  expect(s.length).toBe(1);
  expect(promiseKind(s[0])).toBe("ご連絡");
  expect(PROMISE_DEADLINE_RE.test(s[0])).toBe(true);
});
it("済んだ報告（〜させて頂きました）は約束に数えない", () => {
  expect(promiseSentences("募集状況確認させて頂きましたところ、現在募集中となります！！").length).toBe(0);
});
it("種類: 交渉・物件探し・確認・条件つきの提案", () => {
  expect(promiseKind("明日管理会社に家賃交渉させて頂きます！！")).toBe("交渉");
  expect(promiseKind("引き続き新着物件を随時確認させて頂き、募集に出次第お送りさせて頂きます！！")).toBe("物件探し");
  expect(promiseKind("代理契約可能か明日管理会社に確認出来次第ご連絡させて頂きます😌！")).toBe("確認");
  expect(promiseKind("お気に召されましたらお申込しお部屋抑えさせて頂きます！！")).toBe("条件つきの提案");
});

// ── 追跡（果たしたか・遅れているか）──
it("確認の約束の後に「確認しましたところ募集中」→ 果たした", () => {
  const t = trackPromises([
    { sender: "staff", text: "募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", createdAt: at(30) },
    { sender: "staff", text: "確認しましたところ現在募集中となります！！", createdAt: at(26) },
  ], NOW);
  expect(t.made > 0).toBe(true);
  expect(t.open.length).toBe(0);
});
it("確認の約束から60時間・報告なし → 遅れ気味（中央値5.7時間・90%で116.5時間）／130時間 → 遅れ", () => {
  const a = trackPromises([{ sender: "staff", text: "代理契約可能か確認させて頂きます！！", createdAt: at(60) }], NOW);
  expect(a.open[0]?.status).toBe("遅れ気味");
  const b = trackPromises([{ sender: "staff", text: "代理契約可能か確認させて頂きます！！", createdAt: at(130) }], NOW);
  expect(b.open[0]?.status).toBe("遅れ");
});
it("代理契約の確認の約束の後に別件の物件送付（[画像]・ご査収）があっても、代理契約の報告が無ければ果たしていない（YUMA 再現）", () => {
  const t = trackPromises([
    { sender: "staff", text: "かしこまりました！！\n代理契約可能か管理会社に確認出来次第ご連絡させて頂きます😌！！", createdAt: at(130) },
    { sender: "staff", text: "[画像]", createdAt: at(100) },
    { sender: "staff", text: "天王寺周辺からピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", createdAt: at(100) },
  ], NOW);
  expect(t.open[0]?.kind).toBe("確認");
  expect(t.open[0]?.status).toBe("遅れ");
  const k = trackPromises([
    { sender: "staff", text: "代理契約可能か管理会社に確認出来次第ご連絡させて頂きます😌！！", createdAt: at(130) },
    { sender: "staff", text: "こちらのお部屋代理契約可能となります！！", createdAt: at(80) },
  ], NOW);
  expect(k.open.length).toBe(0);
});
it("14日より前の約束は数えない／内覧のご案内・条件つきの提案は追わない（お客様の返事待ち）", () => {
  const t = trackPromises([
    { sender: "staff", text: "募集状況確認させて頂きます！！", createdAt: at(24 * 20) },
    { sender: "staff", text: "お気に召されましたらご案内させて頂きます！！", createdAt: at(5) },
  ], NOW);
  expect(t.made).toBe(0);
});
it("ブレインへの材料: 遅れている約束と、場面の約束率を出す", () => {
  const t = trackPromises([{ sender: "staff", text: "9月30日に一度募集状況をご連絡させて頂きます！！", createdAt: at(200) }], NOW);
  const note = buildPromiseBrainNote(t, "条件提示");
  expect(note).toContain("【遅れ】ご連絡の約束");
  expect(note).toContain("期限の語あり");
  expect(note).toContain("76.3%");
  expect(note).toContain("途中経過");
});
it("約束が無い会話では遅れの行を出さない", () => {
  const note = buildPromiseBrainNote(trackPromises([{ sender: "staff", text: "ありがとうございます😊！！", createdAt: at(1) }], NOW), "質問");
  expect(note.includes("遅れている約束がある")).toBe(false);
});

// ── 場面の材料（① 何卒・② 絵文字）──
it("場面: 実物の質問「2年ごとに更新日がかかりますか？」→ 質問", () => {
  expect(customerSceneOf("2年ごとに更新日がかかりますか？", deps)).toBe("質問");
  expect(customerSceneOf("ありがとうございます！！", deps)).toBe("短い了承・お礼");
});
it("① 質問への返事は何卒 5.6%（成約 2.8%）＝付けない方が普通 ／ 条件フォームは 47.7%＝半々", () => {
  const q = buildCustomerSceneStyleNote("質問");
  expect(q).toContain("5.6%");
  expect(q).toContain("付けない方が普通");
  expect(buildCustomerSceneStyleNote("条件フォーム受領")).toContain("半々");
});
it("② 絵文字: 説明・報告の行と URL には付けない／お客様に合わせる必要はない（率を渡す）", () => {
  const all = buildSentShapeNoteAll("質問");
  expect(all).toContain("説明・報告の行");
  expect(all).toContain("付けない");
  expect(all).toContain("合わせる必要はない");
  expect(all).toContain("絵文字なしの返信も 29% ある");
});
it("場面が分からない時は場面の行を出さない（従来の表だけ）", () => {
  expect(buildSentShapeNoteAll(null).includes("お客様の発言の場面は")).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
