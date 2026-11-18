/**
 * 録画→課題→学習→仕組み補強（手元で数字を見る）
 *
 *   npx tsx --env-file=.env.local scripts/rec-challenge-reinforce.ts
 */
import { createClient } from "@supabase/supabase-js";
import { buildRecChallengeReinforce } from "../app/lib/rec-challenge-reinforce";
import { nearnessFromMotionRows } from "../app/lib/human-nearness";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const sb = createClient(url, key);
const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";

function line(s = "") { console.log(s); }

void (async () => {
  const r = await fetch(`${BASE}/api/human-learn-profile?touch=0&scope=realpro`, { cache: "no-store" });
  const j = r.ok ? (await r.json()) as Record<string, unknown> : {};
  const b = (j.bundle || {}) as Record<string, unknown>;
  const hl = (b.human_like || {}) as Record<string, number>;
  const fa = (b.foundation_audit || b.foundationAudit || {}) as { key?: Record<string, { ok?: boolean; line?: string }> };
  const key = fa.key || {};
  const f15 = key.F15_cursor_aim_hit;
  const f16 = key.F16_learn_warm;
  const f28 = key.F28_auto_gap_floor;
  const f29 = key.F29_human_nearness;
  const f32 = key.F32_link_pipeline;
  const f31 = key.F31_learn_reflect_station;
  const f38 = key.F38_improve_reflect_chain;
  const f49 = key.F49_vision_photo_reach;
  const f6 = key.F6_auto_after_bundle;

  let aimAri = 0, aimNashi = 0, warmN = 0;
  const aimM = String(f15?.line || "").match(/aim有=(\d+).*aim無=(\d+)/);
  if (aimM) { aimAri = Number(aimM[1]) || 0; aimNashi = Number(aimM[2]) || 0; }
  const warmM = String(f16?.line || "").match(/learn_warm=(\d+)/);
  if (warmM) warmN = Number(warmM[1]) || 0;
  const shortM = String(f28?.line || "").match(/（([\d.]+)%/);
  const shortPct = shortM ? Number(shortM[1]) : null;
  const nearM = String(f29?.line || "").match(/近さ(\d+)点/);
  const nearScore = nearM ? Number(nearM[1]) : null;
  const readM = String(f32?.line || f38?.line || "").match(/read[_=]?(\d+)/i)
    || String(f38?.line || "").match(/read=(\d+)/);
  const readCount = readM ? Number(readM[1]) : (/read_count=0|拡張が束を読む✗/.test(String(f32?.line || "")) ? 0 : null);
  const solidM = String(f38?.line || "").match(/solid=(\d+)/);
  const refM = String(f31?.line || "").match(/reflect_ok=(\d+)/);

  const since48 = new Date(Date.now() - 48 * 3600e3).toISOString();
  const rows: Array<{ mode?: unknown; shot_ops?: unknown }> = [];
  let from = 0;
  while (from < 2000) {
    const { data } = await sb.from("human_motion_learn").select("mode,shot_ops").gte("created_at", since48)
      .order("created_at", { ascending: false }).range(from, from + 999);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const near = nearnessFromMotionRows(rows);

  const pointPct = hl.rows ? Math.round((Number(hl.withPoint || 0) / Number(hl.rows)) * 100) : Number(hl.point_pct) || null;
  const cursorPct = hl.rows ? Math.round((Number(hl.withCursor || 0) / Number(hl.rows)) * 100) : Number(hl.cursor_pct) || null;

  const loop = buildRecChallengeReinforce({
    pointPct: pointPct ?? (Number(hl.point_pct) || 14),
    cursorPct: cursorPct ?? (Number(hl.cursor_pct) || 70),
    aimAri,
    aimNashi,
    learnWarmN: warmN,
    shortGapPct: shortPct ?? near?.auto?.fast400pct ?? null,
    nearnessAllowed: near?.allowed ?? f29?.ok === true,
    nearnessScore: nearScore ?? near?.score?.total ?? null,
    visionPhotoOk: f49?.ok !== false,
    fireAtPointWired: true,
    extVersion: "2.8.90",
    readCount,
    screenSolid: solidM ? Number(solidM[1]) : null,
    reflectOk: refM ? Number(refM[1]) : 0,
    autoAfterBundle: f6?.ok === true,
    changedWithoutClick: Number(hl.changedWithoutClick) || 0,
    humanLike: {
      withPoint: Number(hl.withPoint) || 0,
      withCursor: Number(hl.withCursor) || 0,
      rows: Number(hl.rows) || 0,
      changedWithoutClick: Number(hl.changedWithoutClick) || 0,
    },
  });

  line("─".repeat(66));
  line("【録画→課題→学習→仕組み補強】");
  line(loop.line);
  line("");
  for (const s of loop.steps) {
    line(`  ${s.ok ? "✓" : "✗"} ${s.n}.${s.name}: ${s.detail}`);
  }
  line("");
  line("■ 仕組みギャップ");
  for (const g of loop.mech_gaps) {
    line(`  ・${g.what}${g.coded ? " [コード有]" : " [未配線]"}`);
    line(`    → ${g.how}`);
  }
  if (!loop.mech_gaps.length) line("  （なし）");
  line("");
  line("■ 学習方法の強化");
  line("  " + loop.method.line);
  line("  " + loop.method.next_method_line);
  line("  continue_loop=" + loop.continue_loop);
  line("");
  line("■ 次手");
  for (const t of loop.tasks.slice(0, 6)) {
    line(`  ・[${t.kind}] ${t.what}`);
    line(`    ${t.why}`);
  }
  line("─".repeat(66));
  process.exitCode = loop.bottleneck_n != null ? 2 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
