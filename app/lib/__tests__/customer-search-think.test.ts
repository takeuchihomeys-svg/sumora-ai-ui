/**
 * 客ごとの検索思考（決定論）
 * 実行: npx tsx app/lib/__tests__/customer-search-think.test.ts
 */
import { thinkCustomerSearch } from "../customer-search-think";
import { judgeImproveVerified } from "../improve-verify-gate";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log("✓", name);
  } else {
    fail++;
    console.log("✗", name, detail);
  }
}

const haru = "7e9394b5-7834-4b29-81a4-c0bf35db2451";
const ino = "b81da468-0000-0000-0000-000000000001";

{
  const r = thinkCustomerSearch({
    customerId: ino,
    areaMode: "ward",
    desiredArea: "中央区、浪速区",
    prevCid: haru,
    prevWantMode: "station",
    playbookSeenRv: "57c9b30a",
    codePlaybookRv: "57c9b30a",
  });
  t("はる駅→Ino地域で駅外し必須", r.forceClearStations === true && r.placeMode === "area");
  t("手順書一致なら stale でない", r.playbookStale === false);
  t("指定客ロックあり", r.designatedLock === true);
  t("summary に clearSt", /clearSt=Y/.test(r.summary));
  t("summary に XOR（所在地だけ・並行しない）", /xor=所在地だけ/.test(r.summary) && /並行しない/.test(r.summary));
}

{
  const r = thinkCustomerSearch({
    customerId: haru,
    areaMode: "station",
    desiredArea: "弁天町駅",
    prevCid: ino,
    prevWantMode: "area",
    playbookSeenRv: "4c266b56",
    codePlaybookRv: "57c9b30a",
  });
  t("地域→駅で区外し必須", r.forceClearWards === true && r.placeMode === "station");
  t("版ずれを検知", r.playbookStale === true);
  t("summary に XOR（沿線・駅だけ）", /xor=沿線・駅だけ/.test(r.summary));
}

{
  const r = thinkCustomerSearch({
    customerId: ino,
    areaMode: "ward",
    desiredArea: "中央区",
    prevCid: ino,
    prevWantMode: "area",
  });
  t("同客の続きは駅外し不要", r.forceClearStations === false);
}

{
  const ok = judgeImproveVerified({
    readCount: 1,
    autoAfterBundle: 1,
    hasReflectOrAim: true,
    playbookSeenRv: "57c9b30a",
    codePlaybookRv: "57c9b30a",
  });
  t("改善検証 全条件で✓", ok.ok === true);

  const ng = judgeImproveVerified({
    readCount: 0,
    autoAfterBundle: 0,
    hasReflectOrAim: false,
    playbookSeenRv: "4c266b56",
    codePlaybookRv: "57c9b30a",
  });
  t("改善検証 read=0 で✗", ng.ok === false && ng.gaps.some((g) => /read/.test(g)));
  t("改善検証 版ずれを gaps に", ng.gaps.some((g) => /版ずれ/.test(g)));
}

console.log(`\ncustomer-search-think: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
