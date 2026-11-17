/**
 * 学んだ画面位置が「自動まで届いているか」を実測する（2026-11-15 竹内さん）
 *
 *   「ちゃんと反映までやるようにする統括」
 *   ⚠ 実測: 束に x/y があっても read_count=0・自動は束より前 → 学んだのに現場未反映。
 *
 * ★ 2026-11-15「ちゃんと連携できるようにボトルネックの部分改善する／会話の時統括把握」:
 *   連携を **段階番号つき**で残す。どこで止まっているかを統括が会話で言えるようにする。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type BundleReflectHint = {
  read_count: number;
  read_at: string | null;
  auto_after: boolean;
  bundle_at: string | null;
};

/** 連携の1段階（統括・会話用） */
export type LinkStep = {
  n: number;
  name: string;
  ok: boolean;
  detail: string;
};

export type LinkPipeline = {
  steps: LinkStep[];
  /** 止まっている段階の番号（全部 OK なら null） */
  bottleneck_n: number | null;
  bottleneck: string | null;
  line: string;
};

/** 最新の束の読まれ方と、そのあとの自動走行の有無を DB から取る */
export async function fetchBundleReflectHint(
  sb: SupabaseClient,
  opt: { scope?: string } = {},
): Promise<BundleReflectHint> {
  const scope = opt.scope && opt.scope !== "all" ? opt.scope : "all";
  const empty: BundleReflectHint = { read_count: 0, read_at: null, auto_after: false, bundle_at: null };
  try {
    const { data: profiles } = await sb
      .from("human_learn_profile")
      .select("created_at, read_at, read_count")
      .eq("scope", scope)
      .order("created_at", { ascending: false })
      .limit(1);
    const p = (profiles ?? [])[0] as { created_at?: string; read_at?: string | null; read_count?: number } | undefined;
    if (!p) return empty;
    const bundle_at = typeof p.created_at === "string" ? p.created_at : null;
    const read_count = Number(p.read_count) || 0;
    const read_at = typeof p.read_at === "string" ? p.read_at : null;
    let auto_after = false;
    if (bundle_at) {
      /**
       * ★ 2026-11-17 連携断絶: 旧は mode=aix だけ見ていた。
       *   実測の自動は `brain_aix`（search_audits）／motion は `aix`・`auto` など。
       *   → どれか1件でも新束のあとにあれば「自動で使った」。
       */
      const { data: aix } = await sb
        .from("human_motion_learn")
        .select("created_at,mode")
        .gte("created_at", bundle_at)
        .order("created_at", { ascending: false })
        .limit(40);
      auto_after = (aix || []).some((r) => /^(aix|auto|brain_aix)$/i.test(String((r as { mode?: string }).mode || "")));
      if (!auto_after) {
        const { data: sa } = await sb
          .from("search_audits")
          .select("created_at,mode")
          .gte("created_at", bundle_at)
          .order("created_at", { ascending: false })
          .limit(20);
        auto_after = (sa || []).some((r) => /aix|auto/i.test(String((r as { mode?: string }).mode || "")));
      }
    }
    return { read_count, read_at, auto_after, bundle_at };
  } catch (_) {
    return empty;
  }
}

/** 反映状態を人が読める1行にする（統括・スクリプト共通） */
export function reflectLine(hint: BundleReflectHint, screenSolid: number, screenAll: number): string {
  const parts: string[] = [`画面位置 ${screenAll}欄（n≥3 ${screenSolid}）`];
  if (hint.read_count <= 0) parts.push("拡張がまだ束を読んでいない（read_count=0）");
  else parts.push(`拡張が読んだ ${hint.read_count}回`);
  if (!hint.auto_after) parts.push("新束のあとの自動走行がまだ無い");
  else parts.push("新束のあとに自動走行あり");
  return parts.join("／");
}

/**
 * ★ 学習→自動の一連連携（会話で統括が把握する形）
 *
 *   1. 写真 Storage 保存（shot_key）
 *   2. 操作・押した位置が記録にある
 *   3. 束に画面位置（n≥3）がある
 *   4. 束に駅場面の遷移（駅の設定へ／沿線へ戻る）がある
 *   5. 拡張が束を読んだ（read_count）
 *   6. 新束のあと自動が走った
 *   7. 自動が束を反映した（learn_reflect）
 *   8. 終わりの合図（stepsが空でない完走／途中段）
 */
