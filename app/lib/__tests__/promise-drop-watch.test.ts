// npx tsx app/lib/__tests__/promise-drop-watch.test.ts
// 2026-11-21 作業員L: 約束の取りこぼしの見張り（本番で見つけた3件の形・こちらの約束の文はそのまま・お客様の文は作った物）
import assert from "node:assert/strict";
import { promiseDropOf, promiseDropKindOf, buildPromiseDropPost, promiseDropDue, promiseDropWatchMode, type PdInput } from "../promise-drop-watch";

const H = 36e5, T0 = Date.parse("2026-10-23T05:37:53Z");
const at = (h: number) => new Date(T0 + h * H).toISOString();
const base = (over: Partial<PdInput> = {}): PdInput => ({ conversationId: "44fd59ab-xxxx", customerName: "テスト", status: "proposing", msgs: [], aix: [], sent: [], items: [], picks: [], ...over });

// スイッチ: 既定は記録だけ
assert.equal(promiseDropWatchMode({}), "shadow");
assert.equal(promiseDropWatchMode({ PROMISE_DROP_WATCH: "on" }), "on");
assert.equal(promiseDropWatchMode({ PROMISE_DROP_WATCH: "off" }), "off");

// 約束の言葉（本番の3件の形）
assert.equal(promiseDropKindOf("永成さんお世話になっております！！\nかしこまりました！！\n門真・四條畷・茨木周辺全域から5万〜6.5万円以内・1K〜1DKでオススメできるお部屋ピックアップしてお送りさせて頂きます！！"), "pickup");
assert.equal(promiseDropKindOf("かしこまりました！！\n若江岩田・八戸の里周辺も含めて、ペット2匹飼育可能なお部屋を新たにピックアップしてお送りさせて頂きます！！"), "pickup");
assert.equal(promiseDropKindOf("お送り頂きました2件、募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！"), "check");
assert.equal(promiseDropKindOf("引き続き新着でオススメ出来るお部屋随時確認させて頂きます！！"), null); // 新着を随時は期日が無い
assert.equal(promiseDropKindOf("ご査収頂きありがとうございます！！"), null);

const promise = { sender: "staff", text: "門真・四條畷・茨木周辺全域からお部屋ピックアップしてお送りさせて頂きます！！", created_at: at(0), is_aix_generated: false };

// 44fd59ab の形: 約束の後お客様も黙り、何も送っていない（29日）→ 出る
const now29 = T0 + 29 * 24 * H;
const d = promiseDropOf(base({ msgs: [promise] }), now29);
assert.ok(d);
assert.equal(d!.kind, "pickup");
assert.equal(d!.days, 29);
assert.equal(d!.customerSpokeAfter, false);

// 83391dda の形: お礼が1回・要対応を取り下げ・後から候補 → 出る（印つき）
const d2 = promiseDropOf(base({ msgs: [promise, { sender: "customer", text: "ありがとうございます", created_at: at(1) }], items: [{ action: "property_send", status: "dismissed", created_at: at(1) }], picks: [{ created_at: at(240), status: "pending", sent_at: null, expired_at: null }] }), T0 + 15 * 24 * H);
assert.ok(d2);
assert.equal(d2!.customerSpokeAfter, true);
assert.equal(d2!.dismissedAfter, 1);
assert.equal(d2!.readyPicksAfter, 1);

// 72時間の前は出ない／30日を過ぎたら出ない
assert.equal(promiseDropOf(base({ msgs: [promise] }), T0 + 71 * H), null);
assert.equal(promiseDropOf(base({ msgs: [promise] }), T0 + 31 * 24 * H), null);
// 物件の AIX・送付で果たした → 出ない
assert.equal(promiseDropOf(base({ msgs: [promise], aix: [{ aix_type: "property_send", sent_at: at(20), created_at: at(20) }] }), now29), null);
assert.equal(promiseDropOf(base({ msgs: [promise], sent: [{ sent_at: at(30) }] }), now29), null);
// 約束の前の AIX は果たした事にならない
assert.ok(promiseDropOf(base({ msgs: [promise], aix: [{ aix_type: "property_send", sent_at: at(-5), created_at: at(-5) }] }), now29));
// お客様が他で決めた・申込以降 → 出ない
assert.equal(promiseDropOf(base({ msgs: [promise, { sender: "customer", text: "他で決まりました！ありがとうございました", created_at: at(5) }] }), now29), null);
assert.equal(promiseDropOf(base({ status: "applying", msgs: [promise] }), now29), null);
// AIX の文（is_aix_generated）は約束に数えない
assert.equal(promiseDropOf(base({ msgs: [{ ...promise, is_aix_generated: true }] }), now29), null);

// 11/21 本番の試しで直した: お客様の「部屋決まった」・こちらの締め → 出ない／「ピックアップ出来次第お送り」も約束
assert.equal(promiseDropOf(base({ msgs: [promise, { sender: "customer", text: "別のところで部屋決まったので大丈夫です", created_at: at(5) }] }), now29), null);
assert.equal(promiseDropOf(base({ msgs: [promise, { sender: "staff", text: "ご丁寧にご連絡いただきありがとうございます！！\n無事お部屋決まりよかったです！！\nまたお引越しの機会がございましたら何時でもお気軽にご連絡ください😊！！", created_at: at(6), is_aix_generated: false }] }), now29), null);
assert.equal(promiseDropKindOf("本庄西・天六・中津周辺を中心に、Aさんにオススメできるお部屋のピックアップ出来次第お送りさせて頂きます！！"), "pickup");

// 確認の約束は手打ちで結果を伝えても果たした
const chk = { sender: "staff", text: "お送り頂きました2件、募集状況確認させて頂きます！！", created_at: at(0), is_aix_generated: false };
assert.equal(promiseDropOf(base({ msgs: [chk, { sender: "staff", text: "サンライトあべの202号室ですが、管理会社より募集終了とのご連絡がございました", created_at: at(20), is_aix_generated: false }] }), now29), null);
assert.ok(promiseDropOf(base({ msgs: [chk] }), now29));

// 文の形: 「〇〇さん → AIX【ボタン】」（feedback_group_aix_only）
const post = buildPromiseDropPost([d!, d2!], now29)!;
assert.ok(post.startsWith("【AIX要対応・お約束した物件がまだ届いていません】"));
assert.ok(/・テストさん → AIX【[^】]+】（お約束から29日）/.test(post), post);
assert.ok(post.includes("候補1件あり・要対応を外した後"), post);
assert.equal(buildPromiseDropPost([], now29), null);

// 1日1回（JST の日付）
assert.equal(promiseDropDue(null, now29), true);
assert.equal(promiseDropDue(new Date(now29 - 2 * H).toISOString(), now29), false);
assert.equal(promiseDropDue(new Date(now29 - 30 * H).toISOString(), now29), true);

console.log("promise-drop-watch: ok");
