// scripts/test-build-hook-ledger.ts — 刺さりの台帳の純関数（伏せ方・型の分け方・数え）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-build-hook-ledger.ts
import assert from "node:assert/strict";
import { propertyNamesOf, maskLedgerText, classifyRow, aggregate, type LedgerRow } from "./build-hook-ledger";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const id = (x: string) => x;

t("物件名を拾って3つの文の全部で伏せる", () => {
  const send = "🌟エグゼ難波西Ⅱ 202号室\nリビング13帖と広く開放感抜群のお部屋となります！！";
  const names = propertyNamesOf(send, "エグゼ難波西Ⅱかなり気に入っています", "エグゼ難波西Ⅱ202号室お申込しお部屋抑えさせて頂きます");
  assert.ok(names.some((x) => x.includes("エグゼ難波西")), JSON.stringify(names));
  const c = maskLedgerText("エグゼ難波西Ⅱかなり気に入っています！田中さん", id, names);
  assert.doesNotMatch(c, /エグゼ/);
  assert.doesNotMatch(c, /田中さん/);
});

t("型の分け方: 刺さる点と刺さらない点が重なる・他の候補を頼む", () => {
  const r = classifyRow("🌟〈物件〉 502号室\n洋室8帖と広いお部屋となります！！", "広くて綺麗ですね！一旦見てみたいです！場所が少し遠い気もしてて、他にも候補ありましたらお願いしたいです", "かしこまりました！！駅近のお部屋を新たにピックアップしてお送りさせて頂きます！！");
  assert.ok(r.combos.includes("ask_other"));
  assert.equal(r.move.dest, "keep_send");
});

t("型の分け方: 取られる不安・比べている", () => {
  const r = classifyRow("🌟〈物件〉 502号室", "かなり気に入っています。他にもっと合う部屋があるかもしれないけど取られるのが不安です", "よろしければ先にお申込みでお部屋を抑えた状態でご内覧頂くのがオススメです！！保証会社の審査通過まではキャンセル料かかりません");
  assert.ok(r.combos.includes("taken_worry") && r.combos.includes("comparing"));
  assert.equal(r.hook, "hooked");
  assert.equal(r.move.dest, "apply");
  assert.equal(r.move.strength, "strong");
});

t("数え: 5未満の型に印・捨てない", () => {
  const base = classifyRow("🌟〈物件〉 502号室", "綺麗ですね！ここ！", "お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！");
  const row: LedgerRow = { conv: "x", sentAt: "", customerAt: "", send: "", customer: "綺麗ですね！ここ！", reply: "", replyIsAix: false, ...base };
  const ag = aggregate([row, row]);
  assert.equal(ag.length, 1);
  assert.equal(ag[0].n, 2);
  assert.equal(ag[0].small, true);
});

console.log(`全部 ${n} 件 ok`);
