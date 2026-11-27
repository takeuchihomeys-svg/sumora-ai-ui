// app/lib/__tests__/silent-since-ours.test.ts — #805 こちらの連絡の後の返事の止まり（事実だけ・SILENT_SINCE_OURS_LINE）
import assert from "node:assert/strict";
import { silentSinceOursLine, silentSinceOursOn } from "../silent-since-ours";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  OK  " + name); } catch (e) { fail++; console.log("  NG  " + name + "\n      " + (e as Error).message); } };
const NOW = Date.parse("2026-11-28T10:00:00+09:00");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const msgs = (staffText: string, h: number) => [
  { sender: "staff", text: staffText, created_at: ago(h) },
  { sender: "customer", text: "ありがとうございます", created_at: ago(h + 1) },
];

t("既定 off", () => { assert.equal(silentSinceOursOn({}), false); assert.equal(silentSinceOursOn({ SILENT_SINCE_OURS_LINE: "on" }), true); });
t("24〜48時間の止まり・最後がこちら・約束でない → 事実の1行", () => {
  const l = silentSinceOursLine(msgs("こちらのお部屋いかがでしょうか！", 30), NOW);
  assert.match(l, /お客様の返事が1日ありません/);
  assert.match(l, /約束ではありません/);
});
t("割合・何をするかは書かない（決め直させない）", () => {
  const l = silentSinceOursLine(msgs("いかがでしょうか", 30), NOW);
  assert.doesNotMatch(l, /%|割|戻り|追う|お送りする|ご案内する/);
});
t("24時間未満・48時間以上・最後がお客様・約束の後は出さない", () => {
  assert.equal(silentSinceOursLine(msgs("いかがでしょうか", 10), NOW), "");
  assert.equal(silentSinceOursLine(msgs("いかがでしょうか", 50), NOW), "");
  assert.equal(silentSinceOursLine([...msgs("いかがでしょうか", 30)].reverse(), NOW), "");
  assert.equal(silentSinceOursLine(msgs("募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます", 30), NOW), "");
});
t("お客様の通が1つも無い会話は出さない", () => {
  assert.equal(silentSinceOursLine([{ sender: "staff", text: "いかがでしょうか", created_at: ago(30) }], NOW), "");
});
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
