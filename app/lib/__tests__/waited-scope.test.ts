// 「お待たせ致しました」を許す場面（竹内さん判断・2026-09-20）。
//
// 竹内「AIX で送ったあとの AIX テンプレートの文の質を上げる」→ 差分を測ると、この語は
//   **場面によって正誤が正反対**だった。竹内さんの判断は「結果を届ける AIX では許す」。
//
// 実測（scripts/audit-omatase-aix.ts・直近60日・生成文と実送信が両方ある1,805件）
//   生成に出た時スタッフがどうしたか（残した / 消した / 足した）:
//     見積書送る                21 / 0  / 16   ← 足すのが最多
//     物件確認した（申込あり）   0 / 0  /  7
//     物件ピックアップ          66 / 6  /  6
//     新着物件                  39 / 1  /  3
//     物件確認した（空室あり）   22 / 3  /  6
//     条件を広げて再検索        17 / 1  /  2
//     ───────────────────────────
//     内覧日調整                 1 / 14 /  0   ← 消すのが圧倒的
//     通常返信（line_reply）     0 / 5  /  1
//
// 実行: npx tsx app/lib/__tests__/waited-scope.test.ts（全 PASS で exit 0）
import { isWaitedAllowed, WAITED_ALLOWED_ACTIONS } from "../waited-scope";
import { stripWaited, WAITED_RE } from "../greeting";

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
  };
}

describe("待たせた作業の結果を届ける場面 → 許す", () => {
  const ALLOW: Array<[string, string]> = [
    ["estimate_sheet", "見積書送る（残21/消0/足16）"],
    ["property_send", "物件ピックアップ（残66/消6/足6）"],
    ["property_send_new_arrival", "新着物件（残39/消1/足3）"],
    ["property_send_widen", "条件を広げて再検索（残17/消1/足2）"],
    ["property_check_result", "物件確認した"],
    ["property_check_result_available", "物件確認した・空室あり（残22/消3/足6）"],
    ["property_check_result_unavailable", "物件確認した・申込あり（残0/消0/足7）"],
    ["property_recommendation", "物件オススメ"],
    ["zenryoku_support", "全力サポート（残7/消1/足0）"],
  ];
  for (const [action, why] of ALLOW) {
    it(`W ${action} は許す — ${why}`, () => { expect(isWaitedAllowed(action)).toBe(true); });
  }
  it("★ W10 サブパターン付き（property_check_result_mgmt_move_in）も許す", () => {
    expect(isWaitedAllowed("property_check_result_mgmt_move_in")).toBe(true);
  });
});

describe("待たせていない場面 → 消す", () => {
  const DENY: Array<[string, string]> = [
    ["viewing_invite", "内覧日調整（残1/消14/足0）"],
    ["meeting_place", "待ち合わせ"],
    ["greeting_viewing", "内覧挨拶"],
    ["condition_hearing", "ヒアリング"],
    ["application_push", "申込へ！"],
    ["phone_call", "電話をかける"],
    ["followup_revive", "追客する"],
  ];
  for (const [action, why] of DENY) {
    it(`D ${action} は消す — ${why}`, () => { expect(isWaitedAllowed(action)).toBe(false); });
  }
  it("★ D8 未知の action は消す側に倒す（新しい AIX が黙って通さない）", () => {
    expect(isWaitedAllowed("brand_new_action")).toBe(false);
    expect(isWaitedAllowed("")).toBe(false);
    expect(isWaitedAllowed(null)).toBe(false);
    expect(isWaitedAllowed(undefined)).toBe(false);
  });
});

describe("出口の掛け方（実物の文で確かめる）", () => {
  // 2026-09-20 の実送信（AIX 由来）
  const PICKUP = "じゅなさんお待たせ致しました！！\n\n大阪市内周辺全域からじゅなさんご希望の家賃管理費込み12万円以内・2LDK以上のお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";
  const ESTIMATE = "Hさんお待たせ致しました！！\nハイツカトレアB号室とハイムM&K 306号室の御見積書をお送りさせて頂きます😊！！\nお手隙の際にご査収ください😌！！";

  it("★ E1 物件ピックアップでは消さない（実送信の形がそのまま残る）", () => {
    const out = isWaitedAllowed("property_send") ? PICKUP : stripWaited(PICKUP).text;
    expect(WAITED_RE.test(out)).toBe(true);
    expect(out).toContain("ピックアップさせて頂きました");
  });

  it("★ E2 見積書送るでは消さない", () => {
    const out = isWaitedAllowed("estimate_sheet") ? ESTIMATE : stripWaited(ESTIMATE).text;
    expect(WAITED_RE.test(out)).toBe(true);
  });

  it("★ E3 内覧日調整では消す（本文は残る）", () => {
    const text = "Rさんお待たせ致しました！！\nご内覧可否確認させて頂きます！！";
    const out = isWaitedAllowed("viewing_invite") ? text : stripWaited(text).text;
    expect(WAITED_RE.test(out)).toBe(false);
    expect(out).toContain("ご内覧可否確認させて頂きます");
  });

  it("E4 消す側でも本文は1文字も欠けない（誤削除0）", () => {
    const text = "お待たせ致しました！！\n日本橋・谷九・難波周辺全域から築浅・ペット可のご条件でオススメできる1LDKのお部屋ピックアップさせて頂きました😊！！";
    const out = stripWaited(text).text;
    expect(out).toContain("日本橋・谷九・難波周辺全域から築浅・ペット可のご条件でオススメできる1LDKのお部屋ピックアップさせて頂きました");
  });
});

describe("定数の自己整合", () => {
  it("C1 許す一覧に内覧日調整・通常返信系を入れていない", () => {
    for (const ng of ["viewing_invite", "meeting_place", "greeting_viewing", "condition_hearing"]) {
      expect(WAITED_ALLOWED_ACTIONS.has(ng)).toBe(false);
    }
  });
  it("C2 許す一覧は空でない（配線の事故で全部消えていないこと）", () => {
    expect(WAITED_ALLOWED_ACTIONS.size >= 10).toBe(true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
