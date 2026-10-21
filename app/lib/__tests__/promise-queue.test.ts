// 2026-10-09 約束の並び（promise-queue.ts）と2段のまとめた約束（two-stage multiPromise）。こちらの文・お客様の連投は実物（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/promise-queue.test.ts
import { promisesInStaffText, buildPromiseQueue, nextPromiseAix, keepPromiseQueueItem, promiseQueueNote, pickupNeedSignals, promiseOrderFor, PROMISE_ORDER, PROMISE_QUEUE_NOTE_PREFIX, type QueueMsg, type QueueAixLog } from "../promise-queue";
import { resolveTwoStage, TWO_STAGE_MULTI_PROMISE_MAX } from "../two-stage";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 300))} to contain ${JSON.stringify(sub)}`); }
function not(s: string, sub: string) { if (s.includes(sub)) throw new Error(`expected not to contain ${JSON.stringify(sub)}`); }
// 既定 on（2026-10-09）
const kinds = (t: string) => promisesInStaffText(t, "2026-10-01T00:00:00.000Z").map((p) => p.kind).sort();

console.log("promisesInStaffText（竹内さんのまとめた約束）");
it("db3722 募集状況の確認＋御見積書（あわせて）", () => eq(kinds("かしこまりました！！\nウェルスクエア〇〇308号室の募集状況確認させて頂きます！！\n確認出来次第、敷金礼金無しの最大限割引させて頂いた初期費用の御見積書もあわせてお送りさせて頂きます😌！！"), ["check", "estimate"]));
it("ed7695 募集状況と初期費用まとめて確認＝確認＋見積", () => eq(kinds("かしこまりました！！\nお送り頂きましたお部屋の募集状況と初期費用まとめて確認させて頂きます😊！！\n確認出来次第お送りさせて頂きます！！"), ["check", "estimate"]));
it("ac7c7f 募集状況＋御見積書をご用意", () => eq(kinds("かしこまりました！！\nお送り頂きました物件の募集状況を確認させて頂きます！！\n他社様の28万円より抑えられるよう、最大限割引して御見積書をご用意いたします😊！！"), ["check", "estimate"]));
it("b3bae3 募集状況＋あわせてピックアップ", () => eq(kinds("募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！\nあわせて、ペット可・1DK・家賃8.5万円以内のお部屋もピックアップしてお送りさせて頂きます😌！！"), ["check", "pickup"]));
it("288d47 「初期費用御見積し送らせて頂きます」も見積の約束", () => eq(kinds("かしこまりました！！\n最大限割引しました初期費用御見積し送らせて頂きます😊！！"), ["estimate"]));
it("f29676 日程調整の約束＝内覧の日程", () => eq(kinds("かしこまりました！！\n日程調整させて頂き確認後明日午前中にご連絡させて頂きます😊！！"), ["viewing_check"]));
it("749c55 室内写真撮影しお送り", () => eq(kinds("現在まだ審査進捗がない状況となります！！\n月曜日に室内写真撮影しお送りさせて頂きます！！"), ["photo"]));
it("2c434b 「お時間厳しい場合…撮影しお送り」（条件つき）は約束にしない", () => eq(kinds("彼氏様お時間厳しい場合室内撮影写真と動画撮影しお送りさせて頂きます！！"), []));
it("報告だけ（約束なし）", () => eq(kinds("こちら〇〇の室内写真となります😊！！\nお手隙の際にご査収ください！！"), []));

console.log("buildPromiseQueue / nextPromiseAix（1本送ったら次）");
const T0 = "2026-10-05T01:00:00.000Z";
const msgs: QueueMsg[] = [
  { sender: "customer", text: "ここ空いてますか？\nあと初期費用も知りたいです\nhttps://suumo.jp/chintai/bc_1/", createdAt: T0 },
  { sender: "staff", text: "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます！！\nあわせて、ご内覧のお日にちも調整させて頂きます！！", createdAt: "2026-10-05T01:05:00.000Z" },
];
it("約束の直後: 次は 物件確認した・残り 内覧", () => {
  const q = buildPromiseQueue(msgs, [], Date.parse("2026-10-05T01:06:00.000Z"));
  const nx = nextPromiseAix(q, { nowMs: Date.parse("2026-10-05T01:06:00.000Z") });
  eq(nx?.next.action, "property_check_result"); eq(nx?.rest.map((s) => s.action), ["viewing_invite"]);
});
it("物件確認した（御見積書同封）を送った後: 次は 内覧日調整", () => {
  const logs: QueueAixLog[] = [{ aixType: "property_check_result", sentAt: "2026-10-05T03:00:00.000Z", estimateSent: true, text: "募集中となります！！最大限割引させて頂いた御見積書となります" }];
  const nx = nextPromiseAix(buildPromiseQueue(msgs, logs, Date.parse("2026-10-05T03:01:00.000Z")), { nowMs: Date.parse("2026-10-05T03:01:00.000Z") });
  eq(nx?.next.action, "viewing_invite"); eq(nx?.rest.length, 0);
});
it("内覧日調整も送った後: 何も残らない", () => {
  const logs: QueueAixLog[] = [{ aixType: "property_check_result", sentAt: "2026-10-05T03:00:00.000Z" }, { aixType: "viewing_invite", sentAt: "2026-10-05T03:10:00.000Z" }];
  eq(nextPromiseAix(buildPromiseQueue(msgs, logs, Date.parse("2026-10-05T03:11:00.000Z")), { nowMs: Date.parse("2026-10-05T03:11:00.000Z") }), null);
});
it("確認＋見積の約束: 見積書を先に送っても確認は済み（空いていた結果を伝えた）", () => {
  const m2: QueueMsg[] = [{ sender: "staff", text: "〇〇の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！", createdAt: T0 }];
  const q = buildPromiseQueue(m2, [{ aixType: "estimate_sheet", sentAt: "2026-10-05T05:00:00.000Z" }], Date.parse("2026-10-05T05:01:00.000Z"));
  eq(nextPromiseAix(q, { nowMs: Date.parse("2026-10-05T05:01:00.000Z") }), null);
});
it("募集終了の結果 → 見積・内覧の約束はやめる（次の要対応にしない）", () => {
  const m2: QueueMsg[] = [{ sender: "staff", text: "お送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第、最大限割引させて頂いた初期費用の御見積書もあわせてお送りさせて頂きます！！", createdAt: T0 }];
  const q = buildPromiseQueue(m2, [{ aixType: "property_check_result", sentAt: "2026-10-05T05:00:00.000Z", text: "確認させて頂きましたところ、既に募集終了となっておりました！！" }], Date.parse("2026-10-05T05:01:00.000Z"));
  eq(q.find((s) => s.kind === "estimate")?.status, "dropped");
  eq(nextPromiseAix(q, { nowMs: Date.parse("2026-10-05T05:01:00.000Z") }), null);
});
it("手打ちで御見積書を送った（estimate_sent）→ 見積の約束は済み", () => {
  const m2: QueueMsg[] = [
    { sender: "staff", text: "最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！", createdAt: T0 },
    { sender: "staff", text: "こちら〇〇の最大限割引させて頂いた初期費用の御見積書となります😊！！", createdAt: "2026-10-05T02:00:00.000Z" },
  ];
  eq(buildPromiseQueue(m2, [], Date.parse("2026-10-05T02:01:00.000Z")).find((s) => s.kind === "estimate")?.status, "done");
});
it("探し続ける約束（お部屋探し継続・新着出次第）は次の要対応にしない", () => {
  const m2: QueueMsg[] = [{ sender: "staff", text: "引き続きお部屋探し継続させていただきます！！", createdAt: T0 }];
  eq(nextPromiseAix(buildPromiseQueue(m2, [], Date.parse(T0) + 60_000), { nowMs: Date.parse(T0) + 60_000 }), null);
});
it("72時間を過ぎた約束は次の要対応にしない", () => {
  eq(nextPromiseAix(buildPromiseQueue(msgs, [], Date.parse(T0) + 80 * 3600_000), { nowMs: Date.parse(T0) + 80 * 3600_000 }), null);
});
it("要対応の印と取り下げない線", () => {
  const nx = nextPromiseAix(buildPromiseQueue(msgs, [], Date.parse(T0) + 600_000), { nowMs: Date.parse(T0) + 600_000 })!;
  const note = promiseQueueNote(nx.next, nx.rest);
  has(note, PROMISE_QUEUE_NOTE_PREFIX); has(note, "物件確認した"); has(note, "残り: 2. 内覧の確認・日程");
  eq(keepPromiseQueueItem({ resolution_note: note, created_at: T0 }, Date.parse(T0) + 3600_000), true);
  eq(keepPromiseQueueItem({ resolution_note: note, created_at: T0 }, Date.parse(T0) + 80 * 3600_000), false);
  eq(keepPromiseQueueItem({ resolution_note: null, created_at: T0 }, Date.parse(T0) + 3600_000), false);
  eq(keepPromiseQueueItem({ resolution_note: note, created_at: T0 }, Date.parse(T0) + 3600_000, { PROMISE_QUEUE: "off" }), false);
});

console.log("ピックアップが必要なお客様はピックアップを上げる（竹内さん③）");
const mixMsgs: QueueMsg[] = [
  { sender: "customer", text: "ここ空いてますか？初期費用も知りたいです\n他にも物件送ってほしいです", createdAt: T0 },
  { sender: "staff", text: "お送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第、最大限割引させて頂いた初期費用の御見積書もあわせてお送りさせて頂きます！！\nあわせて、ご希望のご条件に合ったお部屋もピックアップしてお送りさせて頂きます！！", createdAt: "2026-10-05T01:05:00.000Z" },
];
const nowMix = Date.parse("2026-10-05T01:10:00.000Z");
const qMix = buildPromiseQueue(mixMsgs, [], nowMix);
it("信号: まだ物件を送っていない・他にもと頼んだ", () => {
  const n = pickupNeedSignals(mixMsgs.slice(0, 1), []);
  eq(n, { noPropertiesSent: true, sentNotFit: false, customerAskedMore: true });
});
it("基本（信号なし）: 確認 → 見積 → ピックアップ", () => eq([nextPromiseAix(qMix, { nowMs: nowMix })!.next.kind, ...nextPromiseAix(qMix, { nowMs: nowMix })!.rest.map((s) => s.kind)], ["check", "estimate", "pickup"]));
it("まだ物件を送っていない → ピックアップが一番先", () => {
  const nx = nextPromiseAix(qMix, { nowMs: nowMix, need: { noPropertiesSent: true, sentNotFit: false, customerAskedMore: false } })!;
  eq([nx.next.kind, ...nx.rest.map((s) => s.kind)], ["pickup", "check", "estimate"]);
});
it("送った後で「他にも」と頼んだ → 確認の次・見積より前", () => {
  const nx = nextPromiseAix(qMix, { nowMs: nowMix, need: { noPropertiesSent: false, sentNotFit: false, customerAskedMore: true } })!;
  eq([nx.next.kind, ...nx.rest.map((s) => s.kind)], ["check", "pickup", "estimate"]);
});
it("送った物件が合わない（AIX で送った後「どれもいまいち」）→ 合わない", () => {
  const n = pickupNeedSignals([{ sender: "customer", text: "どれもいまいちでした", createdAt: T0 }], [{ aixType: "property_send", sentAt: "2026-10-04T00:00:00.000Z" }]);
  eq(n.sentNotFit, true); eq(n.noPropertiesSent, false); eq(promiseOrderFor(n)[1], "pickup");
});
it("送った後・信号なし → 基本の順", () => eq(promiseOrderFor({ noPropertiesSent: false, sentNotFit: false, customerAskedMore: false }), PROMISE_ORDER));

console.log("resolveTwoStage 旧の形（TWO_STAGE_PROMISE_SEQUENCE=off＝10/09 のあわせて最大5つ。10/13 からの形は promise-sequence.test.ts）");
process.env.TWO_STAGE_PROMISE_SEQUENCE = "off";
it("あわせて足す約束の上限は5（竹内さん②）", () => {
  eq(TWO_STAGE_MULTI_PROMISE_MAX, 5);
  const v = resolveTwoStage({ finalAix: "estimate_sheet", decisionSource: "llm", pickupReady: false, postApply: false, estimateTarget: "〇〇",
    customerText: "ここ空いてますか？\n初期費用いくらですか？\n内覧したいです\n他にも物件ありますか？\n室内の写真ありますか？\nペット可ですか？" })!;
  eq((v.extraPromises ?? []).length <= TWO_STAGE_MULTI_PROMISE_MAX, true);
  eq(v.extraPromises, ["check", "viewing", "pickup", "photo", "confirm"]);
});
const base = { finalAix: "property_check_result", decisionSource: "llm", pickupReady: false, postApply: false } as const;
it("空き（主）＋内覧＋他の物件 → 内覧の日程・ピックアップをあわせて約束", () => {
  const v = resolveTwoStage({ ...base, customerText: "こちらまだ空いてますか？\n空いていたら内覧したいです\n他にも似たような物件ありますか？", ackOnly: false })!;
  has(v.direction, "あわせて"); has(v.direction, "ご内覧のお日にち"); has(v.direction, "ピックアップ");
  eq(v.extraPromises, ["viewing", "pickup"]);
});
it("持ち込み＋空き＋費用（brought_both）は今まで通り（足さない）", () => {
  const v = resolveTwoStage({ ...base, customerText: "https://suumo.jp/chintai/bc_1/\nここ空いてますか？初期費用いくらですか？", brought: { ask: "both", count: 1 } })!;
  eq(v.extraPromises, undefined); has(v.source, "brought_both");
});
it("依頼が1つ（空きだけ）は足さない", () => {
  const v = resolveTwoStage({ ...base, customerText: "こちらまだ空いてますか？" })!;
  eq(v.extraPromises, undefined); not(v.direction, "まとめて約束");
});
it("ピックアップの約束（主）＋空き＋見積（物件が無い番の費用は足さない）", () => {
  const v = resolveTwoStage({ ...base, finalAix: "property_send", customerText: "このURLの物件空いてますか？\nあと初期費用っていくらくらいですか？", ackOnly: false })!;
  eq(v.kind, "pickup"); eq(v.extraPromises, ["check"]);
});
it("戻す TWO_STAGE_MULTI_PROMISE=off", () => {
  process.env.TWO_STAGE_MULTI_PROMISE = "off";
  try { eq(resolveTwoStage({ ...base, customerText: "こちらまだ空いてますか？\n空いていたら内覧したいです\n他にも似たような物件ありますか？" })!.extraPromises, undefined); }
  finally { delete process.env.TWO_STAGE_MULTI_PROMISE; }
});
console.log("buildPromiseQueue 時刻の順（2026-10-22 同じ種類の約束が重なると新しい約束が消えていた・1191b1 10/02）");
{
  const CHECK = "お部屋お送りいただきありがとうございます😊！！\nお部屋の募集状況確認させていただきます！！";
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 2, h, m)).toISOString();
  const res = (h: number, m = 0, text = "お送りいただきました物件〇〇号室現在募集中となります！！"): QueueAixLog => ({ aixType: "property_check_result", checkPattern: "available", sentAt: at(h, m), text });
  const pend = (q: ReturnType<typeof buildPromiseQueue>) => q.filter((s) => s.status === "pending").map((s) => `${s.kind}@${s.promisedAt.slice(11, 16)}`);
  it("同じ種類の約束 → AIX で果たす → また約束: 新しい約束は開いたまま（前は消えていた）", () => {
    const m: QueueMsg[] = [{ sender: "staff", text: CHECK, createdAt: at(1) }, { sender: "customer", text: "ここも出してもらっていいですか？", createdAt: at(9, 50) }, { sender: "staff", text: CHECK, createdAt: at(10, 12) }];
    const q = buildPromiseQueue(m, [res(2)], Date.parse(at(10, 13)));
    eq(q.filter((s) => s.kind === "check").map((s) => s.status), ["done", "pending"]);
    eq(nextPromiseAix(q, { nowMs: Date.parse(at(10, 13)) })?.next.promisedAt, at(10, 12));
  });
  it("その後の AIX で新しい約束も果たす（AIX は自分より前の約束だけ）", () => {
    const m: QueueMsg[] = [{ sender: "staff", text: CHECK, createdAt: at(1) }, { sender: "staff", text: CHECK, createdAt: at(10, 12) }];
    const q = buildPromiseQueue(m, [res(2), res(10, 27)], Date.parse(at(11)));
    eq(q.filter((s) => s.kind === "check").map((s) => `${s.status}@${s.doneAt?.slice(11, 16)}`), ["done@02:00", "done@10:27"]);
  });
  it("前の約束がまだ開いている間の同じ種類の約束は1つにまとめる（今までどおり）・AIX 1本で済み", () => {
    const m: QueueMsg[] = [{ sender: "staff", text: CHECK, createdAt: at(1) }, { sender: "staff", text: CHECK, createdAt: at(3) }];
    const q = buildPromiseQueue(m, [res(4)], Date.parse(at(5)));
    eq(q.filter((s) => s.kind === "check").length, 1); eq(pend(q), []);
  });
  it("違う種類が間に入っても、それぞれの約束はそれぞれの AIX で果たす", () => {
    const m: QueueMsg[] = [
      { sender: "staff", text: CHECK, createdAt: at(1) },
      { sender: "staff", text: "最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！", createdAt: at(1, 30) },
      { sender: "staff", text: CHECK, createdAt: at(6) },
    ];
    const q = buildPromiseQueue(m, [res(2), { aixType: "estimate_sheet", sentAt: at(3) }], Date.parse(at(7)));
    eq(pend(q), ["check@06:00"]);
    eq(q.find((s) => s.kind === "estimate")?.doneBy, "AIX【見積書送る】");
  });
  it("AIX が約束より前（60秒より前）なら、その約束は果たさない", () => {
    const m: QueueMsg[] = [{ sender: "staff", text: CHECK, createdAt: at(10, 12) }];
    eq(pend(buildPromiseQueue(m, [res(10, 0)], Date.parse(at(11)))), ["check@10:12"]);
  });
  it("60秒の幅は今までどおり（AIX の30秒後の約束の通も果たした扱い）", () => {
    const m: QueueMsg[] = [{ sender: "staff", text: CHECK, createdAt: "2026-10-02T10:12:30.000Z" }];
    eq(pend(buildPromiseQueue(m, [res(10, 12)], Date.parse(at(11)))), []);
  });
  it("手打ちの報告で果たした新しい約束は済み（手打ちの判定は残す）", () => {
    const m: QueueMsg[] = [
      { sender: "staff", text: CHECK, createdAt: at(1) },
      { sender: "staff", text: CHECK, createdAt: at(10, 12) },
      { sender: "staff", text: "〇〇の管理会社に確認しましたところ、現在募集中となります！！", createdAt: at(10, 40) },
    ];
    const q = buildPromiseQueue(m, [res(2)], Date.parse(at(11)));
    eq(q.filter((s) => s.kind === "check").map((s) => `${s.status}/${s.doneBy}`), ["done/AIX【物件確認した（募集状況）】", "done/返信"]);
  });
  it("後に回した依頼（探す）も、前の探す約束を果たした後なら新しく並ぶ", () => {
    const m: QueueMsg[] = [
      { sender: "staff", text: "ご条件に合ったお部屋ピックアップしてお送りさせて頂きます！！", createdAt: at(1) },
      { sender: "customer", text: "ここ空いてますか？\n他にも良い物件ありますか？\n大阪市北区でお願いします", createdAt: at(5) },
      { sender: "staff", text: CHECK, createdAt: at(5, 10) },
    ];
    const q = buildPromiseQueue(m, [{ aixType: "property_send", sentAt: at(2) }], Date.parse(at(6)));
    eq(q.filter((s) => s.kind === "pickup").map((s) => `${s.status}${s.deferred ? "/後" : ""}`), ["done", "pending/後"]);
  });
  it("「現在募集に出ていない」結果 → 同じ通で約束した見積はやめる（96c140）", () => {
    const m: QueueMsg[] = [{ sender: "staff", text: "お送り頂きました大日の物件、募集状況確認させて頂きます！！\n確認出来次第、最大限割引させて頂いた初期費用の御見積書とあわせてお送りさせて頂きます！！", createdAt: at(10, 15) }];
    const q = buildPromiseQueue(m, [{ aixType: "property_check_result", checkPattern: "unavailable", sentAt: at(10, 38), text: "こちらのお部屋現在募集に出ていないお部屋となっております！！" }], Date.parse(at(11)));
    eq(q.find((s) => s.kind === "estimate")?.status, "dropped"); eq(nextPromiseAix(q, { nowMs: Date.parse(at(11)) }), null);
  });
  const CHK_EST = "お送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第、最大限割引させて頂いた初期費用の御見積書を作成しお送りさせて頂きます！！";
  it("別の部屋が募集してた（available・『他は募集に出ていない』）→ 見積はやめない（レビュー 10/22・217a4b 型）", () => {
    const q = buildPromiseQueue([{ sender: "staff", text: CHK_EST, createdAt: at(10, 15) }], [{ aixType: "property_check_result", checkPattern: "available", sentAt: at(10, 38), text: "サンライズ成田現在募集中となります！！明日再度費用面確認させていただきます！！他2件は募集に出ていないお部屋となっております。" }], Date.parse(at(11)));
    eq(q.find((s) => s.kind === "estimate")?.status, "pending");
  });
  it("ピッカーの結果が無い本文でも「募集中」があれば見積はやめない／無ければやめる", () => {
    const q1 = buildPromiseQueue([{ sender: "staff", text: CHK_EST, createdAt: at(10, 15) }], [{ aixType: "property_check_result", sentAt: at(10, 38), text: "203号室現在募集中となります！！他2件は募集に出ていないお部屋となっております。" }], Date.parse(at(11)));
    eq(q1.find((s) => s.kind === "estimate")?.status, "pending");
    const q2 = buildPromiseQueue([{ sender: "staff", text: CHK_EST, createdAt: at(10, 15) }], [{ aixType: "property_check_result", sentAt: at(10, 38), text: "こちらのお部屋現在募集に出ていないお部屋となっております！！" }], Date.parse(at(11)));
    eq(q2.find((s) => s.kind === "estimate")?.status, "dropped");
  });
  it("「現在募集に出ていない」でも 3分より後の通の見積の約束はやめない", () => {
    const q = buildPromiseQueue([{ sender: "staff", text: CHECK, createdAt: at(10, 0) }, { sender: "staff", text: "最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！", createdAt: at(10, 20) }], [{ aixType: "property_check_result", checkPattern: "unavailable", sentAt: at(10, 38), text: "こちらのお部屋現在募集に出ていないお部屋となっております！！" }], Date.parse(at(11)));
    eq(q.find((s) => s.kind === "estimate")?.status, "pending");
  });
  it("戻す PROMISE_QUEUE_CHRONO=off（前の組み立て＝新しい約束はまとめられて消える）", () => {
    process.env.PROMISE_QUEUE_CHRONO = "off";
    try {
      const m: QueueMsg[] = [{ sender: "staff", text: CHECK, createdAt: at(1) }, { sender: "staff", text: CHECK, createdAt: at(10, 12) }];
      eq(buildPromiseQueue(m, [res(2)], Date.parse(at(11))).filter((s) => s.kind === "check").map((s) => s.status), ["done"]);
    } finally { delete process.env.PROMISE_QUEUE_CHRONO; }
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
