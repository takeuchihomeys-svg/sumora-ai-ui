// app/lib/__tests__/brain-situation-1016.test.ts — 2026-10-16 状況の読み（伝え済み・背景・送っていない番のご査収・代理契約の交渉）
//   実行: npx tsx app/lib/__tests__/brain-situation-1016.test.ts
import { roomToldOf, roomToldLines } from "../property-told";
import { fixUnsentReviewAck, sentSinceLastAttachment } from "../unsent-review-ack";
import { fixProxyNegotiate } from "../takeuchi-wording-r11";
import { moveOutViewingVerdict } from "../move-out-context";
import { pickCostBreakdownImages } from "../cost-breakdown-images";
import { splitPropertyName } from "../customer-state";
import { normalizeBrainTurnContract, buildTurnContract, renderTurnContractNote } from "../turn-contract";
import { ackFormShapeLine, ackFormCloserLine, isCompactWaitLine } from "../repeat-brain-align";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const jst = (iso: string) => iso.slice(5, 16);

// ── 伝え済み（事例 c）──
const sentAt = "2026-10-15T10:54:41.000Z";
const msgs = [
  { sender: "staff", text: "[画像]", created_at: sentAt, image_url: "u1" },
  { sender: "staff", text: "Xさんお待たせ致しました！！\nこちらの2件初期費用2,980円＋前家賃でご入居出来るお部屋となります！！\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！", created_at: "2026-10-15T10:54:42.000Z" },
  { sender: "customer", text: "こちらの物件気になります", created_at: "2026-10-15T10:56:03.000Z" },
];
const told = roomToldOf([{ at: sentAt, kind: "sent" }, { at: "2026-10-15T10:56:03.000Z", kind: "customer_ask" }], msgs);
t("初期費用を伝え済み・ご案内に誘った", !!told.cost && /2,980円/.test(told.cost.quote) && told.viewingInvited);
const lines = roomToldLines({ told, origin: "ours", topic: "like", turnAt: "2026-10-15T10:56:03.000Z", jst });
t("目安は内覧の日程（確認・見積の約束にしない）", lines.some((l) => /aix=viewing_invite/.test(l)) && lines.some((l) => /送った時点で募集中/.test(l)));
t("質問の番（「202は子ども不可ですか」）には内覧の目安を出さない", !roomToldLines({ told, origin: "ours", topic: "other", turnAt: "2026-10-15T10:56:03.000Z", jst, customerText: "202は子ども不可ですか" }).some((l) => /目安/.test(l)));
t("「こちらの物件気になります」（話題は other）には出す", roomToldLines({ told, origin: "ours", topic: "other", turnAt: "2026-10-15T10:56:03.000Z", jst, customerText: "こちらの物件気になります" }).some((l) => /aix=viewing_invite/.test(l)));
t("お客様の持ち込みには目安を出さない", !roomToldLines({ told, origin: "customer", topic: "like", turnAt: "2026-10-15T10:56:03.000Z", jst }).some((l) => /目安/.test(l)));
t("3日より前に送った物件は募集中と言わない", !roomToldLines({ told, origin: "ours", topic: "like", turnAt: "2026-10-20T10:56:03.000Z", jst }).some((l) => /募集中/.test(l)));
// 事例 g: 見積書を送った物件の費用の質問
const told2 = roomToldOf([{ at: "2026-10-09T08:19:00.000Z", kind: "estimate", text: "初期費用 170,480円" }], []);
t("見積書を送った物件の費用の質問 → AIX【初期費用について】", roomToldLines({ told: told2, origin: "customer", topic: "cost", turnAt: "2026-10-13T05:13:00.000Z", jst }).some((l) => /AIX【初期費用について】/.test(l)));

