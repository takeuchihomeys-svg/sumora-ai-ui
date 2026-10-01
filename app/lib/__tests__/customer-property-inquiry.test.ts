// 2026-10-01 竹内（和樹事例）「ここは物件確認したから送る形なので、そのようにする」
// 実行: npx tsx app/lib/__tests__/customer-property-inquiry.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 本文は本番の会話（和樹 fecda03f・10/1 12:45）と、監査で読んだ実物をそのまま使う
import { correctCustomerPropertyInquiryAix, isCustomerBroughtProperty } from "../customer-property-inquiry";
import { splitPromisesForFreshInquiry } from "../promise-calendar";
import { detectAixSceneEvidence, isPropertyCandidateImage, customerRequestedPropertyCheck } from "../aix-scene-evidence";
import { unrepliedCustomerTurn, sceneEvidenceForTurn } from "../brain-aix-feedback";
import { detectPropertyCheckPattern } from "../aix-taxonomy";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

// 和樹 10/1 12:45（2通の連投）
const KAZUKI_TURN = "ＭＡＩＳＯＮ　ＬＵＮＡ 1階\nhttps://suumo.jp/chintai/bc_100500564435/\nby SUUMO\nここはどうでしょうか？";
// 和樹 9/30 21:34（同じ形・スタッフは 10/1 11:32 に 物件確認した＋御見積書同封）
const KAZUKI_PREV = "初芝 1SLDK 2階\nhttps://suumo.jp/chintai/bc_100528886581/\nby SUUMO\n\nここ気になってます！";
const sceneOf = (turn: string, hasImage = false) => {
  const s = detectAixSceneEvidence({ latestCustomerTurn: turn, hasCustomerImage: hasImage, sentPropertyCount: 6 });
  return s ? { scene: s.scene, propertySpecifiedBy: s.propertySpecifiedBy } : null;
};

it("和樹 12:45: 場面は S1（URL の持ち込み）", () => {
  const s = sceneOf(KAZUKI_TURN);
  expect(s?.scene).toBe("S1_vacancy");
  expect(s?.propertySpecifiedBy).toBe("url");
});
it("和樹 12:45: ブレインの 確認します → 物件確認した", () => {
  const r = correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene: sceneOf(KAZUKI_TURN), customerTurn: KAZUKI_TURN });
  expect(r?.action).toBe("property_check_result");
  expect(r?.decisionSource).toBe("correction:customer_property_inquiry");
});
it("和樹 9/30 21:34「ここ気になってます！」も 物件確認した", () => {
  expect(correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene: sceneOf(KAZUKI_PREV), customerTurn: KAZUKI_PREV })?.action).toBe("property_check_result");
});
it("LLM が 見積書送る・物件確認した・物件ピックアップを選んだ時は変えない", () => {
  for (const a of ["estimate_sheet", "property_check_result", "property_send", null]) {
    expect(correctCustomerPropertyInquiryAix({ finalAix: a, scene: sceneOf(KAZUKI_TURN), customerTurn: KAZUKI_TURN })).toBe(null);
  }
});
it("初期費用を聞いた持ち込み（実物 732692f2「この物件達の初期費用っていくらになりますか？」＋画像）→ 見積書送る", () => {
  // ブレインに渡る今回の発言（unrepliedCustomerTurn）は画像の通を外した言葉だけ（hasImage は別に持つ）
  const t = "この物件達の初期費用っていくらになりますか？";
  const r = correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene: { scene: "S1_vacancy", propertySpecifiedBy: "image" }, customerTurn: t });
  expect(r?.action).toBe("estimate_sheet");
});
it("値引きの相談（実物 f5e92bc6「いくらくらいお安くできますか？」）は見積の語が無いので 物件確認した（スタッフも 物件確認した）", () => {
  const t = "https://suumo.jp/chintai/bc_100525219054/\nこんにちは。こちらはいくらくらいお安くできますか？";
  expect(correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene: { scene: "S1_vacancy", propertySpecifiedBy: "url" }, customerTurn: t })?.action).toBe("property_check_result");
});
it("広告・通販の URL（実物 temu の招待）は持ち込みではない → 変えない", () => {
  const t = "選べる無料ギフトがたくさん！お見逃しなく！🎁\nhttps://temu.com/s/PyvF3Gc4vR2keWX";
  expect(isCustomerBroughtProperty({ scene: { scene: "S1_vacancy", propertySpecifiedBy: "url" }, customerTurn: t })).toBe(false);
  expect(correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene: { scene: "S1_vacancy", propertySpecifiedBy: "url" }, customerTurn: t })).toBe(null);
});
it("物件の語だけの S1（実物「銀行振込は何日に行えばいいですか？」の誤当たり等）は変えない＝URL・画像の持ち込みだけ", () => {
  expect(correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene: { scene: "S1_vacancy", propertySpecifiedBy: "property_word" }, customerTurn: "この物件のいちばん広い部屋ありますか？" })).toBe(null);
});
it("S1 以外の場面（内覧 S4）は変えない", () => {
  expect(correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene: { scene: "S4_viewing", propertySpecifiedBy: "url" }, customerTurn: KAZUKI_TURN })).toBe(null);
});
it("画像の読み取り文にある「初期費用」はお客様の言葉ではない → 物件確認した", () => {
  // 通の区切り（MSG_SEP）で渡された時も、画像の読み取り文の通は見ない
  const t = ["[画像] IBCレジデンスウエスト 5階\n【賃料】18.4万\n初期費用シミュレーション", "このマンションも空いてますか？"].join("\n⁣\n");
  expect(correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene: { scene: "S1_vacancy", propertySpecifiedBy: "image" }, customerTurn: t })?.action).toBe("property_check_result");
});

