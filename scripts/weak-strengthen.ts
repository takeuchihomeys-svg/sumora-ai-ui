/**
 * 弱い部分を画像から徹底学習→強化する（仕組み⑳）
 *
 *   npx tsx --env-file=.env.local scripts/weak-strengthen.ts
 *   npx tsx --env-file=.env.local scripts/weak-strengthen.ts --yes-cost
 *   npx tsx --env-file=.env.local scripts/weak-strengthen.ts --yes-cost --rounds=2
 *
 * ⚠ photo_learn は --yes-cost の時だけ。無料は束反映・計画表示・記録。
 */
import { createClient } from "@supabase/supabase-js";
import { fetchBundleReflectHint, reflectLine } from "../app/lib/bundle-reflect";
import { buildImproveLoop, improveLoopTasks } from "../app/lib/improve-loop";
import { summarizeLatestAutoChallenges, summarizeRecordingFreshness } from "../app/lib/latest-learn-loop";
import { DETAIL_DEGREE, scoreFieldsFine, weakDetailFields } from "../app/lib/learn-improve-mech";
import { buildHumanLearnBundle, compactBundle, type MotionRow } from "../app/lib/human-learn-brain";
import { findShotsToLearn, learnFromWeakShots } from "../app/lib/shot-learn-server";
import { aliasesOf, fieldHasPosition } from "../app/lib/field-name-aliases";
import { realproButtonLabel, resolveRealproButtonId } from "../app/lib/realpro-buttons";
import { itandiButtonLabel, resolveItandiButtonId } from "../app/lib/itandi-buttons";
import { buildWeakStrengthenPlan } from "../app/lib/weak-strengthen-loop";
import { atomsFromEvidence } from "../app/lib/weak-auto-atoms";
import type { ButtonCatalogSite } from "../app/lib/button-catalog-targets";

const args = process.argv.slice(2);
const yesCost = args.includes("--yes-cost");
const roundsArg = args.find((a) => a.startsWith("--rounds="));
const maxRounds = Math.min(5, Math.max(1, Number(roundsArg?.split("=")[1] || 1) || 1));
const siteArg = (args.find((a) => a.startsWith("--site=")) || "").replace("--site=", "").trim();
const site: ButtonCatalogSite = siteArg === "itandi" ? "itandi" : "realpro";

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
      .select("created_at,mode,shot_key,shot_w,shot_learn,ext_version,shot_ops,ops,kinds,fields,point_fields,point_x,point_y")
      .gte("created_at", since)
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
    supervisor?: { meeting?: { evidence?: Array<{ label?: string; value?: string }> } };
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
  const evidence = bundle?.supervisor?.meeting?.evidence || [];
  return { screen_all, screen_solid, learned, points, evidence };
}

