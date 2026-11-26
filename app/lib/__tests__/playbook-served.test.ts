/**
 * 拡張の軽い確認（touch=0）が返す手順書の版＝渡す時の版（2.8.310）
 * ・純関数の場合分け
 * ・refreshPlaybookIfStale（実際に渡す時に作り直す所）と**同じ判定**になっているか（食い違いの網）
 * npx tsx app/lib/__tests__/playbook-served.test.ts
 */
import { autoRulesVersion } from "../auto-procedure-rules";
import { PLAYBOOK_BUILD_V, refreshPlaybookIfStale } from "../action-playbook";
import { servedPlaybookRulesV } from "../playbook-served";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

const CODE = { rules_v: "codeRules01", build_v: 14 };

// 1. 手順書が無い → コードの版を返し、作り直し要
{
  const r = servedPlaybookRulesV(null, CODE);
  assert(r.rules_v === CODE.rules_v && r.stale === true, "手順書が無い時はコードの版");
  const r2 = servedPlaybookRulesV({}, CODE);
  assert(r2.stale === true && r2.rules_v === CODE.rules_v, "rules_v の無い手順書も作り直し");
  console.log("  ✓ 手順書が無い");
}

// 2. 作り方が古い → コードの版・作り直し要（DB の版が同じでも）
{
  const r = servedPlaybookRulesV({ rules_v: CODE.rules_v, build_v: 13 }, CODE);
  assert(r.stale === true && r.rules_v === CODE.rules_v, "作り方が古ければ作り直し");
  assert(!!r.why && r.why.includes("作り方が古い"), "理由に作り方が入る");
  console.log("  ✓ 作り方が古い");
}

// 3. 決まりの版が違う（コードを直した）→ コードの版・作り直し要。ここが今回の穴
{
  const r = servedPlaybookRulesV({ rules_v: "oldRules99", build_v: 14 }, CODE);
  assert(r.stale === true && r.rules_v === CODE.rules_v, "決まりを直したら DB が古くても渡すのはコードの版");
  console.log("  ✓ 決まりの版が違う（今回の穴）");
}

// 4. 同じ → DB の版をそのまま返す・作り直し不要
{
  const r = servedPlaybookRulesV({ rules_v: CODE.rules_v, build_v: 14 }, CODE);
  assert(r.stale === false && r.rules_v === CODE.rules_v && r.why === null, "同じなら作り直し不要");
  // 作り方が新しい（14 より大きい）DB は古いとは言わない
  const r2 = servedPlaybookRulesV({ rules_v: CODE.rules_v, build_v: 15 }, CODE);
  assert(r2.stale === false, "作り方が新しければ作り直さない");
  console.log("  ✓ 同じなら作り直さない");
}

// 5. 実物と一致: refreshPlaybookIfStale（実際に渡す時の作り直し）と stale が一致する
{
  const code = { rules_v: autoRulesVersion(), build_v: PLAYBOOK_BUILD_V };
  const cases: Array<Record<string, unknown>> = [
    { playbook: { rules_v: code.rules_v, build_v: PLAYBOOK_BUILD_V } }, // 最新
    { playbook: { rules_v: "oldRules99", build_v: PLAYBOOK_BUILD_V } }, // 決まりが違う
    { playbook: { rules_v: code.rules_v, build_v: PLAYBOOK_BUILD_V - 1 } }, // 作り方が古い
    { playbook: { rules_v: code.rules_v } }, // build_v 無し
    {}, // 手順書無し
  ];
  for (const bundle of cases) {
    const served = servedPlaybookRulesV(bundle.playbook as never, code);
    const real = refreshPlaybookIfStale(bundle);
    assert(served.stale === real.refreshed, `食い違い: ${JSON.stringify(bundle)} served=${served.stale} real=${real.refreshed}`);
  }
  // 最新の時は DB の版を返す（作り直しの無い束と同じ値）
  const latest = servedPlaybookRulesV({ rules_v: code.rules_v, build_v: PLAYBOOK_BUILD_V }, code);
  assert(latest.rules_v === code.rules_v, "最新の時の版");
  console.log("  ✓ refreshPlaybookIfStale と判定が一致（5場合）");
}

console.log("playbook-served.test OK");
