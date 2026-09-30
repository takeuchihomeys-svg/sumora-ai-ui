// 2026-09-30 竹内「管理会社の名前は『確認した』から送るようにする。物件確認したじゃなくて。物件確認したと確認したがごっちゃになっている」
//   「物件確認した（募集状況）」と「確認した（条件・交渉）」の分かれ目（場面の証拠 → check_pattern → 帯・カード・AIX要対応の表記）。
//   文は本番の実物（365日・scripts/audit-check-button-split.ts で読んだ物）をそのまま使う。
// 実行: npx tsx app/lib/__tests__/check-button-split.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { MGMT_COMPANY_Q_RE } from "../scene-patterns";
import { detectAixSceneEvidence, customerRequestedPropertyCheck } from "../aix-scene-evidence";
import { resolveBrainCheckPattern, sceneSignalFallback } from "../brain-aix-feedback";
import { buildAixLineNote, buildAixStaffNote, detectPropertyCheckPattern, propertyCheckKindFor } from "../aix-taxonomy";
import { aixButtonText } from "../aix-action-text";
import { brainAixButtonLabel } from "../aix-button-view";
import { resolveBodySafety, sceneSafetyRow } from "../aix-reply-set";
import { checkPatternTopic, pickerOptionLabel } from "../aix-pickers";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const MIKOTO = "3日はおやすみですよね💦\nそれと審査の件ですがこの物件の管理会社はどこですか？？";
const ev = (text: string, o: { img?: boolean; sent?: number } = {}) => detectAixSceneEvidence({ latestCustomerTurn: text, hasCustomerImage: !!o.img, sentPropertyCount: o.sent ?? 0 });
const kind = (text: string, o: { img?: boolean; sent?: number } = {}) => resolveBrainCheckPattern("property_check_result", ev(text, o), null, text, { hasImage: !!o.img });

describe("管理会社そのものの質問（MGMT_COMPANY_Q_RE・実物）", () => {
  const HIT = [
    "それと審査の件ですがこの物件の管理会社はどこですか？？",          // 09-30 8a77820b（みこと）
    "こちらの管理会社ってどこになりますか？",                            // 07-23 d3245ba7
    "なるほどです🤔\nちなみにこの物件の管理会社ってどちらですか？？",    // 09-11 62d01e33
    "お疲れ様です！管理会社の連絡先おしえてほしいです！",                // 05-26 bad8b9a4
    "後管理会社の電話番号を教えて欲しいです。",                          // 09-09 d3245ba7
    "管理会社様のお電話番号教えていただいてもよろしいでしょうか",        // 09-10 f5afb8c2
    "それぞれの管理会社と保証会社お教えいただけますでしょうか？",        // 06-15 e68fd1e2
  ];
  const MISS = [
    "電子契約について連絡したのですが、最後の確定ボタンが押せないようで、問い合わせ先は管理会社になりますでしょうか？", // 07-21
    "直接管理会社に連絡したら良いですか？？",                                                                       // 08-09
    "ちなみに管理会社さんに私から直接連絡とかって難しいですか？😅",                                                 // 06-19
    "日付指定されており別用紙再度用意して欲しいと管理会社に伝えて貰えますか",                                       // 09-25
    "管理会社から連絡ありました！",                                                                                 // 06-01
    "また、本物件でペットを飼育する際 管理会社の方に連絡等必要でしょうか？",                                        // 05-23
    "水道は管理会社に払うタイプか 直接かどうかも確認お願いします",                                                  // 09-03
    "先に管理会社に審査通してって感じですか？",                                                                     // 09-11
    "管理会社が連絡とれないって中々 異常だと思うんです。",                                                          // 08-11
    "なくなった場合や忘れた場合は管理会社に連絡して対応してもらうってことになるんですか？",                         // 09-15
  ];
  for (const t of HIT) it(`拾う: ${t.slice(0, 28)}`, () => expect(MGMT_COMPANY_Q_RE.test(t)).toBe(true));
  for (const t of MISS) it(`拾わない: ${t.slice(0, 28)}`, () => expect(MGMT_COMPANY_Q_RE.test(t)).toBe(false));
});

