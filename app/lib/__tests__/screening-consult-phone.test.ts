// 審査の相談 → AIX【電話をかける】の材料（2026-10-28 竹内さんの決定 701e2665・咲）
// 実行: npx tsx app/lib/__tests__/screening-consult-phone.test.ts
import { screeningConsultTurn, screeningPhoneTurnLine, screeningConsultPhoneEnabled } from "../screening-phone-material";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const ON = { SCREENING_CONSULT_PHONE: "on" };
const SAKI = "相談なのですが、今、水商売をしていて、いつも不動産屋さんに審査通るように職場の案内してもらうのですが、こちらでもしてもらえますか？";

it("既定 off", () => { eq(screeningConsultPhoneEnabled({}), false); eq(screeningPhoneTurnLine(SAKI, {}), ""); });
it("咲: 水商売・職場の案内の審査の相談 → 電話の材料", () => {
  ok(screeningConsultTurn(SAKI));
  const t = screeningPhoneTurnLine(SAKI, ON);
  ok(/電話をかける/.test(t) && /10\/28/.test(t), t);
});
it("試験で竹内さんが電話にしていない審査の話は網に掛けない（q021・q054・q117・q186 の言い方）", () => {
  eq(screeningConsultTurn("ブラックなど審査は通らないですか（ ; ; ）"), false);
  eq(screeningConsultTurn("こっちの審査落ちたら こっちに行きたいです"), false);
  eq(screeningConsultTurn("⑧【その他ご要望あれば】⇒審査に通りにくい･バストイレ別"), false);
  eq(screeningConsultTurn("1番手の保証会社のところは審査通りませんでした。"), false);
  eq(screeningConsultTurn("審査ってどれくらいかかりますか？"), false);
});
it("本番の実物: 職業を言っただけ・初回の条件の紙・別の文の相談は掛けない／審査のことで相談は掛ける", () => {
  eq(screeningConsultTurn("それと事前に審査のことで職業のことを相談させて頂いておりましたが対応は可能でしょうか？"), true);
  eq(screeningConsultTurn("夜職、ブラックなので審査不安です！"), false);
  eq(screeningConsultTurn("夜職でも審査通りそうな物件紹介して欲しいです"), false);
  eq(screeningConsultTurn("⑧【その他ご要望あれば】⇒ホストしているので審査が不安なのでよろしくお願いしたいです。"), false);
  eq(screeningConsultTurn("保証会社の審査通過のご連絡ありがとうございます。 入居日についてご相談です。"), false);
  eq(screeningConsultTurn("そのため、保証会社の審査や入居審査について比較的相談しやすく、保証人不要で申し込み可能な物件を優先してご紹介いただけると助かります。"), false);
  eq(screeningConsultTurn("審査OKの場合、いつぐらいに在籍確認等の連絡が入るか教えてください。"), false);
  eq(screeningConsultTurn("入居審査についてご相談です！私自身、夜職での勤務ということと、過去に支払いの滞納歴があるため"), true);
});
it("名義貸しの行は on の時「通常の審査の相談は電話にしない」を書かない", () => {
  const t = screeningPhoneTurnLine("友人の名義で契約できますか", { SCREENING_PHONE_LINE: "on", ...ON });
  ok(/名義/.test(t) && !/電話にしない/.test(t), t);
  ok(/電話にしない/.test(screeningPhoneTurnLine("友人の名義で契約できますか", { SCREENING_PHONE_LINE: "on" })));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
