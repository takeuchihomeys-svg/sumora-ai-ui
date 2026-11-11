// 今の番にお客様が送ってきた物件（URL・画像だけ）の物件名・号室（app/lib/turn-shared-property.ts・TURN_SHARED_PROPERTY_TARGET=on）のテスト
//
// 2026-11-11 作業員1（KB 決定 親 P0 ecd7b961・対象の一致 12/30）。お客様の発言は実物（試験の q119・q185・q199 の会話の発言・
//   画像は受け取った時点の書き起こし＝物件の値だけ。個人の値は無い）。URL の番号は実物の形のまま（物件の掲載の番号）。
// 実行: npx tsx app/lib/__tests__/turn-shared-property.test.ts
import { customerTurnOf, knownRoomOf, sharedPropertyOfTurn, fingerprintKnownRoom, turnDocTargetWithShared, sharedTargetMaterialLine, turnSharedPropertyTargetOn, type TsMsg, type KnownRoom } from "../turn-shared-property";
import type { PortalPage } from "../portal-page-read";
import type { ThreadLite } from "../brain-material-wiring";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const cust = (text: string, at: string, image_type: string | null = null): TsMsg => ({ sender: "customer", text, image_type, created_at: at });
const staff = (text: string, at: string): TsMsg => ({ sender: "staff", text, created_at: at });

// q199 の実物（SUUMO の画面・物件名の無い掲載）
const Q199_IMG = "[画像] 【物件の画面（ポータル）】\n14:53\nSUUMO\nアプリならプッシュ通知で新着物件を見逃さない！\n\n寝屋川市 2LDK 2階(2LDK/2階/60.61㎡)の賃貸住宅情報\n\n1/20\n\n9.9万円／管理費 7000円\n敷 - 礼 18万円\n\n間取り：2LDK\n築年数：築4年\n階建：2階/3階建\n\n広さ：60.61㎡\n築年月：2023年9月月\n向き：西\n\n入居：'26年11月中旬";
// q119 の実物（SUUMO の画面・物件名あり）
const Q119_IMG = "[画像] エスリード難波ザ・ブライト 5階\n\n6.39万円/管理費 5600円\n数 - 礼 6.95万円\n\n間取り：1K\n広さ：21.51㎡\n\n築年数：築3年\n築年月：2024年3月\n\nお問い合わせ\n内見予約（3人が問い合わせ）\n最新の空室状況を知りたい";
// こちらが送った資料（グラン寝屋川 101）をお客様が送り直した書き起こしの形
const GRAN_DOC_IMG = "[画像] 【物件の資料】\n物件名 グラン寝屋川\n号室名 101（1階部分）\n専有面積 30.38㎡\n賃料 68,000 円";
const page = (url: string, p: Partial<PortalPage>): PortalPage => ({ url, site: "suumo", status: "ok", name: null, floor: null, rentYen: null, adminYen: null, madori: null, areaSqm: null, station: null, walk: null, address: null, ...p });

const GRAN: KnownRoom = { name: "グラン寝屋川", roomNo: "101", areaSqm: 30.38, madori: "1LDK", rentYen: 68000 };

describe("既定 off", () => {
  it("TURN_SHARED_PROPERTY_TARGET が無ければ off", () => { eq(turnSharedPropertyTargetOn({}), false); eq(turnSharedPropertyTargetOn({ TURN_SHARED_PROPERTY_TARGET: "on" }), true); });
});

describe("今の番の切り出し・こちらの送った部屋の値", () => {
  it("最後のスタッフの発言より後のお客様の発言だけ", () => {
    const t = customerTurnOf([cust("前の話", "2026-08-26T07:59:57Z"), staff("かしこまりました！！", "2026-08-26T08:05:19Z"), cust("フォーリアライズ京橋 4階\nhttps://suumo.jp/chintai/bc_100520738857/\nby SUUMO", "2026-08-26T08:42:10Z"), cust("ここみてもらってもいいですか", "2026-08-26T08:42:20Z")]);
    eq(t.length, 2);
  });
  it("sent_image_properties.facts（実物の形）から ㎡・間取り・家賃", () => {
    eq(knownRoomOf({ property_name: "グラン寝屋川", room_no: "101", facts: { rent: 68000, area_sqm: 30.38, floor_plan: "1LDK", room_no: "101" } }), GRAN);
    eq(knownRoomOf({ property_name: null, room_no: null, facts: {} }), null);
  });
});

