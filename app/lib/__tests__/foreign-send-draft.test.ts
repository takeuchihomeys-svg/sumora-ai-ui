// 2026-10-20 竹内さん（12:42「文を送ったのにまだ下書きに同じのが出ている」）: 別の画面の送信で、この画面の入力欄の古い下書きを空にする判定
// 実行: npx tsx app/lib/__tests__/foreign-send-draft.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { decideForeignSendDraft, isSameDraftFamily, foreignSendClearEnabled, OWN_SEND_WINDOW_MS } from "../foreign-send-draft";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 本番の形（10/20 12:39〜12:41 JST・物件名は言い換え）: 下書き3行 → 別のタブで3行目（ご査収）を消して送った
const DRAFT = "かしこまりました😊！！\nサンプル難波 406号室の初期費用、最大限割引させて頂いた御見積書を作成しお送りさせて頂きます！！\nお手隙の際にご査収ください😌！！";
const SENT = "かしこまりました😊！！\nサンプル難波 406号室の初期費用、最大限割引させて頂いた御見積書を作成しお送りさせて頂きます！！";
const NOW = Date.parse("2026-10-20T03:41:11.500Z");
const AT = "2026-10-20T03:41:10.889Z";
const base = { replyDraft: DRAFT, draftIsAi: true, staffText: SENT, staffAt: AT, ownInsertAtMs: null, sending: false, nowMs: NOW };

console.log("decideForeignSendDraft");
it("本番の形: 別のタブが直して送った → 直していない AI の下書きは消す", () => eq(decideForeignSendDraft(base), "clear"));
it("AI の印が外れていても（手で触った）送った文とほぼ同じなら消す", () => eq(decideForeignSendDraft({ ...base, draftIsAi: false }), "clear"));
it("手で書いた別の文は消さずに知らせる", () => eq(decideForeignSendDraft({ ...base, draftIsAi: false, replyDraft: "明日の内覧のお時間は何時頃がよろしいでしょうか？" }), "notice"));
it("入力欄が空なら何もしない", () => eq(decideForeignSendDraft({ ...base, replyDraft: "  " }), "keep"));
it("この画面が送っている途中は触らない", () => eq(decideForeignSendDraft({ ...base, sending: true }), "keep"));
it("この画面が直前に入れた通（自分の送信）は触らない", () => eq(decideForeignSendDraft({ ...base, ownInsertAtMs: NOW - 3_000 }), "keep"));
it("自分の送信から時間が経っていれば別の画面の送信として扱う", () => eq(decideForeignSendDraft({ ...base, ownInsertAtMs: NOW - OWN_SEND_WINDOW_MS - 1 }), "clear"));
it("古い通（3分より前）が後から届いても触らない", () => eq(decideForeignSendDraft({ ...base, staffAt: "2026-10-20T03:30:00.000Z" }), "keep"));
it("画像だけの送信は消さずに知らせる（文と一緒に送るつもりの事がある）", () => eq(decideForeignSendDraft({ ...base, staffText: "[画像]" }), "notice"));
it("時刻が読めなくても判定は続ける", () => eq(decideForeignSendDraft({ ...base, staffAt: null }), "clear"));

console.log("isSameDraftFamily");
it("1行消して送った", () => eq(isSameDraftFamily(DRAFT, SENT), true));
it("1行足して送った", () => eq(isSameDraftFamily(SENT, DRAFT), true));
it("絵文字・！！の違いは同じ", () => eq(isSameDraftFamily("承知しました😊！！確認いたします！！", "承知しました！確認いたします"), true));
it("短い一部だけ重なる別の文は違う", () => eq(isSameDraftFamily(DRAFT, "かしこまりました😊！！"), false));
it("全く別の文は違う", () => eq(isSameDraftFamily(DRAFT, "明日の内覧は10時でお願いします"), false));
it("空は違う", () => eq(isSameDraftFamily("", SENT), false));

console.log("foreignSendClearEnabled");
it("既定は on", () => eq(foreignSendClearEnabled(undefined), true));
it("off で止まる", () => eq(foreignSendClearEnabled(" OFF "), false));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