async function reflectBundle() {
  /**
   * ★ 仕組み㉑: 本番 `/api/human-learn-profile?fresh=1` は使わない。
   *   実測: 本番 fresh=1 のあと solid 77→0（shots.learned の x/y が落ちる）。
   *   → 手元の `buildHumanLearnBundle` で書いてから数字を読む。
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
    const { data, error } = await sb
      .from("human_motion_learn")
      .select(SELECT)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (error) return `束の作り直し失敗 ${error.message}`;
    rows.push(...((data ?? []) as unknown as MotionRow[]));
    if (!data || data.length < 1000) break;
  }
  const hint0 = await fetchBundleReflectHint(sb, { scope: "all" });
  const all = compactBundle(buildHumanLearnBundle(rows, Date.now(), null, null, { bundle_reflect: hint0 }));
  /**
   * ★ 2026-11-17 統括Pro「学習成果が消える／solid 96→0」:
   *   共通 learn-bundle-preserve。消す書き込みは拒否。
   */
  const { inheritLinkFoundations } = await import("../app/lib/learn-bundle-preserve");
  const inserts: Array<Record<string, unknown>> = [];
  const allB = all as unknown as Record<string, unknown>;
  const prAll = await inheritLinkFoundations(sb, allB, "all", { lookback: 20, minSolid: 30 });
  if (!prAll.safe_to_write) return `束の書き込み拒否 all: ${prAll.why}`;
  inserts.push({
    scope: "all",
    source_rows: all.source.rows,
    source_from: all.source.from,
    source_to: all.source.to,
    bundle: allB,
    lines: all.lines,
  });
  const realpro = rows.filter((r) => {
    const s = String(r.site ?? "").toLowerCase();
    return s === "realpro" || s.includes("realnet");
  });
  if (realpro.length >= 3) {
    const one = compactBundle(buildHumanLearnBundle(realpro, Date.now()));
    const oneB = one as unknown as Record<string, unknown>;
    const prOne = await inheritLinkFoundations(sb, oneB, "realpro", { lookback: 20, minSolid: 30 });
    if (prOne.safe_to_write) {
      inserts.push({
        scope: "realpro",
        source_rows: one.source.rows,
        source_from: one.source.from,
        source_to: one.source.to,
        bundle: oneB,
        lines: one.lines,
      });
    } else {
      console.warn("  realpro 束書き込み拒否:", prOne.why);
    }
  }
  const { prepareBundleForWrite } = await import("../app/lib/bundle-write-prepare");
  for (const r of inserts) prepareBundleForWrite(r.bundle as Record<string, unknown>);
  const { error: werr } = await sb.from("human_learn_profile").insert(inserts);
  if (werr) return `束の書き込み失敗 ${werr.message}`;
  /**
   * ★ 2026-11-17: 改善したら自動へ連動する印を明示（読むだけで終わらせない）。
   *   新束は read_count=0・auto_after=false から始まる → 拡張取込→自動1回が必須。
   */
  console.log("  → 自動連動: 拡張2.8.78再読込＋リアプロタブ再読込→popupで束取込→自動1回（learn_reflect_ok / aim有）");
  const hint = await fetchBundleReflectHint(sb, { scope: "all" });
  const { screen_all, screen_solid } = await screenCounts();
  return reflectLine(hint, screen_solid, screen_all) + "／要:拡張取込→自動1回";
}

/** 1ボタン理解用の focus 語（正名・別名・画面ラベル） */
function focusNeedlesFor(field: string): string[] {
  const id =
    site === "itandi"
      ? (resolveItandiButtonId(field) || field)
      : (resolveRealproButtonId(field) || field);
  const label = site === "itandi" ? itandiButtonLabel(id) : realproButtonLabel(id);
  const set = new Set<string>([field, id, label, ...aliasesOf(field), ...aliasesOf(id)]);
  return [...set].map((s) => String(s || "").trim()).filter(Boolean);
}

