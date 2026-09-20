// app/lib/__tests__/apply-claim.test.ts
// 実行: npx tsx app/lib/__tests__/apply-claim.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内（S さん事例）「まだ申込情報の意味不明なのが出ている」
//   「申込情報は申込のフォーマットの部分となる」
//   「このようなミス起きないようにテストもおこなう」
//
// 線（scripts/audit-apply-format-flow.ts）:
//   ・「申込の情報を受け取った」型は実送信365日 **12,046通中 0通** ＝ 誤削除0
//   ・申込フォーマットが記入されて返ってきた時のスタッフの正解は全部
//     「ご入力いただきありがとうございます」「お送り頂きありがとうございます」型で、
//     「受け取りました」とは**誰も書かない** ＝ 正しい場面でも不要
import { stripApplyReceivedClaim, hasApplyReceivedClaim, APPLY_FORMAT_SENT_RE, APPLY_FORM_FILLED_RE } from "../apply-claim";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が入ってはいけない`); },
  };
}

console.log("\n── ★ 本物の捏造（S さん・まりあさん）──");

it("★ S さん: 「考えます」への返信から申込の1行だけが消え、本文は残る", () => {
  const real = "はい！！\nお申込み情報を確かに受け取りました😊！！\n私の方でもオススメできるお部屋がございましたら随時ピックアップしてお送りさせて頂きますので、何卒よろしくお願い致します😌！！";
  const { text, removed } = stripApplyReceivedClaim(real);
  expect(text).toBe("はい！！\n私の方でもオススメできるお部屋がございましたら随時ピックアップしてお送りさせて頂きますので、何卒よろしくお願い致します😌！！");
  expect(removed.length).toBe(1);
  expect(removed[0]).toContain("お申込み情報を確かに受け取りました");
});

it("★ まりあさん: 「全て見に行きたいです」への返信からも消える", () => {
  const real = "かしこまりました！！\n\nお申込み情報受け取りました😊！！\n\nこちらのお部屋、お申込み完了次第ご連絡させて頂きますので、引き続き何卒よろしくお願い致します😌！！";
  const { text } = stripApplyReceivedClaim(real);
  expect(text).notToContain("受け取りました");
  expect(text).toContain("かしこまりました！！");
  expect(text).toContain("引き続き何卒よろしくお願い致します");
});

it("★ 見積書のカバーレターに出た形も消える", () => {
  for (const s of ["お申込み情報を確かに受け取りました！！", "お申込み情報拝受いたしました。", "お申込み情報を受け取りました"]) {
    expect(hasApplyReceivedClaim(s)).toBe(true);
    expect(stripApplyReceivedClaim(`YUMAさんお世話になっております😊\n${s}\nご確認ください！！`)).notToContain("受け取り");
  }
});

it("★ 行の途中に混ざっていても、その文だけ落ちる", () => {
  const { text } = stripApplyReceivedClaim("かしこまりました！！お申込み情報を受け取りました！！引き続きよろしくお願い致します！！");
  expect(text).toContain("かしこまりました！！");
  expect(text).toContain("引き続きよろしくお願い致します！！");
  expect(text).notToContain("受け取りました");
});

console.log("\n── ★ 誤削除0（お客様への本物の実送信は1文字も変えない）──");

// 実送信（messages.sender=staff）から採った、申込まわりの本物
const KEEP: string[] = [
  "こちらお申込に必要なご情報となります😊！！\n上記フォーマットご入力いただき、ご本人確認書類として運転免許証またはマイナンバーカードの裏表の写真をお送りください！！\nお送り頂き次第、お部屋お申込し抑えさせて頂きます！！",
  "ほのかさん\nご入力いただきありがとうございます😊！！\n緊急連絡先様はほのかさんから3親等以内で設定頂く必要がございます！！",
  "あにかさん\nご情報お送りいただきありがとうございます😊！！\nマイナンバーカードの表裏のお写真お送りください！！",
  "お送り頂きありがとうございます😊！！\nこちらでお申込みさせて頂きます！！\nお申込み完了しましたらご連絡させて頂きます！！",
  "ご記入ありがとうございます😊\n申込書の内容を確認させていただきました。あと緊急連絡先の欄のみ、ご記入いただきたく存じます。",
  "ただいまお申込みURL再送させていただきました！！\n届きましたらご対応の程よろしくお願いいたします😊！！",
  "Skyさん\n無事1番手でお申込み完了しております😊！！\n審査の進捗あり次第ご連絡させていただきます😌！！",
  "はい！！\nお申込み頂きましたら最短2週間程でのご入居が可能となりますので、8末のご希望にも間に合わせられるようサポートさせて頂きます😊！！",
  "お送り頂きありがとうございます！！\nこちらのお部屋一度弊社でお申込みさせて頂きましたお部屋となりますので、協力業者にてお申込させて頂きます。",
  "お申込みフォームお送りさせていただきました😌！！\nご入力のほどよろしくお願いいたします！！",
  "かしこまりました！！\nお部屋お申込みさせていただきます😊！！",
  "モモカさん\nお世話になっております！！\nヴィラ沙町のお部屋が既にお申込み終了してとり、オーラコート杭瀬216号室を1番手でお申し込み完了しております😊！！",
];
for (const s of KEEP) {
  it(`「${s.split("\n")[0].slice(0, 22)}…」は1文字も変わらない`, () => {
    const { text, removed } = stripApplyReceivedClaim(s);
    expect(text).toBe(s);
    expect(removed.length).toBe(0);
  });
}

it("★ 「ご情報お送りいただきありがとうございます」は消さない（正解の受け方）", () => {
  expect(hasApplyReceivedClaim("ご情報お送りいただきありがとうございます😊！！")).toBe(false);
});

it("★ 「申込書の内容を確認させていただきました」は消さない（確認であって受領の宣言ではない）", () => {
  expect(hasApplyReceivedClaim("申込書の内容を確認させていただきました。")).toBe(false);
});

console.log("\n── 壊さない（空・短い・本文が消えるだけの時）──");

it("空・null は素通り", () => {
  expect(stripApplyReceivedClaim("").text).toBe("");
});

it("★ 落とすと何も残らない時は元のまま返す（本文を空にしない）", () => {
  const only = "お申込み情報を受け取りました😊！！";
  const { text, removed } = stripApplyReceivedClaim(only);
  expect(text).toBe(only);
  expect(removed.length).toBe(0);
});

it("空行が3つ以上続かない", () => {
  const { text } = stripApplyReceivedClaim("はい！！\n\nお申込み情報受け取りました😊！！\n\n引き続きよろしくお願い致します！！");
  expect(text).notToContain("\n\n\n");
});

it("★ 落とす物が無い文は1文字も変えない（空行・前後の空白もそのまま）", () => {
  // 2026-09-20 全件監査で見つけたバグ: 落とす物がゼロでも空行の畳み込み・trim をしていて、
  //   実送信12,046通のうち136通が「落とした物ゼロなのに変わる」状態だった。
  const keeps = [
    "🌟エステムプラザ難波WESTリバークロス 404\n\n\n（オススメポイント）\n・家賃62,000円",   // 空行3つ
    "  先頭に空白がある文です！！  ",                                                    // 前後の空白
    "お申込み時は無しでの申込みも可能です！！\n審査の際に管理会社より追加指示がある可能性がございます😌！！\n\n\n勤務先情報は開けてご入力頂けましたら大丈夫です！！",
    "末尾に改行がある\n",
  ];
  for (const s of keeps) {
    const { text, removed } = stripApplyReceivedClaim(s);
    if (text !== s) throw new Error(`変わってしまった:\n  前「${s}」\n  後「${text}」`);
    expect(removed.length).toBe(0);
  }
});

console.log("\n── 申込フォーマットの流れ（竹内「流れ分かれば理解できる」）──");

it("★ ①フォーマットの送付を見分けられる（実送信150通の定型）", () => {
  expect(APPLY_FORMAT_SENT_RE.test("こちらお申込に必要なご情報となります😊！！")).toBe(true);
  expect(APPLY_FORMAT_SENT_RE.test("【お申込者様記入欄】\n・入居希望日\n・氏名、フリガナ")).toBe(true);
  expect(APPLY_FORMAT_SENT_RE.test("上記フォーマットご入力いただき")).toBe(true);
});

it("★ ②お客様が記入して返した形を見分けられる", () => {
  expect(APPLY_FORM_FILLED_RE.test("【お申込者様記入欄】\n・入居希望日 8月末日\n・氏名、フリガナ 畑中祭興")).toBe(true);
  expect(APPLY_FORM_FILLED_RE.test("・入居希望日 9月中\n・氏名、フリガナ 中澤美")).toBe(true);
});

it("★ ふつうの物件紹介・内覧案内を申込の流れと間違えない", () => {
  for (const s of ["🌟B-PROUD天満橋 1202\n新着でかなり条件のいいお部屋となります！！", "明日16時お部屋ご案内させて頂きます！！"]) {
    expect(APPLY_FORMAT_SENT_RE.test(s)).toBe(false);
    expect(APPLY_FORM_FILLED_RE.test(s)).toBe(false);
    expect(hasApplyReceivedClaim(s)).toBe(false);
  }
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
