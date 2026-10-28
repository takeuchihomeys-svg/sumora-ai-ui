// 実行: npx tsx app/lib/__tests__/brain-material-miss.test.ts
import { collectMaterialMisses, materialMissNote, brainMaterialMissEnabled } from "../brain-material-miss";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
console.log("brain-material-miss");
const TO = { message: "TimeoutError: The operation was aborted due to timeout" };
it("error のある材料だけ拾う（data が空でも error が無ければ拾わない）", () => eq(collectMaterialMisses({ pc: { error: null }, sent_props: { error: TO }, aix_logs: { error: undefined }, open_tasks: null, viewings: { error: TO } }), ["sent_props", "viewings"]));
it("読めなかった物が無ければ何も足さない", () => eq(materialMissNote([]), ""));
it("名前で並べ・重複は1回", () => { const n = materialMissNote(["customer_state", "sent_props", "sent_props"]); eq(n.split("\n")[0], "【読めなかった材料（DB の読みの時間切れ等・今回だけ）】今の状況（段階・内覧・送ったお部屋の一覧）・送った物件"); });
it("知らない鍵はそのまま", () => eq(materialMissNote(["x_table"]).split("\n")[0].endsWith("x_table"), true));
it("既定 off", () => { delete process.env.BRAIN_MATERIAL_MISS_NOTE; eq(brainMaterialMissEnabled(), false); process.env.BRAIN_MATERIAL_MISS_NOTE = "on"; eq(brainMaterialMissEnabled(), true); delete process.env.BRAIN_MATERIAL_MISS_NOTE; });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
