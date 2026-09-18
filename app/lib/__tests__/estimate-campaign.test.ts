// app/lib/__tests__/estimate-campaign.test.ts
// 実行: npx tsx app/lib/__tests__/estimate-campaign.test.ts
import { buildCampaignLine, buildCampaignNote, ensureCampaignLine } from "../estimate-campaign";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── スタッフの言葉をそのまま使う（完成文）");
{
  // 竹内さんが画像で示した実送信そのまま
  const a = buildCampaignLine("9月中のお申込は礼金キャンペーン中となり、敷金礼金0円でご入居出来ますので初期費用をかなり抑える事が出来ます");
  t("完成文はそのまま（末尾だけ！！に揃える）",
    a?.source === "as_is" && a.line === "9月中のお申込は礼金キャンペーン中となり、敷金礼金0円でご入居出来ますので初期費用をかなり抑える事が出来ます！！",
    a?.line);
  const b = buildCampaignLine("初回保証料免除のキャンペーン中ですので初期費用かなり抑える事ができます！！");
  t("既に！！が付いていても増やさない", b?.line.endsWith("できます！！") === true, b?.line);
  t("「。」で終わる文も！！に揃える",
    buildCampaignLine("11月末まで家賃無料のキャンペーン中となります。")?.line === "11月末まで家賃無料のキャンペーン中となります！！");
}

console.log("── 中身だけなら実送信の骨組みに当てはめる");
{
  const a = buildCampaignLine("礼金0円");
  t("「礼金0円」→ 実送信の骨組み",
    a?.source === "framed" && a.line === "礼金0円のキャンペーン中となりますので初期費用をかなり抑える事が出来ます😊！！", a?.line);
  const b = buildCampaignLine("初回保証料免除");
  t("「初回保証料免除」も同じ骨組み", b?.line.startsWith("初回保証料免除のキャンペーン中となりますので") === true, b?.line);
  t("末尾の助詞は落としてから当てはめる",
    buildCampaignLine("礼金0円の")?.line === "礼金0円のキャンペーン中となりますので初期費用をかなり抑える事が出来ます😊！！");
}

console.log("── 空・短すぎ");
{
  t("空は null", buildCampaignLine("") === null && buildCampaignLine(null) === null && buildCampaignLine("   ") === null);
  t("1字は null", buildCampaignLine("あ") === null);
  t("指示も空になる", buildCampaignNote("") === "");
}

console.log("── 生成の指示");
{
  const note = buildCampaignNote("礼金0円");
  t("入力した1文が指示に入る", note.includes("礼金0円のキャンペーン中となりますので"), note);
  t("創作を禁じる行が入る", note.includes("入力していない特典・期限・金額を書き足さない"));
  t("言い換えを禁じる行が入る", note.includes("言い換え・要約・金額の足し引きをしない"));
}

console.log("── 出口の保証（締めの直前に入れる）");
{
  // カバーレターの実送信の並び: 御見積書の案内 → キャンペーン → 締め
  const draft = "こちら初期費用の御見積書となります！！\nお気に召されましたらお部屋ご案内させて頂きます😌！！";
  const r = ensureCampaignLine(draft, "9月中のお申込は礼金キャンペーン中となり、敷金礼金0円でご入居出来ますので初期費用をかなり抑える事が出来ます");
  t("締めの直前に入る", r.added && r.text.split("\n")[1].startsWith("9月中のお申込は礼金"), r.text);
  t("締めは最後のまま", r.text.split("\n").slice(-1)[0].startsWith("お気に召されましたら"), r.text);

  const already = "こちら初期費用の御見積書となります！！\n9月中のお申込は礼金キャンペーン中となり敷金礼金0円でご入居頂けます！！\nお手隙の際にご査収ください😌！！";
  t("既にキャンペーンの話があれば触らない", ensureCampaignLine(already, "礼金0円").added === false);

  const noClosing = "こちら初期費用の御見積書となります！！";
  const r2 = ensureCampaignLine(noClosing, "礼金0円");
  t("締めが無ければ末尾に足す", r2.added && r2.text.split("\n").slice(-1)[0].startsWith("礼金0円のキャンペーン"), r2.text);

  t("キャンペーンの入力が無ければ触らない", ensureCampaignLine(draft, "").added === false);
  t("本文が空なら触らない", ensureCampaignLine("", "礼金0円").added === false);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
