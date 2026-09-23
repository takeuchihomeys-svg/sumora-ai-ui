// お客様が送ってきた物件が、こちらが前に送った物件と同じか（2026-09-22 竹内・𝓡さん事例）
// 実行: npx tsx app/lib/__tests__/own-property-match.test.ts（全 PASS で exit 0）
import { extractScreenshotProperty, matchOwnProperty, buildOwnPropertyNote, normalizeRoom, type SentProperty } from "../own-property-match";
import { resolveConfirmationContext } from "../confirmation-context";
import { isMisumoriContextAppropriate } from "../estimate-context";
import { detectAixSceneEvidence } from "../aix-scene-evidence";
import { VIEWING_INTENT_RE } from "../scene-patterns";
import { CUSTOMER_FOUND_PROPERTY_VOCAB } from "../example-premise";
import { normalizeSharedPropertyReference } from "../shared-property-ref";
import { CUSTOMER_ASKS_CONTINUOUS_PICKUP_RE, MSG_SEP, CUST_VIEWING_INTENT_RE, customerAsksMoreListings } from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (!String(actual).includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)}`); },
  };
}

// 実物（𝓡さん 9/22 00:44 のお客様のスクショの読み取り文）
const A = "[画像] ラクラス阿倍野元町 0507 6.4万円（省なし）(+共 8,000円)\n\n募集中 物探下見 入居可能時期：入力なし";
const B = "[画像] floor_plan\n\n物件種目：住居用 マンション\n物件名：エクセレンス新今宮\n号室：1202（12階部分）\n所在地：〒552-0002 大阪府大阪市";
const C = "[画像] エステムコート難波サウスプレイスVIリリアン 201 号室\n\n【所在地】\n大阪府大阪市浪速区日本橋3丁目15-5";
// こちらが送った物件（9/19・9/20 の記録）
const SENT: SentProperty[] = [
  { name: "ラクラス阿倍野元町", room: "0507", sentAt: "2026-09-19T10:50:00Z" },
  { name: "エステムコート四天王寺夕陽ヶ丘II", room: "11K", sentAt: "2026-09-19T10:50:00Z" },
  { name: "エスリードレジデンス大阪天王寺", room: "1006", sentAt: "2026-09-19T10:50:00Z" },
  { name: "SUMMIT（サミット）", room: "406", sentAt: "2026-09-20T12:51:00Z" },
];

// ── 2026-09-23 竹内「お客さんが送ってきた画像が、こちらから送った画像かどうかの判定」──────────
// 全件監査（180日 222通）で取り出せなかった**実物の本文**をそのまま使う。
const D = "[画像] 【物件種目】[住居用] マンション\n【物件名】スプランディッド本町グラン\n【号室名】1003（10階部分）\n【所在地】〒540-0017 大阪府大阪市中央区松屋町住吉4丁目3";
const E = "[画像] スモラ 2026/09/16 16:37＞\n物件種目 【住居用】アパート\n物件名 ジーメゾン石津町東プリシエ\n号室名 0102\n所在地 〒592-8335 大阪府堺市西区浜寺石津町東5丁7-40";
const F = "[画像] 名称 GOTTS大今里 502号室\n【物件情報】\n種別：マンション\n交通：\n- 地下鉄千日前線「今里」駅 徒歩2分";
const G = "[画像] 102号室 ～2号室タイプ/北向き～\n【賃貸バイツ】\n名称：Kanon神椿川 102号室\n賃料：78,000円";
const H = "[画像] 【ページ情報】\n- サイト: homes.co.jp - LIFULL HOME'S\n- 物件種別: 賃貸マンション\n- 物件名: ノルデンタワー天神橋アネックス（2階/1 LDK/41.26m²）\n- 賃料: 8.7万円/月";
const I = "[画像] フォーリアライズ難波リアン 10階\n【間取り図】\n- 洋6（6畳）\n【物件情報】\n- 賃料：6.45万円/管理費 10000円";

it("★★ D 見出しが【】・区切り無し「【物件名】〇〇／【号室名】1003（10階部分）」", () => {
  const r = extractScreenshotProperty(D);
  expect(r?.name).toBe("スプランディッド本町グラン"); expect(r?.room).toBe("1003");
});
it("★★ E 区切りが空白だけ「物件名 〇〇／号室名 0102」（物件種目は名前にしない）", () => {
  const r = extractScreenshotProperty(E);
  expect(r?.name).toBe("ジーメゾン石津町東プリシエ"); expect(r?.room).toBe("102");
});
it("★★ F 見出し「名称」＋値に号室「名称 GOTTS大今里 502号室」", () => {
  const r = extractScreenshotProperty(F);
  expect(r?.name).toBe("GOTTS大今里"); expect(r?.room).toBe("502");
});
it("★★ G「名称：Kanon神椿川 102号室」", () => {
  const r = extractScreenshotProperty(G);
  expect(r?.name).toBe("Kanon神椿川"); expect(r?.room).toBe("102");
});
it("★★ H 箇条書き＋括弧の付録「- 物件名: 〇〇（2階/1 LDK/41.26m²）」→ 括弧は外す", () => {
  const r = extractScreenshotProperty(H);
  expect(r?.name).toBe("ノルデンタワー天神橋アネックス"); expect(r?.room).toBe(null);
});
it("★★ I 号室が無く階だけ「フォーリアライズ難波リアン 10階」→ 号室は分からない（null）", () => {
  const r = extractScreenshotProperty(I);
  expect(r?.name).toBe("フォーリアライズ難波リアン"); expect(r?.room).toBe(null);
});
it("★ 名前が無い実物（間取り図の説明だけ）は取り出さない", () => {
  expect(extractScreenshotProperty("[画像] 【物件情報】\n間取り図と物件詳細情報が記載されたページ\n【間取り図エリア】\n左側：2つの間取り図が並んでいる")).toBe(null);
  expect(extractScreenshotProperty("[画像] 【物件情報】\n所在地：神奈川県横浜市\n構造：木造2階建\n建築年月日：平成30年8月")).toBe(null);
});
it("★ 物件種目の値（OCR の取り違え）を物件名にしない", () => {
  expect(extractScreenshotProperty("[画像] 【物件概要】\n物件種目：ハイム・MK\n所在地：大阪市中央区")).toBe(null);
});
it("★★ 空白の有無で建物を取り違えない（FORESTA VIII ↔ FORESTAVIII）", () => {
  const sent: SentProperty[] = [{ name: "FORESTAVIII", room: "302", sentAt: "2026-09-01T00:00:00Z" }];
  // 建物としては同じと分かる（号室が無いので「同じ部屋」とまでは言わない＝下のテスト）
  expect(matchOwnProperty({ name: "FORESTA VIII", room: null }, sent).kind).toBe("same_building");
  expect(matchOwnProperty({ name: "FORESTA VIII", room: "302" }, sent).kind).toBe("same_room");
});
it("★★ お客様の側に号室が無い時は「同じ部屋」と言い切らない（実物 フォーリアライズ難波リアン 10階）", () => {
  // 実物: こちらが送った建物だが、スタッフは「お部屋の募集状況確認させていただきます」と確認していた＝別の部屋
  const sent: SentProperty[] = [{ name: "フォーリアライズ難波リアン", room: "705", sentAt: "2026-08-20T00:00:00Z" }];
  const r = matchOwnProperty({ name: "フォーリアライズ難波リアン", room: null }, sent);
  expect(r.kind).toBe("same_building");
  // 「こちらが送った物件」として本文の材料には出さない（出すのは same_room だけ）
  expect(buildOwnPropertyNote([{ item: { name: "フォーリアライズ難波リアン", room: null }, match: r }])).toBe("");
});
it("★ こちらの記録に号室が無い時は今までどおり同じ部屋とみなす（記録の抜け）", () => {
  const sent: SentProperty[] = [{ name: "ラクラス阿倍野元町", room: null, sentAt: "2026-09-19T00:00:00Z" }];
  expect(matchOwnProperty({ name: "ラクラス阿倍野元町", room: "507" }, sent).kind).toBe("same_room");
});
it("★★ シリーズ番号が違う建物は今までどおり別（サウスプレイスVI ↔ VIII）", () => {
  const sent: SentProperty[] = [{ name: "エステムコート難波サウスプレイスVIIIハイド", room: "201", sentAt: "2026-09-01T00:00:00Z" }];
  expect(matchOwnProperty({ name: "エステムコート難波サウスプレイスVIリリアン", room: "201" }, sent).kind).toBe("none");
});

it("号室の表記ゆれ（0507 と 507・号室付き）を揃える", () => {
  expect(normalizeRoom("0507")).toBe("507");
  expect(normalizeRoom("201 号室")).toBe("201");
  expect(normalizeRoom("11K")).toBe("11K");
  expect(normalizeRoom("")).toBe(null);
});
it("★★ A「ラクラス阿倍野元町 0507 6.4万円」→ 名前と号室", () => {
  const r = extractScreenshotProperty(A);
  expect(r?.name).toBe("ラクラス阿倍野元町"); expect(r?.room).toBe("507");
});
it("★★ B「物件名：／号室：」の形", () => {
  const r = extractScreenshotProperty(B);
  expect(r?.name).toBe("エクセレンス新今宮"); expect(r?.room).toBe("1202");
});
it("★★ C「名前 201 号室」の形", () => {
  const r = extractScreenshotProperty(C);
  expect(r?.name).toBe("エステムコート難波サウスプレイスVIリリアン"); expect(r?.room).toBe("201");
});
it("★ 画像でない文・物件でない画像は取り出さない", () => {
  expect(extractScreenshotProperty("この三つの物件良さそうです")).toBe(null);
  expect(extractScreenshotProperty("[画像] 大阪府大阪市浪速区日本橋3丁目 5.2万円")).toBe(null);
  expect(extractScreenshotProperty("[画像]")).toBe(null);
});
it("★★ こちらが送ったラクラス阿倍野元町 0507 → 同じ物件", () => {
  const m = matchOwnProperty(extractScreenshotProperty(A)!, SENT);
  expect(m.kind).toBe("same_room"); expect(m.sent?.name).toBe("ラクラス阿倍野元町");
});
it("★★ エステムコート難波… は エステムコート四天王寺… と**別の物件**（シリーズ名だけ共通）", () => {
  expect(matchOwnProperty(extractScreenshotProperty(C)!, SENT).kind).toBe("none");
});
it("★ 記録に無い物件は none（違うとは言わない＝分からない）", () => {
  expect(matchOwnProperty(extractScreenshotProperty(B)!, SENT).kind).toBe("none");
});
it("★★ 全件監査の誤照合: サウスプレイス**VIII**ハイド と サウスプレイス**VI**レジダー は別の建物", () => {
  const sent: SentProperty[] = [{ name: "エステムコート難波サウスプレイスVIレジダー", room: null, sentAt: "2026-08-28T00:00:00Z" }];
  expect(matchOwnProperty({ name: "エステムコート難波サウスプレイスVIIIハイド", room: null }, sent).kind).toBe("none");
});
it("★ シリーズ番号が同じなら読み違い（セレニテ／セレニティ）でも同じ物件", () => {
  const sent: SentProperty[] = [{ name: "セレニティ難波ブリエ", room: "611", sentAt: "2026-09-16T00:00:00Z" }];
  expect(matchOwnProperty({ name: "セレニテ難波ブリエ", room: "611" }, sent).kind).toBe("same_room");
});
it("★ Ⅱ（全角）と II（半角）は同じ番号", () => {
  const sent: SentProperty[] = [{ name: "エステムコート四天王寺夕陽ヶ丘Ⅱ", room: "501", sentAt: null }];
  expect(matchOwnProperty({ name: "エステムコート四天王寺夕陽ヶ丘II", room: "501" }, sent).kind).toBe("same_room");
});
it("★ 同じマンションの別の部屋 → same_building", () => {
  expect(matchOwnProperty({ name: "ラクラス阿倍野元町", room: "302" }, SENT).kind).toBe("same_building");
});
it("★★ 生成への説明: こちらの物件を「お送り頂きました物件」と呼ばない・募集状況確認の宣言をしない", () => {
  const items = [A, B, C].map((t) => extractScreenshotProperty(t)!);
  const note = buildOwnPropertyNote(items.map((item) => ({ item, match: matchOwnProperty(item, SENT) })));
  expect(note).toContain("ラクラス阿倍野元町 507号室");
  expect(note).toContain("9/19");
  expect(note).toContain("お送り頂きました物件");
  expect(note).toContain("残り2件はこちらの記録に無い");
});
it("こちらの物件が1件も無ければ何も足さない（今までどおり）", () => {
  const item = extractScreenshotProperty(C)!;
  expect(buildOwnPropertyNote([{ item, match: matchOwnProperty(item, SENT) }])).toBe("");
});

// ── 照合の結果（all）を、確認対象・見積・AIX の場面が同じように受け取る（同じ事実に逆の指示を出さない）──
// 実物（YUMA 再現: こちらが送った2件のスクショ＋お客様の言葉）
const TURN = `${A}${MSG_SEP}[画像] floor_plan\n\n物件種目：住居用 マンション\n物件名：エスリードレジデンス大阪天王寺\n号室：1006（10階部分）${MSG_SEP}この物件良さそうですが、\nもう少し見てみたいので、送っていただきたいです🙇‍♀️`;

it("確認対象: こちらの物件の送り返しは物件の指名にしない（従来は募集状況の確認を許可）", () => {
  expect(resolveConfirmationContext({ customerMessage: TURN }).allowed).toBe(true);
  const v = resolveConfirmationContext({ customerMessage: TURN, ownPropertyReturnedAll: true, conversationObjects: { propertyNames: ["ラクラス阿倍野元町 0507号室"] } });
  expect(v.allowed).toBe(false);
});
it("確認対象: 送り返しでもお客様が言葉で空室を聞いたら確認してよい", () => {
  const v = resolveConfirmationContext({ customerMessage: `${A}${MSG_SEP}こちらまだ空いてますか？`, ownPropertyReturnedAll: true });
  expect(v.allowed).toBe(true);
});
it("見積: 送り返しは新しい物件の送付（customer_sent_property）にしない", () => {
  const base = { customerMessage: TURN, sentPropertiesCount: 2, recentCustomerMessages: [], hasCustomerImage: true };
  expect(isMisumoriContextAppropriate(base).trigger).toBe("customer_sent_property");
  expect(isMisumoriContextAppropriate({ ...base, ownPropertyReturnedAll: true }).trigger === "customer_sent_property").toBe(false);
});
it("AIX の場面: 送り返しの画像は物件の指名（S1 空室確認）にしない", () => {
  const o = { latestCustomerTurn: "[画像]\n[画像]\nこの物件良さそうですが、もう少し見てみたいので、送っていただきたいです", hasCustomerImage: true, sentPropertyCount: 2 };
  expect(detectAixSceneEvidence(o)?.scene ?? "none").toBe("S1_vacancy");
  expect(detectAixSceneEvidence({ ...o, ownPropertyReturnedAll: true })?.scene === "S1_vacancy").toBe(false);
});
it("「もう少し見てみたいので、送っていただきたい」は引き続きのご紹介の依頼", () => {
  expect(CUSTOMER_ASKS_CONTINUOUS_PICKUP_RE.test("もう少し見てみたいので、送っていただきたいです")).toBe(true);
  expect(CUSTOMER_ASKS_CONTINUOUS_PICKUP_RE.test("よろしくお願いします")).toBe(false);
});
it("「もう少し見てみたい／ほかもあれば見てみたい」は内覧の希望ではない（実データ4件とも物件のご紹介）", () => {
  for (const m of ["もう少し見てみたいので、送っていただきたいです", "ほかもあれば見てみたいです🙇🏻‍♀️", "もう少し見てみたいのでまたあれは紹介して欲しいです。"]) expect(CUST_VIEWING_INTENT_RE.test(m)).toBe(false);
  for (const m of ["一度お部屋見てみたいです", "内覧したいです", "実際に見たいです"]) expect(CUST_VIEWING_INTENT_RE.test(m)).toBe(true);
});
it("AIX の場面（S4 内覧）も「もう少し見てみたい」を内覧にしない（同じ接頭）", () => {
  expect(VIEWING_INTENT_RE.test("もう少し見てみたいので、送っていただきたいです")).toBe(false);
  expect(VIEWING_INTENT_RE.test("一度見てみたいです")).toBe(true);
});
it("ナレッジの入口: 送り返しの時に落とす語（実物のナレッジ2件）", () => {
  expect(CUSTOMER_FOUND_PROPERTY_VOCAB.test("「〇〇さんお部屋お送りいただきありがとうございます😊！！」で感謝を伝えた後、「お部屋の募集状況確認させていただきます！！」と次アクションを明示")).toBe(true);
  expect(CUSTOMER_FOUND_PROPERTY_VOCAB.test("お送り頂きました物件名号室、募集状況をご確認させて頂きました！！")).toBe(true);
  expect(CUSTOMER_FOUND_PROPERTY_VOCAB.test("お送りさせて頂きましたお部屋の中でも特にライフ野江401がかなりオススメ出来るお部屋となります")).toBe(false);
});
it("出口: 送り返しの時は「〇〇の物件」を「お送り頂きました物件」に置き換えない", () => {
  const draft = "エスリードレジデンス大阪天王寺の物件ですね😊！！";
  expect(normalizeSharedPropertyReference(draft, TURN).count > 0).toBe(true);
  expect(normalizeSharedPropertyReference(draft, TURN, { ownPropertyReturnedAll: true }).text).toBe(draft);
});
// 2026-09-22 竹内「引き続き新着物件が優先。実際の LINE 見てもそうなってると思う」（実送信 6/6・見積書 0/6）
it("他のお部屋も見たい（実物6件）はお客様の言葉だけで判定する", () => {
  for (const m of ["とても魅力的ですが、他の物件も見てみたいです。", "ほかもあれば見てみたいです🙇🏻‍♀️", "もう少し見てみたいのでまたあれは紹介して欲しいです。", "この三つの物件良さそうですが、\nもう少し見てみたいので、送っていただきたいです🙇‍♀️", "あと一応ほかも見れたら見たいのですが、物件出していただくこと可能ですか？", "その日に他の物件も見たいのでまた出していただけると助かります"]) expect(customerAsksMoreListings(m)).toBe(true);
  expect(customerAsksMoreListings(TURN)).toBe(true);
  expect(customerAsksMoreListings(`${A}${MSG_SEP}ありがとうございます`)).toBe(false);
  expect(customerAsksMoreListings("一度お部屋見てみたいです")).toBe(false);
});
it("見積: 他のお部屋も見たい時は前向きな反応でも見積書を宣言しない（費用の質問は従来どおり）", () => {
  const base = { customerMessage: "この物件良さそうですが、もう少し見てみたいので、送っていただきたいです", sentPropertiesCount: 3, recentCustomerMessages: [] };
  expect(isMisumoriContextAppropriate({ ...base, customerAsksMoreListings: true }).mode).toBe("forbid");
  expect(isMisumoriContextAppropriate({ ...base, customerMessage: "他の物件も見てみたいです。ここの初期費用いくらですか？", customerAsksMoreListings: true }).mode).toBe("declare");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
