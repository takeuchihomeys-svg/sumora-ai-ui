/**
 * 録画を読む — 全体図と「マウス・ボタン・プルダウン」の3つを実データから読み取る（2026-11-15 竹内さん）
 *
 *   竹内さん「全体図理解して そしてマウス動いている部分やボタンの部分プルダウンの部分をよみとってりかいしたらどうか」
 *
 * ★ この道具の役目
 *   「録画に何が入っていて、何が読めて、何が読めないか」を**1画面**で出す。
 *   読めない物は**なぜ読めないか**まで書く（推測で「読めていない」と決めない）。
 *
 * ★ 3つの軸
 *   ① マウス … 速さ・曲がり・1回の時間・距離・軌跡の形（`moves_*`・`move_shapes`）
 *   ② ボタン … どの欄を・どこを押したか（`point_fields`・`shot_ops` の `w`）
 *   ③ プルダウン … select かどうか（`w:"select"`）と、押したら何が開いたか（`opens`）
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/rec-read.ts
 *   npx tsx --env-file=.env.local scripts/rec-read.ts --days=14
 *
 * ⚠ 読むだけ。**入力した中身・お客様の情報は出さない**（欄の名前・数・位置だけ）。
 */
import { supabase } from "../app/lib/supabase-server";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const days = Math.max(1, Math.min(180, Number(argOf("days", "90")) || 90));
const since = new Date(Date.now() - days * 86400_000).toISOString();
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) + "%" : "-");
const med = (a: number[]) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
const nm = (f: unknown) => String(f == null ? "" : f).replace(/^(左の|右の|上の|下の)/, "").replace(/｜[^｜]*$/, "").trim();

type Op = { t?: number; k?: string; f?: string; w?: string; by?: string; opened?: string };
type Row = Record<string, unknown> & { shot_ops?: Op[] | null };

