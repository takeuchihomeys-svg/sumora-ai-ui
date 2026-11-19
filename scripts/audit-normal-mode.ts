/**
 * 通常モードの録画から、弱い所を**細部まで**分析する（2026-11-15 竹内さん）
 *
 *   竹内さん「今弱い部分通常モードの録画の部分から分析して解決できないのか／そこの部分細分まで強化する／土台もひつようならつくる」
 *
 * ★ なぜ要るか（実測 2026-11-15）
 *   既存の `audit-scene-flows.ts` は **`search_audits`（点検）だけ**を見ていた。
 *   通常モードの録画（`human_motion_learn`）には**押した順番が残っている**のに、
 *   **録画側を分析していなかった**。
 *   実測: 通常モード単独だと 51回・検索5回しか取れない（薄い）。
 *        点検（`filled.ops`）と**合わせる**と 200回超・5場面すべてになる。
 *   → **2つを別々に見て、足りない所を補い合う**。
 *
 * ★ 何を細かく見るか（7つ）
 *   ① 場面ごとの手順（点検＋録画を別々に・重複を畳む）
 *   ② **場面ごとの「手数」と「通りの数」**（迷いの度合い）
 *   ③ **操作の間（gap）**（待たされている・止まっている疑い）
 *   ④ **押した欄の種類**（プルダウン／チェック／入力／ボタン）
 *   ⑤ **同じ欄を2回押している**（選び直し・トグルの疑い）
 *   ⑥ **手本が無い場面**（そこは学べていない・人が1回やる）
 *   ⑦ **記録の抜け**（操作が付いていない写真・by が無い操作＝旧版）
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/audit-normal-mode.ts
 *   npx tsx --env-file=.env.local scripts/audit-normal-mode.ts --days=14
 *   npx tsx --env-file=.env.local scripts/audit-normal-mode.ts --save   # 弱い所を learn_improvements に残す
 *
 * ⚠ 読むだけ（DBに書かない・`--save` の時だけ記録を1行）。
 * ⚠ 入れるのは**欄の名前・操作の種類・時刻だけ**（入力した中身は扱わない）。
 */
import { supabase } from "../app/lib/supabase-server";
import {
  learnSceneFlows, findWeakScenes, describeSceneFlow, scenePlaybook,
  lastSceneOf, SCENE_JA, collapseSameField, sceneOfOp,
  type FlowOp, type FlowScene,
} from "../app/lib/learn-flow-steps";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const days = Math.max(1, Math.min(60, Number(argOf("days", "14")) || 14));
const doSave = args.includes("--save");
const since = new Date(Date.now() - days * 86400_000).toISOString();

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) + "%" : "-");

/** 1つの並びを「同じ欄の click→change」を畳んで返す */
function cleanOps(raw: Array<Record<string, unknown>>): FlowOp[] {
  const ops = raw
    .filter((o) => o && typeof o.f === "string" && String(o.f) && o.k !== "diag" && o.k !== "same")
    .filter((o) => o.by === undefined || o.by === null || o.by === "human")   // 人の手本だけ
    .map((o) => ({
      k: String(o.k || "click") + ":" + String(o.f),
      t: Number(o.t) || null,
      by: String(o.by || "human"),
    }));
  return collapseSameField(ops as never) as FlowOp[];
}