describe("場面の証拠: 管理会社そのものは S1 募集状況にしない", () => {
  it("★ みこと 9/30「この物件の管理会社はどこですか？？」→ mgmt_company_question（確認した（条件・交渉）→管理会社）", () => {
    const e = ev(MIKOTO, { sent: 3 });
    expect(e?.reasonCode).toBe("mgmt_company_question");
    expect(e?.candidateAction).toBe("property_check_result");
    expect(e?.checkPattern).toBe("mgmt_company");
  });
  it("物件の語が無くても、こちらが送った物件があれば（07-23「こちらの管理会社ってどこになりますか？」）", () => {
    expect(ev("こちらの管理会社ってどこになりますか？", { sent: 2 })?.reasonCode).toBe("mgmt_company_question");
  });
  it("物件が1件も無く指してもいない → 証拠なし", () => {
    expect(ev("管理会社の電話番号を教えて欲しいです。")).toBe(null);
  });
  it("同じ連投で物件を持ち込んだ（URL）→ S1（募集状況の確認が先）", () => {
    expect(ev("https://suumo.jp/chintai/xx/ この物件の管理会社はどこですか？")?.scene).toBe("S1_vacancy");
  });
  it("空きも同じ連投で聞いた → S1 のまま（物件確認したの報告に答えを添える）", () => {
    expect(ev("この物件まだ空いてますか？管理会社はどこですか？", { sent: 1 })?.scene).toBe("S1_vacancy");
  });
  it("場面の信号（LLM が AIX なしで他の信号も無い時）→ 物件確認した（語彙）＋ mgmt_company", () => {
    const s = sceneSignalFallback(ev(MIKOTO, { sent: 3 }));
    expect(s?.action).toBe("property_check_result"); expect(s?.checkPattern).toBe("mgmt_company");
  });
  it("空き・入居日・保証会社・室内写真の場面は今まで通り", () => {
    expect(ev("さっきのお部屋まだ空いてますか？", { sent: 3 })?.scene).toBe("S1_vacancy");
    expect(ev("この物件いつから入居できますか？")?.checkPattern).toBe("mgmt_move_in");
    expect(ev("この物件の保証会社はどこですか？")?.reasonCode).toBe("guarantor_question");
    expect(ev("室内の写真ありますか？", { sent: 2 })?.checkPattern).toBe("interior_photo");
  });
  it("物件確認のタスクの判定（お客様から確認の依頼があったか）は変えない", () => {
    expect(customerRequestedPropertyCheck({ recentMessages: [{ sender: "staff", text: "https://x.example/1 お部屋です" }, { sender: "customer", text: MIKOTO }] })).toBe(true);
  });
});

describe("分かれ目（resolveBrainCheckPattern）: 質問の中身でボタンを決める", () => {
  it("★ 管理会社はどこ → 確認した（条件・交渉）・mgmt_company", () => {
    const k = kind(MIKOTO, { sent: 3 });
    expect(k?.ui_button).toBe("確認した（条件・交渉）"); expect(k?.check_pattern).toBe("mgmt_company");
    expect(/AIX【確認した（条件・交渉）】/.test(k?.note ?? "")).toBe(true);
    expect(/物件確認した（募集状況）/.test(k?.note ?? "")).toBe(false);
  });
  it("場面の証拠が無くても語で決まる（管理会社の連絡先）", () => {
    expect(resolveBrainCheckPattern("property_check_result", null, null, "管理会社の連絡先おしえてほしいです！")?.check_pattern).toBe("mgmt_company");
  });
  it("管理会社と保証会社を一緒に聞いた → 管理会社を先に（06-15）", () => {
    expect(detectPropertyCheckPattern("それぞれの管理会社と保証会社お教えいただけますでしょうか？")?.check_pattern).toBe("mgmt_company");
  });
  it("空いてますか → 物件確認した（募集状況）とはっきり書く（check_pattern は空＝結果はスタッフが選ぶ）", () => {
    const k = kind("ここまだありますか？", { sent: 1 });                       // 09-14 1191b1eb → 押した: available
    expect(k?.ui_button).toBe("物件確認した（募集状況）"); expect(k?.check_pattern).toBe("");
    expect(kind("さっきのお部屋まだ空いてますか？", { sent: 3 })?.ui_button).toBe("物件確認した（募集状況）");
    expect(kind("まだ募集してますか？", { sent: 1 })?.ui_button).toBe("物件確認した（募集状況）");
  });
  it("持ち込み（URL だけ・画像だけ）→ 物件確認した（募集状況）", () => {
    expect(kind("https://suumo.jp/chintai/xx/")?.ui_button).toBe("物件確認した（募集状況）");
    expect(kind("", { img: true })?.ui_button).toBe("物件確認した（募集状況）");
  });
  it("入居日・設備・ペット・駐車場・保証会社・交渉 → 確認した（条件・交渉）", () => {
    expect(kind("この物件いつから入居できますか？")?.check_pattern).toBe("mgmt_move_in");
    expect(kind("こっちはインターネット無料ですか?", { sent: 1 })?.check_pattern).toBe("mgmt_equipment");   // 07-03 cdf07418
    expect(kind("この物件はペット可でしょうか?")?.check_pattern).toBe("mgmt_pet");                          // 07-05 0133b787
    expect(kind("駐車場はいくらですか?", { sent: 1 })?.check_pattern).toBe("mgmt_parking");                  // 06-05 583171e6
    expect(kind("礼金の交渉はできますか？", { sent: 1 })?.check_pattern).toBe("mgmt_initial_cost");
    for (const cp of ["mgmt_move_in", "mgmt_equipment", "mgmt_pet", "mgmt_parking", "mgmt_initial_cost", "mgmt_guarantor", "mgmt_proxy", "nearby_parking", "vacate_date", "mgmt_company"]) {
      expect(propertyCheckKindFor(cp)?.ui_button).toBe("確認した（条件・交渉）");
    }
  });
  it("「この物件…ですか」の形だけ（空きの語も条件の語も無い）→ 決めない（どちらとも書かない）", () => {
    const t = "この物件は、部屋に壁の色などが違うのでしょうか？";                 // 06-09 5e32a1bb（場面の証拠は S1 availability_question）
    expect(ev(t)?.reasonCode).toBe("availability_question");
    expect(kind(t)).toBe(null);
    expect(kind("宜しくお願い致します！", { sent: 1 })).toBe(null);
  });
  it("内覧の枠の「空いて」は空きの質問にしない", () => {
    expect(resolveBrainCheckPattern("property_check_result", null, null, "明日ってまだ空いてますか")).toBe(null);
  });
  it("物件でない画像（場面の証拠が S1 でない）だけでは募集状況と書かない", () => {
    expect(resolveBrainCheckPattern("property_check_result", null, null, "給料明細なのですが、転職したてで1ヶ月分しかないんです。", { hasImage: true })).toBe(null);
  });
});

