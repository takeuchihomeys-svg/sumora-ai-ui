// app/lib/__tests__/sent-room-match.test.ts
// 2026-09-30 v2.5.42 竹内「画面監視して、一度送った物件はお客さんごとに再度送らないようにする形で」
//   送る側の「送付済みの部屋」の照合（sent-room-match.ts）＝拡張 chrome-extension/sent-skip.js と同じ答えか（四者同名・実物の名前）、
//   既定のチェック・✨質の高い10件・手で選んだ時の確かめ・★物件出し★のまとめの上位から外れるか。
// 実行: npx tsx app/lib/__tests__/sent-room-match.test.ts
import { createRequire } from "module";
import { buildSentRoomIndex, isSentRoom, sentRoomKey, roomKeyOf, normRoomNo, normRoomName, pickSentRooms, splitRoomFromName, roomFromRealproCell, roomOfCandidate } from "../sent-room-match";
import { sentBeforeIds, sentConfirmMessage, pickQualityTop, defaultAixChecks, qualityPickMessage } from "../pickup-review-order";
import { buildAnnouncement } from "../pickup-group-announce";
const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SK = require_("../../../chrome-extension/sent-skip.js") as { buildIndex(r: Array<{ name: string; room: string }>): unknown; isSentRoom(i: unknown, n: string, r: string | null): boolean; normName(s: string): string; roomKey(s: string): string; normRoom(s: string): string; roomFromRealproCell(s: string): string | null };

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}

console.log("\n■ 拡張 sent-skip.js と同じ答え（本番の送付の実物の名前）");
{
  const sent = [
    { name: "プレサンス難波インフィニティ", room: "304" }, { name: "エスリード難波ザ・アーク", room: "1104" }, { name: "HOPE CITY天神橋", room: "A0205" },
    { name: "セレコート福島Ⅰ.Ⅱ", room: "503" }, { name: "シャトー岡村A棟", room: "7" }, { name: "CITY　SPIRE難波WEST", room: "508" }, { name: "ジアコスモ難波南", room: "" },
  ];
  const probes: Array<[string, string | null]> = [
    ["プレサンス難波インフィニティ", "304"], ["プレサンス難波インフィニティ", "0304"], ["プレサンス難波インフィニティ", "305"], ["プレサンス難波インフィニティ", null],
    ["【3】エスリード難波ザ・アーク", "1104号室"], ["HOPE CITY天神橋", "A0205"], ["HOPE CITY天神橋", "B0205"], ["HOPE CITY天神橋", "205"],
    ["セレコート福島Ⅰ.Ⅱ", "II-503"], ["セレコート福島Ⅰ.Ⅱ", "503"], ["シャトー岡村A棟", "A-7"], ["CITY SPIRE難波WEST", "508"], ["ジアコスモ難波南", "201"], ["物件", "304"], ["プレサンス難波インフィニティⅡ", "304"],
  ];
  const ts = buildSentRoomIndex(sent), ext = SK.buildIndex(sent);
  let same = 0;
  for (const [n, r] of probes) if (isSentRoom(ts, n, r) === SK.isSentRoom(ext, n, r)) same++;
  t(`${probes.length}組すべて同じ答え`, same === probes.length);
  t("同じ部屋（304・0304・【3】付き・号室付き）は送付済み", isSentRoom(ts, "プレサンス難波インフィニティ", "0304") && isSentRoom(ts, "【3】エスリード難波ザ・アーク", "1104号室"));
  t("同じ建物の別の部屋（305）・号室なし・Ⅱ・「物件」は送付済みにしない", !isSentRoom(ts, "プレサンス難波インフィニティ", "305") && !isSentRoom(ts, "プレサンス難波インフィニティ", null) && !isSentRoom(ts, "プレサンス難波インフィニティⅡ", "304") && !isSentRoom(ts, "物件", "304"));
  t("英字付きの号室は英字ごと（A0205 は同じ・B0205・205 は別）", isSentRoom(ts, "HOPE CITY天神橋", "A0205") && !isSentRoom(ts, "HOPE CITY天神橋", "B0205") && !isSentRoom(ts, "HOPE CITY天神橋", "205"));
  t("「II-503」と「503」は別（迷ったら外さない・本番の例 #937）", !isSentRoom(ts, "セレコート福島Ⅰ.Ⅱ", "II-503"));
  t("全角の空白は名前の正規化で同じ", isSentRoom(ts, "CITY SPIRE難波WEST", "508"));
  t("号室の無い送付は引けない", !isSentRoom(ts, "ジアコスモ難波南", "201") && ts.size === 6);
  t("正規化の関数も同じ", ["【1】ルクレ　難波・208", "Ａ棟"].every((s) => normRoomName(s) === SK.normName(s)) && ["0405", "A0205", "005B", "405号室"].every((s) => roomKeyOf(s) === SK.roomKey(s) && normRoomNo(s) === SK.normRoom(s)));
  t("リアプロの先頭のセルの号室も同じ", ["309 4日前 閲覧済", "0405 4時間前", "4日前"].every((c) => roomFromRealproCell(c) === SK.roomFromRealproCell(c)));
  t("候補の記録 → 号室は room_no → 先頭のセル", roomOfCandidate({ name: "X", cells: ["309 4日前"] }).room === "309" && roomOfCandidate({ name: "X", room_no: "0405", cells: ["309 4日前"] }).room === "0405" && roomOfCandidate(null).room === null);
  t("鍵（sentRoomKey）は名前が読めない・号室が無いと null", sentRoomKey("物件", "304") === null && sentRoomKey("プレサンス", "") === null && sentRoomKey("プレサンス難波", "304") === "プレサンス難波|304");
  t("物件名の末尾の号室を分ける", JSON.stringify(splitRoomFromName("エスリード難波 303号室")) === JSON.stringify({ building: "エスリード難波", room: "303" }) && splitRoomFromName("エスリード難波").room === null);
}

