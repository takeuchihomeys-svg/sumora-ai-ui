/**
 * 自動モードの録画から「弱い所・抜け・機械的な所・直接入力」を見つける（2026-11-15 竹内さん）
 *
 *   竹内さん「自動モードの録画で弱い部分や抜けている部分、機械的な部分、
 *     直接入力されてしまっている部分も見つけられるようにする／それでブラッシュアップを積み重ねていけば強化されていく」
 *
 * ★ なぜ要るか
 *   自動モードは**機械が押している**ので人の手本にはならない（by=human は全体の4%）。
 *   だが「うまくいったか」を確かめる材料としては一番濃い。
 *   → 手本にするのではなく、**次の4つを見つける**ために使う。
 *
 * ★ 数え方の罠は `app/lib/learn-auto-audit.ts` に純関数として分けた（テストで固定）。
 *   ① 1行＝1回の検索ではない（写真1枚＝1行・`shot_ops` は run の中で累積）
 *   ② 1回の押下が `tap` と `click` の2件で記録される
 *   この2つを畳まないと「押し直し40回」のような**誤読**になる（実際は1回の検索）。
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/audit-auto-mode.ts
 *   npx tsx --env-file=.env.local scripts/audit-auto-mode.ts --days=30
 *   npx tsx --env-file=.env.local scripts/audit-auto-mode.ts --save
 *
 * ⚠ 読むだけ（`--save` の時だけ記録を1行）。
 * ⚠ 入れるのは欄の名前・操作の種類・時刻だけ（入力した中身は扱わない）。
 */
import { supabase } from "../app/lib/supabase-server";
import { sceneOfOp, SCENE_JA } from "../app/lib/learn-flow-steps";
import {
  foldRuns, foldTapClick, fieldName, countRetries, countChangedWithoutClick,
  countDirectTyping, collectGaps, judgeMechanical, countAdjacentRepresses,
  countPerRowPresses, isPerRowField, type AutoRow, type AutoOp,
} from "../app/lib/learn-auto-audit";
import { kindsKeyVsOpsKey } from "../app/lib/learn-auto-audit";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const days = Math.max(1, Math.min(90, Number(argOf("days", "30")) || 30));
const doSave = args.includes("--save");
const since = new Date(Date.now() - days * 86400_000).toISOString();
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) + "%" : "-");

