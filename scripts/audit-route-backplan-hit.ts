// scripts/audit-route-backplan-hit.ts — 逆算の計画の「この先」の駅が、竹内さん本人の会話で実際に当たった割合（台帳 #745 ③・読むだけ・LLM なし・DB は --write の時だけ）
// 2026-11-25 作業員A: 照らしの json（audit-route-progress-takeuchi・竹内さん本人の番・会話ごとに時刻の順）の本線の駅の並びで、
//   番 i の駅から計画（route-backplan の本線・内覧あり）の この先 [1手先, 2手先] を出し、その会話の後の番で駅が変わった先（1つ目・2つ目の違う駅）と比べる。
//   1手先の当たり＝次に変わった駅が1手先・2手先の当たり＝2つ目に変わった駅が2手先（内覧なしの道へ飛んだ番は別に数える）
// 実行: npx tsx --env-file=.env.local scripts/audit-route-backplan-hit.ts --from=<照らしの json> [--write]
import { readFileSync } from "node:fs";
import { MAIN_ROUTE, type RouteNodeId } from "../app/lib/apply-route-map";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { conv: string; at: string; node: string | null; branch: string | null };
const rows = (JSON.parse(readFileSync(arg("from"), "utf8")) as Row[]).filter((r) => r.node && !r.branch && (MAIN_ROUTE as readonly string[]).includes(r.node));
const byConv = new Map<string, Row[]>();
for (const r of rows) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), r]);
let n1 = 0, h1 = 0, n2 = 0, h2 = 0, skipViewing = 0;
for (const xs of byConv.values()) {
  xs.sort((a, b) => a.at.localeCompare(b.at));
  for (let i = 0; i < xs.length; i++) {
    const node = xs[i].node as RouteNodeId;
    const k = MAIN_ROUTE.indexOf(node);
    const ahead = MAIN_ROUTE.slice(k + 1, k + 3);
    const changes: string[] = [];
    for (let j = i + 1; j < xs.length && changes.length < 2; j++) { const prev = changes.length ? changes[changes.length - 1] : node; if (xs[j].node !== prev) changes.push(xs[j].node!); }
    if (changes[0] && ahead[0]) { n1++; if (changes[0] === ahead[0]) h1++; }
    if (changes[1] && ahead[1]) { n2++; if (changes[1] === ahead[1]) h2++; else if (ahead[1].startsWith("viewing") && !changes[1].startsWith("viewing")) skipViewing++; }
  }
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
console.log(`■ 逆算の計画の この先 の当たり（竹内さん本人の番・本線の駅 ${rows.length}・会話 ${byConv.size}）`);
console.log(`  1手先: ${h1}/${n1}（${pct(h1, n1) ?? "—"}%）・2手先: ${h2}/${n2}（${pct(h2, n2) ?? "—"}%）・2手先が内覧の駅で内覧を飛ばした番 ${skipViewing}`);
(async () => {
  if (process.argv.includes("--write")) {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const qd = [
      { day, metric: "route:backplan_hit1", scope: "takeuchi", value: pct(h1, n1), n: n1, source: "scripts/audit-route-backplan-hit.ts（作業員A・#745）" },
      { day, metric: "route:backplan_hit2", scope: "takeuchi", value: pct(h2, n2), n: n2, detail: { skip_viewing: skipViewing }, source: "scripts/audit-route-backplan-hit.ts（作業員A・#745）" },
    ];
    const { error } = await sb.from("quality_daily").upsert(qd, { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`書いた: quality_daily ${qd.length}行（${day}）`);
  }
  // 2026-11-28 作業員A（作業員L の見回り: 晩の費用0の仕事で 0xC0000409 の落ち）: process.exit(0) は Windows の Node で開いた通信の口を閉じる途中に落ちる＝
  //   終わりの番号だけ付けて、口が閉じてから自然に終わる（書き込みは済んでいる）
  process.exitCode = 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
