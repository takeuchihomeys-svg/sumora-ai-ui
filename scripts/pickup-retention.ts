// 売上サポ（property_pickups）の画像・資料の保存期間（72時間）の点検・実行（/api/cron/pickup-retention と同じ関数）
// 2026-09-25 竹内「3日前の画像は消されるように。保存期間が終了しましたと出る感じで（実際の LINE のように）」
// 実行（既定は dry-run＝何も消さない）:
//   npx tsx --env-file=.env.local scripts/pickup-retention.ts                       # 今の時刻で消す予定
//   npx tsx --env-file=.env.local scripts/pickup-retention.ts --now=2026-09-28T00:00:00Z   # その時刻なら何が消えるか（送った画像が混ざらないかを目で見る）
//   npx tsx --env-file=.env.local scripts/pickup-retention.ts --apply --ids=123      # 指定した行だけ実際に消す（BLOB_READ_WRITE_TOKEN が要る・テスト用）
import { runPickupRetention } from "../app/lib/pickup-retention-server";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
(async () => {
  const apply = process.argv.includes("--apply");
  const ids = arg("ids")?.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (apply && !ids?.length) { console.log("--apply は --ids= と一緒に使う（本番の全件は cron が消す）"); process.exit(1); }
  const nowMs = arg("now") ? Date.parse(arg("now")!) : Date.now();
  const r = await runPickupRetention({ dry: !apply, nowMs, onlyIds: ids, measure: !apply });
  console.log(JSON.stringify(r, null, 2));
})();
