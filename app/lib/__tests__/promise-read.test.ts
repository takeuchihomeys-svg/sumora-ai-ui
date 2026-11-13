// 約束の読みを1つに（app/lib/promise-read.ts）と、各所が同じ答えを出すかのテスト
// 実行: npx tsx app/lib/__tests__/promise-read.test.ts
import { readPromises, openPromises, lastOpenPromise, isPromiseSentence, promiseReadKindOf, promiseReadUnifiedOn, type PromiseWhenKind } from "../promise-read";
import { openPromiseAt } from "../conductor-focus";
import { ourSideBlock } from "../conductor-our-side";
import { buildExchangeLedger } from "../exchange-ledger";
import { classifySentence } from "../writing-blueprint";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };
const T = (h: number) => new Date(Date.parse("2026-11-12T00:00:00Z") + h * 36e5).toISOString();
const S = (h: number, text: string) => ({ sender: "staff", text, created_at: T(h), is_aix_generated: false });
const C = (h: number, text: string) => ({ sender: "customer", text, created_at: T(h) });

ok("既定 off", !promiseReadUnifiedOn({}) && promiseReadUnifiedOn({ PROMISE_READ_UNIFIED: "on" }));
// 種類の名前（作業員19 の promise-deadline-words と同じ文字列）
const when: Array<[string, PromiseWhenKind]> = [
  ["オススメできるお部屋ピックアップしてお送りさせて頂きます！！", "pickup"],
  ["引き続き新着でオススメ出来るお部屋募集に出次第お送りさせて頂きます！", "new_arrival"],
  ["お送り頂きました物件の募集状況確認させて頂きます😊！！", "check_vacancy"],
  ["駐車場を平置きに出来るか、管理会社に確認させて頂きます！", "check_mgmt"],
  ["初期費用の交渉させて頂きます！！", "negotiate"],
  ["最大限割引した初期費用の御見積書を作成しお送りさせて頂きます！！", "estimate"],
];
for (const [s, k] of when) ok(`種類 ${k}`, promiseReadKindOf(s) === k, `${s} → ${promiseReadKindOf(s)}`);
ok("約束の文の判定（お願いは約束でない）", isPromiseSentence("募集状況確認させて頂きます！") && !isPromiseSentence("お送りの程よろしくお願い致します"));

{ // q371 の形: 確認と見積の約束→AIX で果たす
  const msgs = [C(0, "上記の物件はまだ空いておりますか？"), S(0.5, "お送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第、最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！")];
  const before = openPromises({ msgs, nowMs: Date.parse(T(26)) });
  ok("開いている: 募集状況の確認・見積書", before.map((p) => p.kind).sort().join() === "check_vacancy,estimate", JSON.stringify(before.map((p) => p.kind)));
  const aix = [{ aix_type: "property_check_result", created_at: T(5), sent_at: T(5) }, { aix_type: "estimate_sheet", created_at: T(5.1), sent_at: T(5.1) }];
  const after = readPromises({ msgs, aix, nowMs: Date.parse(T(26)) });
  ok("AIX で果たした（誰が・いつ）", after.every((p) => p.fulfilled && p.fulfilledBy === "aix" && !!p.fulfilledAt), JSON.stringify(after));
  ok("開いている約束なし", lastOpenPromise({ msgs, aix, nowMs: Date.parse(T(26)) }) === null);
}
{ // 文で果たした（募集中となります）
  const msgs = [S(0, "募集状況確認させて頂きます！"), S(3, "こちらのお部屋現在も募集中となります😊！！")];
  ok("文で果たした", readPromises({ msgs, nowMs: Date.parse(T(4)) })[0]?.fulfilledBy === "text");
}
{ // お客様次第・管理会社への連絡だけは開いている約束にしない
  const msgs = [S(0, "お気に召されましたらご案内させて頂きます！"), S(0.1, "管理会社にお伝え致します！")];
  const r = readPromises({ msgs, nowMs: Date.parse(T(1)) });
  ok("お客様次第は customer_turn", r.some((p) => p.by === "customer_turn"), JSON.stringify(r));
  ok("開いている約束にしない", openPromises({ msgs, nowMs: Date.parse(T(1)) }).length === 0, JSON.stringify(openPromises({ msgs, nowMs: Date.parse(T(1)) })));
}

// 各所が同じ答えを出す（PROMISE_READ_UNIFIED=on）
process.env.PROMISE_READ_UNIFIED = "on";
{
  const msgs = [C(0, "上記の物件はまだ空いておりますか？"), S(0.5, "お送り頂きました物件の募集状況確認させて頂きます😊！！"), C(2, "よろしくお願いします")];
  // 物件の AIX（別件の物件送付）は確認の約束を果たさない＝旧の ourSideBlock は果たした扱い（FULFIL に property_send）だった
  const aix = [{ aix_type: "property_send", created_at: T(1), sent_at: T(1) }];
  const now = Date.parse(T(2)) + 1;
  const u = lastOpenPromise({ msgs, aix, nowMs: now });
  ok("正: 確認の約束は開いている", u?.kind === "check_vacancy", JSON.stringify(u));
  ok("conductor-focus も開いている", !!openPromiseAt([...msgs.map((m) => ({ ...m })), { sender: "staff", text: null, created_at: T(1), aixType: "property_send" }].sort((a, b) => a.created_at.localeCompare(b.created_at))));
  ok("conductor-our-side も開いている（同じ種類の名前）", /開いている約束: 募集状況の確認の約束/.test(ourSideBlock({ msgs, aix, nowMs: now })), ourSideBlock({ msgs, aix, nowMs: now }));
  const l = buildExchangeLedger({ msgs, aix, nowMs: now });
  ok("照らし合わせ表も開いている", l.open.some((x) => x.kind === "our_promise_unkept" && /募集状況の確認/.test(x.what)), JSON.stringify(l.open));
  ok("書き手の設計図も約束の段", classifySentence("お送り頂きました物件の募集状況確認させて頂きます😊！！") === "promise");
}
delete process.env.PROMISE_READ_UNIFIED;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