void (async () => {
  console.log(`自動モードの録画を見る（${days}日）`);
  console.log("═".repeat(76));

  let rows: AutoRow[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("created_at,mode,shot_ops,point_fields,shot_taken,shot_key,shot_w,shot_learn,moves_n,gap_ms,ops,opens,kinds,ext_version")
      .eq("mode", "aix").gte("created_at", since)
      .order("created_at", { ascending: false }).range(from, from + 999);
    rows = rows.concat((data ?? []) as AutoRow[]);
    if ((data ?? []).length < 1000) break;
  }
  const nRow = rows.length;
  if (!nRow) { console.log("自動モードの記録がありません（PCを自動モードにして検索してください）"); return; }

  const runs = foldRuns(rows);
  // 押下を1回に畳む（run ごと）
  const folded = runs.map((r) => ({ ...r, ops: foldTapClick(r.ops) as AutoOp[] }));
  const n = folded.length;

  console.log(`  写真の記録 ${nRow}枚 → **同じ run を畳むと ${n}回の検索**`);
  const ver: Record<string, number> = {};
  for (const r of folded) { const v = String(r.row.ext_version ?? "?"); ver[v] = (ver[v] || 0) + 1; }
  console.log(`  版: ${Object.entries(ver).sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v}×${c}`).join(" / ")}`);
  const daySet = new Set(folded.map((r) => String(r.row.created_at).slice(5, 10)));
  console.log(`  日: ${[...daySet].sort().join("・")}`);

  const allOps = folded.flatMap((r) => r.ops);

  // ── ① 弱い所 ────────────
  console.log("\n① 弱い所（機械が迷っている・押し直している）");
  // ⚠ 一覧の行ごとに押す物（印刷用PDF など）は**押し直しではない**（物件の件数）
  const perRowTotal: Record<string, number> = {};
  for (const r of folded) for (const [f, c] of Object.entries(countPerRowPresses(r.ops))) perRowTotal[f] = (perRowTotal[f] || 0) + c;
  const perRow = Object.entries(perRowTotal).sort((a, b) => b[1] - a[1]);
  if (perRow.length) {
    console.log(`   ${perRow.map(([f, c]) => `${f}×${c}`).join(" / ")} … 一覧の行ごとの押下（押し直しではない）`);
    const pdf = perRowTotal["印刷用PDF"] || 0;
    console.log(`   → この${n}回の検索で扱った物件: ${pdf}件（1回あたり ${n ? (pdf / n).toFixed(1) : "-"}件）`);
  }
  const tw = Object.entries(countRetries(folded.map((r) => r.ops)))
    .sort((a, b) => b[1] - a[1]).slice(0, 10);
  const adj: Record<string, number> = {};
  for (const r of folded) for (const [f, c] of Object.entries(countAdjacentRepresses(r.ops))) adj[f] = (adj[f] || 0) + c;
  const adjList = Object.entries(adj).sort((a, b) => b[1] - a[1]);
  if (!tw.length) console.log(`   ✅ 同じ欄の押し直しはありません（${n}回の検索）`);
  for (const [f, c] of tw) {
    const sc = sceneOfOp("click:" + f);
    console.log(`   ⚠ ${f.padEnd(28)} ${c}/${n}回の検索で同じ欄を2回以上  [${SCENE_JA[sc]}]`);
  }
  if (adjList.length) {
    console.log(`   ⚠ 続けて2回押した欄（人がやらない）: ${adjList.map(([f, c]) => `${f}×${c}`).join(" / ")}`);
  }

  // ── ② 抜け ────────────
  console.log("\n② 抜け（学べない理由）");
  const cnt = (f: (r: { row: AutoRow; ops: AutoOp[] }) => boolean) => folded.filter(f).length;
  const noOps = cnt((r) => r.ops.length === 0);
  const diagOnly = cnt((r) => r.ops.length > 0 && r.ops.every((o) => String(o.k) === "diag"));
  const noPhoto = cnt((r) => r.row.shot_taken !== true || !r.row.shot_key);
  const noLearn = cnt((r) => !r.row.shot_learn);
  const noMoves = cnt((r) => !(Number(r.row.moves_n) > 0));
  const noOpens = cnt((r) => !r.row.opens || Object.keys(r.row.opens as object).length === 0);
  const noBy = cnt((r) => r.ops.length > 0 && r.ops.every((o) => !o.by));
  console.log(`   操作が無い        : ${String(noOps).padStart(3)}/${n} (${pct(noOps, n)})`);
  if (diagOnly) console.log(`   理由だけ（diag）  : ${String(diagOnly).padStart(3)}/${n} (${pct(diagOnly, n)})`);
  console.log(`   写真が無い        : ${String(noPhoto).padStart(3)}/${n} (${pct(noPhoto, n)})`);
  console.log(`   写真から読んでない  : ${String(noLearn).padStart(3)}/${n} (${pct(noLearn, n)})`);
  console.log(`   カーソルが動いてない: ${String(noMoves).padStart(3)}/${n} (${pct(noMoves, n)})`);
  console.log(`   開き方が無い      : ${String(noOpens).padStart(3)}/${n} (${pct(noOpens, n)})`);
  console.log(`   人の物か機械かの印が無い: ${String(noBy).padStart(3)}/${n} (${pct(noBy, n)})`);

  // ── ③ 機械的な所 ────────────
  console.log("\n③ 機械的な所（人がやらない動き）");
  const gaps: number[] = [];
  for (const r of folded) gaps.push(...collectGaps(r.ops));
  const mech = judgeMechanical(gaps);
  if (!mech.n) {
    console.log("   操作の間が取れません（時刻 t が入っていない）");
  } else {
    console.log(`   間の中央値 ${mech.median}ms（${mech.n}個）`);
    console.log(`   ⚠ 200ms 未満（速すぎる＝押しっぱなし）: ${mech.tooFast}個 (${pct(mech.tooFast, mech.n)})`);
    console.log(`   ${mech.flat ? "⚠ ほぼ一定（機械的）" : "✅ ばらつきあり（人の揺れ）"}（種類 ${mech.kinds}/${mech.n}）`);
  }
  const by: Record<string, number> = {};
  for (const o of allOps) { const k = String(o.by || "(印なし)"); by[k] = (by[k] || 0) + 1; }
  console.log(`   操作の出どころ: ${Object.entries(by).map(([k, c]) => `${k} ${c}`).join(" / ")}`);
  let center = 0;
  for (const r of folded) {
    for (const v of Object.values((r.row.point_fields ?? {}) as Record<string, unknown>)) {
      const o = v as { x?: number; y?: number };
      if (Math.abs(Number(o.x) - 0.5) < 0.01 && Math.abs(Number(o.y) - 0.5) < 0.01) center++;
    }
  }
  if (center) console.log(`   ⚠ 真ん中(0.5,0.5)を押した記録: ${center}個（拡張が決め打ちで押した）`);

  // ── ④ 直接入力 ────────────
  console.log("\n④ 直接入力（選ぶ所に文字を打ち込んでいる疑い）");
  /**
   * ⚠ まず**記録の経路**を確かめる（「0件」が『していない』なのか『見えていない』なのか）。
   *   実測（v2.7.75 より前）: `kinds.key` 36回に対し `shot_ops` の `key` 0件だった。
   */
  const kk = kindsKeyVsOpsKey(rows, (r) => foldTapClick(r.shot_ops ?? []) as AutoOp[]);
  if (kk.broken) {
    console.log(`   ⚠ 記録の経路が欠けています: 打った ${kk.kindsKey}回 なのに 記録に ${kk.opsKey}件（見えていない）`);
    console.log(`     → 拡張の版が 2.7.75 より前だと打ち込みが記録に載りません（受け口が click/change だけだった）`);
  } else if (kk.kindsKey > 0) {
    console.log(`   打った ${kk.kindsKey}回 → 記録 ${kk.opsKey}件（間引きあり・経路は健全）`);
  }
  const keyOps: Record<string, number> = {};
  for (const r of folded) for (const [f, c] of Object.entries(countDirectTyping(r.ops))) keyOps[f] = (keyOps[f] || 0) + c;
  const keyTotal = Object.values(keyOps).reduce((a, b) => a + b, 0);
  if (!keyTotal) {
    console.log("   ✅ 直接入力（key）はありません");
  } else {
    console.log(`   ⚠ key（文字を打つ）: ${keyTotal}回`);
    for (const [f, c] of Object.entries(keyOps).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const sc = sceneOfOp("key:" + f);
      const isChoose = sc === "cond" || sc === "station" || sc === "area";
      console.log(`     ${f.padEnd(26)} ${String(c).padStart(3)}回  [${SCENE_JA[sc]}]${isChoose ? " ⚠ 選ぶ所を打ち込んでいる疑い" : ""}`);
    }
  }
  /**
   * ⚠ もう1つの「直接入力」: **プルダウン・チェックを選ばずに値だけ変えた**疑い。
   *   人が選ぶ時は `click`（開く）→ `change`（決まる）。`change` だけの欄は疑いが濃い。
   */
  const cncMap: Record<string, number> = {};
  for (const r of folded) for (const [f, c] of Object.entries(countChangedWithoutClick(r.ops))) cncMap[f] = (cncMap[f] || 0) + c;
  const cnc = Object.entries(cncMap).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (cnc.length) {
    console.log(`   ⚠ 押さずに値だけ変わった欄（選ばずに入れた疑い）: ${cnc.map(([f, c]) => `${f}×${c}`).join(" / ")}`);
  }

  // ── ⑤ 止まった場所 ────────────
  console.log("\n⑤ 最後に触った場所（＝そこで終わった）");
  const stopAt: Record<string, number> = {};
  for (const r of folded) {
    const ops = r.ops.filter((o) => fieldName(o.f));
    if (!ops.length) { stopAt["(記録なし)"] = (stopAt["(記録なし)"] || 0) + 1; continue; }
    const f = fieldName(ops[ops.length - 1].f);
    const sc = sceneOfOp("click:" + f);
    stopAt[SCENE_JA[sc]] = (stopAt[SCENE_JA[sc]] || 0) + 1;
  }
  for (const [k, c] of Object.entries(stopAt).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(26)} ${c}回`);

  // ── ⑥ 次の一手 ────────────
  console.log("\n⑥ ブラッシュアップの候補（この順）");
  const todo: string[] = [];
  const oldVer = Object.keys(ver).filter((v) => v !== "?" && v < "2.7.70");
  if (kk.broken) todo.push(`記録の経路が欠けている（打った${kk.kindsKey}回が記録0件）→ 2.7.75 以降で撮り直す`);
  if (oldVer.length) todo.push(`古い版の録画: ${oldVer.join("・")} → 今の版で自動モードを1回回して撮り直す`);
  if (keyTotal > 0) todo.push(`直接入力が ${keyTotal}回 → 選ぶ所は**選ぶ**（打ち込まない）`);
  if (cnc.length) todo.push(`押さずに値が変わる欄: ${cnc.slice(0, 3).map(([f]) => f).join("・")} → 選択の操作を通す`);
  if (adjList.length) todo.push(`続けて2回押した欄: ${adjList.slice(0, 3).map(([f, c]) => `${f}×${c}`).join("・")} → 二重押しを止める`);
  if (tw.length) todo.push(`同じ欄を2回以上: ${tw.slice(0, 3).map(([f, c]) => `${f}(${c}回)`).join("・")} → 順番を固定`);
  if (noOpens / n > 0.7) todo.push(`開き方が無いのが ${pct(noOpens, n)} → 押した後に何が開いたかを記録する`);
  if (mech.n && mech.tooFast / mech.n > 0.2) todo.push("間が短すぎる所がある → 人の速さに寄せる");
  if (!todo.length) console.log("   ✅ 大きな所はありません");
  todo.forEach((t, i) => console.log(`   ${i + 1}. ${t}`));

  if (doSave) {
    const { saveImprovement } = await import("../app/lib/learn-improvements");
    const r = await saveImprovement({
      area: "自動",
      title: `自動モードの録画を分析（${days}日・${n}回の検索／写真${nRow}枚）`,
      why: "竹内さん「自動モードの録画で弱い部分や抜けている部分、機械的な部分、直接入力されてしまっている部分も見つけられるようにする」",
      how: "run ごとに畳み（累積の水増しを除く）・tap/click を1回に畳んだ上で、弱い所・抜け・機械的・直接入力の4つを数えた",
      effect: todo.length ? todo.join(" / ").slice(0, 400) : "大きな所なし",
      at: new Date().toISOString(),
    } as never);
    console.log("\n記録: " + (r.ok ? "OK" : "NG（" + r.skipped + "）"));
  }
})();
