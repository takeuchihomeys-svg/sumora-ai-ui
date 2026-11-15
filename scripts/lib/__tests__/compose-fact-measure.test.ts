// 2026-11-15 作業員H: 文の物差しの「事実」の数え直し（話題か中身の重なり）と、本番の毎日の物差し（竹内さんの実送信×下書き）の純関数のテスト。DB・LLM なし。
//   元の番の形（試験 q063・q326・q057 の竹内さんの文と設計図の事実の欄・見張りの番の形）
// 実行: npx tsx scripts/lib/__tests__/compose-fact-measure.test.ts
import { factContentRatio, FACT_CONTENT_MIN, ELEMENTS } from "../compose-gold";
import { compareProdTurn, tallyProd } from "../compose-prod-elements";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

// q063: 竹内さんの話題「2階の虫」×設計図の答え「7階以上は虫が入る可能性が低い…」＝話題の語では当たらないが、中身は竹内さんの文と同じ
const q063T = "お世話になっております！！ 2階は虫が入る可能性御座います！！ お部屋7階以上ですと虫入る可能性ほとんど御座いませんので、虫気になられる場合は7階以上のお部屋でご選択頂くのがオススメです😊！";
const q063F = "7階以上は虫が入る可能性が低い。低層階は可能性がある。";
ok("q063: 中身の重なりで当たり（話題の語の比べでは外れていた）", factContentRatio(q063F, q063T).ratio >= FACT_CONTENT_MIN, String(factContentRatio(q063F, q063T).ratio));
// q326: 「初期費用の分割払い」×「クレジットカード払いのみ分割対応可」
const q326T = "初期費用はクレジットカード払いの場合のみ分割が可能です😊！！ カード手数料として合計金額に3.24%が別途必要となります！！";
ok("q326: 中身の重なりで当たり", factContentRatio("クレジットカード払いのみ分割対応可", q326T).ratio >= FACT_CONTENT_MIN);
// q057: 設計図は「内見可能」・竹内さんは「退去前のため室内の内覧はできない」＝中身が違う→外れのまま
const q057T = "はい！！ 退去前のため室内の内覧はできないのですが、建物の外観や共用部・周辺環境は現地でご確認いただけます！！";
ok("q057: 中身が違う（内見可能）は外れのまま", factContentRatio("内見可能。現地案内・オンライン内見・室内撮影から選べる", q057T).ratio < FACT_CONTENT_MIN);
ok("物差しの要素に「事実（中身）」「事実（話題だけ）」がある", ELEMENTS.includes("事実（中身）") && ELEMENTS.includes("事実（話題だけ）"));

// 本番の物差し: 竹内さんの実送信×下書き
{
  const T = ["かしこまりました！！\n駐車場・駐輪場の有無を確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！"];
  const D = "かしこまりました！！\n駐車場と駐輪場の有無を確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！\n何卒よろしくお願い致します！！";
  const r = compareProdTurn(T, D);
  const get = (e: string) => r.find((x) => x.el === e)!;
  ok("頭が同じ（かしこまりました）", get("頭").hit);
  ok("事実（答えの文の重なり）が当たり", get("事実").has && get("事実").hit, get("事実").detail);
  ok("締めの違い（竹内さんは結びなし・下書きは何卒）は外れ", !get("締め").hit, get("締め").detail);
  ok("竹内さんの文に無い要素は数えない（信頼・潜在・つなぎ・2通目）", !get("信頼").has && !get("潜在").has && !get("つなぎ").has && !get("2通目").has);
  const t = tallyProd([r, r]);
  ok("集計", t["頭"].has === 2 && t["頭"].hit === 2 && t["締め"].hit === 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