export function buildLinkPipeline(opt: {
  photoInStorage: number;
  withOps: number;
  screenSolid: number;
  screenAll: number;
  hint: BundleReflectHint;
  /** true のとき駅遷移・反映印・steps到達まで8段で測る（F32） */
  full?: boolean;
  /** 束 scene_flows.station に遷移ボタンがあるか（full時） */
  stationTransit?: boolean;
  /** 自動監査に learn_reflect_ok / learn_station_flow_hit（full時） */
  learnReflectHit?: boolean;
  /** 直近監査で steps 空でない割合（0〜1・full時） */
  stepsNonEmptyRate?: number;
}): LinkPipeline {
  const steps: LinkStep[] = [
    {
      n: 1,
      name: "写真Storage保存",
      ok: opt.photoInStorage > 0,
      detail: opt.photoInStorage > 0
        ? `${opt.photoInStorage}枚（human-motion-shots・shot_keyあり＝保存済み）`
        : "shot_key が無い（未保存に見える／列を読んでいない）",
    },
    {
      n: 2,
      name: "操作・押した位置",
      ok: opt.withOps > 0,
      detail: opt.withOps > 0 ? `操作つき ${opt.withOps}件` : "操作の並びが薄い",
    },
    {
      n: 3,
      name: "束の画面位置",
      ok: opt.screenSolid >= 3,
      detail: `画面位置 ${opt.screenAll}欄（n≥3 ${opt.screenSolid}）`,
    },
  ];
  if (opt.full) {
    steps.push({
      n: 4,
      name: "束の駅遷移",
      ok: opt.stationTransit === true,
      detail: opt.stationTransit
        ? "scene_flows.station に駅の設定へ／沿線へ戻るあり"
        : "束の station に遷移が無い（録画マージ／sceneOfOpを確認）",
    });
  }
  const nRead = opt.full ? 5 : 4;
  const nAuto = opt.full ? 6 : 5;
  steps.push({
    n: nRead,
    name: "拡張が束を読む",
    ok: opt.hint.read_count > 0,
    detail: opt.hint.read_count > 0
      ? `読んだ ${opt.hint.read_count}回${opt.hint.read_at ? `（${String(opt.hint.read_at).slice(0, 19)}）` : ""}`
      : "read_count=0 → 拡張再読み込み／ポップアップで学習再取得",
  });
  steps.push({
    n: nAuto,
    name: "自動で使う",
    ok: opt.hint.read_count > 0 && !!opt.hint.auto_after,
    detail: opt.hint.read_count <= 0
      ? "拡張がまだ束を読んでいないので自動に新学びは届いていない"
      : (opt.hint.auto_after ? "新束のあとに自動走行あり" : "新束のあとの自動走行がまだ無い"),
  });
  if (opt.full) {
    steps.push({
      n: 7,
      name: "自動が束を反映",
      ok: opt.learnReflectHit === true,
      detail: opt.learnReflectHit
        ? "learn_reflect_ok / learn_station_flow_hit あり"
        : "自動監査に反映印が無い（2.8.53再読込→自動1回）",
    });
    steps.push({
      n: 8,
      name: "終わりの合図（steps）",
      ok: typeof opt.stepsNonEmptyRate === "number" && opt.stepsNonEmptyRate >= 0.5,
      detail: typeof opt.stepsNonEmptyRate === "number"
        ? `steps非空 ${(opt.stepsNonEmptyRate * 100).toFixed(0)}%（完了線≥50%・progress書込で上げる）`
        : "steps到達率が未測",
    });
  }
  const stuck = steps.find((s) => !s.ok) || null;
  const line = steps.map((s) => `${s.n}.${s.name}${s.ok ? "✓" : "✗"}`).join(" → ")
    + (stuck ? ` ／止: ${stuck.n}.${stuck.name}（${stuck.detail}）` : " ／連携完了");
  return {
    steps,
    bottleneck_n: stuck ? stuck.n : null,
    bottleneck: stuck ? `${stuck.n}.${stuck.name}: ${stuck.detail}` : null,
    line,
  };
}