async function oneRound(round: number) {
  console.log(`\n══ 弱い部分の強化 周回${round}/${maxRounds} site=${site} ══`);
  const rows = await loadRows();
  const hint = await fetchBundleReflectHint(sb, { scope: "all" });
  let { screen_all, screen_solid, learned, points, evidence } = await screenCounts();
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
    site: "all", mode: "normal", days: 7, limit: 80, order: "newest", perSig: 8, strideMs: 1500,
  })).length;

  const atoms = atomsFromEvidence(
    evidence.map((e) => ({ label: String(e.label || ""), value: String(e.value || "") })),
  );
  const atomIds = atoms.map((a) => a.id);

  // 押した位置%（証拠から拾えれば）
  let pointPct: number | null = null;
  let cursorPct: number | null = null;
  const hum = evidence.find((e) => /人間らしさ|再現/.test(String(e.label || "")));
  const mP = String(hum?.value || "").match(/押した位置\s*(\d+)\s*%/);
  const mC = String(hum?.value || "").match(/カーソル\s*(\d+)\s*%/);
  if (mP) pointPct = Number(mP[1]);
  if (mC) cursorPct = Number(mC[1]);
  for (const a of atoms) {
    if (a.id === "point_pct" && typeof a.score === "number") pointPct = a.score;
    if (a.id === "cursor_pct" && typeof a.score === "number") cursorPct = a.score;
  }

  // 画像で位置がある欄名
  const imagePos: string[] = [];
  if (learned && typeof learned === "object") {
    for (const list of Object.values(learned)) {
      for (const f of Array.isArray(list) ? list : []) {
        const name = String((f as { name?: unknown }).name ?? "").trim();
        if (name && typeof (f as { x?: unknown }).x === "number") imagePos.push(name);
      }
    }
  }
  for (const [k, v] of Object.entries(points || {})) {
    if (typeof v?.x === "number") imagePos.push(k);
  }

  // 欄×観点の弱い欄（★台帳正名のみ。値・区名・路線名の生は buildWeakStrengthenPlan 側で写す/落とす）
  const candidateFields = site === "itandi"
    ? [...new Set([
        ...(ch.fields || []),
        "rent:lteq", "room_layout:in", "station_checkbox", "line_checkbox",
        "filter_wards_open", "filter_stations_open", "offer_conditions_updated_at:gteq",
        "search", "modal_confirm", "option_id:pet",
      ])]
    : [...new Set([
        ...(ch.fields || []),
        "required_time", "transportation_id", "rental_cost2", "structured_date", "update_date",
        "route_id[]", "city_code[]", "town_code[]", "station_id[]", "room_layout_id[]",
        "駅の設定へ進む", "沿線の設定へ戻る", "確定してリストへ", "所在地絞り込み＋",
        "沿線・駅絞り込み＋", "間取り絞り込み＋", "絞り込み条件＋", "eq_rm[]", "検索",
      ])];
  let weakFields: string[] = [];
  try {
    const fine = scoreFieldsFine({
      fields: candidateFields,
      imagePositionFields: imagePos,
      cursorPct,
      pointPct,
    });
    weakFields = weakDetailFields(fine, DETAIL_DEGREE.WEAK_FIELD);
  } catch (_) {
    weakFields = [...(ch.fields || [])];
  }

  const plan = buildWeakStrengthenPlan({
    weakFields,
    challengeFields: ch.fields,
    atoms: atomIds,
    unreadNormal: unread,
    bottleneck_n: loop.bottleneck_n,
    pointPct,
    round,
    site,
  });

  /**
   * ★ F46 2026-11-17: 録画の弱い流れ → 強化 → 自動反映を計画に足す。
   *   scene_flows / scene_missing / 自動の flow_done 欠けを材料にする。
   */
  let flowLine = "";
  try {
    const { findWeakFlowFromRecordings, buildFlowReflectCycle, autoFlowGapsFromStepsBlob } =
      await import("../app/lib/flow-reflect");
    const { data: profFlow } = await sb
      .from("human_learn_profile")
      .select("bundle")
      .eq("scope", "all")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const bundle = (profFlow?.bundle && typeof profFlow.bundle === "object")
      ? (profFlow.bundle as Record<string, unknown>)
      : {};
    const sceneFlows = Array.isArray(bundle.scene_flows)
      ? (bundle.scene_flows as Array<{ scene?: string; steps?: string[]; n?: number }>)
      : null;
    const sceneMissing = Array.isArray(bundle.scene_missing_names)
      ? (bundle.scene_missing_names as string[])
      : (typeof bundle.scene_missing === "number" && Number(bundle.scene_missing) > 0
        ? ["area", "station", "cond", "search"]
        : null);
    let autoBlob = "";
    try {
      const { data: auRows } = await sb
        .from("search_audits")
        .select("steps,error,mode")
        .eq("site", "realpro")
        .in("mode", ["brain_aix", "aix", "auto"])
        .order("created_at", { ascending: false })
        .limit(8);
      for (const a of auRows || []) {
        const steps = Array.isArray(a.steps) ? a.steps : [];
        autoBlob += steps.map((s: unknown) => {
          if (typeof s === "string") return s;
          const o = s as { k?: string; d?: string };
          return `${o.k || ""} ${o.d || ""}`;
        }).join("|") + " " + String(a.error || "") + "|";
      }
    } catch (_) {}
    const flowWeak = findWeakFlowFromRecordings({
      sceneFlows,
      sceneMissing,
      autoFlowGaps: autoFlowGapsFromStepsBlob(autoBlob),
    });
    const flowPlan = buildFlowReflectCycle(flowWeak, { unreadNormal: unread });
    flowLine = flowPlan.line;
    if (flowPlan.cycle.length) {
      // photo_learn は既存の後ろに足し、need_auto_run は重複しなければ足す
      for (const t of flowPlan.cycle) {
        if (t.kind === "need_auto_run" && plan.cycle.some((x) => x.kind === "need_auto_run")) continue;
        plan.cycle.push(t);
      }
      plan.continue_loop = true;
      plan.line = plan.line + " ／" + flowPlan.line;
      if (flowPlan.needs_auto) {
        console.log("  流れF46: needs_auto（録画→自動反映が未完）");
      }
    }
  } catch (e) {
    console.warn("  流れF46スキップ:", e instanceof Error ? e.message : e);
  }

  console.log("  状態:", loop.improve_line);
  console.log("  鮮度:", fresh.line.slice(0, 100));
  console.log("  計画:", plan.line);
  if (flowLine) console.log("  流れ:", flowLine);
  console.log("  対象:", plan.targets.slice(0, 8).join("・") || "（原子・位置%中心）");
  plan.cycle.forEach((t, i) => {
    console.log(`  ${i + 1}. [${t.kind}] ${t.what}`);
    console.log(`      なぜ: ${t.why}`);
  });

  /**
   * ★ 1つずつ: photo_learn はボタン／欄ごとに実行し、束の作り直しは全部のあと1回だけ。
   *   （途中で毎回 fresh すると遅い・read_count も揺れる）
   */
  let photoTotal = { tried: 0, learned: 0, saved: 0 };
  const photoTasks = plan.cycle.filter((t) => t.kind === "photo_learn");
  for (const t of photoTasks) {
    if (!yesCost) {
      console.log("  💰 photo_learn は --yes-cost が必要（スキップ）:", t.what);
      process.exitCode = 3;
      break;
    }
    const limit = Math.min(20, Number(t.limit) || 8);
    const focus = (t.fields || [])[0] || "";
    const focusFields = focus ? focusNeedlesFor(focus) : [];
    console.log(`  ▶ 1つずつ Vision: 「${focus || "（原子）"}」 limit=${limit}${focusFields.length ? ` focus=${focusFields.slice(0, 3).join("|")}` : ""}`);
    /**
     * ★ 2026-11-17 竹内さん「通常モードの録画や自動モードの録画から学習」:
     *   先に通常（人の手本）。0枚なら自動(aix)の同じボタン写真も読む（弱い部分がなくなるまで）。
     */
    let r = await learnFromWeakShots({
      site: null, mode: "normal", days: 7, limit, order: (t.order as "newest") || "newest",
      perSig: 12, strideMs: 800, dryRun: false, noRefresh: true, concurrency: 3,
      focusFields: focusFields.length ? focusFields : null,
    });
    if (r.tried === 0 && focusFields.length) {
      console.log(`  ↪ 通常0枚 → 自動(aix)でも「${focus}」を読む`);
      const r2 = await learnFromWeakShots({
        site: null, mode: "aix", days: 7, limit, order: (t.order as "newest") || "newest",
        perSig: 12, strideMs: 800, dryRun: false, noRefresh: true, concurrency: 3,
        focusFields: focusFields.length ? focusFields : null,
      });
      r = {
        ...r2,
        tried: r.tried + r2.tried,
        learned: r.learned + r2.learned,
        saved: r.saved + r2.saved,
      };
    }
    photoTotal.tried += r.tried;
    photoTotal.learned += r.learned;
    photoTotal.saved += r.saved;
    console.log(`  ✓ 「${focus}」完了: 試した${r.tried}・読めた${r.learned}・保存${r.saved}${r.tried === 0 ? "（通常も自動もこのボタンの操作写真が無い）" : ""}`);
  }
  if (photoTasks.length && yesCost) {
    const ref = await reflectBundle();
    console.log("  反映（1つずつ全部のあと）:", ref);
    try {
      const { saveImprovement } = await import("../app/lib/learn-improvements");
      await saveImprovement({
        area: "学習",
        title: `弱い部分1つずつ強化 周回${round}: ${photoTasks.length}ボタン・${photoTotal.learned}枚`,
        why: plan.line,
        how: "weak-strengthen: ボタン1つずつ photo_learn→まとめてreflect→拡張→自動→verify",
        effect: "各ボタンの位置・押し方が束に載り、自動が1つずつ正しく押せる",
        verify: "npx tsx --env-file=.env.local scripts/weak-strengthen.ts",
      });
    } catch (_) { /* ignore */ }
  }

  for (const t of plan.cycle) {
    if (t.kind === "photo_learn") continue; // 上で実行済み
    if (t.kind === "reflect_auto") {
      if (!(photoTasks.length && yesCost)) {
        const ref = await reflectBundle();
        console.log("  反映:", ref);
      }
    } else if (t.kind === "need_ext_reload" || t.kind === "need_auto_run") {
      console.log("  🙋 人の手:", t.what);
    } else if (t.kind === "verify_improve") {
      // ★ 周回冒頭の数字だと photo_learn→reflect 後の効果が消える（実測: 反映96欄なのに検証が0欄と誤報）
      const after = await screenCounts();
      const hintAfter = await fetchBundleReflectHint(sb, { scope: "all" });
      const loopAfter = buildImproveLoop({
        photoInStorage: rows.length,
        withOps: rows.length,
        screenSolid: after.screen_solid,
        screenAll: after.screen_all,
        hint: hintAfter,
        challengeFields: ch.fields,
        canMeasure: hintAfter.read_count > 0 && hintAfter.auto_after,
      });
      screen_solid = after.screen_solid;
      screen_all = after.screen_all;
      learned = after.learned;
      points = after.points;
      console.log("  効果:", loopAfter.improve_line);
      console.log("  反映:", reflectLine(hintAfter, after.screen_solid, after.screen_all));
    }
  }

  // improve-loop と同じ missing も一度出す（穴の可視化）
  const haveNames = new Set<string>();
  if (learned && typeof learned === "object") {
    for (const list of Object.values(learned)) {
      for (const f of Array.isArray(list) ? list : []) {
        const name = String((f as { name?: unknown }).name ?? "").trim();
        if (!name) continue;
        if (typeof (f as { x?: unknown }).x !== "number") continue;
        haveNames.add(name);
      }
    }
  }
  for (const [k, v] of Object.entries(points || {})) {
    if (typeof v?.x === "number") haveNames.add(k);
  }
  const miss = (ch.fields || []).filter((f) => !fieldHasPosition(f, haveNames));
  if (miss.length) console.log("  ⚠ 課題なのに束に位置が無い:", miss.join("・"));

  const nextTasks = improveLoopTasks({
    loop,
    unreadNormal: unread,
    challengeFields: ch.fields,
    preferNewest: true,
    missingInBundle: miss,
  });
  if (nextTasks[0]) {
    console.log("  improve-loop次:", `[${nextTasks[0].kind}] ${nextTasks[0].what}`);
  }

  return plan.continue_loop;
}

