// 「お待たせ致しました」— 2026-09-27 竹内さん決定: **AIX でも使わない**（9/20 の「結果を届ける AIX では許す」を上書き）。
//
// 経緯: 9/20 に実測（scripts/audit-omatase-aix.ts・60日・1,805件）で「結果を届ける AIX では許す」にした。
//   9/27 の YUMA 実送信で AIX【物件ピックアップした】が「YUMAさんお待たせ致しました！！」で始まり
//   （本番の AIX の物件送付でも直近7日で17通）、竹内さんは AIX でも使わないと決めた（自動返信化の方針）。
//
// 出口（replaceWaitedOpening）は AIX の実送信712通（お待たせを含む全部）×（挨拶あり・本日挨拶済み）で
//   「お待たせ」以外の文字の削除 0・残り 0 を確かめた（旧 stripWaited は名前の呼びかけまで消していた＝920/1424）。
//
// 実行: npx tsx app/lib/__tests__/waited-scope.test.ts（全 PASS で exit 0）
import { isWaitedAllowed, WAITED_ALLOWED_ACTIONS, replaceWaitedOpening, neutralizeWaitedInExample, buildWaitedOpeningChoice, buildWaitedNote, waitedSentRate, waitedGapAllowed, isWaitedAllowedForAix, lastExchangeAt, WAITED_GAP_MS } from "../waited-scope";
import { WAITED_RE } from "../greeting";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    notToContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); },
  };
}

describe("2026-09-27: AIX の全種類で許さない", () => {
  const ALL = [
    "property_send", "property_send_new_arrival", "property_send_widen", "estimate_sheet",
    "property_check_result", "property_check_result_available", "property_check_result_unavailable",
    "property_check_result_alternative", "property_check_result_mgmt_move_in", "zenryoku_support",
    "property_recommendation", "acknowledge_check", "viewing_invite", "meeting_place", "application_push",
  ];
  for (const a of ALL) it(`★ ${a} は許さない`, () => { expect(isWaitedAllowed(a)).toBe(false); });
  it("★ 許す一覧は空", () => { expect(WAITED_ALLOWED_ACTIONS.size).toBe(0); });
  it("未知・空も許さない", () => {
    expect(isWaitedAllowed("brand_new_action")).toBe(false);
    expect(isWaitedAllowed("")).toBe(false);
    expect(isWaitedAllowed(null)).toBe(false);
  });
  it("★ 入口の2択・率の材料は出ない（プロンプトに『お待たせ』を書かせる道が無い）", () => {
    for (const a of ["property_send", "estimate_sheet", "property_check_result_available", "zenryoku_support"]) {
      expect(buildWaitedOpeningChoice(a, "お世話になっております！！", true)).toBe("");
      expect(buildWaitedNote(a)).toBe("");
      expect(waitedSentRate(a)).toBe(null);
    }
  });
});

