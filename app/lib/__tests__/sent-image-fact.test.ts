// npx tsx app/lib/__tests__/sent-image-fact.test.ts
// 2026-11-24 作業員L（台帳 #672・SENT_IMAGE_FACT 既定 off）: 照合できた手の画像の送付を行動台帳の物件の送付に残し、約束の【必ず】の行を閉じる
import assert from "node:assert/strict";
import { sentImageFactOn, staffImageSentEntry } from "../sent-image-fact";
import { planPromiseCompletion } from "../promise-calendar";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const base = { source: "staff_image", matched: true, sentProperties: "inserted", propertyName: "テストハイツ", roomNo: "203" };

t("既定は off・=on で使う", () => {
  assert.equal(sentImageFactOn({}), false);
  assert.equal(sentImageFactOn({ SENT_IMAGE_FACT: "on" }), true);
});

t("照合できた手の画像を新しく書いた時だけ物件の送付にする", () => {
  const e = staffImageSentEntry(base);
  assert.equal(e?.kind, "properties_sent");
  assert.equal(e?.status, "done");
  assert.deepEqual(e?.detail?.propertyNames, ["テストハイツ 203号室"]);
  assert.equal(staffImageSentEntry({ ...base, roomNo: "" })?.detail?.propertyNames?.[0], "テストハイツ");
});

t("書かない: AIX の画像（recordAixFacts が書く）・照合できない画像・同じ物件の重ね・物件名なし", () => {
  assert.equal(staffImageSentEntry({ ...base, source: "aix:property_send" }), null);
  assert.equal(staffImageSentEntry({ ...base, source: "vision", matched: false }), null);
  assert.equal(staffImageSentEntry({ ...base, matched: false }), null);
  assert.equal(staffImageSentEntry({ ...base, sentProperties: "duplicate_skipped" }), null);
  assert.equal(staffImageSentEntry({ ...base, propertyName: " " }), null);
});

t("この送付で開いている【必ず】物件ピックアップ送付の行が閉じる（手打ちの送付と同じ決まり・保証会社の確認は閉じない）", () => {
  const e = staffImageSentEntry(base)!;
  const open = [
    { id: 1, event_type: "property_send", notes: "【必ず】物件ピックアップ送付【今日中】\n約束: 「…」", is_done: false },
    { id: 2, event_type: "follow_up", notes: "【必ず】保証会社の確認→ご連絡\n約束: 「…」", is_done: false },
  ];
  const ids = planPromiseCompletion([{ kind: e.kind, object: null, checkPattern: null, propertyNames: e.detail?.propertyNames ?? null } as never], open);
  assert.deepEqual(ids, [1]);
});

console.log(`sent-image-fact: ${n} ok`);
