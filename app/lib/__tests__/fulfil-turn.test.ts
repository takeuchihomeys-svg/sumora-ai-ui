// 約束を果たす番の見分け（作業員M 2026-11-21・台帳 #405）
// 実行: npx tsx app/lib/__tests__/fulfil-turn.test.ts
import { brainFulfilTurnOn, fulfilTurnOf, fulfilTurnBrainText, isFulfilAck } from "../fulfil-turn";
import type { OpenPromise } from "../promise-tracker";
export {};
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) pass++; else { fail++; console.error("NG", n, x ?? ""); } };
const P = (kind: OpenPromise["kind"], elapsedH: number, sentence = "ミナミ・島之内周辺全域からオススメできるお部屋ピックアップしてお送りさせて頂きます！！"): OpenPromise =>
  ({ kind, sentence, at: "2026-11-21T00:00:00Z", elapsedH, hasDeadline: false, status: "期限内" });

ok("既定 off", !brainFulfilTurnOn({}) && brainFulfilTurnOn({ BRAIN_FULFIL_TURN: "on" }));
ok("off は空文字（プロンプトは変わらない）", fulfilTurnBrainText({ shortAck: true, open: [P("物件探し", 0.3)] }, {}) === "");
// q447 の形: ピックアップの約束（18分前）→「かしこまりました！」
const q447 = fulfilTurnOf({ shortAck: true, open: [P("物件探し", 0.3)] });
ok("q447: 了承だけ＋ピックアップの約束＝物件を送る", q447?.aix === "property_send" && q447.kind === "物件探し", q447);
ok("1塊に約束の引用と果たす物", fulfilTurnBrainText({ shortAck: true, open: [P("物件探し", 0.3)] }, { BRAIN_FULFIL_TURN: "on" }).includes("AIX【物件を送る】"));
ok("見積書の約束＝見積書", fulfilTurnOf({ shortAck: true, open: [P("見積書", 2, "御見積書を作成しお送りさせて頂きます！！")] })?.aix === "estimate_sheet");
ok("了承でない番（問い・依頼）は作らない", fulfilTurnOf({ shortAck: false, open: [P("物件探し", 0.3)] }) === null);
ok("確認の約束（管理会社の答え待ち）は入れない", fulfilTurnOf({ shortAck: true, open: [P("確認", 0.5, "募集状況確認させて頂きます！！")] }) === null);
ok("24時間より前の約束は入れない", fulfilTurnOf({ shortAck: true, open: [P("物件探し", 30)] }) === null);
ok("新着待ちの約束は入れない", fulfilTurnOf({ shortAck: true, open: [{ ...P("物件探し", 1), status: "待ち（新着・審査の結果次第）" }] }) === null);
ok("近い方の約束を採る", fulfilTurnOf({ shortAck: true, open: [P("見積書", 5, "見積書をお送りします"), P("物件探し", 0.5)] })?.kind === "物件探し");
ok("了承の見分け（q447・q448・2d7548d5 の形）", isFulfilAck("〇〇かしこまりました！") && isFulfilAck("こちらこそ宜しくお願いいたします") && isFulfilAck("はい！お願いいたします") && !isFulfilAck("他にもありますか？") && !isFulfilAck("住吉区でも探して頂いてもいいですか") && !isFulfilAck("1LDK以上で家賃は8万以内で探して欲しいです"));
ok("お客様の文から了承を見る", fulfilTurnOf({ customerText: "こちらこそ宜しくお願いいたします", open: [P("物件探し", 0.5)] })?.aix === "property_send" && fulfilTurnOf({ customerText: "初期費用はいくらですか？", open: [P("物件探し", 0.5)] }) === null);
console.log(`fulfil-turn: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
