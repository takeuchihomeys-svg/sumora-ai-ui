// 実行: npx tsx app/lib/__tests__/brain-recheck.test.ts
import { deepStrictEqual } from "node:assert";
let passed = 0, failed = 0;
const describe = (_n: string, fn: () => void) => fn();
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const expect = (v: unknown) => ({
  toBe: (w: unknown) => { if (v !== w) throw new Error(`${JSON.stringify(v)} !== ${JSON.stringify(w)}`); },
  toEqual: (w: unknown) => deepStrictEqual(v, w),
  toBeNull: () => { if (v !== null) throw new Error(`${JSON.stringify(v)} is not null`); },
  toContain: (w: string) => { if (!String(v).includes(w)) throw new Error(`${JSON.stringify(v)} does not contain ${w}`); },
  toHaveLength: (n: number) => { if ((v as unknown[] | undefined)?.length !== n) throw new Error(`length ${(v as unknown[] | undefined)?.length} !== ${n}`); },
});
import { recheckMaterialLine, recheckFromSendBack } from "../brain-recheck";
import { sendBackMaterialLine } from "../aix-sendback";

describe("brain-recheck", () => {
  it("旧 sendBack と同じ文", () => {
    const rc = recheckFromSendBack({ kind: "promise", why: "結果がまだ" }, "property_check_result");
    expect(recheckMaterialLine(rc)).toBe(sendBackMaterialLine({ kind: "promise", why: "結果がまだ" }, "property_check_result"));
  });
  it("逆向きの相談（AIX の番）", () => {
    const l = recheckMaterialLine({ from: "aix_consult", kind: "aix", key: "property_check_result", why: "管理会社の確認が要る", firstAix: null });
    expect(l).toContain("最初の判断（返信）"); expect(l).toContain("AIX property_check_result の番かもしれない");
  });
  it("取ってきた材料", () => {
    const l = recheckMaterialLine({ from: "fetch", kind: "reread", why: "設備の質問", material: "資料: 室内洗濯機置場あり" });
    expect(l).toContain("足りない材料を取ってきた"); expect(l).toContain("室内洗濯機置場あり");
  });
  it("理由が無ければ空", () => { expect(recheckMaterialLine({ from: "deep", kind: "reread", why: " " })).toBe(""); expect(recheckMaterialLine(null)).toBe(""); });
});

console.log(`
${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
