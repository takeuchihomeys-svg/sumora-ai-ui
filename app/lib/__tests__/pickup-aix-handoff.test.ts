// 2026-09-25 竹内「複数選択なら AIX 物件ピックアップ・1件なら AIX 物件オススメ」— 売上サポ → トークの AIX の受け渡し
// 実行: npx tsx app/lib/__tests__/pickup-aix-handoff.test.ts
import { aixTypeForPickupCount, pickupAixButtonLabel, buildPickupAixHref, parsePickupAixHandoff, planPickupMarkSent, PICKUP_AIX_MAX } from "../pickup-aix-handoff";

const WJ = String.fromCharCode(0x2060);
const plain = (s: string) => s.split(WJ).join("");

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}

console.log("■ 件数で AIX の種類を決める");
t("1件 → 物件オススメ", aixTypeForPickupCount(1) === "property_recommendation");
t("2件 → 物件ピックアップ", aixTypeForPickupCount(2) === "property_send");
t("10件 → 物件ピックアップ", aixTypeForPickupCount(10) === "property_send");
t("0件 → なし", aixTypeForPickupCount(0) === null);
t("ボタン: 1件は 物件オススメ", plain(pickupAixButtonLabel(1)) === "🏠 AIX物件オススメ（1件）");
t("ボタン: 3件は 物件ピックアップ（3件）", plain(pickupAixButtonLabel(3)) === "📤 AIX物件ピックアップ（3件）");
// 2026-09-25 E2E（390px のスクショ）:「（1」「件）」で割れて折り返していた → 数字と件の間は WORD JOINER
t("ボタン: 数字と「件」の間で折り返さない（1件・12件）", pickupAixButtonLabel(1).includes(`1${WJ}件`) && pickupAixButtonLabel(10).includes(`10${WJ}件`));
t("ボタン: 0件はチェックを促す", /チェック/.test(pickupAixButtonLabel(0)));

