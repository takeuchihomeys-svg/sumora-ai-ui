// 2026-09-15 竹内（朱莉事例）: こちらが締めた後のお礼（返信しないで連絡を待つ）と、送った文と同じ内容の下書きの判定
// 実行: npx tsx app/lib/__tests__/closed-ack.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveClosedAck, staffClosedTheDoor, findNearDuplicateSent } from "../closed-ack";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

// 朱莉の実会話（9/15）
const AKARI = [
  { sender: "staff", text: "[画像]" },
  { sender: "staff", text: "朱莉さんお世話になっております！！\n\n光善寺駅・香里園周辺全域から朱莉さんにオススメできるお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！" },
  { sender: "staff", text: "朱莉さんお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！\nお気軽にお申し付けください😌✨" },
  { sender: "customer", text: "ありがとうございます！確認してみます！" },
  { sender: "staff", text: "はい😊！！\n朱莉さん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！" },
  { sender: "customer", text: "ありがとうございます！" },
];

it("朱莉: こちらが「何時でもお気軽にご連絡ください」で締めた後のお礼だけ → 返信しないで連絡を待つ", () => {
  const v = resolveClosedAck(AKARI, true);
  expect(v.closed).toBe(true);
  expect(v.staffLine).toBe("朱莉さん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！");
});
it("お客様の最後がお礼だけでなければ待たない（呼び出し側の isAckOnly=false）", () => {
  expect(resolveClosedAck(AKARI, false).closed).toBe(false);
});
it("直前のこちらの文が締めでなければ待たない（物件送付の直後のお礼には返す場面がある）", () => {
  const msgs = [...AKARI.slice(0, 2), { sender: "customer", text: "ありがとうございます！" }];
  expect(resolveClosedAck(msgs, true).closed).toBe(false);
});
it("こちらの最後がお客様への質問なら、お礼だけでも待たない", () => {
  expect(staffClosedTheDoor("気になる点ございましたらご連絡ください！！\nご内覧のご希望日はございますでしょうか？")).toBe(false);
});
it("締めの形: 「お気軽にお申し付けください」「お待ちしております」「ご不明点…ご連絡ください」も締め・本文の途中だけなら締めではない", () => {
  expect(staffClosedTheDoor("朱莉さんお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！\nお気軽にお申し付けください😌✨")).toBe(true);
  expect(staffClosedTheDoor("はい！！\n同居人様とご相談いただきご連絡お待ちしております😊！！")).toBe(true);
  expect(staffClosedTheDoor("ご不明点ございましたらいつでもご連絡ください！！\n\nこちら〇〇の資料となります！！\n1LDKで家賃8万円です！！\nお手隙の際にご査収ください😌！！")).toBe(false);
});
it("お電話・ご来店の約束の「お待ちしております」は締めではない（120日の実データ yasuki 9/14）", () => {
  expect(staffClosedTheDoor("かしこまりました！！\n10時半頃のお電話お待ちしております😊！！")).toBe(false);
  expect(staffClosedTheDoor("ふりーだむさんのご来店、心よりお待ちしております😊")).toBe(false);
});
it("こちらの締めとお客様のお礼の間に画像だけの通があっても、文字の発言で見る", () => {
  const msgs = [{ sender: "staff", text: "はい😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！" }, { sender: "staff", text: "[画像]" }, { sender: "customer", text: "ありがとうございます" }];
  expect(resolveClosedAck(msgs, true).closed).toBe(true);
});

it("朱莉の下書きは直前に送った文とほぼ同じ（何時でも↔いつでも・「等」・絵文字の違いだけ）", () => {
  const r = findNearDuplicateSent("はい😊！！\n朱莉さん気になる点等出てきましたらいつでもお気軽にご連絡ください！！", ["はい😊！！\n朱莉さん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！"]);
  expect(r.dup).toBe(true);
});
it("新しい内容の返信（実データの返信2件の形）は同じ内容ではない", () => {
  const sent = ["はい😊！！\nあんしん+住道矢田08のお部屋、気になる点等出てきましたらいつでもお気軽にご連絡ください！！"];
  expect(findNearDuplicateSent("はい😊！！\nあいさんのご希望のご条件に合ったお部屋引き続き新着で募集に出次第お送りさせて頂きます！！\n何卒よろしくお願い致します！！", sent).dup).toBe(false);
});
it("短すぎる文（「はい😊！！」だけ）は比べない", () => {
  expect(findNearDuplicateSent("はい😊！！", ["はい😊！！"]).dup).toBe(false);
});
it("同じ型でも物件名・中身が違えば同じ内容ではない", () => {
  expect(findNearDuplicateSent("メゾン光善寺201号室の最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！", ["香里園ハイツ305号室の最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！"]).dup).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
