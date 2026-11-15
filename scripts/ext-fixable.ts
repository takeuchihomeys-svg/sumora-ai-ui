/**
 * いまある録画データで「拡張のどこまで直せるか」を切り分ける（2026-11-15 竹内さん）
 *
 *   竹内さん「いまある録画データで改善できるのか 拡張の部分」
 *
 * ★ なぜ要るか
 *   拡張を直す前に、**手元の録画だけで決められる事**と
 *   **新しい録画を撮らないと分からない事**を分ける必要がある。
 *   分けずに直すと「材料が無いのに推測で直す」＝また同じ間違いになる。
 *
 * ★ 3つに分ける
 *   ① 録画データだけで直せる（材料が十分にある）
 *   ② 録画データでは足りない（撮り直しが要る）
 *   ③ 録画と関係なく先に直す（コードを見れば分かる）
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/ext-fixable.ts
 *   npx tsx --env-file=.env.local scripts/ext-fixable.ts --days=30
 *
 * ⚠ 読むだけ（DBに書かない）。
 */
import { supabase } from "../app/lib/supabase-server";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const days = Math.max(1, Math.min(90, Number(argOf("days", "60")) || 60));
const since = new Date(Date.now() - days * 86400_000).toISOString();
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) + "%" : "-");

type Op = { t?: number; k?: string; f?: string; w?: string; by?: string };
type Row = Record<string, unknown> & { shot_ops?: Op[] | null };

const nm = (f: unknown) => String(f == null ? "" : f).replace(/^(左の|右の|上の|下の)/, "").replace(/｜[^｜]*$/, "").trim();

