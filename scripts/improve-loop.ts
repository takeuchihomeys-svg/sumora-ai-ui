/**
 * 画像学習 → 束更新 → 拡張反映 → 自動 → 効果確認 まで一連で回す
 * （2026-11-15 竹内さん「改善につながるまで一連」「画像から学習した部分はちゃんと改善して更新」）
 *
 *   npx tsx --env-file=.env.local scripts/improve-loop.ts
 *   npx tsx --env-file=.env.local scripts/improve-loop.ts --yes-cost   … 段階1〜3で未読があれば Vision（上限20）
 *   npx tsx --env-file=.env.local scripts/improve-loop.ts --once       … 今止まっている1手だけ
 *
 * ⚠ 段階4（拡張再読込）・段階5（自動1回）は人。それ以外はここで実行する。
 */
import { createClient } from "@supabase/supabase-js";
import { fetchBundleReflectHint, reflectLine } from "../app/lib/bundle-reflect";
import { buildImproveLoop, improveLoopTasks } from "../app/lib/improve-loop";
import { summarizeLatestAutoChallenges, summarizeRecordingFreshness } from "../app/lib/latest-learn-loop";
import { findShotsToLearn, learnFromWeakShots } from "../app/lib/shot-learn-server";
import { fieldHasPosition } from "../app/lib/field-name-aliases";
import { auditLearnFoundations, formatFoundationAudit } from "../app/lib/learn-foundation-audit";
import { buildHumanLearnBundle, compactBundle, type MotionRow } from "../app/lib/human-learn-brain";

const args = process.argv.slice(2);
const yesCost = args.includes("--yes-cost");
const once = args.includes("--once");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

async function loadRows() {
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 3000; i += 1000) {
    const { data } = await sb
      .from("human_motion_learn")
      .select("created_at,mode,shot_key,shot_w,shot_learn,ext_version,shot_ops")
      .gte("created_at", since)
      .not("shot_key", "is", null)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    rows.push(...((data || []) as Array<Record<string, unknown>>));
    if ((data || []).length < 1000) break;
  }
  return rows;
}

async function screenCounts() {
  const { data } = await sb
    .from("human_learn_profile")
    .select("bundle")
    .eq("scope", "all")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const bundle = data?.bundle as {
    shots?: { learned?: Record<string, Array<{ name?: string; x?: number; y?: number; n?: number }>> };
    points?: Record<string, { x?: number; y?: number; n?: number }>;
  } | null;
  const learned = bundle?.shots?.learned;
  const points = bundle?.points || {};
  let screen_all = 0, screen_solid = 0;
  if (learned && typeof learned === "object") {
    for (const list of Object.values(learned)) {
      for (const f of Array.isArray(list) ? list : []) {
        if (typeof f?.x !== "number" || typeof f?.y !== "number") continue;
        screen_all++;
        if ((Number(f.n) || 0) >= 3) screen_solid++;
      }
    }
  }
  return { screen_all, screen_solid, learned, points };
}

async function reflectBundle() {
  /**
   * ★ 2026-11-16: 本番 fresh=1 は shots.learned を消す実測あり。
   *   → 手元 buildHumanLearnBundle で書いてから数字を読む（weak-strengthen と同じ）。
   */
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const rows: MotionRow[] = [];
  const SELECT = [
    "created_at", "site", "mode", "ext_version", "ops",
    "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist",
    "points_n", "point_x", "point_y", "point_fields",
    "scrolls_n", "scroll_dy", "kinds", "fields", "field_order", "shot_ops", "shot_learn",
    "shot_taken", "shot_key", "shot_w", "shot_h",
  ].join(", ");
  for (let i = 0; i < 20_000; i += 1000) {
    const { data, error } = await sb.from("human_motion_learn").select(SELECT)
      .gte("created_at", since).order("created_at", { ascending: false }).range(i, i + 999);
    if (error) return `束の作り直し失敗 ${error.message}`;
    rows.push(...((data ?? []) as unknown as MotionRow[]));
    if (!data || data.length < 1000) break;
  }
  const hint0 = await fetchBundleReflectHint(sb, { scope: "all" });
  const all = compactBundle(buildHumanLearnBundle(rows, Date.now(), null, null, { bundle_reflect: hint0 }));
  const { inheritLinkFoundations } = await import("../app/lib/learn-bundle-preserve");
  const b = all as unknown as Record<string, unknown>;
  const pr = await inheritLinkFoundations(sb, b, "all", { lookback: 20, minSolid: 30 });
  if (!pr.safe_to_write) return `束の書き込み拒否 ${pr.why}`;
  const { error: werr } = await sb.from("human_learn_profile").insert({
    scope: "all",
    source_rows: all.source.rows,
    source_from: all.source.from,
    source_to: all.source.to,
    bundle: b,
    lines: all.lines,
  });
  if (werr) return `束の書き込み失敗 ${werr.message}`;
  const hint = await fetchBundleReflectHint(sb, { scope: "all" });
  const { screen_all, screen_solid } = await screenCounts();
  return reflectLine(hint, screen_solid, screen_all);
}

