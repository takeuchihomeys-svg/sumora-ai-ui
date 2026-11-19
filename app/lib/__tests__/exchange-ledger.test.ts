// やり取りの照らし合わせ表（app/lib/exchange-ledger.ts）と部分の語彙（app/lib/our-part-types.ts）のテスト
// 実行: npx tsx app/lib/__tests__/exchange-ledger.test.ts
import { buildExchangeLedger, exchangeLedgerLine, exchangeLedgerOn, exchangeLedgerBrainOn } from "../exchange-ledger";
import { splitOurPartsFine, splitTheirParts, OUR_PARTS, OUR_PART_KINDS } from "../our-part-types";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };
const T = (h: number) => new Date(Date.parse("2026-11-12T00:00:00Z") + h * 36e5).toISOString();

ok("既定 off（入口・ブレインとも）", !exchangeLedgerOn({}) && !exchangeLedgerBrainOn({}) && exchangeLedgerOn({ CONDUCTOR_EXCHANGE_LEDGER: "on" }) && exchangeLedgerBrainOn({ CONDUCTOR_EXCHANGE_LEDGER_BRAIN: "on" }));
ok("部分の鍵は粗い種類（作業員16 と同じ鍵＋aix）の下", Object.values(OUR_PARTS).every((p) => (OUR_PART_KINDS as readonly string[]).includes(p.kind)));
ok("部分は目的・期待・期限を持つ", Object.values(OUR_PARTS).every((p) => !!p.purpose && !!p.expect && p.dueHours > 0));

{ // 細かい部分（竹内さんの実際の文）
  const parts = splitOurPartsFine("YUMAさんお世話になっております！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！\n確認出来次第、最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！", T(0));
  const keys = parts.map((p) => p.key);
  ok("約束: 確認する・見積を出す", keys.includes("promise.check") && keys.includes("promise.estimate"), JSON.stringify(keys));
  const q = splitOurPartsFine("ご希望の間取りはございますか？\nご都合よろしいお日にちお聞かせください！！", T(0)).map((p) => p.key);
  ok("聞いた事: 間取り・日程", q.includes("question.layout") && q.includes("question.schedule"), JSON.stringify(q));
  const pr = splitOurPartsFine("お送りさせて頂きましたお部屋の中でも、こちらのJino花園町お部屋がYUMAさんにかなりオススメのお部屋となります！！\nお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます😊！！", T(0)).map((p) => p.key);
  ok("送った物件: 1件推し・誘い: 内覧の扉", pr.includes("property.one_push") && pr.includes("invite.viewing_door"), JSON.stringify(pr));
}
{ // お客様の部分
  const k = splitTheirParts("1LDKで家賃8万くらい、梅田周辺がいいです", T(0));
  ok("条件（鍵は info-fill-map と同じ）", k.some((x) => x.kind === "condition" && x.conditionKeys.includes("layout") && x.conditionKeys.includes("rent") && x.conditionKeys.includes("area")), JSON.stringify(k));
  ok("了承", splitTheirParts("ありがとうございます🙇", T(0))[0]?.kind === "accept");
  ok("物件の持ち込み", splitTheirParts("https://suumo.jp/chintai/bc_1/", T(0)).some((x) => x.kind === "property_bring"));
}

const S = (h: number, text: string, aix = false) => ({ sender: "staff", text, created_at: T(h), is_aix_generated: aix });
const C = (h: number, text: string) => ({ sender: "customer", text, created_at: T(h) });