describe("表記（帯・カード・AIX要対応・本文の安全）が同じボタンを指す", () => {
  it("カード: 条件側は「AIX 確認した（条件・交渉）」・募集状況／室内写真／未定は「AIX 物件確認した」", () => {
    expect(brainAixButtonLabel("property_check_result", "mgmt_company")).toBe("AIX 確認した（条件・交渉）");
    expect(brainAixButtonLabel("property_check_result", "mgmt_move_in")).toBe("AIX 確認した（条件・交渉）");
    expect(brainAixButtonLabel("property_check_result", null)).toBe("AIX 物件確認した");
    expect(brainAixButtonLabel("property_check_result", "interior_photo")).toBe("AIX 物件確認した");
    expect(brainAixButtonLabel("estimate_sheet", null)).toBe("AIX 見積書送る");
    expect(brainAixButtonLabel("unknown_action", null)).toBe(undefined);
  });
  it("AIX要対応（売上番長グループ）: 管理会社は「確認した（条件・交渉）→管理会社について」", () => {
    expect(aixButtonText("property_check_result", "mgmt_company")).toBe("AIX【確認した（条件・交渉）→管理会社について】");
    expect(aixButtonText("property_check_result", null)).toBe("AIX【物件確認した（募集状況）】");
    expect(buildAixLineNote("property_check_result", "mgmt_company")).toBe("回答を AIX【確認した（条件・交渉）】で送る（管理会社（名前・連絡先））");
  });
  it("帯: 管理会社は確認した側の文・空きは物件確認した側の文・決まらない時は2つの区別の文", () => {
    expect(/AIX【確認した（条件・交渉）】を押してください: 管理会社/.test(buildAixStaffNote("property_check_result", kind(MIKOTO, { sent: 3 })))).toBe(true);
    expect(/^AIX【物件確認した（募集状況）】を押してください/.test(buildAixStaffNote("property_check_result", kind("まだ空いてますか？", { sent: 1 })))).toBe(true);
    const generic = buildAixStaffNote("property_check_result", null);
    expect(/2つは別のボタン/.test(generic) && /管理会社の名前や連絡先/.test(generic)).toBe(true);
  });
  it("本文の安全: 管理会社名を本文で言い切らない・保証会社の橋渡し文を使わない", () => {
    const o = { latestCustomerTurn: MIKOTO, hasCustomerImage: false, sentPropertyCount: 3 };
    const row = sceneSafetyRow("property_check_result", "mgmt_company", o, detectAixSceneEvidence(o));
    expect(row.label).toBe("確認した（条件・交渉）→管理会社について");
    expect(row.bridge).toBe(null);
    expect(/管理会社の名前・連絡先・電話番号をテキストで書くこと/.test(row.forbiddenText)).toBe(true);
    const s = resolveBodySafety(detectAixSceneEvidence(o), o);
    expect(/保証会社の情報確認/.test(JSON.stringify(s))).toBe(false);
  });
  it("ピッカーの一覧・話題（監査の単位）", () => {
    expect(pickerOptionLabel("property_check_result", "check_pattern", "mgmt_company")).toBe("管理会社について");
    expect(checkPatternTopic("mgmt_company")).toBe("condition");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
