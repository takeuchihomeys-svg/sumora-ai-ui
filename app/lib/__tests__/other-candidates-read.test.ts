// 2026-11-06 作業員1（弱い所 61・q174）: 物件を送った後の「良さそう・一旦見てみたい＋他にも候補があれば」を内覧の依頼と読まない手本
// 実行: npx tsx app/lib/__tests__/other-candidates-read.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { readOtherCandidates, otherCandidatesReadOn, pickOtherCandidatesExamples, otherCandidatesBrainText } from "../other-candidates-read";
import { customerAsksMoreListings } from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`); }
}
function expect<T>(a: T) { return { toBe: (b: T) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }, toContain: (s: string) => { if (!String(a).includes(s)) throw new Error(`expected to contain ${s}`); } }; }

// 実物の本文（q174・c068a6a3 10/16 竹内さんの番）
const Q174 = "そうなんですね、、(うるうる)\n承知しました！\nありがとうございます！\n広くて綺麗ですね！✨一旦見てみたいです！\n場所が少し遠い気もしてて、もし他にも候補ありましたらお願いしたいです(ぺこり)";
// 実物（7/31 e9b2c02c 従業員の番・ピックアップ）
const J731 = "部屋見てみたいのですが、他の部屋も紹介してみたいです！";
// 実物（10/06 f2967621 本当の内覧の依頼・竹内さんは AIX【内覧調整】）
const VIEW = "ありがとうございます！！\nここ内覧お願いいたします🙇‍♀️\n他にも気になる物件がありますので含めて行きたいです！\n今週の日曜日等予定空いていますか？\n他の物件も明日までには送ります";

it("スイッチは既定 on（止める =off）", () => { expect(otherCandidatesReadOn({})).toBe(true); expect(otherCandidatesReadOn({ BRAIN_OTHER_CANDIDATES_READ: "off" })).toBe(false); });
it("q174: 当たる・好感の言葉あり", () => { const r = readOtherCandidates({ customerText: Q174, sentPropertyCount: 8 }); expect(r.hit).toBe(true); expect(r.liking).toBe(true); });
it("q174: 前からある「もう少し見てみたい」の材料は拾っていない（重ならない）", () => { expect(customerAsksMoreListings(Q174)).toBe(false); });
it("7/31: 「部屋見てみたい…他の部屋も紹介」も当たる", () => { expect(readOtherCandidates({ customerText: J731, sentPropertyCount: 5 }).hit).toBe(true); });
it("本当の内覧の依頼（内覧・今週の日曜日）は当たらない", () => { expect(readOtherCandidates({ customerText: VIEW, sentPropertyCount: 3 }).hit).toBe(false); });
it("試験の内覧の問題（q087・q129・q045・q107 の本文）は当たらない＝材料は変わらない", () => {
  for (const t of ["ここ見てみたいです!", "こちらと こちら1度見てみたいです！", VIEW, "お世話になっております。\nどれもいい感じの物件なんですが実際に見て決めたいです。"]) expect(readOtherCandidates({ customerText: t, sentPropertyCount: 5 }).hit).toBe(false);
});
it("日時を言った番は当たらない", () => { expect(readOtherCandidates({ customerText: "良さそうです！他にも候補あれば土曜に一緒に見たいです", sentPropertyCount: 3 }).hit).toBe(false); });
it("監査の外し: 拝見・申込・質問の番は当たらない（実物 9/02・11/05・7/09）", () => {
  expect(readOtherCandidates({ customerText: "メロディハイムで別の部屋で似ている部屋の空きがあればそこを拝見し確認する事は可能でしょうか？", sentPropertyCount: 3 }).hit).toBe(false);
  expect(readOtherCandidates({ customerText: "なのでこの物件はキャンセルさせていただきたいです。\n可能であれば別の物件にお申し込みさせていただきたいです", sentPropertyCount: 3 }).hit).toBe(false);
  expect(readOtherCandidates({ customerText: "重ねて他の物件の疑問して良いですか？", sentPropertyCount: 3 }).hit).toBe(false);
});
it("物件を送っていない会話は当たらない", () => { expect(readOtherCandidates({ customerText: Q174, sentPropertyCount: 0 }).hit).toBe(false); });
it("「もう少し見てみたい」の材料が出た番は重ねない", () => { expect(readOtherCandidates({ customerText: Q174, sentPropertyCount: 8, alreadySeeMore: true }).hit).toBe(false); });
it("他の候補の依頼が無い好感だけの番は当たらない", () => { expect(readOtherCandidates({ customerText: "広くて綺麗ですね！一旦見てみたいです！", sentPropertyCount: 8 }).hit).toBe(false); });
it("手本: 同じ会話は外す（答えが漏れない）", () => {
  const ex = pickOtherCandidatesExamples("c068a6a3-1018-40c6-8224-8388c98f6469", {});
  expect(ex.some((e) => e.conv.startsWith("c068a6a3"))).toBe(false);
  expect(ex.length).toBe(2);
});
it("手本: 試験の元の会話（BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV）も外す", () => {
  const ex = pickOtherCandidatesExamples("copy-conv", { BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV: "c068a6a3-1018-40c6-8224-8388c98f6469" });
  expect(ex.some((e) => e.conv.startsWith("c068a6a3"))).toBe(false);
});
it("材料の文: 好感の時は内覧を書かない読み方と竹内さんの数", () => {
  const t = otherCandidatesBrainText({ hit: true, liking: true }, pickOtherCandidatesExamples("x", {}));
  expect(t).toContain("内覧の依頼ではない");
  expect(t).toContain("内覧に誘った 0・AIX【内覧調整】0");
  expect(t).toContain("竹内さん: ピックアップの約束（2段:pickup）");
  // 11/06 q174-ab: 読み方と一手（ピックアップの約束）を1組で渡す
  expect(t).toContain("一手: 竹内さんは新たにピックアップしてお送りする約束を返す");
  expect(t).toContain("route=promise");
  expect(t).toContain("相づち・お礼だけの返信で終わらせない");
});
it("材料の文: 当たらなければ空", () => { expect(otherCandidatesBrainText({ hit: false, liking: false }, [])).toBe(""); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
