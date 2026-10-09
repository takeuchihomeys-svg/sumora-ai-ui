// app/lib/__tests__/search-exhausted.test.ts — 今の条件の物件を出し切ったか（実行: npx tsx app/lib/__tests__/search-exhausted.test.ts）
//   実物は不一致 #178 #194 #200 #214 の形と、60日の実送信の言い回し（名前は伏せた）
import { searchExhausted, applySearchExhausted, isExhaustMarker, type ExMsg } from "../search-exhausted";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };
const m = (sender: string, text: string, at: string, aixType?: string): ExMsg => ({ sender, text, createdAt: `2026-10-0${at}`, isAix: sender === "staff", aixType: aixType ?? null });

const allPicked = "〇〇さんお世話になっております！！\n新大阪・南吹田周辺全域から現在募集中のお部屋で〇〇さんのご条件に近いお部屋を全てピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！";
const futurePick = "桜川周辺から9万まで・1LDKで〇〇さんにオススメできるお部屋全てピックアップしてお送りさせて頂きます！！";
const checkedNone = "左側エリア全域から、現在募集中のお部屋 全て確認させて頂きましたところご条件に近いお部屋御座いませんでした。";
const newArrival = "かしこまりました！！\n天王寺のお部屋で〇〇さんのご条件に合ったお部屋の新着状況随時確認させて頂きオススメ出来るお部屋募集に出次第お送りさせて頂きます！！";

t("印: 全てピックアップさせて頂きました", isExhaustMarker(m("staff", allPicked, "1T10:00:00Z")));
t("印: 全て確認させて頂きましたところ", isExhaustMarker(m("staff", checkedNone, "1T10:00:00Z")));
t("印: 新着…出次第お送り", isExhaustMarker(m("staff", newArrival, "1T10:00:00Z")));
t("印にしない: これから全てピックアップしてお送り（約束）", !isExhaustMarker(m("staff", futurePick, "1T10:00:00Z")));
t("印にしない: 物件1件の募集終了", !isExhaustMarker(m("staff", "お送り頂いた物件は現在募集に出ておらず、募集終了しておりました！！", "1T10:00:00Z")));
t("印にしない: お客様の文", !isExhaustMarker(m("customer", allPicked, "1T10:00:00Z")));