console.log("\n■ 送る側: 既定のチェック・✨質の高い10件から外す（届けた物だけ・共有は除く）");
{
  const hist = [
    { property_name: "プレサンス難波インフィニティ", room_no: "304", delivery: "customer", source: "aix:property_send", channel: "pickup", sent_at: "2026-09-27T10:00:00Z" },
    { property_name: "エスリード難波ザ・アーク", room_no: "1104", delivery: "shared", source: "line_group", channel: "extension_group", sent_at: "2026-09-27T10:00:00Z" },
    { property_name: "ルクレ難波", room_no: "208", delivery: null, source: "vision", channel: "recommendation", sent_at: "2026-09-28T10:00:00Z" },
  ];
  const row = (id: number, name: string, room: string, extra: Record<string, unknown> = {}) => ({ id, rank: id, recommended: 0, score: 100 - id, status: "pending", verdict: "pass", property_name: name, room_no: room, ...extra });
  const items = [row(1, "プレサンス難波インフィニティ", "304"), row(2, "プレサンス難波インフィニティ", "305"), row(3, "エスリード難波ザ・アーク", "1104"), row(4, "ルクレ難波", "208"), row(5, "ルクレ難波", "208", { status: "sent" }), row(6, "新しい物件", "101")];
  const before = sentBeforeIds(items, hist);
  t("届けた部屋（304・オススメの 208）だけ・共有した 1104・別の部屋 305・送信済みの行は入れない", JSON.stringify([...before].sort()) === JSON.stringify([1, 4]), [...before]);
  const q = pickQualityTop(items, null, 10, { sentBefore: before });
  t("✨質の高い10件: 送付済みの2件は入らない・数える", JSON.stringify(q.ids) === JSON.stringify([2, 3, 6]) && q.sentExcluded === 2, q);
  t("知らせの文に「送付済みの部屋は選びません・2件」", /送付済みの部屋は選びません・2件/.test(qualityPickMessage(q.ids.length, q.ngExcluded, 10, { sentExcluded: q.sentExcluded })));
  const def = defaultAixChecks([{ items, created_at: "2026-09-29T00:00:00Z" }], null, 10, { sentHistory: hist });
  t("既定のチェックも同じ（1・4 は付かない）", def[1] === false && def[4] === false && def[2] === true && def[6] === true, def);
  t("履歴を渡さなければ今まで通り", defaultAixChecks([{ items }], null, 10)[1] === true);
  t("手で選んだ時の確かめ: 送付済みが入っていれば文（OK で送れる）", /送付済みの部屋が2件入っています/.test(sentConfirmMessage([items[0], items[1], items[4]], hist) ?? "") && sentConfirmMessage([items[1], items[5]], hist) === null);
  t("空の履歴では何も外さない", sentBeforeIds(items, []).size === 0 && sentBeforeIds(items, null).size === 0);
}

console.log("\n■ ★物件出し★のまとめ: 送付済みの部屋は上位に並べない・👑 なら印");
{
  const it = (id: number, name: string, room: string, sent_before = false) => ({ id, verdict: "pass", status: "pending", score: 120 - id, property_name: name, room_no: room, summary_text: `【${id}】${name} ${room}\n家賃 7万`, sent_before });
  const text = buildAnnouncement({ customerName: "YUMA", sites: { realpro: 3 }, items: [it(1, "A", "101", true), it(2, "B", "202"), it(3, "C", "303", true), it(4, "D", "404")], bestId: 1, link: null });
  t("👑 が送付済みなら印", /👑 一番オススメ（[^）]*）（⚠ この部屋は送付済み）/.test(text), text);
  t("上位に送付済みの C は並ばない", !/【\d】C 303/.test(text) && /【2】B 202/.test(text) && /【3】D 404/.test(text), text);
  t("並べなかった数を1行", /（送付済みの部屋 2件は並べていません）/.test(text));
  const plain = buildAnnouncement({ customerName: "YUMA", sites: { realpro: 2 }, items: [it(1, "A", "101"), it(2, "B", "202")], bestId: 1, link: null });
  t("送付済みが無ければ今まで通り（印も行も出ない）", !/送付済み/.test(plain));
  const rooms = pickSentRooms([{ property_name: "エスリード難波 101号室", room_no: null }, { property_name: "エスリード難波", room_no: "102" }], buildSentRoomIndex([{ name: "エスリード難波", room: "101" }]));
  t("pickSentRooms: 号室が無い行は物件名の末尾から読む", rooms.length === 1 && rooms[0].property_name === "エスリード難波 101号室");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