void (async () => {
  console.log(`通常モードの録画から弱い所を細かく見る（${days}日）`);
  console.log("═".repeat(74));

  // ── ① 材料を集める（点検と録画を別々に）────────────────
  const { data: auditRows } = await supabase.from("search_audits")
    .select("created_at,status,filled,steps").gte("created_at", since)
    .not("filled", "is", null).order("created_at", { ascending: false }).limit(600);

  let motionRows: Array<Record<string, unknown>> = [];
  for (let from = 0; from < 4000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("created_at,mode,shot_ops,field_order,point_fields,ops,shot_taken,shot_learn,moves_n")
      .eq("mode", "normal").gte("created_at", since)
      .order("created_at", { ascending: false }).range(from, from + 999);
    motionRows = motionRows.concat((data ?? []) as Array<Record<string, unknown>>);
    if ((data ?? []).length < 1000) break;
  }

  /** 点検から（1回の検索＝1つの並び） */
  const auditRuns: FlowOp[][] = [];
  for (const r of (auditRows ?? []) as Array<Record<string, unknown>>) {
    const f = r.filled as { ops?: unknown[] } | null;
    const ops = Array.isArray(f?.ops) ? (f!.ops as Array<Record<string, unknown>>) : [];
    const cleaned = cleanOps(ops);
    if (cleaned.length >= 2) auditRuns.push(cleaned);
  }
  /** 録画から（同じ日・同じ並びは1回だけ＝水増し防止） */
  const motionMap = new Map<string, FlowOp[]>();
  let rawRuns = 0;
  for (const r of motionRows) {
    rawRuns++;
    const fromShot = cleanOps((r.shot_ops as Array<Record<string, unknown>>) ?? []);
    const fo = (r.field_order as unknown[]) ?? [];
    const list: FlowOp[] = fromShot.length >= 2
      ? fromShot
      : fo.map((n) => ({ k: "click:" + String(n), t: null, by: "human" }));
    if (list.length < 2) continue;
    const key = String(r.created_at).slice(0, 10) + "|" + list.map((o) => String(o.k)).join(">");
    const cur = motionMap.get(key);
    if (!cur || list.length > cur.length) motionMap.set(key, list);
  }
  const motionRuns = [...motionMap.values()];

  console.log(`\n① 材料`);
  console.log(`  点検（search_audits）      : ${(auditRows ?? []).length}件 → 手順になる回 ${auditRuns.length}`);
  console.log(`  録画（human_motion_learn） : ${rawRuns}件 → 手順になる回 ${motionRuns.length}（重複を畳んだ後）`);
  console.log(`  合わせた回                 : ${auditRuns.length + motionRuns.length}`);

  const flowsAudit = learnSceneFlows(auditRuns);
  const flowsMotion = learnSceneFlows(motionRuns);
  const flowsAll = learnSceneFlows([...auditRuns, ...motionRuns]);

  // ── ② 場面ごとの手順（2つを並べる）────────────────
  console.log(`\n② 場面ごとの手順（点検 / 録画 / 合わせた）`);
  const allScenes: FlowScene[] = ["area", "station", "cond", "search", "list", "next", "other"];
  for (const sc of allScenes) {
    const a = flowsAudit.find((f) => f.scene === sc);
    const m = flowsMotion.find((f) => f.scene === sc);
    const t = flowsAll.find((f) => f.scene === sc);
    if (!a && !m && !t) continue;
    console.log(`  【${SCENE_JA[sc]}】`);
    console.log(`    点検: ${a ? `${a.runs}回 ${a.ops}手 ${a.variants}通り` : "なし"}`);
    console.log(`    録画: ${m ? `${m.runs}回 ${m.ops}手 ${m.variants}通り` : "なし"}`);
    console.log(`    合計: ${t ? `${t.runs}回 ${t.ops}手 ${t.variants}通り` : "なし"}${t ? `  例: ${t.steps.slice(0, 4).join(" → ")}` : ""}`);
  }

  // ── ③ 弱い所（細かく）────────────────
  console.log(`\n③ 弱い所（細かく）`);
  const weak = findWeakScenes(flowsAll);
  if (!weak.length) console.log("  （見つかりませんでした）");
  for (const w of weak) console.log(`  ⚠ 【${SCENE_JA[w.scene]}】${w.why}\n      → ${w.next}`);

  // ── ④ 操作の間（待ち・止まり）────────────────
  console.log(`\n④ 操作の間（人が次を押すまでの待ち）`);
  const gapsByScene: Record<string, number[]> = {};
  for (const run of [...auditRuns, ...motionRuns]) {
    let prevT = 0;
    for (const o of run) {
      const t = Number(o.t) || 0;
      if (prevT && t > prevT) {
        const g = t - prevT;
        if (g > 0 && g <= 60000) {
          const sc = sceneOfOp(String(o.k));
          if (!gapsByScene[sc]) gapsByScene[sc] = [];
          gapsByScene[sc].push(g);
        }
      }
      if (t) prevT = t;
    }
  }
  const med = (a: number[]) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  for (const sc of allScenes) {
    const g = gapsByScene[sc];
    if (!g || !g.length) continue;
    const m = med(g);
    const slow = g.filter((x) => x >= 15000).length;
    console.log(`  ${SCENE_JA[sc].padEnd(20)} 中央値 ${String(m).padStart(6)}ms  15秒以上 ${slow}回/${g.length}`);
  }

  // ── ⑤ 押した欄の種類 ────────────────
  console.log(`\n⑤ 押した欄の種類（記録から分かる物・写真から読んだ物）`);
  const kinds: Record<string, { rec: number; photo: number }> = {};
  for (const r of motionRows) {
    for (const o of ((r.shot_ops as Array<Record<string, unknown>>) ?? [])) {
      if (!o || typeof o.f !== "string" || !o.f) continue;
      const kd = String(o.w || "").trim();
      if (!kd) continue;
      if (!kinds[kd]) kinds[kd] = { rec: 0, photo: 0 };
      kinds[kd].rec++;
    }
    const sl = r.shot_learn as { fields?: Array<{ kind?: unknown }> } | null;
    for (const f of (sl?.fields ?? [])) {
      const kd = String(f?.kind || "").trim();
      if (!kd) continue;
      if (!kinds[kd]) kinds[kd] = { rec: 0, photo: 0 };
      kinds[kd].photo++;
    }
  }
  for (const [k, v] of Object.entries(kinds).sort((a, b) => (b[1].rec + b[1].photo) - (a[1].rec + a[1].photo)).slice(0, 8)) {
    console.log(`  ${k.padEnd(12)} 記録 ${String(v.rec).padStart(4)}  写真 ${String(v.photo).padStart(4)}`);
  }
  if (!Object.keys(kinds).length) console.log("  （欄の種類が1件も無い＝記録の経路を疑う）");

  // ── ⑥ 同じ欄を2回押している（選び直し）────────────────
  console.log(`\n⑥ 同じ欄を2回以上押している（選び直し・疑い）`);
  const twice: Record<string, number> = {};
  for (const run of [...auditRuns, ...motionRuns]) {
    const c: Record<string, number> = {};
    for (const o of run) {
      const nm = String(o.k).replace(/^[a-z]+:/i, "").replace(/^左の|^右の/, "").replace(/｜.*$/, "").slice(0, 26);
      if (!nm) continue;
      c[nm] = (c[nm] || 0) + 1;
    }
    for (const [n, k] of Object.entries(c)) if (k >= 2) twice[n] = (twice[n] || 0) + 1;
  }
  const tw = Object.entries(twice).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!tw.length) console.log("  （なし）");
  for (const [n, c] of tw) console.log(`  ${n.padEnd(28)} ${c}回の検索で押し直し`);

  // ── ⑦ 記録の抜け（ここが一番効く）────────────────
  console.log(`\n⑦ 記録の抜け（学べていない理由）`);
  const n = motionRows.length;
  const cnt = (f: (r: Record<string, unknown>) => boolean) => motionRows.filter(f).length;
  const withOps = cnt((r) => Number(r.ops) > 0);
  const withShotOps = cnt((r) => Array.isArray(r.shot_ops) && (r.shot_ops as Array<Record<string, unknown>>).some((o) => o && (o as Record<string, unknown>).f));
  const withMoves = cnt((r) => Number(r.moves_n) > 0);
  const withLearn = cnt((r) => !!r.shot_learn);
  const withPhoto = cnt((r) => r.shot_taken === true);
  console.log(`  写真がある         : ${String(withPhoto).padStart(4)}/${n} (${pct(withPhoto, n)})`);
  console.log(`  操作(ops)がある    : ${String(withOps).padStart(4)}/${n} (${pct(withOps, n)})`);
  console.log(`  写真に操作が付く   : ${String(withShotOps).padStart(4)}/${n} (${pct(withShotOps, n)})`);
  console.log(`  カーソルの動き     : ${String(withMoves).padStart(4)}/${n} (${pct(withMoves, n)})`);
  console.log(`  写真から種類を読む : ${String(withLearn).padStart(4)}/${n} (${pct(withLearn, n)})`);

  const cuts: string[] = [];
  if (withPhoto > 0 && withShotOps / Math.max(1, n) < 0.5) {
    cuts.push(`写真はあるのに操作が付くのが ${pct(withShotOps, n)} → **操作の記録の経路**を疑う（拡張の再読み込み・版を確かめる）`);
  }
  if (withMoves / Math.max(1, n) < 0.5) {
    cuts.push(`カーソルの動きが ${pct(withMoves, n)} → pointer-ui の mousemove が記録されていない（v2.7.74 で修正済み・再読み込みが必要）`);
  }
  if (withLearn / Math.max(1, n) < 0.5) {
    cuts.push(`写真から種類を読むのが ${pct(withLearn, n)} → 写真学習が走っていない（弱い所の写真だけ読む設定・費用の上限）`);
  }
  const noHand = flowsAll.filter((f) => !flowsAll.some((x) => x.scene === f.scene));
  const missing = ["area", "station", "cond", "search", "list", "next"].filter((sc) => !flowsAll.some((f) => f.scene === sc));
  if (missing.length) cuts.push(`手本が無い場面: ${missing.map((m) => SCENE_JA[m as FlowScene]).join("・")} → 人が1回やる`);

  console.log(`\n⑧ 解決の道（この順）`);
  if (!cuts.length) console.log("  ✅ 大きな抜けはありません");
  cuts.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));

  // ── 自動モードが使う形（教える手順）────────────────
  const pb = scenePlaybook(flowsAll);
  if (pb.length) {
    console.log(`\n⑨ 自動モードに渡す手順（${pb.length}場面）`);
    for (const p of pb) console.log(p.split("\n").map((l) => "  " + l).join("\n"));
  }

  /**
   * 記録に残す（`--save` の時だけ）。
   *   ⚠ 統括が次回「今日 強化した事」として読む。
   */
  if (doSave) {
    const { saveImprovement } = await import("../app/lib/learn-improvements");
    const r = await saveImprovement({
      area: "学習",
      title: `通常モードの録画から弱い所を分析（${days}日・手順${flowsAll.length}場面）`,
      why: "竹内さん「今弱い部分通常モードの録画の部分から分析して解決できないのか／そこの部分細分まで強化する」",
      how: "点検（search_audits）と録画（human_motion_learn）を別々に集計し、7つの観点（手順・通り数・操作の間・欄の種類・押し直し・手本の無い場面・記録の抜け）で見た",
      effect: `手順 ${flowsAll.length}場面・抜け ${cuts.length}件: ` + cuts.map((c) => c.slice(0, 40)).join(" / ").slice(0, 300),
      at: new Date().toISOString(),
    } as never);
    console.log("\n記録: " + (r.ok ? "OK" : "NG（" + r.skipped + "）"));
  }
})();