async function main() {
  console.log("══ 改善までの一連を回す ══");
  // ★ 毎回のテスト／改善で土台を数字で出す（足りない物を隠さない）
  try {
    const fa = await auditLearnFoundations(sb);
    for (const line of formatFoundationAudit(fa)) console.log(line);
  } catch (e) {
    console.warn("  土台点検失敗:", e instanceof Error ? e.message : String(e));
  }
  let guard = 0;
  while (guard++ < 6) {
    const rows = await loadRows();
    const hint = await fetchBundleReflectHint(sb, { scope: "all" });
    const { screen_all, screen_solid, learned, points } = await screenCounts();
    const ch = summarizeLatestAutoChallenges(rows as never, { hours: 48 });
    const fresh = summarizeRecordingFreshness(rows as never);
    const loop = buildImproveLoop({
      photoInStorage: rows.length,
      withOps: rows.length,
      screenSolid: screen_solid,
      screenAll: screen_all,
      hint,
      challengeFields: ch.fields,
      canMeasure: hint.read_count > 0 && hint.auto_after,
    });
    const unread = (await findShotsToLearn({
      site: "all", mode: "normal", days: 7, limit: 20, order: "newest", perSig: 8, strideMs: 1500,
    })).length;
    // 束は画面キー → 欄名は fields[].name。課題欄が x/y 付きで載っているか（points も見る）
    const haveNames = new Set<string>();
    if (learned && typeof learned === "object") {
      for (const list of Object.values(learned)) {
        for (const f of Array.isArray(list) ? list : []) {
          const name = String((f as { name?: unknown }).name ?? "").trim();
          if (!name) continue;
          if (typeof (f as { x?: unknown }).x !== "number" || typeof (f as { y?: unknown }).y !== "number") continue;
          haveNames.add(name);
        }
      }
    }
    for (const [k, v] of Object.entries(points || {})) {
      if (typeof v?.x === "number" && typeof v?.y === "number") haveNames.add(k);
    }
    const missInBundle = (ch.fields || []).filter((f) => !fieldHasPosition(f, haveNames));
    const tasks = improveLoopTasks({
      loop,
      unreadNormal: unread,
      challengeFields: ch.fields,
      preferNewest: true,
      missingInBundle: missInBundle,
    });

    console.log("\n■ 状態");
    console.log(" ", loop.improve_line);
    console.log("  鮮度:", fresh.line.slice(0, 100));
    console.log("  課題:", (ch.fields || []).slice(0, 6).join("・") || "なし");
    if (missInBundle.length) console.log("  ⚠ 課題なのに束に位置が無い:", missInBundle.join("・"));
    console.log("  未読通常:", unread, "枚");

    const next = tasks[0];
    if (!next) {
      console.log("\n✓ 次の課題なし（一連完了）");
      return;
    }
    console.log(`\n▶ 次: [${next.kind}] ${next.what}`);
    console.log("  なぜ:", next.why);

    if (next.kind === "need_ext_reload" || next.kind === "need_auto_run") {
      console.log("\n🙋 ここで人の手が要ります（こちらからは押せません）");
      if (next.kind === "need_ext_reload") {
        console.log("  1. chrome://extensions で拡張 2.8.22 を再読み込み");
        console.log("  2. ポップアップを開く／学習の再取得 → コンソール「連携完了」");
        console.log("  3. もう一度: npx tsx --env-file=.env.local scripts/improve-loop.ts");
      } else if (next.kind === "need_auto_run") {
        console.log("  1. 自動/AIXモードで1回検索");
        console.log("  2. もう一度: npx tsx --env-file=.env.local scripts/improve-loop.ts");
      }
      process.exitCode = 2;
      return;
    }

    if (next.kind === "photo_learn") {
      // 束に課題欄が無い／段階1〜3／段階6で残課題 → 読む
      if (!yesCost) {
        console.log("  💰 Vision 費用あり。付ける時は --yes-cost（上限", next.limit ?? 20, "枚）");
        process.exitCode = 3;
        return;
      }
      const { resolveShotLearnLimit } = await import("../app/lib/shot-learn-limit");
      const limit = resolveShotLearnLimit(next.limit);
      const order = (next.order === "newest" || next.order === "time" || next.order === "size") ? next.order : "newest";
      console.log(`  Vision: mode=normal order=${order} limit=${limit}`);
      const r = await learnFromWeakShots({
        site: null, mode: "normal", days: 7, limit, order, perSig: 12, strideMs: 800, dryRun: false,
      });
      console.log(`  完了: 試した${r.tried}・読めた${r.learned}・保存${r.saved}・束${r.refreshed ? "更新済" : "未"}`);
      if (once) return;
      continue;
    }

    if (next.kind === "reflect_auto") {
      const line = await reflectBundle();
      console.log("  完了:", line);
      if (once) return;
      continue;
    }

    if (next.kind === "verify_improve") {
      console.log("  効果:", loop.improve_line);
      console.log("  反映:", reflectLine(hint, screen_solid, screen_all));
      if (loop.bottleneck_n === 6 && (ch.fields || []).length && unread > 0) {
        console.log("  → 残課題あり。--yes-cost で通常画像から補強できます");
        if (!yesCost) { process.exitCode = 3; return; }
      } else if (!loop.bottleneck_n) {
        console.log("\n✓ 改善までの一連が数字で完了");
        return;
      }
      if (once) return;
      continue;
    }

    console.log("  （未知の kind）");
    process.exitCode = 1;
    return;
  }
  console.log("\n⚠ ループ上限。状態を確認してください");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
