// 人の動きの記録をまとめて「学習の束」を作る（読むだけ→--apply で DB に書く）
//
// 2026-11-13 竹内さん「ちゃんと学習担当のブレインをつくってより効率的に学習できるようにする。
//   データベースを有効活用する」
//
// 実行:
//   npx tsx --env-file=.env.local scripts/human-learn-brain.ts             # 見るだけ（記録しない）
//   npx tsx --env-file=.env.local scripts/human-learn-brain.ts --apply     # human_learn_profile に書く
//   npx tsx --env-file=.env.local scripts/human-learn-brain.ts --days=7    # 期間を変える
//
// 本番の毎晩のまとめ: /api/cron/human-learn-brain（Vercel Cron・同じ app/lib/human-learn-brain.ts を使う）
import { createClient } from "@supabase/supabase-js";
import { buildHumanLearnBundle, compactBundle, type MotionRow } from "../app/lib/human-learn-brain";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? null;
const has = (k: string) => process.argv.includes(`--${k}`);

const SELECT = [
  "created_at", "site", "mode", "ext_version", "ops",
  "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist",
  "points_n", "point_x", "point_y", "point_fields",
  "scrolls_n", "scroll_dy", "kinds", "fields", "field_order", "shot_ops", "shot_learn",
  /**
   * ★ 2026-11-15「画像データベースの保存されている／統括は把握する」:
   *   ⚠ 旧はこの3列が無く、統括に Storage 保存枚数が 0 と届いていた（誤報の原因）。
   *   shot_b64 は重いので読まない（正本は Storage の shot_key）。
   */
  "shot_taken", "shot_key", "shot_w", "shot_h",
].join(", ");

(async () => {
  const days = Math.min(Math.max(Number(arg("days") ?? 30) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: MotionRow[] = [];
  /**
   * 2026-11-13: `shot_ops` の列がまだ無い DB でも動くようにする（列を足す前は読めなかった）。
   *   列が無いと言われたら、その列だけ外して読み直す。
   */
  const fetchPage = async (cols: string, from: number, to: number) =>
    sb.from("human_motion_learn").select(cols)
      .gte("created_at", since).order("created_at", { ascending: false }).range(from, to);
  let cols = SELECT;
  for (let i = 0; i < 20_000; i += 1000) {
    let r = await fetchPage(cols, i, i + 999);
    if (r.error && /shot_ops/i.test(r.error.message) && cols.includes("shot_ops")) {
      cols = cols.replace(", shot_ops", "").replace(", shot_learn", "");
      console.log("（shot_ops 列がまだ無いので、押す場所と動きだけ学びます）");
      r = await fetchPage(cols, i, i + 999);
    }
    if (r.error) { console.error("読めない:", r.error.message); process.exit(1); }
    rows.push(...((r.data ?? []) as unknown as MotionRow[]));
    if (!r.data || r.data.length < 1000) break;
  }
  console.log(`■ 元にした記録: ${rows.length}件（直近${days}日）`);

  const { fetchBundleReflectHint } = await import("../app/lib/bundle-reflect");
  const reflectHint = await fetchBundleReflectHint(sb, { scope: "all" });
  const all = compactBundle(buildHumanLearnBundle(rows, Date.now(), null, null, { bundle_reflect: reflectHint }));
  console.log("\n■ 学んだこと:");
  for (const line of all.lines) console.log("  " + line);
  if (all.supervisor?.meeting?.evidence) {
    const ref = all.supervisor.meeting.evidence.find((e) => e.label === "自動への反映");
    if (ref) console.log("  【反映】" + ref.value);
  }

  console.log("\n■ 押す順番（上位10）:");
  Object.entries(all.next).slice(0, 10).forEach(([from, v]) => {
    console.log(`  「${from}」 → 「${v.next}」 (${v.n}/${v.total}回)`);
  });

  console.log("\n■ 押す場所（上位10）:");
  all.buttons.slice(0, 10).forEach((b) => {
    const p = all.points[b.name];
    console.log(`  ${b.name} … ${b.n}回・横${p ? Math.round(p.x * 100) : "?"}%・縦${p ? Math.round(p.y * 100) : "?"}%`);
  });

  if (has("apply")) {
    /**
     * ★ 2026-11-15「改善したら更新されていく」:
     *   all だけ書くと拡張が古い realpro を優先して学びが届かない（実測 x/y 0）。
     *   → サイト別も同時に書く。
     * ★ 2026-11-17: 消す書き込み拒否（learn-bundle-preserve）。
     */
    const { inheritLinkFoundations } = await import("../app/lib/learn-bundle-preserve");
    const nowMs = Date.now();
    const candidates: Array<{ scope: string; bundle: Record<string, unknown>; source_rows: number; source_from: unknown; source_to: unknown; lines: unknown }> = [{
      scope: "all",
      source_rows: all.source.rows,
      source_from: all.source.from,
      source_to: all.source.to,
      bundle: all as unknown as Record<string, unknown>,
      lines: all.lines,
    }];
    for (const site of ["realpro", "itandi"] as const) {
      const sub = rows.filter((r) => {
        const s = String(r.site ?? "").toLowerCase();
        return site === "realpro" ? (s === "realpro" || s.includes("realnet")) : (s === "itandi" || s.includes("itandi"));
      });
      if (sub.length < 3) continue;
      const one = compactBundle(buildHumanLearnBundle(sub, nowMs));
      candidates.push({
        scope: site,
        source_rows: one.source.rows,
        source_from: one.source.from,
        source_to: one.source.to,
        bundle: one as unknown as Record<string, unknown>,
        lines: one.lines,
      });
    }
    const inserts: Array<Record<string, unknown>> = [];
    for (const c of candidates) {
      const pr = await inheritLinkFoundations(sb, c.bundle, c.scope, { lookback: 20, minSolid: 30 });
      if (!pr.safe_to_write) {
        console.warn(`  消す書き込み拒否 ${c.scope}: ${pr.why}`);
        continue;
      }
      inserts.push({
        scope: c.scope,
        source_rows: c.source_rows,
        source_from: c.source_from,
        source_to: c.source_to,
        bundle: c.bundle,
        lines: c.lines,
      });
    }
    if (!inserts.length) {
      console.log("\n■ 書けませんでした: 全scopeで消す書き込みを拒否");
    } else {
      const { prepareBundleForWrite } = await import("../app/lib/bundle-write-prepare");
      for (const r of inserts) prepareBundleForWrite(r.bundle as Record<string, unknown>, String(r.scope ?? "")); // 2026-11-26: サイトを渡す
      const { error } = await sb.from("human_learn_profile").insert(inserts);
      console.log(error
        ? `\n■ 書けませんでした: ${error.message}`
        : `\n■ human_learn_profile に書きました（${inserts.map((x) => x.scope).join("・")}）`);
    }
  } else {
    console.log("\n（--apply を付けると human_learn_profile に書きます）");
  }
})();