it("YUMA の場面テストで見つけた漏れ: 「クーラー取り付けられるか」は 設備（mgmt_equipment）", () => {
  expect(detectPropertyCheckPattern("リビングにクーラー取り付けられるか分かりますでしょうか？")?.check_pattern).toBe("mgmt_equipment");
});

// ── 画像の見出し（image-label）: 物件以外の画像は持ち込みにしない ──
const CHAT_SHOT = "[画像] 【物件以外：やり取りのスクショ】\nお疲れ様です。物件の契約は法人契約でなければならないのか…";
const PORTAL_SHOT = "[画像] 【物件の画面（ポータル）】\nIBCレジデンスウエスト 5階 2LDK 59.59㎡ 18.4万";
it("ae3ffecb 型: 勤務先とのやり取りのスクショ（物件以外）は場面 S1（画像）にならない", () => {
  const t = unrepliedCustomerTurn([{ sender: "customer", text: CHAT_SHOT }, { sender: "staff", text: "x" }]);
  expect(t.hasImage).toBe(true);
  expect(t.nonPropertyImagesOnly).toBe(true);
  expect(sceneEvidenceForTurn(t, { sentPropertyCount: 3 })?.scene ?? null).toBe(null);
});
it("ポータルの画面の見出しの画像は今まで通り S1（画像の持ち込み）", () => {
  const t = unrepliedCustomerTurn([{ sender: "customer", text: "このマンションも空いてますか？" }, { sender: "customer", text: PORTAL_SHOT }, { sender: "staff", text: "x" }]);
  expect(t.nonPropertyImagesOnly).toBe(false);
  const s = sceneEvidenceForTurn(t, { sentPropertyCount: 3 });
  expect(s?.scene).toBe("S1_vacancy");
  expect(s?.propertySpecifiedBy).toBe("image");
});
it("見出しの無い昔の行・読み取り前の [画像] は今まで通り（物件以外とみなさない）", () => {
  expect(isPropertyCandidateImage("[画像]")).toBe(true);
  expect(isPropertyCandidateImage("[画像] 物件名：大阪市住吉区 長居東１丁目")).toBe(true);
  expect(isPropertyCandidateImage("[画像] 【種類不明】\nxxx")).toBe(true);
  expect(isPropertyCandidateImage(CHAT_SHOT)).toBe(false);
  // 種類の名前だけで保存した書類（監査 D: S1（画像）の判断のうち 21件がこれだけ・スタッフが AIX を押した回 0）
  expect(isPropertyCandidateImage("[画像] 本人確認書類")).toBe(false);
  expect(isPropertyCandidateImage("[画像] 収入証明書（労働条件通知書）")).toBe(false);
  expect(isPropertyCandidateImage("[画像] 本人確認書類", "id_document")).toBe(false);
});
it("物件確認の依頼の判定: 物件以外の画像だけなら依頼にしない／ポータルの画面なら依頼", () => {
  expect(customerRequestedPropertyCheck({ recentMessages: [{ sender: "staff", text: "x" }, { sender: "customer", text: "[画像] 【物件以外：ペットの写真】\n猫" }] })).toBe(false);
  expect(customerRequestedPropertyCheck({ recentMessages: [{ sender: "staff", text: "x" }, { sender: "customer", text: PORTAL_SHOT }] })).toBe(true);
});

// ── 赤帯の並び（約束は消さず「後で」に回す）──
const PROMISE_951 = { id: 951, event_type: "property_send", start_at: "2026-09-30T02:08:30.478Z", notes: "【必ず】物件ピックアップ送付【今日中】\n約束: 「引き続き新着でオススメできるお部屋ピックアップしお送りさせていただきます」" };
const CONFIRM = { id: 1, event_type: "follow_up", start_at: "2026-09-30T03:12:47Z", notes: "【必ず】ヴィレ堺湊102号室の審査の確認→ご連絡" };
const CUST_1245 = "2026-10-01T03:45:51.659Z";

it("和樹: ブレインが 物件確認した → 9/30 のピックアップの約束は後で（消えない）", () => {
  const r = splitPromisesForFreshInquiry([PROMISE_951, CONFIRM], { brainAction: "property_check_result", latestCustomerAt: CUST_1245 });
  expect(r.later.length).toBe(1);
  expect(r.later[0].id).toBe(951);
  expect(r.now.length).toBe(1);
  expect(r.now[0].id).toBe(1);
});
it("見積書送る でも同じ（お客様の物件の見積が先）", () => {
  expect(splitPromisesForFreshInquiry([PROMISE_951], { brainAction: "estimate_sheet", latestCustomerAt: CUST_1245 }).later.length).toBe(1);
});
it("ブレインが 物件ピックアップ・AIX なしの時は今のまま", () => {
  expect(splitPromisesForFreshInquiry([PROMISE_951], { brainAction: "property_send", latestCustomerAt: CUST_1245 }).now.length).toBe(1);
  expect(splitPromisesForFreshInquiry([PROMISE_951], { brainAction: null, latestCustomerAt: CUST_1245 }).now.length).toBe(1);
});
it("約束がお客様の発言より新しい時（確認の後にピックアップを約束した）は今のまま", () => {
  expect(splitPromisesForFreshInquiry([{ ...PROMISE_951, start_at: "2026-10-01T04:00:00Z" }], { brainAction: "property_check_result", latestCustomerAt: CUST_1245 }).now.length).toBe(1);
});
it("お客様の発言の時刻が無い時は今のまま", () => {
  expect(splitPromisesForFreshInquiry([PROMISE_951], { brainAction: "property_check_result", latestCustomerAt: null }).now.length).toBe(1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
