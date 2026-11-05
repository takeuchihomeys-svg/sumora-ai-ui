// 実行: npx tsx app/lib/__tests__/draft-self-repeat-exit.test.ts
// 2026-11-05 作業員3: 同じ下書きの中の二度言いを落とす出口（draft-repeat.ts selfRepeatExitHits / dropSelfRepeats / applySelfRepeatExit）。
//   実物の文（竹内さんの送信・過去の下書き）をそのまま使う。竹内さんの送信は1つも変えない＝誤削除0（scripts/audit-self-repeat.ts の 60日監査と同じ物）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dropSelfRepeats, applySelfRepeatExit, draftSelfRepeatDropOn } from "../draft-repeat";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const same = (t: string) => { const r = dropSelfRepeats(t); ok(r.dropped.length === 0 && r.text === t, JSON.stringify(r.dropped)); };

// ── 竹内さんの送信（変えてはいけない）──
it("竹内さん 2fa0c933: 条件を付けて言い直す（〜次第）は残す", () => same("かしこまりました！！\nお申込し審査かけさせて頂きます！！\n\n上記フォーマットご入力いただき、ご本人確認書類として運転免許証またはマイナンバーカードの裏表の写真をお送りください！！\n※マイナンバーカードの場合は番号部分をマスキングいただけますと幸いです😌！！\n\nお送り頂き次第、お部屋お申込し審査かけさせて頂きます！！"));
it("竹内さん: 申込フォーマットの項目の重なり（申込者・同居人）は見ない", () => same("【お申込者様記入欄】\n・氏名、フリガナ\n・現住所 （住民票記載〒）\n・駐車場利用の有無（台数）\n\n【同居人記入欄】\n・氏名、フリガナ\n・現住所 （住民票記載〒）\n・駐車場利用の有無（台数）"));
it("竹内さん fb4d98fd: 物件ごとの条件の箇条書きは見ない", () => same("①レジュールアッシュOSAKAデイフィール\n・インターネット無料\n・短期違約金有り(6ヶ月未満総賃料2ヶ月、1年未満総賃料1ヶ月)\n\n\n②グランドロアール上新庄\n・インターネット別途契約必要\n・短期違約金有り(6ヶ月未満総賃料2ヶ月、1年未満総賃料1ヶ月)"));
it("竹内さん: 物件の札（罫線・駅徒歩・㎡）・金額の行は見ない", () => {
  same("━━━━━━━━━━━━━━\n1LDK 35.25㎡\n東海道線「西大路」徒歩15分\n━━━━━━━━━━━━━━\n1LDK 29.95㎡\n東海道線「西大路」徒歩15分\n━━━━━━━━━━━━━━");
  same("差引請求金額：337,980\n\n差引請求金額：337,980");
});
it("礼儀の定型は見ない", () => same("かしこまりました！！\n何卒よろしくお願い致します！！\n何卒よろしくお願い致します！！"));

it("b18ac4b8: 物件ごとの「・物件名」の下の同じ文は残す", () => same("・エテルノ泉南馬場\n小型犬のみ飼育可能なお部屋となります。\n\n・ボニート西本町\n小型犬のみ飼育可能なお部屋となります。"));
it("9a764026: 約束でないお願いの文（ご不明点等ございましたらいつでもご連絡ください）は見ない", () => same("ご確認後、ご質問やご不明点等ございましたらいつでもご連絡ください😌！！\n何卒よろしくお願い致します！！\nご確認後、ご質問やご不明点等ございましたらいつでもご連絡ください😌！！"));
it("物件の札で区切られた同じ約束は比べない（区切りが変わる）", () => same("募集状況確認させて頂きます！！\n・Aハイツ 301号室\n募集状況確認させて頂きます！！"));

// ── 過去の下書き ──
it("145c2664: 同じ約束の二度言いの2つ目を落とす", () => {
  const d = "かしこまりました！！\nお送り頂きました物件の初期費用、最大限割引させて頂いた御見積書を作成しお送りさせて頂きます😊！！\n\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！\nご入居日によって別途かかるのは日割家賃のみですので、ご安心ください😌！！";
  const r = dropSelfRepeats(d);
  ok(r.dropped.length === 1 && !/^最大限割引させていただいた/m.test(r.text) && /お送り頂きました物件の初期費用/.test(r.text) && /日割家賃/.test(r.text) && !/\n\n\n/.test(r.text), JSON.stringify(r));
});
it("bcfc51dd: 日にちが違う2文（明日9月17日12時／本日12時）は言い直しでない＝どちらも残す", () => same("Sさん明日9月17日12時お部屋ご案内させて頂きます！\n\n本日12時お部屋ご案内させて頂きます！\n\n本日は何卒よろしくお願い致します！！"));
it("ab0008d1: 「本日〇〇時」と「本日13時」は別の文（出口はどちらが正しいかを決めない）", () => same("慶次さんお疲れ様です！！\n本日〇〇時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！\n\n慶次さんお疲れ様です！！\n本日13時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！"));

// ── スイッチと配線 ──
it("既定 on で落とす・off は本文を変えない", () => {
  const d = "御見積書を作成しお送りさせて頂きます！！\n御見積書を作成しお送りさせて頂きます！！";
  ok(draftSelfRepeatDropOn({}) && applySelfRepeatExit(d, { DRAFT_SELF_REPEAT_DROP: "off" }).text === d);
  const r = applySelfRepeatExit(d, { DRAFT_SELF_REPEAT_DROP: "on" });
  ok(r.text === "御見積書を作成しお送りさせて頂きます！！" && r.changes.length === 1 && r.changes[0].startsWith("二度言いを外す: "), JSON.stringify(r));
});
it("配線: generate-reply の仕上げの出口（wording-1002 の束）で applySelfRepeatExit を呼び、本文に戻す", () => {
  const src = readFileSync(join(__dirname, "..", "..", "api", "generate-reply", "route.ts"), "utf8");
  ok(/import \{[^}]*applySelfRepeatExit[^}]*\} from "@\/app\/lib\/draft-repeat"/.test(src), "import が無い");
  const m = src.match(/const dc = dropDoubleConfirmContact\(draftBody\);[\s\S]{0,600}?const srp = applySelfRepeatExit\(draftBody\); if \(srp\.changes\.length\) \{ w\.push\(\.\.\.srp\.changes\); draftBody = srp\.text; \}/);
  ok(m, "仕上げの束で呼んでいない");
  // 同じ束のログ（wording-1002）の前にある
  const at = src.indexOf("const srp = applySelfRepeatExit(draftBody)"), log = src.indexOf('tag: "generate-reply:wording-1002"');
  ok(at > 0 && log > at, "ログより前でない");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