// ── 送っていない番のご査収（事例 f）──
const conv = [
  { sender: "staff", text: "[画像]", isAix: true },
  { sender: "staff", text: "【〇〇 405号室】初期費用…", isAix: true },
  { sender: "customer", text: "ここは入居可能日いつ頃ですか？" },
  { sender: "staff", text: "即入居可能なお部屋となります！！" },
  { sender: "customer", text: "分かりました！" },
];
t("送った後にこちらが話している＝送っていない番", sentSinceLastAttachment(conv));
const f = fixUnsentReviewAck("はい😊！！\nお手隙の際にご査収ください😌！！\n何卒よろしくお願い致します！！", conv, true);
t("ご査収 → お気軽にご連絡", !!f.changed && /お気軽にご連絡ください/.test(f.text) && !/ご査収/.test(f.text));
const justSent = [{ sender: "staff", text: "[画像]", isAix: true }, { sender: "customer", text: "ありがとうございます" }];
t("送った直後のお礼への「ご査収ください」は竹内さんの形＝そのまま", !fixUnsentReviewAck("はい😊！！\nお手隙の際にご査収ください😌！！", justSent, true).changed);
t("「ご査収頂きありがとうございます」は触らない", !fixUnsentReviewAck("ご査収頂きありがとうございます！！", conv, true).changed);
t("下書きが新しい資料を添える文ならそのまま", !fixUnsentReviewAck("それぞれの初期費用お見積書お送りさせていただきました😊！！\nお手隙の際にご査収ください😌！！", conv, true).changed);
// 確かめる人の残り: [画像] の後の添え文 → お客様のお礼 は送った番（添え文を会話文と数えない）
const captioned = [
  { sender: "customer", text: "見積お願いします" },
  { sender: "staff", text: "[画像]", imageUrl: "u" },
  { sender: "staff", text: "お待たせ致しました！！\nこちら最大限割引しました初期費用の御見積書となります！！" },
  { sender: "customer", text: "ありがとうございます" },
];
t("添え文の後のお礼は送った番＝そのまま", !sentSinceLastAttachment(captioned) && !fixUnsentReviewAck("はい😊！！\nお手隙の際にご査収ください😌！！", captioned, true).changed);
t("窓に資料が無い時は分からない＝そのまま", !fixUnsentReviewAck("お手隙の際にご査収ください😌！！", [{ sender: "staff", text: "確認させて頂きます！！" }, { sender: "customer", text: "ありがとうございます" }], true).changed);
t("送った後にお客様が話しこちらが答えた（固まりが別）＝替える", sentSinceLastAttachment([...captioned, { sender: "staff", text: "即入居可能です！！" }, { sender: "customer", text: "分かりました！" }]));

// ── 代理契約は交渉（事例 e）──
t("代理契約の約束は交渉", fixProxyNegotiate("クリエオーレ一津屋Ⅱの代理契約が可能かどうかを管理会社に確認させて頂きます！！", true).text === "クリエオーレ一津屋Ⅱの代理契約が可能かどうかを管理会社に交渉させて頂きます！！");
t("結果の報告（確認させて頂きましたところ）は触らない", fixProxyNegotiate("代理契約可能か確認させて頂きましたところ", true).changes.length === 0);
t("代理契約の書類の確認は交渉にしない", fixProxyNegotiate("代理契約の必要書類につきまして確認させて頂きます！！", true).changes.length === 0);
t("募集状況も同じ文で確認する約束は替えない", fixProxyNegotiate("〇〇の募集状況と代理契約が可能か確認させて頂きます", true).changes.length === 0);

