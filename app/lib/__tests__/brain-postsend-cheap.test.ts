// 2026-10-22 約束の送信の直後の安い道（brain-postsend-cheap.ts）。こちらの文は実物の形（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/brain-postsend-cheap.test.ts
import { brainPostSendCheapEnabled, decidePostSendCheap, customerPointedPropertyText, customerTurnBefore, propertyInPlayFrom } from "../brain-postsend-cheap";
import { promisesInStaffText } from "../promise-queue";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.error(`✗ ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`);
};
const at = "2026-10-20T03:00:00.000Z"; const now = Date.parse(at) + 30_000;
const base: { nowMs: number; need: null; openItemAction: string | null; isPostApply: boolean; propertyInPlay: boolean; customerPointedProperty: boolean } = { nowMs: now, need: null, openItemAction: null, isPostApply: false, propertyInPlay: true, customerPointedProperty: true };
const kind = (t: string, o: Partial<typeof base> = {}) => { const d = decidePostSendCheap({ ...base, ...o, sentSteps: promisesInStaffText(t, at) }); return d.kind === "insert" ? `insert:${d.step.action}:${d.tasks.join(",")}` : `${d.kind}:${d.reason}`; };

eq("既定 OFF", brainPostSendCheapEnabled({}), false);
eq("on で使う", brainPostSendCheapEnabled({ BRAIN_POSTSEND_CHEAP: "on" }), true);
eq("募集状況の確認の約束 → 物件確認した", kind("お部屋お送りいただきありがとうございます😊！！\nお部屋の募集状況確認させていただきます！！"), "insert:property_check_result:property_check");
eq("見積書の約束 → 見積書送る", kind("かしこまりました！！ 3部屋の最大限割引させていただいたお見積書お送りさせていただきます😊！！"), "insert:estimate_sheet:estimate_sheet");
eq("ピックアップの約束はブレインへ", kind("かしこまりました！！ 〇〇さんにオススメできるお部屋を新たにピックアップしてお送りさせて頂きます😌！！"), "full:other_kind");
eq("確認＋ピックアップの混ざりはブレインへ", kind("お送り頂きました物件の募集状況確認させて頂きます！！ 他にもオススメできるお部屋ピックアップしお送りさせて頂きます！！"), "full:other_kind");
eq("約束の無い通はブレインへ", kind("ご査収いただきありがとうございます😊！！"), "full:no_step");
eq("見積る物件が見えない見積の約束はブレインへ", kind("最大限割引させていただいたお見積書お送りさせていただきます！！", { propertyInPlay: false }), "full:estimate_no_property");
eq("お客様の依頼が見えない確認の約束はブレインへ", kind("お部屋の募集状況確認させていただきます！！", { customerPointedProperty: false }), "full:check_no_request");
eq("同じ要対応が立っている → 何もしない", kind("お部屋の募集状況確認させていただきます！！", { openItemAction: "property_check_result" }), "skip:open_same");
eq("違う要対応が立っている → ブレインへ", kind("お部屋の募集状況確認させていただきます！！", { openItemAction: "property_send" }), "full:open_differs");
eq("申込以降 → ブレインへ", kind("お部屋の募集状況確認させていただきます！！", { isPostApply: true }), "full:post_apply");

const msgs = [
  { sender: "staff", text: "よろしくお願いします", createdAt: "2026-10-20T01:00:00Z" },
  { sender: "customer", text: "[画像] 【物件の画面（ポータル）】", createdAt: "2026-10-20T02:50:00Z" },
  { sender: "customer", text: "ここ空いてますか？", createdAt: "2026-10-20T02:51:00Z" },
  { sender: "staff", text: "お部屋の募集状況確認させていただきます！！", createdAt: at },
];
eq("直前のお客様の連投", customerTurnBefore(msgs, Date.parse(at)), "[画像] 【物件の画面（ポータル）】\nここ空いてますか？");
eq("物件を指す連投", customerPointedPropertyText("ありがとうございます"), false);
eq("お客様の画像で見積る物件あり", propertyInPlayFrom(msgs, false), true);
eq("何も無ければ見積る物件なし", propertyInPlayFrom([{ sender: "customer", text: "初期費用知りたいです" }], false), false);

if (fail) { console.error(`${fail} failed`); process.exit(1); }
console.log("all ok");