describe("出口 replaceWaitedOpening（実物の本文）", () => {
  const G = "お世話になっております！！";
  // 9/27 YUMA の実送信（AIX【物件ピックアップした】）の形
  const YUMA = "YUMAさんお待たせ致しました！！\n\n大阪市西区・浪速区周辺から1LDK・家賃8万円程でYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";
  it("★ R1 挨拶がまだの日は「[名]さんお世話になっております！！」に差し替える（名前を消さない）", () => {
    const r = replaceWaitedOpening(YUMA, G);
    expect(r.replaced).toBe(1);
    expect(r.text.startsWith("YUMAさんお世話になっております！！\n")).toBe(true);
    expect(r.text).toContain("オススメできるお部屋ピックアップさせて頂きました😊！！");
    expect(WAITED_RE.test(r.text)).toBe(false);
  });
  it("★ R2 本日挨拶済み（挨拶が空）は「お待たせ致しました」だけ落として名前行を残す", () => {
    const r = replaceWaitedOpening(YUMA, "");
    expect(r.text.startsWith("YUMAさん\n")).toBe(true);
    expect(r.text).notToContain("お世話になっております");
    expect(WAITED_RE.test(r.text)).toBe(false);
  });
  it("★ R3 名前行の次の行の「お待たせいたしました！！」は名前行に挨拶をつなぐ（実送信の形）", () => {
    const t = "愛乃さん\nお待たせいたしました！！\n\n本町駅～大国町駅周辺エリアから家賃6〜8万円・1Kのお部屋ピックアップさせて頂きました！！";
    const r = replaceWaitedOpening(t, G);
    expect(r.text.startsWith("愛乃さんお世話になっております！！\n")).toBe(true);
    expect(r.text).toContain("本町駅～大国町駅周辺エリアから家賃6〜8万円・1Kのお部屋ピックアップさせて頂きました！！");
  });
  it("★ R4 既に「お世話になっております」がある通は、お待たせの行だけ落とす（挨拶を重ねない）", () => {
    const t = "お客様お世話になっております！！\nお待たせ致しました！！\nお送り頂いたS-RESIDENCE堺筋本町Deux 909号室の御見積書となります！！";
    const r = replaceWaitedOpening(t, G);
    expect(r.text).toBe("お客様お世話になっております！！\nお送り頂いたS-RESIDENCE堺筋本町Deux 909号室の御見積書となります！！");
  });
  it("★ R5 同じ行に続く本題は1文字も触らない", () => {
    const t = "ゆーたさん\nお待たせ致しました！！ご希望の3部屋を最大限割引させていただいた御見積書お送りさせていただきます😊！！";
    const r = replaceWaitedOpening(t, "");
    expect(r.text).toBe("ゆーたさん\nご希望の3部屋を最大限割引させていただいた御見積書お送りさせていただきます😊！！");
  });
  it("★ R6 見積書の表の後ろにある挨拶行も直す（表は触らない）", () => {
    const t = "【メイウール木川中里 413号室】\n\n初期費用：324,500円\n\n※ご入居日によって日割家賃が発生致します。\nmasayaさんお待たせ致しました！！\n\nメイワール木川中里413号室の初期費用を最大限割引させて頂いた御見積書をお送りさせて頂きます😊！！";
    const r = replaceWaitedOpening(t, G);
    expect(r.text).toContain("【メイウール木川中里 413号室】\n\n初期費用：324,500円\n\n※ご入居日によって日割家賃が発生致します。\nmasayaさんお世話になっております！！");
    expect(WAITED_RE.test(r.text)).toBe(false);
  });
  it("R7 さんの無い表示名・「、」・大変・絵文字の形も取る", () => {
    expect(replaceWaitedOpening("iお待たせ致しました！！\n本文です", G).text).toBe("iお世話になっております！！\n本文です");
    expect(replaceWaitedOpening("ニアさん、お待たせ致しました！！\n本文です", "").text).toBe("ニアさん\n本文です");
    expect(replaceWaitedOpening("大変お待たせ致しました！！2物件それぞれの初期費用御見積書となります😊！！", "").text).toBe("2物件それぞれの初期費用御見積書となります😊！！");
    expect(replaceWaitedOpening("Kさんお待たせ致しました😌！！\n本文", "").text).toBe("Kさん\n本文");
  });
  it("R8 お待たせが無ければ何もしない（同じ文字列を返す）", () => {
    const t = "YUMAさんお世話になっております！！\n本文";
    const r = replaceWaitedOpening(t, G);
    expect(r.text).toBe(t);
    expect(r.replaced).toBe(0);
  });
  it("R9 夜の挨拶（夜分遅くに失礼致します）も同じく名前につなぐ", () => {
    expect(replaceWaitedOpening(YUMA, "夜分遅くに失礼致します！！").text.startsWith("YUMAさん夜分遅くに失礼致します！！\n")).toBe(true);
  });
});

describe("入口 neutralizeWaitedInExample（手本に見せない）", () => {
  it("★ N1 手本の「お待たせ致しました」を「お世話になっております」に置き換える", () => {
    expect(neutralizeWaitedInExample("じゅなさんお待たせ致しました！！\n本文")).toBe("じゅなさんお世話になっております！！\n本文");
  });
  it("★ N2 置き換えて挨拶が2つ並んだら1つに畳む", () => {
    expect(neutralizeWaitedInExample("お客様お世話になっております！！\nお待たせ致しました！！\n本文")).toBe("お客様お世話になっております！！\n本文");
  });
  it("N3 null・無い時はそのまま", () => {
    expect(neutralizeWaitedInExample(null)).toBe("");
    expect(neutralizeWaitedInExample("本文")).toBe("本文");
  });
});

// 2026-10-06 竹内さん決定「お待たせ致しました は前の文から3時間以上経過したとき。AIXからの文にでるだけで通常の返信にはださない」
it("前の発言から3時間ちょうど以上 → AIX で残す", () => { expect(waitedGapAllowed("2026-10-06T00:00:00Z", "2026-10-06T03:00:00Z")).toBe(true); expect(WAITED_GAP_MS).toBe(3 * 3600_000); });
it("2時間59分 → 消す", () => expect(waitedGapAllowed("2026-10-06T00:00:00Z", "2026-10-06T02:59:00Z")).toBe(false));
it("前の発言の時刻が読めない → 消す（今まで通り）", () => { expect(waitedGapAllowed(null, "2026-10-06T03:00:00Z")).toBe(false); expect(isWaitedAllowedForAix("property_send", null, "2026-10-06T03:00:00Z")).toBe(false); });
it("AIX: 場面は問わず3時間以上で残す・未満は消す", () => { expect(isWaitedAllowedForAix("property_send", "2026-10-06T00:00:00Z", "2026-10-06T04:00:00Z")).toBe(true); expect(isWaitedAllowedForAix("property_check_result", "2026-10-06T02:00:00Z", "2026-10-06T04:00:00Z")).toBe(false); });
it("一番新しい発言の時刻（rawCreatedAt・createdAt・created_at）", () => expect(lastExchangeAt([{ rawCreatedAt: "2026-10-06T01:00:00Z" }, { createdAt: "2026-10-06T02:00:00Z" }, { created_at: "2026-10-05T00:00:00Z" }])).toBe("2026-10-06T02:00:00Z"));
it("通常の返信の許す一覧は空のまま（返信では今まで通り禁止）", () => expect(WAITED_ALLOWED_ACTIONS.size).toBe(0));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
