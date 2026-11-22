// 欄の少ない読みを1回だけ読み直す（2026-11-22 作業員G・#509）。実物の形を伏せて
// 実行: npx tsx app/lib/__tests__/sent-read-retry.test.ts
import { filledCount, isThinRead, pickRicher, sentReadRetryThinOn } from "../sent-read-retry";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

// 本番で抜けた時: 駅・面積だけ（家賃・間取り・築年・号室が空）
const thin = { station: "〇〇", areaSqm: 22.43, rent: null, floorPlan: null, built: null, roomNumber: "" };
// 読み直した時: 全部
const full = { station: "〇〇", areaSqm: 22.43, rent: 67000, floorPlan: "1K", built: "2013年9月", roomNumber: "1403", status: "open" };
ok("家賃・間取り・築年が空 → 読み直す", isThinRead(thin) === true);
ok("全部ある → 読み直さない", isThinRead(full) === false);
ok("1つだけ空 → 読み直さない", isThinRead({ ...full, built: null }) === false);
ok("2つ空 → 読み直す", isThinRead({ ...full, built: null, rent: null }) === true);
ok("読み直しの方が多ければ使う", pickRicher(thin, full).used === "retry" && pickRicher(thin, full).item.rent === 67000);
ok("読み直しが同じか少なければ最初のまま", pickRicher(full, thin).used === "first" && pickRicher(thin, null).used === "first");
ok("埋まった欄の数", filledCount(full) === 7 && filledCount(thin) === 2);
ok("既定 off", sentReadRetryThinOn({}) === false && sentReadRetryThinOn({ SENT_IMAGE_READ_RETRY_THIN: "on" }) === true);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
