// 試験の本質の道の数え方（scripts/lib/exam-essence.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-essence.test.ts（全 PASS で exit 0）
// 答案は 11/06 の cond1-on（conductor-1105）の q008・q010 を縮めた物
import { essencePickupPromise } from "../exam-essence";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`✗ ${name}`); } }

const q010 = { aix: "property_send", turn_contract: { asks: [{ quote: "職場が本町なのでアクセスしやすいところがいいです", kind: "request", route: "promise", aix: "property_send" }] } };
const q008 = { aix: "property_send", turn_contract: { asks: [{ quote: "神崎川はすんでましたが不便だったので汗", kind: "concern", route: "aix", aix: "property_send" }] } };
ok("q010: 物件の AIX＋route promise＋候補0件 → 2段:pickup", essencePickupPromise(q010, false));
ok("q010: 候補の記録が無い古い答案も route だけで 2段:pickup", essencePickupPromise(q010, null));
ok("候補がある番は物件の AIX のまま", !essencePickupPromise(q010, true));
ok("q008: route が aix なら物件の AIX のまま", !essencePickupPromise(q008, false));
ok("物件以外の AIX は変えない", !essencePickupPromise({ aix: "viewing_invite", turn_contract: { asks: [{ route: "promise", aix: "viewing_invite" }] } }, false));
ok("該当の ask は物件の AIX を書いた ask（別の ask の promise では変えない）", !essencePickupPromise({ aix: "property_send", turn_contract: { asks: [{ route: "aix", aix: "property_send" }, { route: "promise", aix: "viewing_invite" }] } }, false));
ok("ask に aix が無い時は全部の ask を見る", essencePickupPromise({ aix: "property_pickup", turn_contract: { asks: [{ route: "promise" }] } }, false));
ok("答えが無い・契約が無い", !essencePickupPromise(null, false) && !essencePickupPromise({ aix: "property_send" }, false));

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