console.log("■ URL を作る");
const one = buildPickupAixHref({ conversationId: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", pickupIds: [45], batchId: "b1" });
t("1件 → aix=property_recommendation", one === "/?conv=dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7&aix=property_recommendation&pickup=45&batch=b1", one);
const many = buildPickupAixHref({ conversationId: "c", pickupIds: [3, 1, 2], batchId: "b" });
t("複数 → aix=property_send・並びはそのまま", many === "/?conv=c&aix=property_send&pickup=3%2C1%2C2&batch=b", many);
t("11件は作らない（10件まで）", buildPickupAixHref({ conversationId: "c", pickupIds: Array.from({ length: PICKUP_AIX_MAX + 1 }, (_, i) => i + 1) }) === null);
t("会話が無ければ作らない", buildPickupAixHref({ conversationId: "", pickupIds: [1] }) === null);
t("0件は作らない", buildPickupAixHref({ conversationId: "c", pickupIds: [] }) === null);

console.log("■ トーク側で URL を読む");
const r1 = parsePickupAixHandoff(new URL(`http://x${one}`).search);
t("作った URL を読める（1件＝物件オススメ）", r1?.aix === "property_recommendation" && r1.ids === "45" && r1.batch === "b1", r1);
const r2 = parsePickupAixHandoff(new URL(`http://x${many}`).search);
t("複数＝物件ピックアップ・ids は 3,1,2", r2?.aix === "property_send" && r2.ids === "3,1,2", r2);
t("旧の URL（aix=property_send で1件）は物件ピックアップのまま", parsePickupAixHandoff("?conv=c&aix=property_send&pickup=7")?.aix === "property_send");
t("物件オススメで2件来たら物件ピックアップに直す（オススメは1件だけ）", parsePickupAixHandoff("?conv=c&aix=property_recommendation&pickup=7,8")?.aix === "property_send");
t("他の aix は読まない", parsePickupAixHandoff("?conv=c&aix=estimate_sheet&pickup=7") === null);
t("pickup が無ければ読まない", parsePickupAixHandoff("?conv=c&aix=property_send") === null);

console.log("■ 送り終えた時の「送った」印（planPickupMarkSent）— 2026-09-25 YUMA の E2E の反証");
{
  const a = { n: "A" }, b = { n: "B" }, c = { n: "C" }, other = { n: "X" };
  const u = ["u1", "u2", "u3"];
  const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const all = planPickupMarkSent({ aix: "property_send", handoffIds: [1, 2, 3], handoffFiles: [a, b, c], sentFiles: [a, b, c], sentImageUrls: u });
  t("ピックアップ: セットしたまま送った → 3件に印・URL を結ぶ", eq(all, { itemIds: [1, 2, 3], imageUrls: u }), all);
  const removed = planPickupMarkSent({ aix: "property_send", handoffIds: [1, 2, 3], handoffFiles: [a, b, c], sentFiles: [a, c], sentImageUrls: ["u1", "u3"] });
  t("ピックアップ: 1枚外して送った → 外した行には印を付けない・URL は結ばない", eq(removed, { itemIds: [1, 3], imageUrls: [] }), removed);
  const added = planPickupMarkSent({ aix: "property_send", handoffIds: [1, 2], handoffFiles: [a, b], sentFiles: [a, b, other], sentImageUrls: ["u1", "u2", "u9"] });
  t("ピックアップ: 1枚足して送った → セットした2件に印・URL は結ばない", eq(added, { itemIds: [1, 2], imageUrls: [] }), added);
  const reordered = planPickupMarkSent({ aix: "property_send", handoffIds: [1, 2], handoffFiles: [a, b], sentFiles: [b, a], sentImageUrls: ["u2", "u1"] });
  t("ピックアップ: 並べ替えた → 2件に印・URL は結ばない（位置で結べない）", eq(reordered, { itemIds: [1, 2], imageUrls: [] }), reordered);
  const none = planPickupMarkSent({ aix: "property_send", handoffIds: [1, 2], handoffFiles: [a, b], sentFiles: [other], sentImageUrls: ["u9"] });
  t("ピックアップ: セットした画像を全部外して別の画像で送った → 印を付けない", none === null, none);
  const noImage = planPickupMarkSent({ aix: "property_send", handoffIds: [], handoffFiles: [], sentFiles: [other], sentImageUrls: ["u9"] });
  t("画像が1枚も取れなかった（取得の失敗・期限切れ）→ 印を付けない（旧は URL の ids 全部に付けていた）", noImage === null, noImage);
  const unknown = planPickupMarkSent({ aix: "property_send", handoffIds: [1, 3], handoffFiles: [a, c], sentFiles: null, sentImageUrls: u });
  t("送る直前の並びが分からない（古い画面）→ セットできた行だけに印・URL は結ばない", eq(unknown, { itemIds: [1, 3], imageUrls: [] }), unknown);
  const rec = planPickupMarkSent({ aix: "property_recommendation", handoffIds: [7], handoffFiles: [a], sentFiles: [a], sentImageUrls: ["u1"] });
  t("オススメ: セットした資料のまま送った → 印のみ・URL は結ばない（記録は画像の読み取り＝aix:property_recommendation）", eq(rec, { itemIds: [7], imageUrls: [] }), rec);
  const recSwap = planPickupMarkSent({ aix: "property_recommendation", handoffIds: [7], handoffFiles: [a], sentFiles: [other], sentImageUrls: [] });
  t("オススメ: 資料を「変更」で別の物件に差し替えて送った → 売上サポの物件に印を付けない", recSwap === null, recSwap);
  const recNoFile = planPickupMarkSent({ aix: "property_recommendation", handoffIds: [7], handoffFiles: [a], sentFiles: [], sentImageUrls: [] });
  t("オススメ: 資料なしで送った → 印を付けない", recNoFile === null, recNoFile);
  t("ids と File の数が違う（呼び間違い）→ 印を付けない", planPickupMarkSent({ aix: "property_send", handoffIds: [1, 2], handoffFiles: [a], sentFiles: [a], sentImageUrls: [] }) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