// ── 背景（答える前の整理）──
const raw = normalizeBrainTurnContract({ background: "審査否決の後で代理契約を気にし、月末の退去に間に合うか焦っている", asks: [{ quote: "代理契約は難しいですか", route: "promise", answer: "管理会社に交渉する" }], feeling: { kind: "hurried", acknowledge: true } });
t("背景を読む", raw?.background === "審査否決の後で代理契約を気にし、月末の退去に間に合うか焦っている");
const tc = buildTurnContract({ brain: raw, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
const note = renderTurnContractNote(tc);
t("返信の本質に背景と支える一言", /この発言の背景（ブレイン）/.test(note) && /一言で支える/.test(note));
t("背景だけでも本質は残る", normalizeBrainTurnContract({ background: "x の背景" })?.background === "x の背景");
t("BRAIN_TURN_BACKGROUND=off で読まない", (() => { process.env.BRAIN_TURN_BACKGROUND = "off"; const r = normalizeBrainTurnContract({ background: "y", asks: [{ quote: "a" }] }); delete process.env.BRAIN_TURN_BACKGROUND; return !r?.background; })());

// ── 初期費用についての画像（事例 g）: 5件の束から今の物件の資料＋直後の御見積書だけ ──
{


  const at = (s: number) => new Date(Date.parse("2026-10-09T08:24:00Z") + s * 1000).toISOString();
  const msgs = [
    { id: "1", image_url: "sheetA", created_at: at(0), sender: "staff" }, { id: "2", image_url: "estA", created_at: at(1), sender: "staff" },
    { id: "3", image_url: "sheetB", created_at: at(30), sender: "staff" }, { id: "4", image_url: "estB", created_at: at(31), sender: "staff" },
  ];
  const sent = [{ property_name: "アーバネックス堺筋本町", room_no: "501", image_url: "sheetA" }, { property_name: "ソルテラスUMEDA NORTH", room_no: "207", image_url: "sheetB" }];
  const got = pickCostBreakdownImages(splitPropertyName("アーバネックス堺筋本町 501号室"), sent, msgs);
  t("今の物件の資料＋直後の御見積書だけ（別の物件の画像は入れない）", JSON.stringify(got?.map((m) => m.id)) === JSON.stringify(["1", "2"]));
  t("記録が無い物件は null（旧の決め方）", pickCostBreakdownImages(splitPropertyName("知らない物件 101号室"), sent, msgs) === null);
}
// ── 内覧日調整の物件名は引用した1件（事例 d）──
{
  const { narrowToQuotedProperty } = require("../quoted-viewing-target") as typeof import("../quoted-viewing-target");
  t("引用した1件だけに絞る", narrowToQuotedProperty("グランパシフィック桜川南 902号室、セレッソコート西心斎橋Ⅲ 305号室", [{ display: "グランパシフィック桜川南 902号室", by: "quote" }]) === "グランパシフィック桜川南 902号室");
  t("名指し・推定は触らない", narrowToQuotedProperty("A 101号室、B 202号室", [{ display: "A 101号室", by: "named" }]) === null);
  t("欄が1件なら触らない", narrowToQuotedProperty("A 101号室", [{ display: "A 101号室", by: "quote" }]) === null);
}
// ── 5日前の別のお部屋の「退去予定・お申込で抑え」で、新しい束への「気になります」を申込へにしない（事例 c）──
{
  const { moveOutViewingVerdict } = require("../move-out-context") as typeof import("../move-out-context");
  const msgs = [
    { sender: "staff", text: "10月末退去予定で1件かなりオススメ出来るお部屋が募集に出ました！！\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！" },
    { sender: "customer", text: "初期費用無料のところもあると見たのですが" },
    { sender: "staff", text: "ピックアップしお送りさせていただきます！！" },
    { sender: "customer", text: "ありがとうございます。" },
    { sender: "staff", text: "[画像]" },
    { sender: "staff", text: "こちらの2件初期費用2,980円＋前家賃でご入居出来るお部屋となります！！" },
    { sender: "customer", text: "こちらの物件気になります" },
  ];
  t("新しい束への反応は退去予定の縛りに入れない", moveOutViewingVerdict(msgs, "oldest_first").blocks === false);
}
// ── 材料の主語（竹内さん→お客様に変えない）──
{
  const { maskPII } = require("../pii-mask") as typeof import("../pii-mask");
  t("材料の「竹内さん」は伏せない・お客様の「田中さん」は伏せる", maskPII("竹内さんはこの番を締める。田中さん", ["YUMA"]) === "竹内さんはこの番を締める。お客様");
}
{
  // 確かめる人 10/16: 新しい束の例外（MOVE_OUT_NEW_BUNDLE）は、同じ退去予定のお部屋の資料を送り直した束には効かない

  const base = [
    { sender: "staff", text: "メゾンラトゥール 103号室現在募集中となります！！\n10月30日退去予定となりますので、お申込みで抑えることをオススメ致します😊" },
    { sender: "customer", text: "ありがとうございます、他も見たいです" },
  ];
  const same = [...base, { sender: "staff", text: "メゾンラトゥール 103号室の資料です" }, { sender: "staff", text: "[画像]" }, { sender: "customer", text: "こちらの物件気になります" }];
  const other = [...base, { sender: "staff", text: "こちらの2件いかがでしょうか" }, { sender: "staff", text: "[画像]" }, { sender: "customer", text: "こちらの物件気になります" }];
  t("同じ退去予定のお部屋の束は先押さえのまま", moveOutViewingVerdict(same as never, "oldest_first").reason === "hold_advised");
  t("名前の無い新しい束は別のお部屋の話", moveOutViewingVerdict(other as never, "oldest_first").reason === "switched_to_other_property");
}
// ── 探す約束の続きの了承（事例 f）: ブレインの wait_line ＋ 決まった処理の open_search が下書きの形まで届く ──
{
  const raw = normalizeBrainTurnContract({ asks: [{ quote: "分かりました！", kind: "feeling", route: "none" }], close_only: true, ack_form: "wait_line", proposals: ["空室1部屋のためお申込みでお部屋を抑える提案"], open_search: "独立洗面台・トイレ別のご条件で引き続きお部屋お探しさせて頂きます" });
  const tc2 = buildTurnContract({ brain: raw, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  const note2 = renderTurnContractNote(tc2);
  t("open_search を読む", tc2.openSearch === "独立洗面台・トイレ別のご条件で引き続きお部屋お探しさせて頂きます");
  t("待ちの形は新着の形（お気軽にご連絡＋新着出次第お送り）", /お気軽にご連絡/.test(note2) && /新着でご条件に合ったお部屋が出次第お送り/.test(note2));
  t("申込の提案は添えない", !/お申込みでお部屋を抑える/.test(note2));
  t("形の行・締めの行も新着の形", /新着/.test(ackFormShapeLine("wait_line", tc2.openSearch)) && /新着/.test(ackFormCloserLine("wait_line", tc2.openSearch)));
  t("受けだけの判断なら新着の形にしない", !/新着/.test(ackFormShapeLine("receive_only", tc2.openSearch)));
  t("探す約束が無ければ今まで通り", !/新着/.test(ackFormShapeLine("wait_line", null)));
  t("新着の待ちの1文は短い待ちの形に数える", isCompactWaitLine("引き続き新着でご条件に合ったお部屋が出次第お送りさせて頂きます😌！！"));
}
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
