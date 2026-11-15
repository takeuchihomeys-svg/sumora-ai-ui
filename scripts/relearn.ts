/**
 * 録画から**学び直す**一式を1コマンドで回す（2026-11-15 竹内さん）
 *
 *   竹内さん「これで今あるので学ぶ直したら自動モードかなり改善されるのでは／ちゃんと学びなおせるように強化する」
 *
 * ★ なぜ要るか
 *   学び直す部品は**バラバラに存在していた**（束を作り直す・写真から読む・場面の手順・弱い所・統括）。
 *   どれをどの順で回すかが決まっておらず、**回し忘れると「学んだつもり」で終わる**。
 *   → **1コマンドで順番どおりに回し、各段の結果を出す**。
 *
 * ★ 回す順番（安い順・効果の大きい順）
 *   ① 束を作り直す（費用0）… `/api/human-learn-profile?fresh=1`
 *   ② 場面の手順を作り直す（費用0）… 点検＋録画から
 *   ③ 弱い所を出す（費用0）… 端末・版・記録の抜け・押し直し
 *   ④ 写真から欄を読む（**費用がかかる**）… 大きい写真だけ・上限つき・`--yes-cost` の時だけ
 *   ⑤ 統括に考えさせる（**費用がかかる**）… `--with-llm` の時だけ
 *   ⑥ 学び直した結果を確かめる（前後の比較）
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/relearn.ts                    # ①②③⑥（費用0）
 *   npx tsx --env-file=.env.local scripts/relearn.ts --yes-cost          # ④ も回す（上限20枚）
 *   npx tsx --env-file=.env.local scripts/relearn.ts --yes-cost --limit=10
 *   npx tsx --env-file=.env.local scripts/relearn.ts --with-llm          # ⑤ も回す
 *
 * ⚠ ④⑤ は**お金がかかる**ので、既定では回さない（明示した時だけ）。
 * ⚠ 読むだけ（DBを書き換えない）。束の作り直しだけはサーバー側が保存する（それは学びの本体）。
 */
import { supabase } from "../app/lib/supabase-server";
import { buildHumanLearnBundle } from "../app/lib/human-learn-brain";
import { learnSceneFlows, findWeakScenes, SCENE_JA, type FlowOp } from "../app/lib/learn-flow-steps";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const yesCost = args.includes("--yes-cost");
const withLlm = args.includes("--with-llm");
const limit = Math.max(1, Math.min(20, Number(argOf("limit", "20")) || 20));
const days = Math.max(1, Math.min(60, Number(argOf("days", "14")) || 14));
const base = process.env.NEXT_PUBLIC_SITE_URL || "https://sumora-ai-ui.vercel.app";

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) + "%" : "-");

/** 学び直す前の状態を1行で（後で比べる） */
async function snapshot(): Promise<Record<string, number>> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let all: Array<Record<string, unknown>> = [];
  for (let from = 0; from < 6000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("mode,shot_taken,shot_key,shot_w,shot_learn,shot_ops,point_fields,ops,install_id")
      .eq("mode", "normal").gte("created_at", since)
      .order("created_at", { ascending: false }).range(from, from + 999);
    all = all.concat((data ?? []) as Array<Record<string, unknown>>);
    if ((data ?? []).length < 1000) break;
  }
  const n = all.length;
  return {
    rows: n,
    photo: all.filter((r) => r.shot_taken === true && r.shot_key).length,
    learned: all.filter((r) => !!r.shot_learn).length,
    with_shot_ops: all.filter((r) => Array.isArray(r.shot_ops) && (r.shot_ops as Array<Record<string, unknown>>).some((o) => o && (o as Record<string, unknown>).f)).length,
    with_points: all.filter((r) => r.point_fields && Object.keys(r.point_fields as object).length >= 1).length,
    learned_pct: Math.round((all.filter((r) => !!r.shot_learn).length / Math.max(1, n)) * 100),
  };
}