async function main() {
  console.log("弱い部分を画像から徹底学習→強化（仕組み⑳）");
  console.log(yesCost ? "  費用あり（--yes-cost）" : "  無料のみ（photo_learn は --yes-cost）");
  // ★ 毎回の強化で土台を数字で出す（テストするたび改善の起点）
  try {
    const { auditLearnFoundations, formatFoundationAudit } = await import("../app/lib/learn-foundation-audit");
    const fa = await auditLearnFoundations(sb);
    for (const line of formatFoundationAudit(fa)) console.log(line);
  } catch (e) {
    console.warn("  土台点検失敗:", e instanceof Error ? e.message : String(e));
  }
  for (let r = 1; r <= maxRounds; r++) {
    const cont = await oneRound(r);
    if (!cont) {
      console.log("\n✓ 弱さの完了線に到達（または次は人の手だけ）");
      break;
    }
    if (r < maxRounds && !yesCost) break; // 無料は1周の計画表示で十分
  }
  try {
    const { auditLearnFoundations, formatFoundationAudit } = await import("../app/lib/learn-foundation-audit");
    const fa2 = await auditLearnFoundations(sb);
    console.log("\n■ 強化後の土台");
    for (const line of formatFoundationAudit(fa2)) console.log(line);
  } catch (_) { /* ignore */ }
  console.log("\n次: 拡張 2.8.34 再読込 → 自動1回 → npx tsx --env-file=.env.local scripts/foundation-audit.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