{
  const msgs = [m("staff", allPicked, "1T10:00:00Z"), m("customer", "ありがとうございます！もう少し探してもらえますか？", "2T10:00:00Z")];
  const r = searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: false });
  t("#178 型: 全て送った後の「もう少し探して」は出し切った", r.exhausted, r);
  t("売上サポに候補がある時は出し切っていない", !searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: true }).exhausted);
  t("この番で条件が変わった時は出し切っていない（2択のまま）", !searchExhausted(msgs, { conditionChangedThisTurn: true, pickupReady: false }).exhausted);
}
{
  const msgs = [m("staff", allPicked, "1T10:00:00Z"), m("customer", "エリアを堺市まで広げても大丈夫です", "2T10:00:00Z"), m("customer", "他にありますか", "3T10:00:00Z")];
  t("印の後に条件を広げた→出し切っていない", !searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
}
{
  const msgs = [m("customer", "他にありますか", "3T10:00:00Z")];
  t("AIX【全力サポート】を送った記録も印", searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: false, zenryokuSentAt: ["2026-10-02T10:00:00Z"] }).exhausted);
  t("印が無い→出し切っていない", !searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
}
{
  const a = applySearchExhausted({ finalAix: "property_send", altActions: ["zenryoku_support"], exhausted: true, postApply: false, env: {} });
  t("Q-A: 主は全力サポート・物件の AIX は2つ目に残す", a.changed && a.finalAix === "zenryoku_support" && a.altActions?.[0] === "property_send" && !a.altActions.includes("zenryoku_support"), a);
  t("物件の AIX でない番は変えない", !applySearchExhausted({ finalAix: "viewing_invite", altActions: undefined, exhausted: true, postApply: false, env: {} }).changed);
  t("申込以降は変えない", !applySearchExhausted({ finalAix: "property_send", altActions: undefined, exhausted: true, postApply: true, env: {} }).changed);
  t("SEARCH_EXHAUSTED_ZENRYOKU=off", !applySearchExhausted({ finalAix: "property_send", altActions: undefined, exhausted: true, postApply: false, env: { SEARCH_EXHAUSTED_ZENRYOKU: "off" } }).changed);
}
// 10/09 試験（出し切り7問）の実物の印と取り消し
t("印: 「全て」の無い送付の報告（天王寺周辺全域から…ピックアップさせて頂きました）", isExhaustMarker(m("staff", "〇〇さんお待たせ致しました！！\n天王寺周辺全域から敷金礼金なし・初期費用を抑えられる物件をピックアップさせて頂きました！！", "1T10:00:00Z")));
t("印: 新着が募集に出ました", isExhaustMarker(m("staff", "〇〇さんにオススメ出来るお部屋が募集にでました！！", "1T10:00:00Z")));
t("印: AIX の物件の送付の記録", searchExhausted([m("customer", "もう少し探していただけますか？", "3T10:00:00Z")], { conditionChangedThisTurn: false, pickupReady: false, deliveredAixAt: ["2026-10-02T10:00:00Z"] }).exhausted);
{
  const base = m("staff", "天王寺周辺全域から物件をピックアップさせて頂きました！！", "1T10:00:00Z");
  t("q007: 絞り込み（中央大通りより北側で）は出し切ったまま", searchExhausted([base, m("customer", "出来れば中央大通りより北側でお願いしたいです。", "2T10:00:00Z")], { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
  t("q009: 家賃をあげて（広げる）→ 取り消す", !searchExhausted([base, m("customer", "もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!", "2T10:00:00Z")], { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
  t("q011: 新しい駅名でありませんか → 取り消す", !searchExhausted([base, m("customer", "トイレに扉は欲しいですね💦\nそれ以外は良かったんですが、\n大国町、本町、堺筋本町、などはあまりありませんか？", "2T10:00:00Z")], { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
  t("q010: 条件のフォームの出し直しで取り消す", !searchExhausted([base, m("customer", "【お部屋お探し中！】\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒10月", "2T10:00:00Z")], { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
}

// 10/09 q038: 新着の1件の送付の後に御見積書まで進んだ番は出し切りでない（竹内さんは礼金0の別の物件を推した）
{
  const msgs = [m("staff", "家賃ご上限オーバーしてしまいますが、中之島で8.1帖のお部屋が9月末退去予定で募集に出ました。", "1T10:00:00Z"),
    m("customer", "こちらの初期費用見積もりだしていただきたいです！", "1T11:00:00Z"),
    m("staff", "YUMAさんこちら初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！", "1T12:00:00Z"),
    m("customer", "礼金がなかったらここで決めてました。。", "1T13:00:00Z")];
  t("q038: 印の後に御見積書 → 出し切りでない", !searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
  t("御見積書の約束（お送りさせて頂きます）だけは取り消さない", searchExhausted([msgs[0], m("staff", "最大限割引させて頂いた御見積書お送りさせて頂きます！！", "1T12:00:00Z"), msgs[3]], { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
  const prev = process.env.SEARCH_EXHAUSTED_ESTIMATE_CANCEL; process.env.SEARCH_EXHAUSTED_ESTIMATE_CANCEL = "off";
  t("SEARCH_EXHAUSTED_ESTIMATE_CANCEL=off で旧", searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: false }).exhausted);
  if (prev === undefined) delete process.env.SEARCH_EXHAUSTED_ESTIMATE_CANCEL; else process.env.SEARCH_EXHAUSTED_ESTIMATE_CANCEL = prev;
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