describe("画像・共有文に物件名がある", () => {
  it("q119: 画像の書き起こしの物件名", () => {
    const r = sharedPropertyOfTurn({ turn: [cust(Q119_IMG, "2026-09-06T12:59:19Z", "property_photo")] });
    eq(r.reason, "ok"); eq(r.target?.name, "エスリード難波ザ・ブライト"); eq(r.target?.by, "image_name"); eq(r.target?.roomNo, null);
  });
  it("こちらの資料の送り直し: 物件名と号室", () => {
    const r = sharedPropertyOfTurn({ turn: [cust(GRAN_DOC_IMG, "2026-11-04T02:50:00Z", "property_material")], known: [GRAN] });
    eq([r.target?.name, r.target?.roomNo, r.target?.by], ["グラン寝屋川", "101", "image_name"]);
  });
  it("q185: 共有文の物件名（号室の無い掲載・こちらが送った同じ建物の部屋が1つなら号室を埋める）", () => {
    const turn = [cust("フォーリアライズ京橋 4階\nhttps://suumo.jp/chintai/bc_100520738857/\nby SUUMO", "2026-08-26T08:42:10Z"), cust("ここみてもらってもいいですか", "2026-08-26T08:42:20Z")];
    const r0 = sharedPropertyOfTurn({ turn });
    eq([r0.target?.name, r0.target?.roomNo, r0.target?.by], ["フォーリアライズ京橋", null, "share_text"]);
    const r1 = sharedPropertyOfTurn({ turn, known: [{ name: "フォーリアライズ京橋", roomNo: "402", areaSqm: 25.2, madori: "1K", rentYen: 70000 }] });
    eq(r1.target?.roomNo, "402");
  });
});

describe("URL だけ（共有文に名前が無い）", () => {
  const URL1 = "https://suumo.jp/chintai/bc_100520738857/";
  it("ページを読んでいなければ決めない", () => {
    eq(sharedPropertyOfTurn({ turn: [cust(URL1, "2026-08-26T08:42:10Z")] }).reason, "unresolved");
  });
  it("SUUMO のページの物件名", () => {
    const pages = new Map([[URL1, page(URL1, { name: "フォーリアライズ京橋", areaSqm: 25.2, madori: "1K", rentYen: 70000 })]]);
    const r = sharedPropertyOfTurn({ turn: [cust(URL1, "2026-08-26T08:42:10Z")], pages });
    eq([r.target?.name, r.target?.by], ["フォーリアライズ京橋", "portal_page"]);
  });
  it("掲載終了（404）のページは名前にしない", () => {
    const pages = new Map([[URL1, page(URL1, { status: "expired" })]]);
    eq(sharedPropertyOfTurn({ turn: [cust(URL1, "2026-08-26T08:42:10Z")], pages }).target, null);
  });
  it("名前の無い掲載のページの値がこちらの送った部屋と同じ → 指紋で当てる", () => {
    const pages = new Map([[URL1, page(URL1, { areaSqm: 30.38, madori: "1LDK", rentYen: 68000 })]]);
    const r = sharedPropertyOfTurn({ turn: [cust(URL1, "2026-11-04T02:50:00Z")], pages, known: [GRAN] });
    eq([r.target?.name, r.target?.roomNo, r.target?.by], ["グラン寝屋川", "101", "fingerprint"]);
  });
});