void (async () => {
  console.log(`録画データで拡張のどこまで直せるか（${days}日）`);
  console.log("═".repeat(78));

  let rows: Row[] = [];
  for (let from = 0; from < 12000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("created_at,mode,ext_version,shot_ops,point_fields,kinds,gap_ms,moves_n,move_speed_px_s,move_ms,shot_w,shot_learn,opens,site,ops")
      .gte("created_at", since)
      .order("created_at", { ascending: false }).range(from, from + 999);
    rows = rows.concat((data ?? []) as Row[]);
    if ((data ?? []).length < 1000) break;
  }
  const n = rows.length;
  if (!n) { console.log("記録がありません"); return; }
  console.log(`記録 ${n}件`);

  const ver: Record<string, number> = {};
  for (const r of rows) { const v = String(r.ext_version ?? "?"); ver[v] = (ver[v] || 0) + 1; }
  const newest = Object.keys(ver).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  }).pop() ?? "?";

  // ── 材料の在庫 ────────────
  const bigShots = rows.filter((r) => Number(r.shot_w) >= 1000).length;
  const learnedRows = rows.filter((r) => r.shot_learn).length;
  const pfRows = rows.filter((r) => r.point_fields && Object.keys(r.point_fields as object).length);
  const fieldCount: Record<string, number> = {};
  for (const r of pfRows) {
    for (const [k, v] of Object.entries((r.point_fields ?? {}) as Record<string, { n?: number }>)) {
      const c = Number(v?.n) || 0;
      if (c >= 2) fieldCount[k] = (fieldCount[k] || 0) + c;
    }
  }
  const cursorRows = rows.filter((r) => Number(r.moves_n) > 0).length;
  const gapRows = rows.filter((r) => Number(r.gap_ms) > 0).length;
  const opensRows = rows.filter((r) => r.opens && Object.keys(r.opens as object).length).length;

  console.log("\n■ 手元にある材料");
  console.log(`  写真が大きい（1000px以上）: ${bigShots}枚 (${pct(bigShots, n)})`);
  console.log(`  写真から欄を読めた        : ${learnedRows}件 (${pct(learnedRows, n)})`);
  console.log(`  押した場所の記録          : ${pfRows.length}件・欄 ${Object.keys(fieldCount).length}種類`);
  console.log(`  カーソルの動き            : ${cursorRows}件 (${pct(cursorRows, n)})`);
  console.log(`  操作の間                  : ${gapRows}件 (${pct(gapRows, n)})`);
  console.log(`  押したら何が開くか        : ${opensRows}件 (${pct(opensRows, n)})`);
  console.log(`  一番新しい版              : ${newest}`);

  // ── 押した場所の上位（拡張が狙える所）────────────
  const top = Object.entries(fieldCount).sort((a, b) => b[1] - a[1]).slice(0, 12);

  // ── ① 録画データだけで直せる ────────────
  console.log("\n① 録画データだけで直せる（材料がある）");
  const canFix: string[] = [];
  if (pfRows.length >= 100 && Object.keys(fieldCount).length >= 20) {
    canFix.push(`押す場所を実測に寄せる（${pfRows.length}件・${Object.keys(fieldCount).length}種類の欄）→ 見えるカーソルが「人が押した所」を狙う`);
  }
  if (cursorRows >= 100) {
    const sp = rows.map((r) => Number(r.move_speed_px_s)).filter((x) => x > 0).sort((a, b) => a - b);
    const med = sp.length ? sp[Math.floor(sp.length / 2)] : 0;
    canFix.push(`カーソルの速さ・曲がりを実測に寄せる（${cursorRows}件・速さの中央値 ${med}px/s）`);
  }
  if (gapRows >= 50) {
    const g = rows.map((r) => Number(r.gap_ms)).filter((x) => x > 0).sort((a, b) => a - b);
    canFix.push(`操作の間を実測に寄せる（${gapRows}件・中央値 ${g[Math.floor(g.length / 2)]}ms）`);
  }
  // 徒歩の順番（実測で正しい順が分かっている）
  let walkGood = 0, walkBad = 0;
  const walkOrder = new Map<string, number>();
  for (const r of rows) {
    const names = ((r.shot_ops ?? []) as Op[]).map((o) => nm(o?.f)).filter(Boolean);
    const iT = names.findIndex((x) => /transportation_id|移動手段/.test(x));
    const iW = names.findIndex((x) => /required_time|^分$|徒歩分/.test(x));
    if (iT >= 0 && iW >= 0) {
      if (iW < iT) walkBad++; else walkGood++;
      walkOrder.set(names.slice(Math.min(iT, iW), Math.max(iT, iW) + 1).join(" → "), (walkOrder.get(names.slice(Math.min(iT, iW), Math.max(iT, iW) + 1).join(" → ")) ?? 0) + 1);
    }
  }
  if (walkGood + walkBad >= 20) {
    canFix.push(`徒歩の順番を固定する（実測: 正しい ${walkGood}回 / 分数が先 ${walkBad}回）`);
  }
  // 間取りなどチェックの重複（同じ欄が2回）
  let dupFields = 0;
  for (const r of rows) {
    const c: Record<string, number> = {};
    for (const o of ((r.shot_ops ?? []) as Op[])) { const f = nm(o?.f); if (f) c[f] = (c[f] || 0) + 1; }
    if (Object.values(c).some((v) => v >= 2)) dupFields++;
  }
  if (dupFields >= 10) canFix.push(`同じ欄の二重押しを止める（${dupFields}件の記録で起きている）`);
  if (!canFix.length) console.log("   （無し）");
  canFix.forEach((x, i) => console.log(`   ${i + 1}. ${x}`));

  // ── ② 録画データでは足りない ────────────
  console.log("\n② 録画データでは足りない（撮り直しが要る）");
  const needShot: string[] = [];
  if (bigShots === 0) needShot.push("写真から欄の種類（プルダウン／入力）を読む → 大きく撮る仕組みを直して撮り直す");
  if (opensRows === 0) needShot.push("押したら何が開くか（小窓・選択肢・結果）→ 2.7.67 以降で撮り直す");
  if (bigShots > 0 && learnedRows / n < 0.2) needShot.push(`写真から読めたのが ${pct(learnedRows, n)} だけ → 読む所（左側・大きさ）を見直して撮り直す`);
  needShot.push("「次のページへ」の手本が無い → 人が1回、次のページを押す所を録画する（推測で作らない）");
  needShot.push("自動モードの成功/失敗の判定 → 完走した回の録画が要る（今は止まった回ばかり）");
  needShot.forEach((x, i) => console.log(`   ${i + 1}. ${x}`));

  // ── ③ 録画と関係なく直せる ────────────
  console.log("\n③ 録画と関係なく先に直せる（コードを見れば分かる）");
  const codeFix = [
    "指示（自動便）が拾われないまま残る → 拡張が取りに来ていない（PCのモード・スリープ）",
    "完走の合図（steps）が届いていない → 終わりの合図の送り方を直す（実測 10回）",
    "写真を送る前の縮小（480px固定）→ 欄が読めない大きさになっている",
  ];
  codeFix.forEach((x, i) => console.log(`   ${i + 1}. ${x}`));

  // ── ④ 押した場所の上位（すぐ使える実測）────────────
  console.log("\n④ いま使える実測（押した場所の上位・2回以上の欄）");
  for (const [k, c] of top) console.log(`   ${k.padEnd(36)} ${String(c).padStart(4)}回`);
  console.log("   → この位置を拡張の「狙う所」に使える（写真を読まなくても効く）");

  // ── ⑤ 結論 ────────────
  console.log("\n⑤ 結論");
  console.log(`   録画だけで直せる: ${canFix.length}件`);
  console.log(`   撮り直しが要る  : ${needShot.length}件`);
  console.log(`   コードで直せる  : ${codeFix.length}件`);
  console.log(`   → 先に「① 録画だけで直せる」を当てる（新しい録画を待たずに効く）`);
})();