{ // q371 の形: 3件の確認と見積の約束→まだ果たしていない（翌日・期限を過ぎた）
  const msgs = [C(0, "新大阪グランドハイツ 2階 https://suumo.jp/chintai/bc_100531094024/"), C(0.1, "上記の物件はまだ空いておりますか？"),
    S(0.5, "お送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第、最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！"),
    C(26, "ART TENDOU WEST 1階 https://suumo.jp/chintai/bc_100532288607/")];
  const l = buildExchangeLedger({ msgs, aix: [], nowMs: Date.parse(T(26)) + 1 });
  ok("約束の残り（確認する・見積を出す）・期限を過ぎた", l.open.filter((x) => x.kind === "our_promise_unkept" && x.overdue).length === 2, JSON.stringify(l.open));
  const line = exchangeLedgerLine(l);
  ok("行は事実だけ（道の言葉なし）", /約束してまだ果たしていない事: 確認する/.test(line) && !/AIX で|返信で|2段|送るべき|すべき/.test(line), line);
  // 果たした後（AIX 物件確認した）は残らない
  const l2 = buildExchangeLedger({ msgs, aix: [{ aix_type: "property_check_result", check_pattern: "availability", created_at: T(5), sent_at: T(5) }, { aix_type: "estimate_sheet", created_at: T(5.1), sent_at: T(5.1) }], nowMs: Date.parse(T(26)) + 1 });
  ok("AIX で果たした約束は残らない", !l2.open.some((x) => x.kind === "our_promise_unkept"), JSON.stringify(l2.open));
}
{ // こちらが聞いた間取りに答えが無い・お客様の問いに答えていない
  const msgs = [S(0, "ご希望の間取りはございますか？"), C(1, "家賃は7万くらいです"), C(1.1, "ペットは飼えますか？"), S(1.5, "かしこまりました！！家賃7万円以内でピックアップさせて頂きます！！"), C(3, "よろしくお願いします")];
  const l = buildExchangeLedger({ msgs, aix: [], nowMs: Date.parse(T(3.1)) });
  ok("聞いた間取りに答えが無い", l.open.some((x) => x.kind === "our_question_unanswered" && /間取り/.test(x.what)), JSON.stringify(l.open));
  ok("お客様の問いにまだ答えていない", l.open.some((x) => x.kind === "their_question_unanswered" && /ペット/.test(x.what)), JSON.stringify(l.open));
}
{ // 条件ヒアリングの AIX に条件が返ってきた＝残らない／物件を送って反応が無い
  const msgs = [C(0, "お部屋探し希望です"), S(0.1, "はじめまして😊！！"), C(2, "①11月 ②8万 ③1LDK ⑤梅田")];
  const l = buildExchangeLedger({ msgs, aix: [{ aix_type: "condition_hearing", created_at: T(0.1), sent_at: T(0.1) }, { aix_type: "property_send", created_at: T(3), sent_at: T(3) }], nowMs: Date.parse(T(60)) });
  ok("条件ヒアリングは答えあり", !l.open.some((x) => x.kind === "our_question_unanswered"), JSON.stringify(l.open));
  ok("送った物件の反応が無い（期限を過ぎた）", l.open.some((x) => x.kind === "property_no_reaction" && x.overdue), JSON.stringify(l.open));
}
{ // 伝えたのにもう一度聞かれた
  const msgs = [S(0, "今回も仲介手数料0円・初期費用も最大限割引させて頂いております！！"), C(1, "仲介手数料はかかりますか？")];
  const l = buildExchangeLedger({ msgs, aix: [], nowMs: Date.parse(T(1.1)) });
  ok("伝わっていない", l.open.some((x) => x.kind === "not_conveyed"), JSON.stringify(l.open));
}
{ // 今の番の問いは入れない（入口が今の一通として読む）
  const l = buildExchangeLedger({ msgs: [S(0, "何卒よろしくお願い致します！！"), C(1, "ペットは飼えますか？")], aix: [], nowMs: Date.parse(T(1.1)) });
  ok("今の番の問いは残りにしない", !l.open.some((x) => x.kind === "their_question_unanswered"), JSON.stringify(l.open));
  ok("網に当たらない答えの文は受け皿", splitOurPartsFine("白基調のお部屋となります😊！！", T(0))[0]?.key === "fact.answer");
}
{ // 残りが無ければ空文字
  const msgs = [C(0, "ありがとうございます"), S(0.1, "何卒よろしくお願い致します！！")];
  ok("残り無し→空", exchangeLedgerLine(buildExchangeLedger({ msgs, aix: [], nowMs: Date.parse(T(0.2)) })) === "");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
