// 実行: npx tsx app/lib/__tests__/progress-push-narrow.test.ts — #6 てん・#12 勇気（10/28 竹内さん）の実物
import { isProgressPushMessage } from "../greeting";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const on = <T,>(f: () => T): T => { process.env.PROGRESS_PUSH_NARROW = "on"; try { return f(); } finally { delete process.env.PROGRESS_PUSH_NARROW; } };
const TEN = "色々検討したんですけど、シーズンフラッツ第一候補なんですけど最短入居日っていつになりますか？";
const YUKI = "ありがとうございます！これは最大の割引でしょうか💦 あと、申し込ませていただいたら支払い時期はいつになりますか？";
console.log("progress-push-narrow");
it("off は今まで通り（時期の質問も催促）", () => { eq(isProgressPushMessage(TEN), true); eq(isProgressPushMessage(YUKI), true); });
it("on: 入居日の時期の質問は催促にしない", () => eq(on(() => isProgressPushMessage(TEN)), false));
it("on: 支払い時期の質問は催促にしない", () => eq(on(() => isProgressPushMessage(YUKI)), false));
it("on: こちらの約束の時期（資料はいつになりますか）は催促", () => eq(on(() => isProgressPushMessage("見積書の資料はいつになりますか？")), true));
it("on: 進捗・返信ない・どうなって はそのまま", () => { eq(on(() => isProgressPushMessage("進捗いかがでしょうか？？")), true); eq(on(() => isProgressPushMessage("全然返信ないですがどうなってますか？")), true); });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
