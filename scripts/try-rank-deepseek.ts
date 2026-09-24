// 🌟 の順位付けが DeepSeek で答えるか（本番と同じ rankWithDeepSeek・読み取りのみ）
import { buildRankPrompt, rankWithDeepSeek } from "../app/lib/pickup-rank";
async function main() {
  const summaries = [
    "【1】セレニティ照ヶ丘矢田A棟\n75,000円 5,000円\n1LDK 35.19㎡\n敷なし 礼なし",
    "【2】ダイレ・エヌ\n80,000円 10,500円\n1LDK 39.23㎡\n敷なし 礼2ヶ月\nAD 1ヶ月",
    "【3】Abelia(アベリア)\n83,000円 8,000円\n1LDK 39.13㎡\n敷なし 礼なし\nAD 2.5ヶ月",
  ];
  const t = Date.now();
  const nums = await rankWithDeepSeek(buildRankPrompt(summaries, "家賃〜10万円 / 1LDK / 敷礼なるべく0"));
  console.log(`DeepSeek の答え: ${JSON.stringify(nums)}  ${Date.now() - t}ms`);
}
main().catch((e) => { console.error(e); process.exit(1); });