void (async () => {
  const t0 = Date.now();
  console.log("録画から学び直す（" + days + "日・" + (yesCost ? "写真も読む" : "費用0だけ") + (withLlm ? "・統括も考える" : "") + "）");
  console.log("═".repeat(74));

  // ① 今の状態（後で比べる）
  const before = await snapshot();
  console.log("① 学び直す前");
  console.log(`   通常モード ${before.rows}件  写真 ${before.photo}  写真から読んだ ${before.learned}(${before.learned_pct}%)`);
  console.log(`   写真に操作 ${before.with_shot_ops}(${pct(before.with_shot_ops, before.rows)})  押した場所 ${before.with_points}(${pct(before.with_points, before.rows)})`);

  // ② 束を作り直す（費用0・サーバーが保存する）
  console.log("\n② 束を作り直す（費用0）");
  let bundleNow: Record<string, unknown> | null = null;
  try {
    const sw = Date.now();
    const res = await fetch(`${base}/api/human-learn-profile?scope=realpro&fresh=1`, { cache: "no-store", signal: AbortSignal.timeout(120000) });
    if (res.ok) {
      const j = (await res.json()) as { bundle?: Record<string, unknown>; generated_at?: string };
      bundleNow = j.bundle ?? null;
      console.log(`   ✅ 作り直しました（${Math.round((Date.now() - sw) / 1000)}秒・版 ${String(j.generated_at ?? "?").slice(11, 19)}）`);
    } else {
      console.log(`   ⚠ 作り直せませんでした（HTTP ${res.status}）`);
    }
  } catch (e) {
    console.log("   ⚠ 作り直せませんでした: " + String((e as Error)?.message || e).slice(0, 80));
  }

  // ③ 場面の手順を作り直す（費用0・点検＋録画）
  console.log("\n③ 場面の手順を作り直す（費用0・点検＋録画）");
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: audits } = await supabase.from("search_audits")
    .select("filled,created_at").gte("created_at", since).not("filled", "is", null).limit(600);
  const auditRuns: FlowOp[][] = [];
  for (const r of (audits ?? []) as Array<Record<string, unknown>>) {
    const f = r.filled as { ops?: Array<Record<string, unknown>> } | null;
    const ops = (f?.ops ?? [])
      .filter((o) => o && o.f && o.k !== "diag")
      .filter((o) => o.by === undefined || o.by === null || o.by === "human")
      .map((o) => ({ k: String(o.k) + ":" + String(o.f), t: Number(o.t) || null, by: "human" }));
    if (ops.length >= 2) auditRuns.push(ops);
  }
  let motionRows: Array<Record<string, unknown>> = [];
  for (let from = 0; from < 4000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("created_at,shot_ops,field_order").eq("mode", "normal").gte("created_at", since)
      .order("created_at", { ascending: false }).range(from, from + 999);
    motionRows = motionRows.concat((data ?? []) as Array<Record<string, unknown>>);
    if ((data ?? []).length < 1000) break;
  }
  const seen = new Map<string, FlowOp[]>();
  for (const r of motionRows) {
    const ops = ((r.shot_ops as Array<Record<string, unknown>>) ?? [])
      .filter((o) => o && o.f && o.k !== "diag")
      .filter((o) => o.by === undefined || o.by === null || o.by === "human")
      .map((o) => ({ k: String(o.k) + ":" + String(o.f), t: Number(o.t) || null, by: "human" }));
    const fo = (r.field_order as unknown[]) ?? [];
    const list = ops.length >= 2 ? ops : fo.map((n) => ({ k: "click:" + String(n), t: null, by: "human" }));
    if (list.length < 2) continue;
    const key = String(r.created_at).slice(0, 10) + "|" + list.map((o) => String(o.k)).join(">");
    if (!seen.has(key) || list.length > (seen.get(key)?.length || 0)) seen.set(key, list);
  }
  const flows = learnSceneFlows([...auditRuns, ...[...seen.values()]] as never);
  console.log(`   回: ${auditRuns.length + seen.size}（点検 ${auditRuns.length}＋録画 ${seen.size}）→ 場面 ${flows.length}`);
  for (const f of flows) console.log(`     ${SCENE_JA[f.scene].padEnd(20)} ${f.runs}回 ${f.ops}手 ${f.variants}通り`);

  // ④ 弱い所（費用0）
  console.log("\n④ 弱い所（費用0・記録から）");
  const weak = findWeakScenes(flows);
  if (!weak.length) console.log("   ✅ 手順の弱い所はありません");
  for (const w of weak) console.log(`   ⚠ 【${SCENE_JA[w.scene]}】${w.why}`);

  // ⑤ 写真から読む（費用がかかる・明示した時だけ）
  console.log("\n⑤ 写真から欄を読む" + (yesCost ? `（上限 ${limit}枚）` : "（--yes-cost で回す）"));
  if (!yesCost) {
    /**
     * ★ 2026-11-15 **実測で判明（お金の無駄を防ぐ）**:
     *   未読の写真 600件は**全部 480x244**だった。
     *   ⚠ 480px の写真からは欄が**読めない**（以前の実測: `{"screen":"modal","fields":[]}`）。
     *   → 読めるのは **1000px 以上**（小窓が開いた瞬間に撮った物）だけ。
     *   ⚠ 480px ばかりの日に `--yes-cost` を回すと**費用だけかかって1つも学べない**。
     *   → **先に大きさを数えて、無駄なら回さない**と言う。
     */
    const { data: sizes } = await supabase.from("human_motion_learn")
      .select("shot_w").eq("mode", "normal").eq("shot_taken", true).is("shot_learn", null)
      .gte("created_at", since).limit(1000);
    const arr = ((sizes ?? []) as Array<{ shot_w?: number | null }>).map((r) => Number(r.shot_w) || 0);
    const big = arr.filter((w) => w >= 1000).length;
    const small = arr.filter((w) => w > 0 && w < 1000).length;
    console.log(`   未読の写真: 大きい(1000px+) ${big}枚 / 小さい ${small}枚`);
    if (big === 0) {
      console.log("   ⏭ 回しません（**大きい写真が0枚**＝読んでも欄が取れず、費用だけかかります）");
      console.log("      → 小窓が開いた瞬間に撮れるのは v2.7.50 以降。**拡張を再読み込みして検索**すれば増えます");
    } else {
      console.log(`   → \`--yes-cost --limit=${Math.min(limit, big)}\` で ${Math.min(limit, big)}枚まで読めます（約$${(Math.min(limit, big) * 0.001).toFixed(3)}）`);
    }
  } else {
    /**
     * ⚠ `--yes-cost` でも**大きい写真が0枚なら回さない**（費用だけかかるのを防ぐ）。
     *   実測: 未読600件が全部 480x244 だった日があった。
     */
    const { data: chk } = await supabase.from("human_motion_learn")
      .select("shot_w").eq("mode", "normal").eq("shot_taken", true).is("shot_learn", null)
      .gte("created_at", since).gte("shot_w", 1000).limit(5);
    if (!((chk ?? []) as unknown[]).length) {
      console.log("   ⏭ 回しません（1000px以上の未読写真が0枚・読んでも欄が取れません）");
    } else try {
      const res = await fetch(`${base}/api/shot-learn?mode=normal&days=${days}&limit=${limit}`, { cache: "no-store", signal: AbortSignal.timeout(180000) });
      if (res.ok) {
        const j = (await res.json()) as { tried?: number; learned?: number; saved?: number; fields?: number };
        console.log(`   ✅ 試した ${j.tried ?? "?"}枚・読めた ${j.learned ?? "?"}枚・保存 ${j.saved ?? "?"}枚（欄 ${j.fields ?? "?"}個）`);
      } else {
        console.log(`   ⚠ 読めませんでした（HTTP ${res.status}）`);
      }
    } catch (e) {
      console.log("   ⚠ 読めませんでした: " + String((e as Error)?.message || e).slice(0, 80));
    }
  }

  // ⑥ 統括に考えさせる（費用がかかる・明示した時だけ）
  console.log("\n⑥ 統括に考えさせる" + (withLlm ? "" : "（--with-llm で回す）"));
  if (!withLlm) {
    console.log("   ⏭ 回しません（お金がかかるため）");
  } else {
    try {
      const res = await fetch(`${base}/api/cron/supervisor-think?scope=realpro&dry=1`, { cache: "no-store", signal: AbortSignal.timeout(120000) });
      const j = (await res.json()) as { llm?: { next?: string; why?: string }; llm_error?: string };
      if (j.llm) console.log(`   ✅ 次に直す: ${j.llm.next}\n      なぜ: ${j.llm.why}`);
      else console.log("   ⚠ " + (j.llm_error || "答えがありません"));
    } catch (e) {
      console.log("   ⚠ 考えられませんでした: " + String((e as Error)?.message || e).slice(0, 80));
    }
  }

  // ⑦ 学び直した後（比べる）
  const after = await snapshot();
  console.log("\n⑦ 学び直した後（前と比べる）");
  const cmp = (label: string, b: number, a: number) => {
    const d = a - b;
    const mark = d > 0 ? "▲+" : d < 0 ? "▼" : "＝";
    console.log(`   ${label.padEnd(16)} ${String(b).padStart(5)} → ${String(a).padStart(5)}  ${mark}${d !== 0 ? Math.abs(d) : ""}`);
  };
  cmp("通常モード", before.rows, after.rows);
  cmp("写真がある", before.photo, after.photo);
  cmp("写真から読んだ", before.learned, after.learned);
  cmp("写真に操作", before.with_shot_ops, after.with_shot_ops);
  cmp("押した場所", before.with_points, after.with_points);
  console.log(`   写真から読んだ割合 ${before.learned_pct}% → ${after.learned_pct}%`);

  // ⑧ 束の中身（自動モードが使う物）
  if (bundleNow) {
    const pts = (bundleNow.points ?? {}) as Record<string, { w_src?: string }>;
    const src: Record<string, number> = {};
    for (const v of Object.values(pts)) src[String(v?.w_src || "なし")] = (src[String(v?.w_src || "なし")] || 0) + 1;
    const dc = Number((bundleNow as { device_count?: unknown }).device_count) || 0;
    console.log("\n⑧ 自動モードが使う束");
    console.log(`   押す場所 ${Object.keys(pts).length}個（出どころ: ${JSON.stringify(src)}）`);
    console.log(`   記録している端末 ${dc}台` + (dc <= 1 ? "  ⚠ 他のPCが参加していません" : ""));
    const scen = Array.isArray((bundleNow as { scene_flows?: unknown }).scene_flows)
      ? ((bundleNow as { scene_flows: Array<{ scene?: string }> }).scene_flows) : [];
    console.log(`   場面の手順 ${scen.length}場面（自動に渡る）`);
  }

  console.log("\n" + "─".repeat(74));
  console.log(`終了（${Math.round((Date.now() - t0) / 1000)}秒）`);
  if (!yesCost) console.log("⚠ 写真から読むのは次: `--yes-cost --limit=20`（大きい写真が無い日は効果が小さい）");
})();
