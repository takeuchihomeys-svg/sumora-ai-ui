// お客様自身の事情で借りられるかの問い（2026-11-05 作業員7・q332）
// 実行: npx tsx app/lib/__tests__/own-situation-question.test.ts
import { isOwnSituationRentQuestion, ownSituationNotVacancyOn } from "../own-situation-question";
import { detectAixSceneEvidence } from "../aix-scene-evidence";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

t("既定 off", ownSituationNotVacancyOn({}) === false && ownSituationNotVacancyOn({ OWN_SITUATION_NOT_VACANCY: "on" }) === true);
// q332 の実物（名前は無い）
t("q332: 無職＋紹介は可能でしょうか＝事情の問い", isOwnSituationRentQuestion("ありがとうございます。\n\nこちらの物件への申込みを検討しております。\n\n現在は無職で、フリマアプリでの商品売買を主な収入源として生活しております。預貯金は200万円ほどで、2年間一人暮らしを継続しております。\n\nこのような状況でも、こちらの物件をご紹介いただくことは可能でしょうか？"));
t("夜職＋契約できますか＝事情の問い", isOwnSituationRentQuestion("学生で夜職なのですが、私個人で契約ってできますかね"));
t("空き・募集の言葉があれば空室の問いのまま", !isOwnSituationRentQuestion("無職なんですけど、この物件まだ空いてますか？"));
t("事情の語が無い＝事情の問いではない", !isOwnSituationRentQuestion("こちらの物件は紹介いただくことは可能でしょうか？"));
t("事情だけで問いが無い＝違う", !isOwnSituationRentQuestion("今は無職です。よろしくお願いします"));
t("空の文", !isOwnSituationRentQuestion(""));

// 配線（場面の網）: q332 の文＋送った物件1件で、off は空室の問い・on は空室の問いにしない
{
  const q = "現在は無職で、フリマアプリでの商品売買を主な収入源として生活しております。\nこのような状況でも、こちらの物件をご紹介いただくことは可能でしょうか？";
  const prev = process.env.OWN_SITUATION_NOT_VACANCY;
  delete process.env.OWN_SITUATION_NOT_VACANCY;
  const off = detectAixSceneEvidence({ latestCustomerTurn: q, hasCustomerImage: false, sentPropertyCount: 1 });
  process.env.OWN_SITUATION_NOT_VACANCY = "on";
  const on = detectAixSceneEvidence({ latestCustomerTurn: q, hasCustomerImage: false, sentPropertyCount: 1 });
  if (prev == null) delete process.env.OWN_SITUATION_NOT_VACANCY; else process.env.OWN_SITUATION_NOT_VACANCY = prev;
  t("配線 off: 空室の問い（今まで通り）", off?.reasonCode === "availability_question", off);
  t("配線 on: 空室の問いにしない", on?.reasonCode !== "availability_question", on);
}

console.log(`\nown-situation-question: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
