// app/lib/__tests__/viewed-state-line.test.ts — #739 内覧後の駅の状態（事実だけ・VIEWED_STATE_LINE）。文は作り物
import assert from "node:assert/strict";
import { viewedStateLine, viewedStateLineOn } from "../viewed-state-line";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  OK  " + name); } catch (e) { fail++; console.log("  NG  " + name + "\n      " + (e as Error).message); } };
const NOW = Date.parse("2026-11-28T12:00:00+09:00");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

t("既定 off", () => { assert.equal(viewedStateLineOn({}), false); assert.equal(viewedStateLineOn({ VIEWED_STATE_LINE: "on" }), true); });
t("内覧の日が分からなければ出さない", () => assert.equal(viewedStateLine({ msgs: [], viewedAt: null, nowMs: NOW }), ""));
t("内覧の後: 良い感想・申込の意思・問い・まだ申込のご案内なし", () => {
  const l = viewedStateLine({ viewedAt: ago(30), nowMs: NOW, msgs: [
    { sender: "customer", text: "とても良かったです！申し込みしたいのですが審査はどのくらいかかりますか？", created_at: ago(2) },
    { sender: "staff", text: "本日はありがとうございました！！", created_at: ago(29) },
  ] });
  assert.match(l, /1日前に済んだ/);
  assert.match(l, /申込の意思の言葉あり/);
  assert.match(l, /良い感想の言葉あり/);
  assert.match(l, /問いあり/);
  assert.match(l, /まだ申込のご案内を送っていない/);
});
t("迷いの言葉と、こちらが申込のご案内を送った事", () => {
  const l = viewedStateLine({ viewedAt: ago(5), nowMs: NOW, msgs: [
    { sender: "customer", text: "少し狭かったので検討します", created_at: ago(1) },
    { sender: "staff", text: "お気に召されましたらお申込みでお部屋抑えさせて頂きます！！", created_at: ago(4) },
  ] });
  assert.match(l, /今日に済んだ/);
  assert.match(l, /気になる点・迷いの言葉あり/);
  assert.match(l, /申込のご案内を送った/);
  assert.doesNotMatch(l, /申込の意思の言葉あり/);
});
t("内覧の前の通は数えない・何をするかは書かない", () => {
  const l = viewedStateLine({ viewedAt: ago(5), nowMs: NOW, msgs: [{ sender: "customer", text: "申し込みたいです", created_at: ago(10) }] });
  assert.match(l, /その後のお客様の通はまだ無い/);
  assert.doesNotMatch(l, /お誘い|すべき|して下さい|送る番/);
});
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
