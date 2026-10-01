// 実行: npx tsx app/lib/__tests__/check-result-closing.test.ts
// 2026-10-01 竹内「見積書や他のよく使うAIXテンプレートの部分も改善する」
//   AIX【物件確認した】の定型の下書きと、スタッフが直して送った文（実送信・お客様の名前だけ置き換え）をそのまま使う。
import { appendCheckResultReceipt, CHECK_RESULT_RECEIPT_LINE } from "../check-result-closing";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

// 下書き（10/01 07:48 の前の形）: 1件・空室・御見積書同封で締めが無い → スタッフは「お手隙の際にご査収ください😌！！」を足して送った
const D1 = "Aさん確認させていただきました！！\nREGALEST初芝3 202号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！\n\n現在お申込みが入っており、2番手でのお申込みが可能となっております！！";
{
  const r = appendCheckResultReceipt(D1, { hasEstimate: true });
  t("御見積書同封・締め無し → ご査収を最後に足す", r.added && r.text === `${D1}\n\n${CHECK_RESULT_RECEIPT_LINE}`, r.text);
}
t("御見積書を同封していない → 足さない", !appendCheckResultReceipt("TC天美南現在募集中となります！！", { hasEstimate: false }).added);
// 複数・御見積書同封（定型の御見積書の行の直後にご査収がある）→ 足さない
const D2 = "お世話になっております！！\nAさんお送り頂きました物件の中で\n・ディアコート曽根 304号室\n・フィユフラッツ中桜塚 102号室\nこちら2件現在募集中となります！！\n最大限割引しました初期費用御見積書同封させて頂きました。\nお手隙の際にご査収ください！！\n\nAさんお送りいただきました他2件は\n募集終了しているお部屋となります。";
t("既にご査収がある（途中の行）→ 足さない", !appendCheckResultReceipt(D2, { hasEstimate: true }).added);
// 内覧の誘い（ボタンで付けた）で締めている → 足さない
const D3 = "Bさん確認させていただきました！！\nエステムコート 1002号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！\n\nBさんご都合よろしいお日にちにご案内させて頂きます😊！！";
t("内覧の誘いで締めている → 足さない", !appendCheckResultReceipt(D3, { hasEstimate: true }).added);
// 「お手隙の際にご確認ください！！」（スタッフの形）も締め
t("ご確認ください の締め → 足さない", !appendCheckResultReceipt("中川西一戸建現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！\n\nお手隙の際にご確認ください😊！！", { hasEstimate: true }).added);
t("空の文 → 何もしない", !appendCheckResultReceipt("", { hasEstimate: true }).added);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
