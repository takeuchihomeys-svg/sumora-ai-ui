// 2026-09-14 Hina 事例: 画像の読み取り文はお客様の発言ではない（意図の判定から外す・物件の特定には使う）
// 実行: npx tsx app/lib/__tests__/image-text.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, customerOwnWords, isImageTextUnit, normalizeCustomerText, MSG_SEP, IMAGE_TEXT_LABEL } from "../reply-context";
import { resolveConfirmationContext } from "../confirmation-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
// Hina: SNS 広告のスクショ2枚（本物の読み取り文の要約）
const AD1 = "[画像] 0:14🌙\nSUMORA\n賃貸物件 大阪 6万円ペット可 1ldk 検索\n初期費用2,980円\n+前家賃だけ!!!\nペットと住める!\n桜川1LDK+S\n洋室6.5帖\n「桜川」駅徒歩6分・ペットと暮らせる";
const AD2 = "[画像] 初期費用用2,980円\nペットと住める！\n大阪市2LDK\n洋室5帖\n「堺筋本町」駅徒歩4分";
const HINA = [AD1, AD2].join(MSG_SEP);
const turn = (msg: string, lastStaff = "") => {
  const sub = analyzeSubstance(msg);
  const staff = classifyLastStaffTurn(lastStaff, {});
  const cust = classifyCustomerResponse(sub, staff, {});
  return { sub, cust, pair: resolveTurnPair(staff, cust, sub, lastStaff, {}) };
};

it("読み取り文の通・プロンプトの見出し付きの通を画像として見分ける", () => {
  expect(isImageTextUnit(AD1)).toBe(true);
  expect(isImageTextUnit(IMAGE_TEXT_LABEL + "ペットと住める！")).toBe(true);
  expect(isImageTextUnit("【スクショ内容】桜川1LDK")).toBe(true);
  expect(isImageTextUnit("この物件ペット可ですか？")).toBe(false);
});
it("お客様の言葉だけ: 画像の通は [画像] に置き換え、書いた通は残す", () => {
  expect(customerOwnWords(`${AD1}${MSG_SEP}この物件まだ空いてますか？`)).toBe(`[画像]${MSG_SEP}この物件まだ空いてますか？`);
  expect(normalizeCustomerText(HINA)).toBe("");
});
it("Hina: 広告スクショだけ → 条件変更・日程・質問にしない（情報が届いた＝その他・了承でもない）", () => {
  const { sub, cust, pair } = turn(HINA);
  expect(sub.kinds.join(",")).toBe("info");
  expect(sub.isAckOnly).toBe(false);
  expect(cust.kind).toBe("other");
  expect(pair.ruleId).toBe(null);
});
it("ピックアップ宣言の後に物件のスクショだけ → 了承への返し（PD_ACK）にしない", () => {
  const { pair } = turn(AD1, "大阪市内全域からオススメできるお部屋ピックアップしてお送りさせて頂きます！！");
  expect(pair.ruleId === "PD_ACK").toBe(false);
});
it("確認の対象: 広告の「ペット可」からは取らない（物件の指名＝募集状況）", () => {
  const v = resolveConfirmationContext({ customerMessage: HINA });
  expect(v.source).toBe("customer_property_nomination");
  expect(v.object).toBe("募集状況");
});
it("お客様が自分で書いた質問は今まで通り（画像＋「この物件ペット可ですか？」→ ペット飼育の可否）", () => {
  const msg = `${AD1}${MSG_SEP}この物件ペット可ですか？`;
  expect(resolveConfirmationContext({ customerMessage: msg }).object).toBe("ペット飼育の可否");
  expect(turn(msg).cust.kind).toBe("question");
});
it("スタッフの質問に画像だけで返した（書類の写真）→ 回答", () => {
  const { cust } = turn("[画像] 運転免許証", "本人確認書類のお写真お送り頂けますでしょうか？");
  expect(cust.kind).toBe("answer");
});
it("スタンプだけは今まで通り了承", () => expect(turn("[スタンプ]").sub.isAckOnly).toBe(true));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
