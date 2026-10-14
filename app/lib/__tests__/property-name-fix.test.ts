// 2026-10-14 竹内さん「物件名はシリーズ名＋地名…化けは正しい地名に直す（候補が1つの時だけ）」— property-name-fix.ts
// 実行: npx tsx app/lib/__tests__/property-name-fix.test.ts
import { fixReadPropertyName, fixReadStationName, buildLedger, ledgerTrusted, isKnownPlaceToken, placeFixCandidate, placeRunsAlike, type LedgerSource } from "../property-name-fix";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}
const L = (...xs: Array<[string, LedgerSource, number?]>) => buildLedger(xs.flatMap(([name, source, n]) => Array.from({ length: n ?? 1 }, () => ({ name, source }))));
const fx = (read: string, ledger: ReturnType<typeof L>) => fixReadPropertyName(read, ledger, {});

console.log("■ 地名の表");
for (const p of ["梅田", "芦原橋", "今福", "遠里小野", "駒川中野", "難波", "大国町", "堺筋本町", "南堀江", "四條畷", "谷町"]) t(`地名: ${p}`, isKnownPlaceToken(p), p);
for (const p of ["梅出", "戸原橋", "令福", "速里小野", "駹川中野", "雑賀", "雜波"]) t(`化け: ${p}`, !isKnownPlaceToken(p), p);
t("旧字は地名の表と合う時だけ（大國町→大国町・確か）", JSON.stringify(placeFixCandidate("大國町")) === JSON.stringify({ from: "大國町", to: "大国町", via: "old_form", sure: true }), placeFixCandidate("大國町"));
t("1字違いの地名（梅出→梅田）は帳簿で確かめる側", placeFixCandidate("梅出")?.to === "梅田" && placeFixCandidate("梅出")?.sure === false, placeFixCandidate("梅出"));
t("化けの癖（雑賀→難波）は3つ以上の建物で見た＝確か", placeFixCandidate("雑賀")?.to === "難波" && placeFixCandidate("雑賀")?.sure === true, placeFixCandidate("雑賀"));
t("化けの癖＋頭尻（雑賀西→難波西）", placeFixCandidate("雑賀西")?.to === "難波西", placeFixCandidate("雑賀西"));
t("似ている地名: 1字違い", placeRunsAlike("戸原橋", "芦原橋"));
t("似ている地名: 字の化けの癖（鶴渡→難波）", placeRunsAlike("鶴渡", "難波"));
t("似ていない地名（日向→中宮）", !placeRunsAlike("日向", "中宮"));

console.log("■ 帳簿");
const lg = L(["スプランディッド難波キャトル", "text"], ["プレサンス芦原橋ヴィブラス", "text"], ["ル・クレール今福 502号室", "staff", 2], ["プレアール遠里小野", "text"], ["プレアール速里小野 102号室", "staff", 1]);
t("資料の文字は信頼", ledgerTrusted(lg.find((e) => e.name.startsWith("スプランディッド"))!));
t("スタッフの入力は2回で信頼（号室を外した名前）", ledgerTrusted(lg.find((e) => e.name === "ル・クレール今福")!), lg.map((e) => e.name));
t("スタッフの入力1回（先入れの化け）は信頼しない", !ledgerTrusted(lg.find((e) => e.name.includes("速里"))!));
t("建物の番号は名前に残す（Luxe難波西2）", buildLedger([{ name: "Luxe難波西2", source: "text" }])[0].name === "Luxe難波西2");

