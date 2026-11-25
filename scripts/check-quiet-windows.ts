/**
 * 邪魔しない窓（2.8.295・axlx_quiet）が実際の一括で効いたかを点検の記録（search_audits.steps）から確かめる。
 *
 * 2026-11-25 竹内さん「並べ替えやリセット、そして新しいお客さんの条件を拡張ツールのAPIから入れなおすところのあいだで
 *   別の作業入って邪魔されないように」「ちゃんと反映されているかも細かいぶぶんまで調査できるように徹底的にする」
 *
 * 見る物（1回の記録ごと）:
 *   - 窓: quiet_on / dl:quiet_on（種類・上限）→ quiet_off / 次の窓 / 上限 で閉じる
 *   - 窓の中に入り込んだ割り込みらしき段（読み直し・見回りの kick・固着の立て直し・切り替え 等）
 *   - 見送った物（quiet_defer の相手ごとの回数）・前の回のリセットの引き継ぎ（quiet_inherit）
 *   - リセットの押下 → 次のお客さんの入力 の間（30秒以上か）
 *   - 2.8.295 以上で reset_press があるのに窓の印が無い＝反映されていない
 *
 * 解析の本体は scripts/lib/quiet-windows-core.js（試験: tests/chrome-extension/quiet-windows-core-v2295.test.js）。
 *
 * 使い方:
 *   npx tsx --env-file=.env.local scripts/check-quiet-windows.ts             # 直近20件（一括・自動）
 *   npx tsx --env-file=.env.local scripts/check-quiet-windows.ts --limit=50
 *   npx tsx --env-file=.env.local scripts/check-quiet-windows.ts --id=1653
 *   npx tsx --env-file=.env.local scripts/check-quiet-windows.ts --since=2026-11-25 --verbose
 * 読むだけ（DB に書かない）。1回 limit 件まで（営業時間でも軽い）。
 */
import { supabase } from "../app/lib/supabase-server";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core: {
  analyzeSteps: (steps: unknown[], ver: string | null, need: string) => {
    wins: { kind: string; src: string; from: number; to: number; why: string }[];
    interrupts: { k: string; d: string; at: number; kind: string }[];
    defers: { who: string; d: string }[];
    inherits: string[];
    resetGaps: { ms: number; short: boolean }[];
    notReflected: boolean;
    isNew: boolean;
  };
  ms: (at: unknown) => number;
} = require("./lib/quiet-windows-core.js");

const NEED_VER = "2.8.295";
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);
const LIMIT = Math.min(200, Math.max(1, Number(args.limit || 20)));
const VERBOSE = !!args.verbose;
const jst = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(5, 19).replace("T", " ");
const sec = (n: number) => (n / 1000).toFixed(1) + "秒";

async function main() {
  let q = supabase
    .from("search_audits")
    .select("id,created_at,ext_version,status,trigger,steps")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (args.id) q = q.eq("id", Number(args.id));
  else q = q.or("trigger.in.(bulk_manual,bulk,bulk_auto,auto,command),trigger.is.null");
  if (args.since) q = q.gte("created_at", new Date(String(args.since)).toISOString());
  const { data, error } = await q;
  if (error) { console.log("読めなかった: " + error.message); process.exit(1); }
  const rows = data || [];
  console.log(`■ 邪魔しない窓の点検（${rows.length}件・反映の印は ${NEED_VER} 以上）\n`);

  const total = { audits: 0, withSteps: 0, newVer: 0, wins: 0, interrupts: 0, defers: 0, inherits: 0, notReflected: 0, shortReset: 0 };
  const deferWho: Record<string, number> = {};
  const intKind: Record<string, number> = {};

  for (const r of rows) {
    total.audits++;
    const st = Array.isArray(r.steps) ? (r.steps as { at?: unknown; k?: string; d?: string }[]) : [];
    if (!st.length) continue;
    total.withSteps++;
    const a = core.analyzeSteps(st, r.ext_version, NEED_VER);
    if (a.isNew) total.newVer++;
    total.wins += a.wins.length;
    total.interrupts += a.interrupts.length;
    total.defers += a.defers.length;
    total.inherits += a.inherits.length;
    for (const i of a.interrupts) {
      const key = i.k.replace(/[(].*$/, "");
      intKind[key] = (intKind[key] || 0) + 1;
    }
    for (const d of a.defers) deferWho[d.who] = (deferWho[d.who] || 0) + 1;
    const lines: string[] = [];
    if (VERBOSE) for (const w of a.wins) lines.push(`    窓 ${w.src === "page" ? "ページ" : "裏"}:${w.kind} ${jst(w.from)}〜${sec(w.to - w.from)}（${w.why}）`);
    for (const i of a.interrupts) lines.push(`    ⚠ 窓(${i.kind})の中に ${i.k}（${i.d}）${jst(i.at)}`);
    for (const d of a.defers) if (VERBOSE) lines.push(`    見送り ${d.d}`);
    for (const d of a.inherits) lines.push(`    引き継ぎ ${d}`);
    for (const g of a.resetGaps) {
      if (g.short) total.shortReset++;
      lines.push(`    リセット→次の入力 ${sec(g.ms)}${g.short ? " ✗ 30秒未満" : ""}`);
    }
    if (a.notReflected) {
      total.notReflected++;
      lines.push(`    ✗ ${NEED_VER} 以上でリセットを押したのに窓の印が無い（反映されていない）`);
    }
    if (lines.length || VERBOSE) {
      console.log(`#${r.id} ${jst(Date.parse(r.created_at))} v${r.ext_version} ${r.trigger ?? "auto"} 段=${st.length} 窓=${a.wins.length}`);
      lines.forEach((l) => console.log(l));
    }
  }

  console.log("\n■ まとめ");
  console.log(`  記録 ${total.audits}件（段あり ${total.withSteps}・${NEED_VER}以上 ${total.newVer}）`);
  console.log(`  窓 ${total.wins}・窓の中の割り込みらしき段 ${total.interrupts}・見送り ${total.defers}・引き継ぎ ${total.inherits}`);
  if (Object.keys(intKind).length) console.log("  割り込みの内訳: " + Object.entries(intKind).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join("  "));
  if (Object.keys(deferWho).length) console.log("  見送った相手: " + Object.entries(deferWho).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join("  "));
  console.log(`  リセット→次の入力が30秒未満 ${total.shortReset}・反映されていない ${total.notReflected}`);
  if (total.newVer === 0) console.log(`  ※ ${NEED_VER} 以上の記録がまだ無い（拡張を再読み込みして自動で1回回すと確かめられる）`);
}

main().catch((e) => { console.log("読めなかった: " + (e && e.message || e)); process.exit(1); });
