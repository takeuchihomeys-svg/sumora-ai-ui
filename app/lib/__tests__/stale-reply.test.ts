// 2026-10-20 竹内さん（設計知見 P1 54ec8c71・すれ違い／P1 d3fe3a9f・お客様の文のオウム返し）
// 実行: npx tsx app/lib/__tests__/stale-reply.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { latestCustomerAtOf, newerCustomerMessageSince, nextComposerBase, isNewerThanBase, staleGuardEnabled, isTrivialAckText, ackExemptEnabled } from "../stale-reply";
import { isCustomerEcho, normalizeForEcho, draftEchoGuardEnabled } from "../draft-echo";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 本番の形（10/19 21:00〜21:08 JST・中身は伏せた言い換え）: お客様の質問 → スタッフの画像 → お客様の取り消し → 前の質問への答えが送られた
const Q_AT = "2026-10-19T12:00:28.706Z";
const IMG_AT = "2026-10-19T12:04:19.608Z";
const NEW_AT = "2026-10-19T12:08:12.851Z";
const msgs = [
  { sender: "customer", text: "すぐ埋まっちゃう感じですかね？埋まるようなら別の所を探してもらおうかと", rawCreatedAt: Q_AT },
  { sender: "staff", text: "[画像]", rawCreatedAt: IMG_AT },
  { sender: "customer", text: "すみません他お願いします。", rawCreatedAt: NEW_AT },
];

console.log("stale-reply（すれ違い）");
it("一番新しいお客様の発言の時刻", () => eq(latestCustomerAtOf(msgs), NEW_AT));
it("スタッフの発言は数えない", () => eq(latestCustomerAtOf(msgs.slice(0, 2)), Q_AT));
it("実例: 質問の時に書き始めた文 → 送る時に「他お願いします」が新しい", () => {
  eq(newerCustomerMessageSince(msgs, Q_AT), { at: NEW_AT, text: "すみません他お願いします。" });
});
it("土台が最新なら新しい発言なし", () => eq(newerCustomerMessageSince(msgs, NEW_AT), null));
it("同じ秒の書き込みの丸め（1秒以内は新しいとしない）", () => eq(newerCustomerMessageSince(msgs, "2026-10-19T12:08:12.100Z"), null));
it("土台が無い・読めない時は止めない", () => { eq(newerCustomerMessageSince(msgs, null), null); eq(newerCustomerMessageSince(msgs, "x"), null); });
it("createdAt でも読める", () => eq(newerCustomerMessageSince([{ sender: "customer", text: "a", createdAt: NEW_AT }], Q_AT)?.at, NEW_AT));
it("入力欄: 空→文で土台を取る", () => eq(nextComposerBase(null, "下書き", Q_AT), Q_AT));
it("入力欄: 文のまま新しい発言が来ても土台は動かない", () => eq(nextComposerBase(Q_AT, "下書き（編集中）", NEW_AT), Q_AT));
it("入力欄: 空に戻ったら外す", () => eq(nextComposerBase(Q_AT, "  ", NEW_AT), null));
it("時刻2つの判定", () => { eq(isNewerThanBase(NEW_AT, Q_AT), true); eq(isNewerThanBase(Q_AT, NEW_AT), false); eq(isNewerThanBase(null, Q_AT), false); });
it("旗: 既定 on・off で止める", () => { eq(staleGuardEnabled(undefined), true); eq(staleGuardEnabled("OFF"), false); eq(staleGuardEnabled("on"), true); });

console.log("stale-reply（短いお礼・了承だけは確かめを出さない）");
for (const t of ["はい", "はーい！", "ありがとうございます😊", "了解です！", "よろしくお願いします。", "承知しました", "[スタンプ]", "🙇‍♂️", "はい、ありがとうございます！", "ありがとうございます、よろしくお願いします", "OKです", "了解ですw"]) {
  it(`お礼・了承だけ: ${t}`, () => eq(isTrivialAckText(t), true));
}
for (const t of ["すみません他お願いします。", "お願いします", "大丈夫です", "はい、内見できますか？", "ありがとうございます！他にもありますか？", "[画像]", "", "はいはいはいはいはいはいはいはい", "ありがとうございます。キャンセルでお願いします", "了解です。やっぱり別のエリアで"]) {
  it(`迷う物は出す側: ${JSON.stringify(t)}`, () => eq(isTrivialAckText(t), false));
}
it("お礼だけの新しい発言は数えない（skipTrivialAck）", () => {
  const m2 = [...msgs, { sender: "customer", text: "ありがとうございます！", rawCreatedAt: "2026-10-19T12:09:00.000Z" }];
  eq(newerCustomerMessageSince(m2, NEW_AT, { skipTrivialAck: true }), null);
  eq(newerCustomerMessageSince(m2, NEW_AT)?.at, "2026-10-19T12:09:00.000Z");
});
it("お礼の前に本当の依頼があればそれを返す", () => {
  const m2 = [...msgs, { sender: "customer", text: "はい", rawCreatedAt: "2026-10-19T12:09:00.000Z" }];
  eq(newerCustomerMessageSince(m2, Q_AT, { skipTrivialAck: true })?.at, NEW_AT);
});
it("旗: お礼の除外は既定 on", () => { eq(ackExemptEnabled(undefined), true); eq(ackExemptEnabled("off"), false); });

console.log("draft-echo（お客様の文と同じ下書き）");
it("実例: 『他はないですか？』の下書きは止める", () => eq(isCustomerEcho("他はないですか？", ["他はないですか？"]), true));
it("句読点・絵文字・空白の違いだけでも止める", () => eq(isCustomerEcho(" 他はないですか😊！！", ["他はないですか？"]), true));
it("お客様の文に少し足しただけ（オウム返し）も止める", () => eq(isCustomerEcho("他はないですか？ですね", ["他はないですか？"]), true));
it("ちゃんとした返事は止めない", () => eq(isCustomerEcho("かしこまりました！！\n他にも条件に合うお部屋ピックアップしお送りさせて頂きます😊！！", ["他はないですか？"]), false));
it("連投をつないだ物と同じなら止める", () => eq(isCustomerEcho("見積ありがとうございます他はないですか", ["見積ありがとうございます", "他はないですか？"]), true));
it("短いお客様の文（4字未満）は含むだけでは止めない", () => eq(isCustomerEcho("はい😊！！\n何卒よろしくお願い致します！！", ["はい"]), false));
it("下書きが空・お客様の文が無い時は止めない", () => { eq(isCustomerEcho("", ["他はないですか？"]), false); eq(isCustomerEcho("他はないですか？", []), false); });
it("そろえ: 全角英数・記号", () => eq(normalizeForEcho("ＡＢＣ！？ 「１」"), "abc1"));
it("旗: 既定 on", () => { eq(draftEchoGuardEnabled(undefined), true); eq(draftEchoGuardEnabled("off"), false); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