console.log("■ 直す（実例）");
const a = fx("スプランディッド雜波キャトル", lg);
t("雜波→難波（1字違い＋帳簿）", a.status === "fixed" && a.name === "スプランディッド難波キャトル", a);
const b = fx("プレサンス戸原橋ヴィブラス", lg);
t("戸原橋→芦原橋（竹内さんの例）", b.status === "fixed" && b.name === "プレサンス芦原橋ヴィブラス", b);
const c = fx("ル・クレール令福 502号室", lg);
t("令福→今福・号室はそのまま", c.status === "fixed" && c.name === "ル・クレール今福 502号室", c);
const d = fx("プレアール速里小野", lg);
t("速里小野→遠里小野（スタッフが化けのまま送った名前があっても資料の文字に）", d.status === "fixed" && d.name === "プレアール遠里小野", d);
const e = fx("セレニテ梅出 302号室", L(["セレニテ梅田", "text"]));
t("梅出→梅田", e.status === "fixed" && e.name === "セレニテ梅田 302号室", e);
const f = fx("Luxe雜賀西2", []);
t("帳簿が無くても確かな化け（雑賀→難波）は直す", f.status === "fixed" && f.name === "Luxe難波西2", f);
const g = fx("ミレージュバレス本町Depart", L(["ミラージュパレス本町Depart", "text", 3]));
t("シリーズ名の化け（ミレージュバレス→ミラージュパレス）", g.status === "fixed" && g.name === "ミラージュパレス本町Depart", g);
const h = fx("セレニテ雑波ミラク参番館", L(["セレニテ難波ミラク参番館", "text"], ["セレニテ難波ミラク壱番館", "text"]));
t("参番館は参番館のまま（壱番館に寄せない）", h.status === "fixed" && h.name === "セレニテ難波ミラク参番館", h);
t("駅の名前: 大國町→大国町", fixReadStationName("大國町") === "大国町");
t("駅の名前: 1字違いは直さない（梅出）", fixReadStationName("梅出") === "梅出");
t("駅の名前: 表の駅はそのまま", fixReadStationName("鴫野") === "鴫野");

console.log("■ 寄せない（シリーズ違い・地名違い・別の棟）");
const n1 = fx("エステムコート梅田", L(["エステムコート難波", "text"]));
t("地名が表にあり違う（梅田／難波）", n1.status !== "fixed", n1);
const n2 = fx("プレステージ日向", L(["プレステージ中宮", "text"]));
t("似ていない地名（日向／中宮）", n2.status !== "fixed", n2);
const n3 = fx("セレニティ加島4丁目B棟", L(["セレニティ加島4丁目A棟", "text"]));
t("B棟をA棟にしない", n3.status !== "fixed", n3);
const n4 = fx("カーザSun", L(["カーザSun I", "text"]));
t("番号を足さない（カーザSun→カーザSun I）", n4.status !== "fixed", n4);
const n5 = fx("深江橋第二コーポ", L(["深江橋コーポ", "text"]));
t("第二を落とさない", n5.status !== "fixed", n5);
const n6 = fx("ダイレ・エス", L(["ダイレ・エヌ", "text"]));
t("短い名前の1字違い（エス／エヌ）", n6.status !== "fixed", n6);
const n7 = fx("スプランディッド雜波", L(["スプランディッド難波", "text"], ["スプランディッド雑賀", "text"]));
t("帳簿の中に化けと同じ名前の建物がある時は寄せない（確かでない）", n7.status !== "fixed" || n7.name === "スプランディッド難波", n7);
const n8 = fx("グランパシフィック桃谷", L(["グランパシフィック長橋", "text"], ["グランパシフィック今宮", "text"]));
t("表の地名（桃谷）は触らない（名前はそのまま）", n8.status !== "fixed" && n8.name === "グランパシフィック桃谷", n8);
const n9 = fx("セレニテ雑波ミラク", L(["セレニテ難波ミラク", "text"], ["セレニテ雑波ミラク", "text"]));
t("読んだ名前が資料の文字の帳簿にある＝そのまま", n9.status === "known", n9);
t("戻す（PROPERTY_NAME_FIX=off）", fixReadPropertyName("スプランディッド雜波キャトル", lg, { PROPERTY_NAME_FIX: "off" }).status === "unchanged");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
