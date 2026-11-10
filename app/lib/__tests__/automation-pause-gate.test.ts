// 2026-11-10 竹内さん「古い版をサーバーで断る＋16件は残す」の関所（app/lib/automation-pause-gate.ts）
// 版は本番の extension_devices に実際にあった値（2.5.91・2.5.88・2.5.51・2.5.48）。
// 実行: npx tsx app/lib/__tests__/automation-pause-gate.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseExtVersion, compareExtVersion, minExtVersion, extVersionGate, cancelPendingWhilePaused,
  blockEnqueueWhilePaused, pausedFromRow, readAutomationPaused, mayEnqueueAutomation, MIN_EXT_VERSION_DEFAULT,
} from "../automation-pause-gate";

let passed = 0, failed = 0; const failures: string[] = [];
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq(a: unknown, b: unknown, m = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} 期待 ${JSON.stringify(b)} 実際 ${JSON.stringify(a)}`); }

/** automation_settings を読むだけの偽のクライアント */
function fakeSb(row: unknown, opts: { error?: boolean; throws?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    from(t: string) {
      calls.push(t);
      if (opts.throws) throw new Error("boom");
      return { select: () => ({ eq: () => ({ maybeSingle: async () => (opts.error ? { data: null, error: { message: "x" } } : { data: row, error: null }) }) }) };
    },
  };
}

(async () => {
  console.log("■ 1. 版の読み・比べ");
  await it("2.5.91 を読む", () => eq(parseExtVersion("2.5.91"), [2, 5, 91]));
  await it("空・null・文字は null", () => { eq(parseExtVersion(""), null); eq(parseExtVersion(null), null); eq(parseExtVersion("abc"), null); eq(parseExtVersion("2.5.x"), null); });
  await it("2.5.9 < 2.5.77（桁で比べる・文字で比べない）", () => { if (!(compareExtVersion([2, 5, 9], [2, 5, 77]) < 0)) throw new Error("文字比べになっている"); });
  await it("2.5 = 2.5.0", () => eq(compareExtVersion([2, 5], [2, 5, 0]), 0));

  console.log("■ 2. 最小の版（env）");
  await it("既定は 2.5.77", () => eq(minExtVersion({}), MIN_EXT_VERSION_DEFAULT));
  await it("env で変えられる", () => eq(minExtVersion({ AUTOMATION_MIN_EXT_VERSION: "2.6.0" }), "2.6.0"));
  await it("off で見ない", () => eq(minExtVersion({ AUTOMATION_MIN_EXT_VERSION: "off" }), null));
  await it("形が違う値は既定に戻す（緩めない）", () => eq(minExtVersion({ AUTOMATION_MIN_EXT_VERSION: "latest" }), "2.5.77"));

  console.log("■ 3. 拾いに来た版の関所（本番にある版）");
  await it("2.5.91 は渡す", () => eq(extVersionGate("2.5.91", {}).ok, true));
  await it("2.5.88 は渡す", () => eq(extVersionGate("2.5.88", {}).ok, true));
  await it("2.5.77 ちょうどは渡す", () => eq(extVersionGate("2.5.77", {}).ok, true));
  await it("2.5.51 は断る（古い）", () => { const g = extVersionGate("2.5.51", {}); eq(g.ok, false); if (!g.ok) eq(g.reason, "ext_version_too_old"); });
  await it("2.5.48 は断る（古い・brain_aix の PC）", () => { const g = extVersionGate("2.5.48", {}); eq(g.ok, false); });
  await it("版の見出しが無い（2.5.40 より前）は断る", () => { const g = extVersionGate(null, {}); eq(g.ok, false); if (!g.ok) eq(g.reason, "ext_version_missing"); });
  await it("off なら版が無くても渡す", () => eq(extVersionGate(null, { AUTOMATION_MIN_EXT_VERSION: "off" }).ok, true));
  await it("断った時は理由の文がある", () => { const g = extVersionGate("2.5.51", {}); if (g.ok || !g.message.includes("2.5.77")) throw new Error("文に最小の版が無い"); });

  console.log("■ 4. 止めの印のスイッチ");
  await it("止めの印の間の取り消しは既定 off（16件を残す）", () => eq(cancelPendingWhilePaused({}), false));
  await it("取り消しは on の時だけ", () => eq(cancelPendingWhilePaused({ AUTOMATION_PAUSE_CANCEL_PENDING: "on" }), true));
  await it("積まないは既定 on", () => eq(blockEnqueueWhilePaused({}), true));
  await it("積まないは off で昔の動き", () => eq(blockEnqueueWhilePaused({ AUTOMATION_PAUSE_BLOCK_ENQUEUE: "off" }), false));
  await it("行の読み: paused=true だけ止める", () => { eq(pausedFromRow({ paused: true }), true); eq(pausedFromRow({ paused: false }), false); eq(pausedFromRow(null), false); eq(pausedFromRow({ paused: "true" }), false); });

  console.log("■ 5. 積む前の関所（偽のクライアント）");
  await it("止めの印の行を読む", async () => { const sb = fakeSb({ paused: true }); eq(await readAutomationPaused(sb), true); eq(sb.calls, ["automation_settings"]); });
  await it("読めない時は止めない", async () => { eq(await readAutomationPaused(fakeSb(null, { error: true })), false); eq(await readAutomationPaused(fakeSb(null, { throws: true })), false); });
  await it("止めの印の間は積まない", async () => eq(await mayEnqueueAutomation(fakeSb({ paused: true }), { by: "t" }, {}), false));
  await it("止めの印が無ければ積む", async () => eq(await mayEnqueueAutomation(fakeSb({ paused: false }), { by: "t" }, {}), true));
  await it("off の時は DB を読まずに積む", async () => { const sb = fakeSb({ paused: true }); eq(await mayEnqueueAutomation(sb, { by: "t" }, { AUTOMATION_PAUSE_BLOCK_ENQUEUE: "off" }), true); eq(sb.calls.length, 0); });

  console.log("■ 6. 配線（呼ぶ所が関所を通るか・insert の前か）");
  const root = join(__dirname, "..", "..", "..");
  const src = (p: string) => readFileSync(join(root, p), "utf8");
  const before = (s: string, a: string, b: string, m: string) => { const i = s.indexOf(a), j = s.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`${m}: 見つからない`); };
  await it("pending: 版の関所が止めの印より前", () => { const s = src("app/api/automation/pending/route.ts"); const i = s.indexOf("extVersionGate(req.headers"), j = s.indexOf('from("automation_settings")'); if (!(i > 0 && j > i)) throw new Error("順番が違う"); });
  await it("pending: 止めの印の間は cancelPendingWhilePaused を見てから取り消す", () => { const s = src("app/api/automation/pending/route.ts"); const i = s.indexOf("cancelPendingWhilePaused()"), j = s.indexOf('.update({ status: "cancelled" })'); if (!(i > 0 && j > i)) throw new Error("取り消しの前にスイッチが無い"); });
  for (const p of ["app/lib/aix-action-items.ts", "app/lib/search-widen-chain-server.ts", "app/lib/screen-watch-server.ts"]) {
    await it(`${p}: insert の前に mayEnqueueAutomation`, () => {
      const s = src(p); const ins = s.lastIndexOf('from("automation_commands").insert');
      const g = s.lastIndexOf("mayEnqueueAutomation(", ins);
      if (!(g > 0 && ins > g)) throw new Error("insert の前に関所が無い");
      before(s, "mayEnqueueAutomation(", 'from("automation_commands").insert', p);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
})();
