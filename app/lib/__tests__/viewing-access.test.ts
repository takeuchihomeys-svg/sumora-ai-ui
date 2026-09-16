// 2026-09-16 竹内（𝒮 さん事例）: 内覧が決まった後の道順の質問は、決まっている住所で答える。中身のない先送りは書かない
// 実行: npx tsx app/lib/__tests__/viewing-access.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { isViewingAccessQuestion, buildViewingAccessNote, stripVagueDeferral } from "../viewing-access";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("𝒮: 内覧が決まっている会話の道順の質問を拾う", () => {
  expect(isViewingAccessQuestion("野田阪神からは少し距離ありますかね🤔土地勘なくてすみません😣💦", true)).toBe(true);
  expect(isViewingAccessQuestion("今の家から野田阪神までバス出てるからバスで行こうと考えててお聞きました", true)).toBe(true);
  expect(isViewingAccessQuestion("最寄りって阪神野田でしたっけ？💭", true)).toBe(true);
  expect(isViewingAccessQuestion("現地のご住所教えていただけますか？", true)).toBe(true);
});
it("内覧が決まっていない会話では拾わない（新しい待ち合わせを決める文は AIX の担当のまま）", () => {
  expect(isViewingAccessQuestion("最寄りって阪神野田でしたっけ？", false)).toBe(false);
});
it("物件探しの条件（駅徒歩10分以内で探して）は道順ではない", () => {
  expect(isViewingAccessQuestion("駅徒歩10分以内で探しています", true)).toBe(false);
  expect(isViewingAccessQuestion("心斎橋や難波の徒歩圏内がいいです💦\n他に物件ありましたら送ってください", true)).toBe(false);
});

it("材料は住所・物件・日時と「先送りしない」「無い事は書かない」の指示（社内情報は入れない）", () => {
  const note = buildViewingAccessNote({
    propertyName: "CRESTTAPP野田 204号室",
    address: "大阪府大阪市福島区吉野5丁目11-4",
    dateMD: "9/17", time: "12:00",
  });
  expect(note.includes("住所: 大阪府大阪市福島区吉野5丁目11-4")).toBe(true);
  expect(note.includes("日時: 9/17 12:00")).toBe(true);
  expect(note.includes("先送りしない")).toBe(true);
  expect(note.includes("キーボックス")).toBe(false);
  expect(buildViewingAccessNote({})).toBe("");
});

it("𝒮: 中身のない先送り（当日迷われないよう明日また詳細ご案内）だけを落とす", () => {
  const draft = "野田阪神駅からですと徒歩14分ほどの距離となりますので、バスでお越しの際は野田阪神から下車頂き、徒歩でマンションまで到着出来ます😊！！\n当日迷われないよう明日また詳細ご案内させて頂きます！！";
  expect(stripVagueDeferral(draft)).toBe("野田阪神駅からですと徒歩14分ほどの距離となりますので、バスでお越しの際は野田阪神から下車頂き、徒歩でマンションまで到着出来ます😊！！");
});
it("何を届けるかが決まっている約束は残す（実データの本物）", () => {
  const real = "お世話になっております！！\nお送り頂きましたDomani2階部分は現在募集中となります！！\n明日午前中に初期費用詳細確認させて頂き御見積しお送りさせて頂きます！！";
  expect(stripVagueDeferral(real)).toBe(real);
  const real2 = "かしこまりました！！\n改めて物件の詳細ご連絡させて頂きます！！";
  expect(stripVagueDeferral(real2)).toBe(real2);
});
it("先送りが無い文・空文字は変えない", () => {
  const t = "かしこまりました！！\n明日12:00〜ご案内させて頂きます！！";
  expect(stripVagueDeferral(t)).toBe(t);
  expect(stripVagueDeferral("")).toBe("");
});
it("先送りだけの下書きは元のまま返す（空にして返信を消さない）", () => {
  const only = "当日迷われないよう明日また詳細ご案内させて頂きます！！";
  expect(stripVagueDeferral(only)).toBe(only);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
