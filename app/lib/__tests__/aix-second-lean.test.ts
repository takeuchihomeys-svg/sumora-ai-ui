// app/lib/__tests__/aix-second-lean.test.ts — 2通目に成約パターン・ナレッジを渡さないスイッチは既定 off
import { aixSecondLeanOn } from "../aix-second-lean";
let failed = 0;
const eq = (n: string, a: unknown, b: unknown) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) failed++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
eq("既定 off", aixSecondLeanOn({}), false);
eq("on で入る", aixSecondLeanOn({ AIX_SECOND_LEAN: " ON " }), true);
eq("off", aixSecondLeanOn({ AIX_SECOND_LEAN: "off" }), false);
console.log(failed ? `${failed} failed` : "all passed");
if (failed) process.exit(1);