describe("名前の無い画像（q199）の指紋", () => {
  it("こちらの送った部屋に無ければ決めない", () => {
    eq(sharedPropertyOfTurn({ turn: [cust(Q199_IMG, "2026-10-20T06:07:29Z", "property_photo")], known: [GRAN] }).reason, "unresolved");
  });
  it("㎡（細かい数）・間取り・家賃が同じ部屋が1つ → 当てる", () => {
    const k: KnownRoom = { name: "サンプル寝屋川", roomNo: "201", areaSqm: 60.61, madori: "2LDK", rentYen: 99000 };
    const r = sharedPropertyOfTurn({ turn: [cust(Q199_IMG, "2026-10-20T06:07:29Z", "property_photo")], known: [GRAN, k] });
    eq([r.target?.name, r.target?.roomNo, r.target?.by], ["サンプル寝屋川", "201", "fingerprint"]);
  });
  it("丸い数の面積（25㎡）は間取りだけでは当てない・間取りと家賃の両方なら当てる", () => {
    const k: KnownRoom = { name: "サンプル", roomNo: "301", areaSqm: 25, madori: "1K", rentYen: 65000 };
    eq(fingerprintKnownRoom({ areaSqm: 25, madori: "1K", rentYen: null }, [k]), null);
    eq(fingerprintKnownRoom({ areaSqm: 25, madori: "1K", rentYen: 65000 }, [k])?.roomNo, "301");
  });
  it("間取りか家賃が食い違えば当てない", () => {
    eq(fingerprintKnownRoom({ areaSqm: 30.38, madori: "1K", rentYen: 68000 }, [GRAN]), null);
    eq(fingerprintKnownRoom({ areaSqm: 30.38, madori: "1LDK", rentYen: 75000 }, [GRAN]), null);
  });
  it("同じ値の部屋が別の建物に2つ → 決めない／同じ部屋の記録の重なりは1つ", () => {
    const a: KnownRoom = { name: "A棟", roomNo: "101", areaSqm: 30.38, madori: "1LDK", rentYen: 68000 };
    eq(fingerprintKnownRoom({ areaSqm: 30.38, madori: "1LDK", rentYen: 68000 }, [GRAN, a]), null);
    eq(fingerprintKnownRoom({ areaSqm: 30.38, madori: "1LDK", rentYen: 68000 }, [GRAN, { ...GRAN, madori: null }])?.roomNo, "101");
  });
});

describe("複数・個人情報", () => {
  it("違う物件が2つ（q199 の連投＋名前のある画像）→ 決めない", () => {
    const k: KnownRoom = { name: "サンプル寝屋川", roomNo: "201", areaSqm: 60.61, madori: "2LDK", rentYen: 99000 };
    const r = sharedPropertyOfTurn({ turn: [cust(Q199_IMG, "2026-10-20T06:07:29Z", "property_photo"), cust(Q119_IMG, "2026-10-20T06:07:31Z", "property_photo")], known: [k] });
    eq([r.reason, r.target], ["multiple", null]);
  });
  it("同じ物件の画像を2枚（号室なし・号室あり）→ 1件（号室あり）", () => {
    const r = sharedPropertyOfTurn({ turn: [cust("[画像] 【物件の資料】\n物件名 グラン寝屋川\n専有面積 31.5㎡", "2026-11-04T02:49:00Z", "property_material"), cust(GRAN_DOC_IMG, "2026-11-04T02:50:00Z", "property_material")] });
    eq([r.reason, r.target?.roomNo], ["ok", "101"]);
  });
  it("本人確認書類の画像は見ない（種類だけの行）", () => {
    eq(sharedPropertyOfTurn({ turn: [cust("[画像] 本人確認書類", "2026-11-04T02:50:00Z", "id_document")], known: [GRAN] }).reason, "none");
  });
  it("文字だけの番は none", () => {
    eq(sharedPropertyOfTurn({ turn: [cust("ありがとうございます！", "2026-11-04T02:50:00Z")] }).reason, "none");
  });
});

describe("今の番の物件の決め方（threadDocTarget の前段）", () => {
  const pt = (o: Partial<ThreadLite>): ThreadLite => ({ rooms: [{ key: "a#101", ref: { building: "アパートA", room: "101" } }], turnTargets: [], turnReferent: null, ...o });
  const shared = { name: "フォーリアライズ京橋", roomNo: null, by: "portal_page" as const, evidence: "x" };
  it("引用・名指しの物件（台帳の turnTargets）が先", () => {
    eq(turnDocTargetWithShared(pt({ turnTargets: [{ roomKey: "a#101" }] }), shared)?.name, "アパートA");
  });
  it("主語の抜けた番の推定（直前に送った1件）より、今送ってきた物件が先", () => {
    eq(turnDocTargetWithShared(pt({ turnReferent: { kind: "one", roomKey: "a#101" } }), shared)?.name, "フォーリアライズ京橋");
  });
  it("送ってきた物件が決まらなければ今まで通り", () => {
    eq(turnDocTargetWithShared(pt({ turnReferent: { kind: "one", roomKey: "a#101" } }), null)?.name, "アパートA");
    eq(turnDocTargetWithShared(null, null), null);
  });
  it("材料の1行（返信か AIX かは書かない）", () => {
    const l = sharedTargetMaterialLine({ name: "グラン寝屋川", roomNo: "101", by: "fingerprint", evidence: "名前の無い URL の値（1LDK・30.38㎡・6.8万円）がこちらが送った部屋と同じ" });
    ok(/グラン寝屋川 101号室/.test(l) && !/AIX/.test(l), l);
    eq(sharedTargetMaterialLine(null), "");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