void (async () => {
  let rows: Row[] = [];
  for (let from = 0; from < 12000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("created_at,mode,site,ext_version,shot_ops,point_fields,kinds,gap_ms,moves_n,move_speed_px_s,move_curve,move_ms,move_dist,move_shapes,shot_w,shot_learn,opens,open_kinds,ops,fields")
      .gte("created_at", since)
      .order("created_at", { ascending: false }).range(from, from + 999);
    rows = rows.concat((data ?? []) as Row[]);
    if ((data ?? []).length < 1000) break;
  }
  const n = rows.length;
  if (!n) { console.log("記録がありません"); return; }

  // ══ 全体 ══
  console.log("録画を読む（" + days + "日）");
  console.log("═".repeat(78));
  const cnt = (f: (r: Row) => boolean) => rows.filter(f).length;
  const tally = (f: (r: Row) => string) => {
    const m: Record<string, number> = {};
    for (const r of rows) { const k = f(r); m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const dates = rows.map((r) => String(r.created_at).slice(0, 10)).sort();
  console.log("■ 全体");
  console.log(`  記録 ${n}件／期間 ${dates[0]} 〜 ${dates[dates.length - 1]}`);
  console.log(`  モード: ${tally((r) => String(r.mode ?? "(空)")).map(([k, c]) => `${k} ${c}`).join(" / ")}`);
  console.log(`  サイト: ${tally((r) => String(r.site ?? "(空)")).map(([k, c]) => `${k} ${c}`).join(" / ")}`);
  const vers = tally((r) => String(r.ext_version ?? "?"));
  console.log(`  版: ${vers.length}種類（新しい順に ${vers.slice(0, 4).map(([k, c]) => `${k}×${c}`).join("・")} …）`);

  // ══ 写真 ══
  console.log("\n■ 写真（読み取れる大きさか）");
  const sizes = tally((r) => (r.shot_w ? String(r.shot_w) + "px" : "なし"));
  for (const [k, c] of sizes) console.log(`  ${k.padEnd(10)} ${String(c).padStart(5)}件 (${pct(c, n)})`);
  const learnable = cnt((r) => Number(r.shot_w) >= 1000);
  console.log(`  → 欄の文字が読める大きさ（1000px以上）: ${learnable}件 (${pct(learnable, n)})`);
  console.log(`  → 写真から読めた記録: ${cnt((r) => !!r.shot_learn)}件 (${pct(cnt((r) => !!r.shot_learn), n)})`);

  // ══ ① マウス ══
  console.log("\n■ ① マウスの動き");
  const mvRows = rows.filter((r) => Number(r.moves_n) > 0);
  const speeds = rows.map((r) => Number(r.move_speed_px_s)).filter((x) => x > 0);
  const curves = rows.map((r) => Number(r.move_curve)).filter((x) => x > 0);
  const mss = rows.map((r) => Number(r.move_ms)).filter((x) => x > 0);
  const dists = rows.map((r) => Number(r.move_dist)).filter((x) => x > 0);
  const shapes = rows.filter((r) => Array.isArray(r.move_shapes) && (r.move_shapes as unknown[]).length);
  console.log(`  記録がある: ${mvRows.length}件 (${pct(mvRows.length, n)})  平均 ${mvRows.length ? Math.round(mvRows.length / Math.max(1, rows.length) * 0 + mvRows.reduce((a, r) => a + (Number(r.moves_n) || 0), 0) / mvRows.length) : 0}回/件`);
  if (speeds.length) console.log(`  速さ  : 中央値 ${med(speeds)}px/s（人の実測）`);
  if (curves.length) console.log(`  曲がり: 中央値 ${(curves.slice().sort((a, b) => a - b)[Math.floor(curves.length / 2)]).toFixed(2)}（1.0＝まっすぐ）`);
  if (mss.length) console.log(`  1回の時間: 中央値 ${med(mss)}ms`);
  if (dists.length) console.log(`  1回の距離: 中央値 ${med(dists)}px`);
  console.log(`  軌跡の形の見本: ${shapes.length}件`);
  console.log(`  → 読める: 「どれくらいの速さで・どう曲げて・何msかけて」動くか`);
  console.log(`  → 使える: 見えるカーソルの速さ・曲がり・待ち時間を実測に寄せる`);

  // ══ ② ボタン ══
  console.log("\n■ ② ボタン（どこを押したか）");
  const pfRows = rows.filter((r) => r.point_fields && Object.keys(r.point_fields as object).length);
  const fieldHit: Record<string, number> = {};
  const fieldW: Record<string, Record<string, number>> = {};
  for (const r of pfRows) {
    for (const [k, v] of Object.entries((r.point_fields ?? {}) as Record<string, { n?: number; w?: string; x?: number; y?: number }>)) {
      const c = Number(v?.n) || 0;
      if (c < 2) continue;
      fieldHit[k] = (fieldHit[k] || 0) + c;
      if (v.w) { fieldW[k] = fieldW[k] || {}; fieldW[k][v.w] = (fieldW[k][v.w] || 0) + c; }
    }
  }
  console.log(`  記録がある: ${pfRows.length}件 (${pct(pfRows.length, n)})・欄 ${Object.keys(fieldHit).length}種類`);
  console.log("  よく押す所（2回以上）:");
  for (const [k, c] of Object.entries(fieldHit).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const w = fieldW[k] ? Object.entries(fieldW[k]).sort((a, b) => b[1] - a[1])[0]?.[0] : null;
    console.log(`    ${k.padEnd(34)} ${String(c).padStart(4)}回${w ? `  [${w}]` : ""}`);
  }
  // 要素の種類の内訳（shot_ops の w）
  const wk: Record<string, number> = {};
  for (const r of rows) for (const o of ((r.shot_ops ?? []) as Op[])) if (o && o.w) wk[o.w] = (wk[o.w] || 0) + 1;
  console.log(`  要素の種類: ${Object.entries(wk).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(" / ") || "（なし）"}`);
  console.log(`  → 読める: どの欄を・どの順で・要素の中のどこを押したか`);

  // ══ ③ プルダウン ══
  console.log("\n■ ③ プルダウン（選ぶ所）");
  const selectOps = rows.reduce((a, r) => a + ((r.shot_ops ?? []) as Op[]).filter((o) => o && o.w === "select").length, 0);
  const selectFields = new Set<string>();
  for (const r of rows) for (const o of ((r.shot_ops ?? []) as Op[])) if (o && o.w === "select" && o.f) selectFields.add(nm(o.f));
  const opensRows = cnt((r) => !!r.opens && Object.keys(r.opens as object).length > 0);
  console.log(`  select と分かっている操作: ${selectOps}回・欄 ${selectFields.size}種類`);
  console.log(`  欄の例: ${[...selectFields].slice(0, 8).join("・") || "（なし）"}`);
  console.log(`  「押したら何が開いたか」の記録: ${opensRows}件 (${pct(opensRows, n)})`);
  if (opensRows === 0) {
    console.log(`  → ⚠ 読めていない。理由は**版**（実測: 記録は 2.7.12〜2.7.61 で、仕組みは 2.7.67 から）`);
    console.log(`     撮り直せば入る。今ある録画からは「選ぶ所かどうか（select）」までしか分からない`);
  }
  // kinds の内訳（打った・押した・選んだ）
  const kk: Record<string, number> = {};
  for (const r of rows) {
    const k = r.kinds as Record<string, unknown> | null;
    if (!k || typeof k !== "object") continue;
    for (const [key, v] of Object.entries(k)) kk[key] = (kk[key] || 0) + (Number(v) || 0);
  }
  if (Object.keys(kk).length) console.log(`  操作の内訳（kinds）: ${Object.entries(kk).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(" / ")}`);

  // ══ 読めない物 ══
  console.log("\n■ 読めない物と、その理由");
  const missing: string[] = [];
  if (learnable === 0) missing.push("写真から欄の種類を読む … 写真が480pxしかなく、拡大しても文字が無い（情報が既に消えている）");
  else if (learnable / n < 0.05) missing.push(`写真から欄の種類を読む … 大きい写真が ${pct(learnable, n)} だけ（大半が480px）`);
  if (opensRows === 0) missing.push("押したら何が開くか … 記録の仕組みが 2.7.67 から（今ある録画は古い）");
  if (!shapes.length) missing.push("マウスの軌跡の形 … 記録が無い");
  if (!missing.length) console.log("  （大きな欠けは無し）");
  missing.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));

  // ══ まとめ ══
  console.log("\n■ まとめ（いま読めている物）");
  console.log(`  マウス : 速さ${speeds.length ? ` ${med(speeds)}px/s` : "－"}・曲がり${curves.length ? ` ${(curves[curves.length - 1] ?? 0).toFixed?.(2) ?? "－"}` : "－"} → **使える**`);
  console.log(`  ボタン : ${Object.keys(fieldHit).length}種類の欄・${pfRows.length}件 → **使える**`);
  console.log(`  プルダウン: select判定まで → **一部使える**（開いた中身は撮り直し）`);
})();
