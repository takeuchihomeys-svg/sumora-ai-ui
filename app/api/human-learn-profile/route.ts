// GET  /api/human-learn-profile … 拡張（自動モード）が読む「学習の束」
// GET  /api/human-learn-profile?history=1 … **学習の履歴**（新しい順・何を学んだかの推移を見る）
// POST /api/human-learn-profile … 今すぐ作り直す（`?fresh=1` と同じ）
// 拡張（自動モード）が読む「学習の束」（2026-11-13 竹内さん
//   「ちゃんと学習担当のブレインをつくってより効率的に学習できるようにする。データベースを有効活用する」)
//
// なぜ要るか:
//   これまで拡張は毎回 `human_motion_learn` の**生の記録**（数百行）を読んでいた。
//   → 記録が増えるほど重くなり、押す順番のような「まとめた知識」は読めなかった。
//   ここは `/api/cron/human-learn-brain` が毎晩作った**束（1行）**を返すだけ。軽い・速い・増えても変わらない。
//
// ?scope=all（既定）／?scope=realpro のようにサイトごとも取れる
// 読んだ印（read_at・read_count）を残す（どの PC が読んでいるか分かる）
import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { buildLeaseOn, tryAcquireLease, releaseLease, buildDecision, supabaseLeaseDb } from "@/app/lib/build-lease";
import { selectDroppingMissing } from "@/app/lib/supabase-safe-select";
import { readRowsKeepingLearned, KEEP_OUTSIDE_CAP_OR } from "@/app/lib/learn-rows-keep";
import { LEARN_PERIODS, sinceIso } from "@/app/lib/learn-periods";
import { countLearnedSolid } from "@/app/lib/learn-bundle-preserve";
import { learnProfileGuardOn, shouldTouchRead, coalesce, cacheHeaders, LEARN_BUILD_MIN_GAP_MS, holdDaytimeRebuild, buildInAfter, buildLeaseKey, laneNextWait } from "@/app/lib/human-learn-profile-guard";
import { jstHourNow } from "@/app/lib/batch-daytime-guard";
import { carryLearnedShots } from "@/app/lib/learn-shots-carry";
import { PLAYBOOK_BUILD_V } from "@/app/lib/action-playbook";
import { AUTO_RULES_REVIEWED_UP_TO, autoRulesVersion } from "@/app/lib/auto-procedure-rules";

export const dynamic = "force-dynamic";
/**
 * ★ 2026-11-15 竹内さん「vercelで動かす形の方が良いのかな？」（main 側の決定を取り込み・2026-11-19 統合）
 *   `maxDuration` が未設定だと Vercel の既定（10秒）で切られる。統括に DeepSeek V4 Pro で考えさせると実測 29.6秒かかる
 *   → 既存の他の LLM API と同じ **60秒**。足りない時は LLM の判断を諦めて決定論を使う（`thinkAsSupervisor` が null を返す＝止まらない）。
 * ★ 2026-11-21 作業員G: 夜の束の作り直しが 60秒を超えて切れていた（11/20 22時台に拡張の GET 12回・cron も）→ 300秒（Vercel の既定の上限）。
 *   拡張の呼び出しは古い束をすぐ返し、作り直しは応答の後（buildInAfter）なので、拡張が300秒待つ事は無い
 */
export const maxDuration = 300;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-automation-key",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const SELECT = [
  "created_at", "site", "mode", "ext_version",
  /**
   * ★ 2026-11-15 竹内さん「この拡張ツール使ってほかのPCでやってもちゃんと学習されるようになっているか」:
   *   **端末（PC）ごとの記録**を数えるために `install_id` を読む。
   *   ⚠ これが無いと「1台しか記録が無い（他のPCが学習に参加していない）」を統括が言えない。
   *   ⚠ 端末のIDは**先頭8文字だけ**材料に出す（長いIDは読めない・個人情報でもないが短く）。
   */
  "install_id",
  "moves_n", "move_speed_px_s", "move_curve", "move_ms", "gap_ms",
  "points_n", "point_x", "point_y", "point_fields",
  "scrolls_n", "scroll_dy", "shot_ops", "shot_learn",
  /**
   * 2026-11-14 竹内さん「一連の動きの学習や強化、反映の為に抜けている部分がある可能性」:
   *   ⚠ `field_order`（押した順番）と `fields`（押した欄の名前）を**読んでいなかった**ので、
   *     写真が少ない通常モードでは順番を学べなかった（実測 normal 34件で順番0）。
   *   → 読む列に足す（無いDBでは selectDroppingMissing が外して読み直す）。
   */
  "field_order", "fields",
  /**
   * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
   *   ⚠ `opens`（押したら何が開いたか）を読む列に足さないと、DBに入っていても**学びに使われない**
   *     （`shot_ops` の時と同じ穴）。無いDBでは selectDroppingMissing が外して読み直す。
   */
  "opens", "open_kinds",
  /**
   * 2026-11-14 竹内さん「データベースの写真から学習する」:
   *   写真がある行（`shot_taken`/`shot_key`）も学びの対象にするため読む。
   * ★ 2026-11-15「統括は把握する」: shot_w/h も読み、大きい写真と Storage 保存を区別する。
   */
  "shot_taken", "shot_key", "shot_w", "shot_h",
].join(", ");

/**
 * 学習の履歴を残す件数（2026-11-13 竹内さん「ちゃんと学習の部分連携して動けているか」）。
 *   推移（弱い所が減っているか）を見るのに要る。多すぎても重くなるので 200 件まで。
 */
const HISTORY_KEEP = 200;

/**
 * 2026-11-13: 記録から**その場で**学習の束を作る（cron を待たない）。
 *   直近3日・最大3000行（重くしない）。
 *   ⚠ DB に無い列があっても、**その列だけ**外して読み直す（`selectDroppingMissing`）。
 *     旧は「`shot_ops` が無い時だけ外す」だったので、実際に無かった `shot_learn` で
 *     読み取りが落ち、`shot_ops` まで一緒に外れて **押す順番 0通り** になっていた。
 *   作った束は DB にも残す（次からは速い・他の PC も読める）。
 */
async function buildNow(scope: string, note?: (why: string) => void) {
  // ★ 学習材料の主期間（動きと監査を同じ窓に揃える）
  const since = sinceIso(LEARN_PERIODS.materialsMs);
  const fetchPage = (cols: string, from: number, to: number) => {
    let q = supabase.from("human_motion_learn").select(cols).gte("created_at", since);
    if (scope && scope !== "all") q = q.eq("site", scope);
    return q.order("created_at", { ascending: false }).range(from, to);
  };
  const rows: unknown[] = [];
  const droppedCols: string[] = [];
  /**
   * 2026-11-13 竹内さん「データベース改善されてるのかな」:
   *   ⚠ 旧は **3000行で打ち切って**いた。実測では3日で3179行あり、
   *     **古い記録が枠を食って、新しい記録が入らない**（＝直近の検索が学習に入らない）。
   *   → 上限を 6000 に上げ、**新しい順**に読む（`order(desc)` は既にそう）ので
   *     打ち切られても**古い方**が落ちる（新しい記録は必ず入る）。
   *   ⚠ 重くしない上限は残す。
   * ★ 2026-11-16 実測: 6000打ち切りの本番束は learned 0欄、手元8236行は 96欄。
   *   shot_learn（位置あり）が新しい自動走行より古い通常録画に多く、6000で落ちていた。
   *   → 10000 に上げる（弱い強化の成果を本番 fresh でも消さない）。
   */
  const MAX_ROWS = 10_000;
  // ★ 2026-11-20: 上限の外に落ちる読んだ写真・通常録画は別枠で読む（learn-rows-keep）
  const onDrop = (c: string, e: { message?: string | null } | null) => { droppedCols.push(c); console.warn("[human-learn-profile] 列が無いので外します:", c, e?.message ?? ""); };
  const kr = await readRowsKeepingLearned<{ created_at?: string | null }>({
    maxRows: MAX_ROWS,
    newest: (a, b) => selectDroppingMissing(SELECT.split(", "), (colsCsv) => fetchPage(colsCsv, a, b), { onDrop }) as never,
    olderKept: (edge, a, b) => selectDroppingMissing(SELECT.split(", "), (colsCsv) => {
      let q = supabase.from("human_motion_learn").select(colsCsv).gte("created_at", since).lt("created_at", edge).or(KEEP_OUTSIDE_CAP_OR);
      if (scope && scope !== "all") q = q.eq("site", scope);
      return q.order("created_at", { ascending: false }).range(a, b);
    }, { onDrop }) as never,
  });
  if (kr.error) { try { note?.("select: " + kr.error); } catch (_) {} return null; }
  rows.push(...kr.rows);
  if (kr.capped) { try { note?.(`上限${MAX_ROWS}行の外から読んだ写真・通常録画を ${kr.kept}行 足した${kr.keptError ? `（失敗: ${kr.keptError}）` : ""}`); } catch (_) {} }
  if (!rows.length) { try { note?.("no_rows"); } catch (_) {} return null; }
  if (droppedCols.length) { try { note?.("dropped_cols: " + Array.from(new Set(droppedCols)).join(",")); } catch (_) {} }
  const { buildHumanLearnBundle, compactBundle } = await import("@/app/lib/human-learn-brain");
  /**
   * 2026-11-14 竹内さん「これで統括に確認したらすべて把握している状態にする。弱い部分も統括はすべて把握する」:
   *   **実際の検索の結果（`search_audits`）**を取って統括に渡す。
   *   ⚠ 旧は人の動きの記録だけを見ていたので、**93%が途中で止まっている**のに
   *     「渡してよい」と判断していた。現場の現実を入れないと統括にならない。
   *   ⚠ 取れなくても学習の束は作る（`audits=null`）。
   */
  let auditsSummary: import("@/app/lib/learn-audit-summary").AuditSummary | null = null;
  try {
    const { summarizeAudits } = await import("@/app/lib/learn-audit-summary");
    // ★ 監査も学習材料の主期間に揃える（旧24時間 → materialsMs）
    const since24 = sinceIso(LEARN_PERIODS.materialsMs);
    /**
     * ⚠ 2026-11-15 **実測で見つけた抜け**: ここで `filled` を取っていなかった。
     *   そのため `summarizeAudits` の「人の検索は操作が10手以上なら完走」判定が
     *   **常に0手に見えて効かず**、統括は古い「完走率8%」のままだった。
     *   → `filled` を取る（人の操作が何手入ったかを見るため。中身は使わない）。
     */
    let aq = supabase
      .from("search_audits")
      .select("created_at, status, site, mode, area_mode, cause_key, error, severity, steps, result, ext_version, filled")
      .gte("created_at", since24)
      .order("created_at", { ascending: false })
      .limit(300);
    if (scope && scope !== "all") aq = aq.eq("site", scope);
    const ar = await aq;
    if (!ar.error) auditsSummary = summarizeAudits((ar.data ?? []) as never, { sinceMs: LEARN_PERIODS.materialsMs });
    else console.warn("[human-learn-profile] search_audits を読めません:", ar.error.message);
  } catch (e) {
    console.warn("[human-learn-profile] 検索の結果を取れません:", e instanceof Error ? e.message : String(e));
  }
  /**
   * 2026-11-14 竹内さん
   *   「時間でみたらよい最大７分の録画なので順番に見れば理解できる」
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   → **場面ごとの手順**（人が実際に押した順）を作って統括に渡す。
   *   ⚠ 材料は `search_audits.filled.ops`（実測: 7日で 56件中32件に入っていた）。
   *     写真（`shot_ops`）が 12% しか無くても、**ここには人の順番が残っている**＝一番強い材料。
   *   ⚠ 取れなくても学習の束は作る（`scene_flows=null`）。
   */
  let sceneFlows: import("@/app/lib/learn-flow-steps").SceneFlow[] | null = null;
  let sceneMissing = 0;
  let sceneMissingNames = "";
  let stoppedScene: string | null = null;
  /**
   * 2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」:
   *   **今日なにを強化したか**を統括に渡す（根拠に出す・点は上げない）。
   */
  let improvements: {
    total: number;
    by_area: Array<{ area: string; n: number }>;
    /**
     * ★ 2026-11-15 竹内さん「このように進化した部分ちゃんと統括にはいるようにする」
     *   「強化必要な部分もちゃんと統括理解してそこの部分を細かく録画画面から読み取って改善されるようにする」
     *
     *   ⚠ 旧は**件数だけ**渡していた（`total` と `by_area`）ので、
     *     統括は「5件強化した」とは言えても**何を直したか**を知らず、次の判断に活かせなかった。
     *   → **直した中身（題・なぜ・どう・効果）も渡す**（`recent`）。
     *     ⚠ 長くしない（最大8件・各120字まで）。統括の材料が膨らむと肝心の弱い所が埋もれる。
     */
    recent?: Array<{ at: string; area: string; title: string; why: string; how: string; effect: string }>;
  } | null = null;
  try {
    const { improvementSummary } = await import("@/app/lib/learn-improvements");
    const imp = await improvementSummary(1);
    if (!imp.error) {
      improvements = {
        total: imp.total,
        by_area: imp.byArea,
        recent: (imp.recent ?? []).slice(0, 8).map((r) => ({
          at: String(r.at ?? "").slice(0, 19),
          area: String(r.area ?? "").slice(0, 20),
          title: String(r.title ?? "").slice(0, 120),
          why: String((r as { why?: unknown }).why ?? "").slice(0, 120),
          how: String((r as { how?: unknown }).how ?? "").slice(0, 120),
          effect: String(r.effect ?? "").slice(0, 120),
        })),
      };
    }
  } catch (e) {
    console.warn("[human-learn-profile] 今日の強化を読めません:", e instanceof Error ? e.message : String(e));
  }
  /** 2026-11-14: 録画の記録（`human_motion_learn`）も同じ7日で見る（try の外でも使う） */
  // 写真・shot_learn も学習材料の主期間に揃える（旧7日 → materialsMs）
  const since7 = sinceIso(LEARN_PERIODS.materialsMs);
  try {
    const { learnSceneFlows, findWeakScenes, lastSceneOf, SCENE_JA } = await import("@/app/lib/learn-flow-steps");
    let fq = supabase
      .from("search_audits")
      .select("status, site, filled")
      .gte("created_at", since7)
      .not("filled", "is", null)
      .order("created_at", { ascending: false })
      .limit(400);
    if (scope && scope !== "all") fq = fq.eq("site", scope);
    const fr = await fq;
    if (fr.error) {
      console.warn("[human-learn-profile] filled.ops を読めません:", fr.error.message);
    } else {
      type Op = { k?: string | null; t?: number | null; by?: string | null };
      const rowsF = (fr.data ?? []) as Array<{ status?: string | null; filled?: { ops?: Op[] } | null }>;
      const runs: Op[][] = [];
      const stopAt: Record<string, number> = {};
      for (const r of rowsF) {
        const ops = Array.isArray(r.filled?.ops) ? r.filled!.ops! : [];
        if (ops.length >= 2) runs.push(ops);
        // 止まった回は「**時系列で最後に触った場面**」を数える（どこで止まるか）
        //   ⚠ `learnSceneFlows(...)[0]` は「手数が多い順」なので最後の場面にならない（実測で誤った）
        if (String(r.status ?? "") !== "finished" && ops.length >= 2) {
          const lastSc = lastSceneOf(ops);
          if (lastSc) stopAt[SCENE_JA[lastSc]] = (stopAt[SCENE_JA[lastSc]] ?? 0) + 1;
        }
      }
      if (runs.length) {
        sceneFlows = learnSceneFlows(runs);
        const weak = findWeakScenes(sceneFlows).filter((w) => w.kind === "no_example");
        sceneMissing = weak.length;
        sceneMissingNames = weak.map((w) => SCENE_JA[w.scene]).join("・");
      }
      const topStop = Object.entries(stopAt).sort((a, b) => b[1] - a[1])[0];
      if (topStop) stoppedScene = topStop[0];
    }
    /**
     * 2026-11-14 竹内さん「逆に何の部分がたりていないのか」
     *   「弱い部分は通常モードで録画したものから学習できるか」:
     *
     *   ⚠ 統括は `search_audits.filled.ops` **だけ**を見ていた。
     *     そのため通常モードの録画（`human_motion_learn`）に残っている
     *     `field_order`（押した欄の順）・`point_fields`（欄ごとの押した位置）を**数えていなかった**。
     *   実測: 通常モード282件のうち「次のページ」が **4回** `point_fields` に残っていたのに、
     *     統括は「次のページの手本が0件」と言っていた（＝**誤り**）。
     *
     *   → **録画の記録も材料にする**（`filled.ops` に無い場面を補う）。
     *     ⚠ `field_order` は「欄の名前の並び」だけなので、時刻が無い＝間（gap）は学べない。
     *       順番と「その場面が出てきた回数」だけを足す（推測で時刻を作らない）。
     */
    try {
      let mq = supabase
        .from("human_motion_learn")
        .select("site, mode, field_order, point_fields, shot_ops")
        .gte("created_at", since7)
        .order("created_at", { ascending: false })
        .limit(600);
      if (scope && scope !== "all") mq = mq.eq("site", scope);
      const mr = await mq;
      if (mr.error) {
        console.warn("[human-learn-profile] field_order を読めません:", mr.error.message);
      } else {
        const rowsM = (mr.data ?? []) as Array<{
          field_order?: unknown;
          point_fields?: unknown;
        }>;
        const runs2: Array<Array<{ k: string; t: null; by: string }>> = [];
        for (const r of rowsM) {
          const order = Array.isArray(r.field_order) ? (r.field_order as unknown[]).map((x) => String(x ?? "")).filter(Boolean) : [];
          const pf = (r.point_fields && typeof r.point_fields === "object" && !Array.isArray(r.point_fields))
            ? Object.keys(r.point_fields as Record<string, unknown>).filter(Boolean) : [];
          /**
           * ★ 2026-11-14 竹内さん「直近の録画した通常モードから学習必要な部分学習するなど（押し方）」
           *   → **実測で判明（押し方が学べない原因）**:
           *     `field_order` がある記録は **600件中11件だけ**（録画は `shot_ops` に順番が入る）。
           *     `point_fields` は181件あるが、これは**欄ごとの集計**（オブジェクト）なので
           *     **キーの並びは押した順ではない**（上書きで順が変わる）。
           *   → **`shot_ops` から順番を作る**（時刻つき・押した順そのもの）。
           *     ⚠ `shot_ops` は写真1枚ごとの「直前までの操作」なので、**一番長い物だけ**使う
           *       （短い途中経過を何度も数えると回数が水増しされる）。
           *     ⚠ 名前に `click:` を付けて `learnSceneFlows` と同じ形にする。
           */
          const ops = Array.isArray((r as { shot_ops?: unknown }).shot_ops)
            ? ((r as { shot_ops: Array<{ f?: unknown; k?: unknown; by?: unknown }> }).shot_ops)
            : [];
          const fromOps = ops
            .filter((o) => o && typeof o.f === "string" && String(o.f) && (o.k !== "diag"))
            .filter((o) => o.by === undefined || o.by === null || o.by === "human")   // 人の手本だけ
            .map((o) => ({ k: "click:" + String(o.f), t: null as null, by: "human" }));
          const names = fromOps.length >= 2 ? fromOps.map((x) => x.k) : (order.length ? order : pf).map((n) => "click:" + n);
          if (names.length < 2) continue;
          runs2.push(names.slice(0, 40).map((k) => ({ k, t: null, by: "human" })));
        }
        if (runs2.length) {
          const flows2 = learnSceneFlows(runs2 as never);
          /**
           * `filled.ops` から作った場面と**合わせる**（同じ場面は回数と手数を足す）。
           * ⚠ 順番は `filled.ops`（時刻つき＝正確）を優先する。
           */
          const byScene = new Map<string, import("@/app/lib/learn-flow-steps").SceneFlow>();
          for (const f of (sceneFlows ?? [])) byScene.set(f.scene, { ...f });
          /**
           * ★ 2026-11-17 竹内さん「学習が自動に反映されない時がある」・DB実測:
           *   filled.ops の station は `transportation_id → required_time` だけで
           *   **駅の設定へ進む／沿線の設定へ戻る／one_station** が無い。
           *   録画 shot_ops には 駅の設定へ進む×240・沿線の設定へ戻る×125 があるのに、
           *   旧は「filled の steps が空でない限り録画を捨てる」ため **正本SEQが束に載らなかった**。
           *   → 駅場面は遷移ボタン付きの録画手順を優先。他場面は従来どおり filled 優先。
           */
          const hasStationTransit = (steps: string[]) =>
            (steps || []).some((s) => /駅の設定へ進む|沿線の設定へ戻る|one_station|one_line|route_id/.test(String(s)));
          for (const f of flows2) {
            const cur = byScene.get(f.scene);
            if (!cur) { byScene.set(f.scene, f); continue; }
            cur.runs += f.runs;
            cur.ops += f.ops;
            cur.raw_ops = (cur.raw_ops ?? 0) + (f.raw_ops ?? 0);
            if (!cur.steps.length) {
              cur.steps = f.steps;
            } else if (
              f.scene === "station"
              && hasStationTransit(f.steps)
              && !hasStationTransit(cur.steps)
            ) {
              cur.steps = f.steps;
            } else if (
              f.scene === "station"
              && hasStationTransit(f.steps)
              && f.steps.length > cur.steps.length
            ) {
              cur.steps = f.steps;
            }
          }
          sceneFlows = [...byScene.values()].sort((a, b) => b.ops - a.ops);
          const weak2 = findWeakScenes(sceneFlows).filter((w) => w.kind === "no_example");
          sceneMissing = weak2.length;
          sceneMissingNames = weak2.map((w) => SCENE_JA[w.scene]).join("・");
        }
      }
    } catch (e) {
      console.warn("[human-learn-profile] 録画の記録を足せません:", e instanceof Error ? e.message : String(e));
    }
  } catch (e) {
    console.warn("[human-learn-profile] 場面ごとの手順を作れません:", e instanceof Error ? e.message : String(e));
  }
  /**
   * 2026-11-14 竹内さん「ここも調べる」:
   *   ⚠ 24時間だと「モードが無かった」が1件しか見えない（実測）。7日だと **187件**。
   *     指示の失敗は**たまに起きる**ので、短い窓では見落とす。
   *   → **7日**で見る（指示は1日数十件なので重くならない）。
   */
  const since7d = sinceIso(LEARN_PERIODS.commandsMs);
  let commandsSummary: import("@/app/lib/learn-command-summary").CommandSummary | null = null;
  try {
    const { summarizeCommands } = await import("@/app/lib/learn-command-summary");
    const cr = await supabase
      .from("automation_commands")
      .select("created_at, picked_up_at, completed_at, status, sites, command_type, error_message")
      .gte("created_at", since7d)
      .order("created_at", { ascending: false })
      .limit(600);
    if (!cr.error) commandsSummary = summarizeCommands((cr.data ?? []) as never, { sinceMs: LEARN_PERIODS.commandsMs });
    else console.warn("[human-learn-profile] automation_commands を読めません:", cr.error.message);
  } catch (e) {
    console.warn("[human-learn-profile] 指示の状態を取れません:", e instanceof Error ? e.message : String(e));
  }
  /**
   * 2026-11-14 竹内さん「統括の部分ちゃんと改善されるようになっているのか」:
   *   ⚠ **統括は「前回と比べる」仕組みを持っているのに、常に prev: null で渡していた**。
   *     だから「良くなったか」を一度も言えていなかった（`learn_supervisor_log` に128件あるのに未使用）。
   *   → **前回の判断**を読んで渡す。比べるのは数だけ（記録・順番・場所・開き方・弱い所）。
   */
  let prevAdvice: {
    at: string | null; rows: number; next: number; points: number; opens: number; weak: number;
    /** ★ 2026-11-15: 前回の弱い所の一覧（`kind|name`）＝「直った」を判定するため */
    prevWeak?: Array<{ kind?: string; name?: string }> | null;
  } | null = null;
  try {
    const { data: prevRows } = await supabase
      .from("learn_supervisor_log")
      .select("created_at, next_n, points_n, opens_n, weak_n, rows, meeting")
      .eq("scope", scope && scope !== "all" ? scope : "all")
      .order("created_at", { ascending: false })
      .limit(1);
    const p = (prevRows ?? [])[0] as Record<string, unknown> | undefined;
    if (p) {
      /**
       * ★ 2026-11-15 竹内さん「学習も弱い部分を見つけて強化できるようにするために」:
       *   前回の**弱い所の一覧**を `meeting.weak_list` から取り出す（保存してある）。
       *   ⚠ 旧い記録には入っていない → その時は null（比べない＝初回と同じ扱い）。
       *   ⚠ 形が違えば空にする（壊れたデータで誤判定しない）。
       */
      let prevWeak: Array<{ kind?: string; name?: string }> | null = null;
      try {
        const m = p.meeting as Record<string, unknown> | null;
        const wl = m && Array.isArray((m as { weak_list?: unknown }).weak_list)
          ? ((m as { weak_list: unknown[] }).weak_list) : null;
        if (wl) {
          prevWeak = wl
            .filter((x) => x && typeof x === "object")
            .map((x) => {
              const o = x as Record<string, unknown>;
              return { kind: String(o.kind ?? ""), name: String(o.name ?? "").slice(0, 40) };
            })
            .filter((x) => x.name)
            .slice(0, 40);
        }
      } catch (_) { prevWeak = null; }
      prevAdvice = {
        at: typeof p.created_at === "string" ? p.created_at : null,
        rows: Number(p.rows) || 0,
        next: Number(p.next_n) || 0,
        points: Number(p.points_n) || 0,
        opens: Number(p.opens_n) || 0,
        weak: Number(p.weak_n) || 0,
        prevWeak,
      };
    }
  } catch (e) {
    console.warn("[human-learn-profile] 前回の判断を読めません:", e instanceof Error ? e.message : String(e));
  }
  /**
   * ★ 2026-11-15 竹内さん「ちゃんと反映までやるようにする統括」:
   *   拡張の read_count と、新束のあとの自動走行を材料に渡す。
   */
  /**
   * ★ 2026-11-20 竹内さん「反映の流れ」（承認済み）: ここで読むのは**前の束**（新しい束はまだ入れていない）。
   *   read_count は従来どおり（前の束の読まれ数）・prev_read_count に同じ値を明記。
   *   判断する束（この束）は作ったばかりで必ず 0 → judged_read_count=0（統括はこれで判定する）。
   */
  let reflectHint: { read_count: number; read_at: string | null; auto_after: boolean; prev_read_count: number; judged_read_count: number } | null = null;
  try {
    const { fetchBundleReflectHint } = await import("@/app/lib/bundle-reflect");
    const h = await fetchBundleReflectHint(supabase, { scope });
    reflectHint = { read_count: h.read_count, read_at: h.read_at, auto_after: h.auto_after, prev_read_count: h.read_count, judged_read_count: 0 };
  } catch (e) {
    console.warn("[human-learn-profile] 反映状態を読めません:", e instanceof Error ? e.message : String(e));
  }
  /**
   * ★ 2026-11-17 竹内さん「統括は土台を理解して統括できるように」:
   *   foundation-audit を束の統括材料に載せる（Proが F29〜F32 を根拠に使える）。
   */
  let foundationAudit: import("@/app/lib/learn-foundation-audit").FoundationForSupervisor | null = null;
  /**
   * ★ 2026-11-20 竹内さん「データベースちゃんと連携できるように、なぜとまっているのか」:
   *   土台点検は human_motion_learn.shot_ops を数千行ずつ何本も読む（重い）。営業時間（JST 9〜22）に
   *   束の作り直しのたびに回すと、手元の統括Proの点検と重なって DB の手が埋まる（11-19 19:40 から読みが5分・21時に全体が 522）。
   *   → 営業時間は直前の束の foundation_audit だけを読んで継ぐ（learn-bundle-scene-meta と同じ決まり）。無い時だけ回す。
   */
  try {
    const { jstHourNow } = await import("@/app/lib/batch-daytime-guard");
    const h = jstHourNow();
    if (h >= 9 && h < 22) {
      const { data: prevFa } = await supabase
        .from("human_learn_profile")
        .select("fa:bundle->foundation_audit")
        .eq("scope", scope)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const fa = (prevFa as { fa?: unknown } | null)?.fa;
      if (fa && typeof fa === "object") {
        foundationAudit = fa as import("@/app/lib/learn-foundation-audit").FoundationForSupervisor;
        try { note?.("foundation_audit_copied_daytime"); } catch (_) {}
      }
    }
  } catch (e) {
    console.warn("[human-learn-profile] 直前の土台点検を読めません:", e instanceof Error ? e.message : String(e));
  }
  if (!foundationAudit) {
    try {
      const { auditLearnFoundations, compactFoundationForSupervisor } = await import("@/app/lib/learn-foundation-audit");
      const faSite = scope === "itandi" || scope === "realpro" ? scope : "all";
      const fa = await auditLearnFoundations(supabase, { site: faSite });
      foundationAudit = compactFoundationForSupervisor(fa);
    } catch (e) {
      console.warn("[human-learn-profile] 土台点検を読めません:", e instanceof Error ? e.message : String(e));
    }
  }
  const bundle = compactBundle(buildHumanLearnBundle(rows as never, Date.now(), auditsSummary, commandsSummary, {
    scene_flows: sceneFlows,
    scene_missing: sceneMissing,
    scene_missing_names: sceneMissingNames,
    stopped_scene: stoppedScene,
    improvements,
    bundle_reflect: reflectHint,
    foundation_audit: foundationAudit,
  }, prevAdvice));
  if (!bundle.source.rows) { try { note?.("empty_bundle"); } catch (_) {} return null; }
  /**
   * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
   *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
   *   場面ごとの手順を**束にも載せる**（呼ぶ側・統括の会話・アプリの画面がそのまま読める）。
   *   ⚠ `compactBundle` が落とす事があるので、落ちていても必ず入れる。
   */
  {
    const b = bundle as unknown as Record<string, unknown>;
    if (sceneFlows && sceneFlows.length) b.scene_flows = sceneFlows;
    if (sceneMissing > 0) b.scene_missing = sceneMissing;
    if (sceneMissingNames) b.scene_missing_names = sceneMissingNames;
    if (stoppedScene) b.stopped_scene = stoppedScene;
  }
  /** ★ F49: compact 後も shots.in_storage / kinds が無ければ bundle_reflect から補完 */
  if (bundle.shots && typeof bundle.shots === "object") {
    const sh = bundle.shots as { in_storage?: number; kinds?: Record<string, number> };
    if (!sh.in_storage) {
      const br = bundle.bundle_reflect as { photo_in_storage?: number } | undefined;
      const stored = Number(br?.photo_in_storage);
      if (Number.isFinite(stored) && stored > 0) sh.in_storage = stored;
    }
    if (!sh.kinds || typeof sh.kinds !== "object") sh.kinds = sh.kinds ?? {};
  }
  /**
   * 2026-11-13 竹内さん「なんで連携できていないのか」:
   *   DB に無い列があって外した時は、**外した列を返す**（黙って落とさない）。
   *   呼ぶ側が「なぜ押す順番が 0 通りなのか」をその場で分かるようにする。
   */
  const dropped = Array.from(new Set(droppedCols));
  if (dropped.length) (bundle as unknown as Record<string, unknown>).dropped_cols = dropped;
  /**
   * ★ 2026-11-16/17: fresh・約31分再生成で solid 96→0 が再発。
   *   共通 inherit + **消す書き込みは拒否**（履歴に solid≥30 があるのに 0 のまま書かない）。
   */
  let wipeBlocked = false;
  try {
    const { inheritLinkFoundations, countLearnedSolid, INHERIT_LOOKBACK_DEFAULT } = await import("@/app/lib/learn-bundle-preserve");
    const b = bundle as unknown as Record<string, unknown>;
    const pr = await inheritLinkFoundations(supabase, b, scope, { lookback: INHERIT_LOOKBACK_DEFAULT, minSolid: 30 });
    if (pr.preserved) {
      console.warn("[human-learn-profile]", pr.why);
      try { note?.("preserved_learned:" + pr.preserved_solid); } catch (_) { /* */ }
    }
    if (!pr.safe_to_write) {
      wipeBlocked = true;
      console.warn("[human-learn-profile] 消す書き込みを拒否:", pr.why);
      try { note?.("abort_wipe:" + pr.why); } catch (_) { /* */ }
    }
  } catch (e) {
    /** ★ 2026-11-18: 例外握りつぶしで solid=0 insert を許さない */
    const { countLearnedSolid } = await import("@/app/lib/learn-bundle-preserve");
    const solidNow = countLearnedSolid(bundle).solid;
    if (solidNow < 30) wipeBlocked = true;
    console.warn("[human-learn-profile] learned 引き継ぎ失敗:", e instanceof Error ? e.message : String(e), `solid=${solidNow} wipeBlocked=${wipeBlocked}`);
  }
  /**
   * ★ 2026-11-20 竹内さん「入力内容として外す」: 束からお客様の名前らしい文字列を外す（段階名は残す・件数は足す）。
   *   実測: 束の next のキーに「今の客:fill_start 〈名前〉」が入っていた（拡張が段階名に名前を付けて記録）。
   *   ⚠ 引き継ぎ（inheritLinkFoundations）の**後**に置く（過去の行から名前が戻らないように）。
   */
  try {
    const { stripCustomerNames } = await import("@/app/lib/bundle-privacy");
    const cleaned = stripCustomerNames(bundle as unknown as Record<string, unknown>);
    if (cleaned.changed) {
      for (const k of Object.keys(cleaned.value)) (bundle as unknown as Record<string, unknown>)[k] = cleaned.value[k];
      note?.("privacy_names_stripped");
    }
  } catch (e) {
    console.warn("[human-learn-profile] 名前の除去に失敗:", e instanceof Error ? e.message : String(e));
  }
  /**
   * ★ 2026-11-20 竹内さん「手順書は束の中に載せる」: 束（場面の手順・押す位置・開く欄・次のページ）から
   *   手順書を作って一緒に保存する。拡張は `playbook` を取り出して保存する（axlx_learn_playbook）。
   *   ⚠ 引き継ぎの後に作る（引き継いだ押す位置・場面の手順も入るように）。
   */
  //   ★ 2026-11-20（2回目）: ここで作ると、下の carryLearnedShots（前の束から押す位置を継ぐ）の前になり、
  //     継いだ位置が手順書に入らなかった。→ 作るのは insert の直前（prepareBundleForWrite・下）。
  // DB にも残す（同じ scope の古い行は消す＝いつも1つだけ）
  /**
   * 2026-11-13 竹内さん「これ学習したところはデータベースに保管されるようになっているのか。
   *   データベースを学習面でも強化していくようにする」:
   *   ⚠ 旧は `try {} catch {}` で**失敗しても黙って捨てて**いたので、保管できていなくても気づけなかった。
   *   → 失敗したら**理由を返す**（`save_error`）。呼ぶ側（私・点検）が分かるようにする。
   *   ⚠ 消してから入れるので、**入れるのに失敗すると前の束も消える**。
   *     → 先に**入れてから**、古い物を消す（消す順を逆にした）。失敗しても前の束が残る。
   * ★ 2026-11-17: 消す書き込み（wipeBlocked）の時は**入れない**。直前の良い束を返す。
   */
  let saveError: string | null = null;
  let saved = false;
  if (wipeBlocked) {
    try {
      // 2026-11-21 作業員G（#588・②・LEARN_HISTORY_SLIM=on の時だけ）: 20行の束を丸ごと読まず、shots だけで探して、返す1行だけ丸ごと読む
      const { countLearnedSolid, learnHistorySlimOn } = await import("@/app/lib/learn-bundle-preserve");
      const slim = learnHistorySlimOn();
      const prev = await supabase
        .from("human_learn_profile")
        .select(slim ? "id,shots:bundle->shots" : "bundle")
        .eq("scope", scope)
        .order("created_at", { ascending: false })
        .limit(20);
      for (const row0 of (prev.data || []) as Array<{ id?: number; bundle?: unknown; shots?: unknown }>) {
        const probe = slim ? { shots: row0.shots } : row0.bundle;
        if (countLearnedSolid(probe).solid >= 30) {
          let full: unknown = row0.bundle;
          if (slim) {
            const one = await supabase.from("human_learn_profile").select("bundle").eq("id", row0.id as number).maybeSingle();
            full = (one.data as { bundle?: unknown } | null)?.bundle;
            if (!full) continue;
          }
          const keep = full as typeof bundle;
          (keep as unknown as Record<string, unknown>).wipe_blocked = true;
          (keep as unknown as Record<string, unknown>).wipe_block_why = "履歴の学習を消す書き込みを拒否";
          return keep;
        }
      }
    } catch (_) { /* 拒否後に良い束が無ければ下で通常保存を試みない */ }
    saveError = "wipe_blocked: 学習消失を防ぐため新束を書かなかった";
    (bundle as unknown as Record<string, unknown>).save_error = saveError;
    (bundle as unknown as Record<string, unknown>).saved_to_db = false;
    return bundle;
  }
  try {
    const carry = await carryLearnedShots(supabase, scope, bundle);
    (bundle as unknown as Record<string, unknown>).shots_carry = carry.why + (carry.from_id ? "@" + carry.from_id : "");
  } catch { /* 位置を継げなくても束は残す */ }
  try {
    const { prepareBundleForWrite } = await import("@/app/lib/bundle-write-prepare");
    const prep = prepareBundleForWrite(bundle as unknown as Record<string, unknown>);
    if (!prep.playbook_ok) console.warn("[human-learn-profile] 手順書を作れません（束は書く）");
  } catch (e) {
    console.warn("[human-learn-profile] 書く前の整えに失敗:", e instanceof Error ? e.message : String(e));
  }
  try {
    const ins = await supabase.from("human_learn_profile").insert({
      scope,
      source_rows: bundle.source.rows,
      source_from: bundle.source.from,
      source_to: bundle.source.to,
      ext_version: null,
      bundle,
      lines: bundle.lines,
    });
    if (ins.error) {
      saveError = ins.error.message;
      console.warn("[human-learn-profile] 束を残せません:", ins.error.message);
    } else {
      saved = true;
      /**
       * 2026-11-13 竹内さん「これでちゃんと学習の部分連携して動けているか」:
       *   ⚠ 旧は「今入れた1件より古い物を全部消す」だったので、**履歴が1件しか残らなかった**
       *     （`?history=1` がいつも1行＝推移が見られない＝学習が進んでいるか分からない）。
       *   → **新しい方から HISTORY_KEEP 件だけ残し、それより古い物を消す**
       *     （消す量を絞るので、失敗しても今までの履歴が残る）。
       */
      try {
        const keep = await supabase.from("human_learn_profile")
          .select("id").eq("scope", scope)
          .order("created_at", { ascending: false })
          .range(HISTORY_KEEP, HISTORY_KEEP + 199);
        const oldIds = ((keep.data ?? []) as Array<{ id: unknown }>).map((x) => x.id).filter((x) => x != null);
        if (oldIds.length) {
          await supabase.from("human_learn_profile").delete().in("id", oldIds);
        }
      } catch { /* 消せなくても害はない（読む時は最新1件だけ見る） */ }
    }
  } catch (e) {
    saveError = e instanceof Error ? e.message : String(e);
    console.warn("[human-learn-profile] 束を残す時に例外:", saveError);
  }
  (bundle as unknown as Record<string, unknown>).saved_to_db = saved;
  if (saveError) (bundle as unknown as Record<string, unknown>).save_error = saveError;
  /**
   * 2026-11-14 竹内さん「なんでここ統括がちゃんと学習する絶対ルールなのに連携できていないのか」:
   *   ⚠ 旧は統括の判断を**投げっぱなし**で保存していて、失敗を握り潰していた
   *     （Vercel は応答を返した時点で打ち切る＝書き込みが消える・RLS で弾かれても気づけない）。
   *   → ここで **await して**、結果を束に載せる（`supervisor_saved`）。
   *     失敗しても束は返す（現場を止めない）。
   */
  try {
    const { saveSupervisorForBundle } = await import("@/app/lib/human-learn-brain");
    const supSave = await saveSupervisorForBundle(bundle);
    (bundle as unknown as Record<string, unknown>).supervisor_saved = supSave;
    if (!supSave.all.ok) console.warn("[human-learn-profile] 統括の判断を残せません:", supSave.all.error || supSave.all.skipped);
  } catch (e) {
    (bundle as unknown as Record<string, unknown>).supervisor_saved = { all: { ok: false, error: e instanceof Error ? e.message : String(e) } };
  }
  return bundle;
}

export async function GET(req: NextRequest) {
  const scope = (req.nextUrl.searchParams.get("scope") || "all").slice(0, 20);
  const touch = req.nextUrl.searchParams.get("touch") !== "0";

  /**
   * ★ 2026-11-15 竹内さん「束の更新は1日1回だけ。すぐ反映したいなら手で実行が必要」:
   *
   *   ⚠ 旧は**毎晩22:20のcronだけ**が束を作り直していた。朝に録画しても夜まで反映されなかった。
   *   → **`?refresh=1` で、いつでもその場で作り直せる**ようにする（更新は常に許可）。
   *     ⚠ 作り直しは重い（6,000件を読む）ので、**同時に1本**に絞る（連打でDBを止めない）。
   *     ⚠ 失敗しても今までの束は残す（消さない）。
   */
  if (req.nextUrl.searchParams.get("refresh") === "1") {
    const g = globalThis as unknown as { __axlxBundleRefreshAt?: number; __axlxBundleRefreshing?: boolean };
    const last = Number(g.__axlxBundleRefreshAt) || 0;
    // ⚠ 20秒に1回まで（録画が続いている時に何度も呼ばれてもDBを止めない）
    if (Date.now() - last < 20_000) {
      return NextResponse.json({ ok: true, skipped: "too_soon", wait_ms: 20_000 - (Date.now() - last) }, { headers: CORS });
    }
    if (g.__axlxBundleRefreshing) {
      return NextResponse.json({ ok: true, skipped: "already_running" }, { headers: CORS });
    }
    g.__axlxBundleRefreshing = true;
    try {
      const mod = await import("@/app/lib/human-learn-brain");
      const buildHumanLearnBundle = mod.buildHumanLearnBundle;
      const compactBundle = mod.compactBundle;
      type MotionRowLocal = Parameters<typeof buildHumanLearnBundle>[0][number];
      const since = sinceIso(LEARN_PERIODS.historyMs);
      const rows: MotionRowLocal[] = [];
      // ★ 2026-11-20: 写真の文字列（shot_b64）まで全列を読んでいた（select("*")）→ 自動の作り直しと同じ列の一覧（SELECT）で読む
      // ★ 2026-11-20: 上限の外に落ちる読んだ写真・通常録画は別枠で読む（learn-rows-keep）
      const kr = await readRowsKeepingLearned<MotionRowLocal>({
        maxRows: 10_000,
        newest: (a, b) => selectDroppingMissing(SELECT.split(", "), (colsCsv) => supabase.from("human_motion_learn").select(colsCsv)
          .gte("created_at", since).order("created_at", { ascending: false }).range(a, b)) as never,
        olderKept: (edge, a, b) => selectDroppingMissing(SELECT.split(", "), (colsCsv) => supabase.from("human_motion_learn").select(colsCsv)
          .gte("created_at", since).lt("created_at", edge).or(KEEP_OUTSIDE_CAP_OR).order("created_at", { ascending: false }).range(a, b)) as never,
      });
      if (kr.error) throw new Error(kr.error.slice(0, 160));
      rows.push(...kr.rows);
      const now = new Date().toISOString();
      const { fetchLearnBundleSceneMeta } = await import("@/app/lib/learn-bundle-scene-meta");
      const sceneMeta = await fetchLearnBundleSceneMeta(supabase, "all", { forceFullAudit: true });
      const bundle = compactBundle(buildHumanLearnBundle(rows, Date.now(), undefined, undefined, sceneMeta));
      /**
       * ⚠ 2026-11-15 実測: `generated_at` 列は**存在しない**（実際の列に無い）。
       *   入れると `Could not find the 'generated_at' column` で失敗する。
       *   → `created_at` は自動で入るので送らない。
       * ★ 2026-11-17: refresh=1 も消す書き込みを拒否（fresh と同じ抜け穴だった）。
       */
      const { inheritLinkFoundations, countLearnedSolid, INHERIT_LOOKBACK_DEFAULT } = await import("@/app/lib/learn-bundle-preserve");
      const b = bundle as unknown as Record<string, unknown>;
      const pr = await inheritLinkFoundations(supabase, b, "all", { lookback: INHERIT_LOOKBACK_DEFAULT, minSolid: 30 });
      if (!pr.safe_to_write) {
        return NextResponse.json({
          ok: true, refreshed: false, wipe_blocked: true, why: pr.why, rows: rows.length,
          solid: countLearnedSolid(b).solid,
        }, { headers: CORS });
      }
      // ★ 2026-11-20: refresh=1 も名前の除去と手順書を通す（ここだけ通していなかった＝古い手順書の写しが残る）
      const { prepareBundleForWrite } = await import("@/app/lib/bundle-write-prepare");
      prepareBundleForWrite(b);
      const ins = await supabase.from("human_learn_profile").insert({
        scope: "all", source_rows: rows.length, bundle: b,
      });
      void now;
      if (ins.error) throw new Error(String(ins.error.message).slice(0, 160));
      g.__axlxBundleRefreshAt = Date.now();
      // 古い束を整理（20件より前を消す・今までの束は残す）
      try {
        const old = await supabase.from("human_learn_profile").select("id")
          .eq("scope", "all").order("created_at", { ascending: false }).limit(50);
        const ids = ((old.data ?? []) as Array<{ id: unknown }>).slice(20).map((x) => x.id);
        if (ids.length) await supabase.from("human_learn_profile").delete().in("id", ids);
      } catch (_) {}
      return NextResponse.json({
        ok: true, refreshed: true, rows: rows.length, preserved: pr.preserved, solid: pr.solid,
        shots: (b as { shots?: unknown }).shots ?? null,
      }, { headers: CORS });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }, { status: 500, headers: CORS });
    } finally {
      g.__axlxBundleRefreshing = false;
    }
  }

  /**
   * 2026-11-13 竹内さん「データベースを学習面でも強化していくようにする形とする」:
   *   **学習の履歴**を見られるようにする（いつ・何件から・何を学んだか）。
   *   → 「学習が進んでいるか」「弱い所が減っているか」を**推移で**確かめられる。
   */
  if (req.nextUrl.searchParams.get("history") === "1") {
    const lim = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20, 1), 100);
    const h = await supabase
      .from("human_learn_profile")
      .select("id, created_at, scope, source_rows, source_from, source_to, ext_version, lines, read_count")
      .eq("scope", scope)
      .order("created_at", { ascending: false })
      .limit(lim);
    if (h.error) {
      const missing = /does not exist|42P01|Could not find the table|schema cache/i.test(h.error.message);
      return NextResponse.json({ ok: false, error: h.error.message, empty: true, rows: [], missing_table: missing }, { status: missing ? 200 : 500, headers: CORS });
    }
    const rows = ((h.data ?? []) as Record<string, unknown>[]).map((x) => ({
      id: x.id, created_at: x.created_at, source_rows: x.source_rows,
      source_from: x.source_from, source_to: x.source_to,
      read_count: x.read_count ?? 0,
      lines: x.lines ?? [],
    }));
    return NextResponse.json({ ok: true, scope, count: rows.length, rows }, { headers: CORS });
  }

  // 2026-11-15 作業員H（DB の止まり 11/15 01:40〜01:43Z の調べ・HUMAN_LEARN_PROFILE_GUARD・既定 on・=off で戻す）＋ 2026-11-19 統合:
  //   拡張の束の取りに来る呼び出しが 1秒に百件近く重なり、①版だけ見る軽い確認（touch=0）まで束の全体（bundle・1行 約40KB）を読み、
  //   ②読むたびに同じ1行（id=1556）へ read_count の書き込み（PATCH 302件）＝同じ行の鍵の取り合い、③束が30分より古いと来た数だけ束を作り直す（1回 約15秒）が重なった。
  //   守り: 軽い確認は版だけ読む・読んだ印は10分に1回だけ後で書く・同じ版の束はCDN で60秒まとめる（同じ要求を1つにまとめる）・作り直しは同じ所で1本だけ（human-learn-profile-guard.ts）
  const guard = learnProfileGuardOn();
  const lightReq = (req.nextUrl.searchParams.get("touch") === "0" || req.nextUrl.searchParams.get("mark_read") === "1") && req.nextUrl.searchParams.get("fresh") !== "1";
  // 選ぶ列は場合で変わる＝文字列の型にして読む（PostgREST の型の読み取りは固定の文字列だけ）
  const rowCols: string = guard && lightReq
    ? "id, created_at, scope, source_rows, read_count, read_at, generated_at:bundle->>generated_at, screen_solid:bundle->>screen_solid, playbook_rules_v:bundle->playbook->>rules_v, playbook_rules_up_to:bundle->playbook->>rules_up_to"
    : `id, created_at, scope, source_rows, source_from, source_to, ext_version, bundle, lines, read_count${guard ? ", read_at" : ""}`;
  // 型は明示する（PostgREST の組み立ての型をそのまま重ねて推し量らせると型の確かめが重くなる・11/15 の組み立てのメモリ切れ）
  type RowRes = { data: unknown[] | null; error: { message: string } | null };
  const r: RowRes = await coalesce<RowRes>(`row:${scope}:${guard && lightReq ? "light" : "full"}`, guard, async (): Promise<RowRes> => {
    const q = await supabase.from("human_learn_profile").select(rowCols).eq("scope", scope).order("created_at", { ascending: false }).limit(1);
    return { data: (q.data ?? null) as unknown[] | null, error: q.error ? { message: q.error.message } : null };
  });

  if (r.error) {
    /**
     * 2026-11-13: 表がまだ無い時（migrate の前）も **200 で返す**（拡張が止まらないように）。
     *   旧は 42P01 だけを見ていたが、PostgREST は「スキーマキャッシュに無い」という別の文
     *   （`Could not find the table ... in the schema cache`）を返すので 500 になっていた。
     */
    const missing = /does not exist|42P01|Could not find the table|schema cache/i.test(r.error.message);
    return NextResponse.json(
      { ok: false, error: r.error.message, empty: true, bundle: null, lines: [], missing_table: missing },
      { status: missing ? 200 : 500, headers: CORS },
    );
  }
  const row = ((r.data ?? []) as unknown as Array<Record<string, unknown>>)[0];
  /**
   * 2026-11-13 竹内さん「連携するようにする」（学習が22:20のcron待ちで、すぐ確かめられない）:
   *   束が**無い**時と、**古い**時（前回から30分以上たっている）は、
   *   **その場で記録から作る**（cron を待たない）。作った物は DB に残すので次からは速い。
   *   ⚠ 重くしない: 直近3日・最大3000行まで。作れなければ今まで通り（空を返す）。
   */
  const stale = !row || (Date.now() - Date.parse(String(row.created_at ?? 0)) > LEARN_PERIODS.bundleFreshMs);
  /**
   * 2026-11-13: `?fresh=1` で**必ず作り直す**（30分待たずに確かめたい時）。
   *   竹内さん「学習できていない部分も学習できるようになっているのか」→ 待たずに確かめたい。
   */
  const forceFresh = req.nextUrl.searchParams.get("fresh") === "1";
  /**
   * ★ 2026-11-14 竹内さん「1と2順に改善するようにする」→ **実測で判明（ここが根本）**:
   *
   *   ⚠ 拡張は **5分ごと**に `?touch=0` で「版だけ」確かめる（軽い確認のつもり）。
   *     ところが `stale`（30分以上前）だと **`?touch=0` でも `buildNow` を走らせていた**。
   *     `buildNow` は **14.6秒**かかる（実測・6000行を読んで集計）。
   *   → 拡張のタイムアウト（8秒）で切れ、**版が読めない** → 取得（15秒）も足りず失敗
   *     ＝ **新しい学びが永久に届かない**（実測: `realpro` の束が 13:54 のまま2時間）。
   *
   *   → **`touch=0` は「作らない」**。DBにある束の版（`generated_at`）だけ返す。
   *     作るのは ① `fresh=1` の時 ② touch あり（＝実際に読む時）③ 束が**1件も無い**時。
   *     ⚠ 束が1件も無い時は作る（拡張が「何も無い」で止まらないように）。
   *     ⚠ 作るのは**1回だけ**。その後の touch=0 は軽い（DBを1行読むだけ）。
   */
  const lightCheck = req.nextUrl.searchParams.get("touch") === "0";
  /**
   * ★ 2026-11-16 連携ボトルネック除去:
   *   版が同じだと拡張が束を取り直さず、read_count が永久に 0 のままになる。
   *   → `mark_read=1` は束を返さず「読んだ印」だけ付ける（軽い・版確認後の確認用）。
   */
  const markReadOnly = req.nextUrl.searchParams.get("mark_read") === "1";
  if (markReadOnly && row) {
    /**
     * ★ 2026-11-17 実測: 拡張の心拍が mark_read を連打し read_count が 738 まで水増し。
     *   10分以内の再印は read_at だけ更新（回数は増やさない）。
     */
    let readCount = Number(row.read_count) || 0;
    let readAt: string | null = null;
    try {
      readAt = new Date().toISOString();
      const prevAt = row.read_at ? Date.parse(String(row.read_at)) : 0;
      const recent = Number.isFinite(prevAt) && prevAt > 0 && Date.now() - prevAt < 10 * 60_000;
      const nextCount = recent && readCount > 0 ? readCount : readCount + 1;
      await supabase
        .from("human_learn_profile")
        .update({ read_at: readAt, read_count: nextCount })
        .eq("id", row.id as number);
      readCount = nextCount;
    } catch { /* 印だけ失敗しても連携は続ける */ }
    return NextResponse.json({
      ok: true, empty: false, scope, marked: true,
      generated_at: guard && lightReq
        ? (row.generated_at ?? row.created_at)
        : (row.bundle && typeof row.bundle === "object")
          ? ((row.bundle as Record<string, unknown>).generated_at ?? row.created_at)
          : row.created_at,
      read_count: readCount,
      read_at: readAt,
    }, { headers: CORS });
  }
  if (lightCheck && !forceFresh && row) {
    /**
     * ★ 2026-11-17 竹内さん「学習しても改善されない／拡張への反映連携の抜け」:
     *   版だけ返すと「読んだ」と「自動で使った」が切れ、拡張が same_version で止まっても
     *   solid が増えた・自動未確認、が分からない。
     *   → light でも screen_solid / needs_auto を付け、拡張が強制取込・自動1回促しできる。
     */
    // ★ 統合（2026-11-19）: 守りの時の軽い確認は束の全体を読まない。束は行ごとに変わらない（id 固定）ので、
    //   solid（位置つき欄の数）は束の `shots.learned` だけを id ごとに1回読んで覚える（束が替わるまで再読しない）。
    let solidLight: number;
    if (guard && lightReq) {
      const memo = ((globalThis as unknown as { __axlxSolidById?: Map<string, number> }).__axlxSolidById ??= new Map<string, number>());
      const key = `${scope}:${String(row.id)}`;
      const hit = memo.get(key);
      if (typeof hit === "number") {
        solidLight = hit;
      } else {
        solidLight = await coalesce<number>(`solid:${key}`, true, async () => {
          try {
            const q = await supabase.from("human_learn_profile").select("learned:bundle->shots->learned").eq("id", row.id as number).limit(1);
            const lr = ((q.data ?? []) as unknown as Array<{ learned?: unknown }>)[0];
            const n = countLearnedSolid({ shots: { learned: lr?.learned } }).solid;
            if (!q.error) {
              if (memo.size > 50) memo.clear();
              memo.set(key, n);
            }
            return n;
          } catch { return 0; }
        });
      }
    } else {
      solidLight = countLearnedSolid(row.bundle).solid;
    }
    let needsAuto = solidLight >= 30;
    try {
      const bundleAt = String(row.created_at || "");
      if (bundleAt && solidLight >= 30) {
        // ★ 2026-11-20: 新しい順 40 件だけ見ていた → 通常の検索が40件を超えると自動の記録が見えず、needs_auto が永久に残っていた。
        //   → 自動（aix／auto）の記録だけを DB で絞って見る（1件あれば十分・軽い）
        const { data: autoAfter } = await supabase
          .from("search_audits")
          .select("created_at, mode")
          .gte("created_at", bundleAt)
          .or("mode.ilike.*aix*,mode.ilike.*auto*")
          .order("created_at", { ascending: false })
          .limit(5);
        const hit = (autoAfter || []).some((a) =>
          /aix|auto|brain_aix/i.test(String(a.mode || "")),
        );
        needsAuto = !hit;
      }
    } catch { /* 監査が読めなくても solid は返す */ }
    /** ★ 2026-11-23: 手順書決まり版を light でも返す（generated_at 据え置きでも拡張が版ずれ検知できる） */
    let playbookRulesV: string | null = null;
    let playbookRulesUpTo: string | null = null;
    try {
      if (guard && lightReq && row.playbook_rules_v != null) playbookRulesV = String(row.playbook_rules_v);
      else if (row.bundle && typeof row.bundle === "object") {
        const pb = (row.bundle as { playbook?: { rules_v?: string } }).playbook;
        if (pb && pb.rules_v) playbookRulesV = String(pb.rules_v);
      }
      if (guard && lightReq) {
        if (row.playbook_rules_up_to != null) playbookRulesUpTo = String(row.playbook_rules_up_to);
      } else if (row.bundle && typeof row.bundle === "object") {
        const pb2 = (row.bundle as { playbook?: { rules_up_to?: string } }).playbook;
        if (pb2 && pb2.rules_up_to) playbookRulesUpTo = String(pb2.rules_up_to);
      }
    } catch { playbookRulesV = null; }
    return NextResponse.json({
      ok: true, empty: false, scope, light: true,
      generated_at: guard && lightReq
        ? (row.generated_at ?? row.created_at)
        : (row.bundle && typeof row.bundle === "object")
          ? ((row.bundle as Record<string, unknown>).generated_at ?? row.created_at)
          : row.created_at,
      source_rows: row.source_rows,
      read_count: row.read_count ?? 0,
      screen_solid: solidLight,
      needs_auto: needsAuto,
      bundle_at: row.created_at,
      playbook_rules_v: playbookRulesV,
      // ★ 2.8.297: 手順書を作った版と、いま動いている本番コードの版。拡張・check-playbook-sync が「本番のコードが古い」を見つける
      //   （本番が古いと、作り直しのたびに古い手順書へ戻る＝2026-11-25 22:00 の実測）。無い（古い本番）なら拡張は「本番が古い」と読む
      playbook_rules_up_to: playbookRulesUpTo,
      server_rules_v: autoRulesVersion(),
      server_rules_up_to: AUTO_RULES_REVIEWED_UP_TO,
      server_build_v: PLAYBOOK_BUILD_V,
    }, { headers: guard ? { ...CORS, ...cacheHeaders("light") } : CORS });
  }
  let why: string | null = null;
  // 守りの時: 束の作り直しは同じ所で1本だけ（重なった要求は同じ結果を待つ）。作ってから短い間（LEARN_BUILD_MIN_GAP_MS）は作り直さない
  const builtRecently = guard && !!row && Date.now() - Date.parse(String(row.created_at ?? 0)) < LEARN_BUILD_MIN_GAP_MS;
  // ★ 2026-11-20: 営業時間は古い束を拡張の呼び出しで作り直さない（最新の束を返す・作り直しは 22:20 の cron と手動の refresh=1）
  const daytimeHold = stale && holdDaytimeRebuild({ hour: jstHourNow(), hasBundle: !!row, forceFresh });
  if ((stale || forceFresh) && !daytimeHold && !(builtRecently && !forceFresh)) {
    try {
      // ★ 2026-11-20 作業員H（11/20 10:24〜10:38 の再起動の直後に時間切れ 181回・kix1 と iad1 の箱で作り直しが重なった）:
      //   coalesce はその箱の中だけ → 作り直しは DB の印（build_leases・期限つき）で全体の中で1本だけ。
      //   取れない（他の箱が作っている）・印が書けない（DB が重い）時は作らずに古い束を返す（束が無ければ空で返し、拡張は次の呼び出しで受け取る）。
      //   作り直しに失敗した時も下で古い束を返す。表が無い（migrate の前）時だけ今まで通り。止める: BUILD_LEASE=off（app/lib/build-lease.ts）
      const runBuild = (inAfter = false) => coalesce(`build:${scope}`, guard && !forceFresh, async () => {
        if (!buildLeaseOn()) return buildNow(scope, (m) => { why = m; });
        const leaseDb = supabaseLeaseDb(supabase as never);
        // 2026-11-21 作業員G（#588・LEARN_BUILD_ONE_LANE=on の時だけ）: 印を全部で1本に・応答の後なら上限つきで順番を待つ
        const key = buildLeaseKey(scope), holder = `${process.env.VERCEL_REGION ?? "local"}:${Math.random().toString(36).slice(2, 10)}`;
        let lease = await tryAcquireLease(leaseDb, key, holder, (maxDuration + 30) * 1000);
        let waitedMs = 0;
        for (let w = laneNextWait({ lease, inAfter, waitedMs }); w != null; w = laneNextWait({ lease, inAfter, waitedMs })) {
          await new Promise((r) => setTimeout(r, w));
          waitedMs += w;
          lease = await tryAcquireLease(leaseDb, key, holder, (maxDuration + 30) * 1000);
        }
        const d = buildDecision(lease, !!row);
        console.log(JSON.stringify({ tag: "human-learn-profile:build-lease", scope, lease, decision: d, ...(waitedMs ? { waitedMs, lane: key } : {}) }));
        if (d !== "build") { why = lease === "held" ? "building_elsewhere" : "build_lease_unavailable"; return null; }
        try { return await buildNow(scope, (m) => { why = m; }); }
        finally { if (lease === "acquired") await releaseLease(leaseDb, key, holder); }
      });
      // 2026-11-21 作業員G: 古い束がある時は作り直しを応答の後へ（拡張は古い束をすぐ受け取る・下の row を返す）。LEARN_BUILD_AFTER=off で今まで通り
      const later = buildInAfter({ hasBundle: !!row, forceFresh });
      if (later) {
        why = "rebuild_after_response";
        after(async () => {
          const t0 = Date.now();
          try { const b = await runBuild(true); console.log(JSON.stringify({ tag: "human-learn-profile:build-after", scope, built: !!b, ms: Date.now() - t0 })); }
          catch (e) { console.warn("[human-learn-profile] 応答の後の作り直しに失敗:", e instanceof Error ? e.message : String(e)); }
        });
      }
      const fresh = later ? null : await runBuild();
      if (fresh) {
        /**
         * ★ 2026-11-16 連携ボトルネック（read_count=0が続く）:
         *   旧は「その場で作った束」を返す時に read 印を付けていなかった。
         *   → 拡張は束を受け取っているのに DB は未読のまま → 統括が「届いていない」と誤認し続ける。
         *   → touch あり（実際に読む時）は最新行に read_at / read_count を残す。
         */
        let readCount = 0;
        let readAt: string | null = null;
        if (touch) {
          try {
            const latest = await supabase
              .from("human_learn_profile")
              .select("id, read_count")
              .eq("scope", scope)
              .order("created_at", { ascending: false })
              .limit(1);
            const lr = (latest.data ?? [])[0] as { id?: number; read_count?: number } | undefined;
            if (lr?.id != null) {
              readAt = new Date().toISOString();
              readCount = (Number(lr.read_count) || 0) + 1;
              await supabase
                .from("human_learn_profile")
                .update({ read_at: readAt, read_count: readCount })
                .eq("id", lr.id);
            }
          } catch { /* 印は残らなくても束は返す */ }
        }
        return NextResponse.json({
          ok: true, empty: false, scope, generated_now: true,
          generated_at: fresh.generated_at,
          source_rows: fresh.source.rows,
          source_from: fresh.source.from,
          source_to: fresh.source.to,
          ext_version: null,
          lines: fresh.lines,
          bundle: fresh,
          read_count: readCount,
          read_at: readAt,
          /**
           * 2026-11-13 竹内さん「学習したところはデータベースに保管されるようになっているのか」:
           *   **DBに残せたか**を返す（残せなかったら理由も）。
           */
          saved_to_db: (fresh as unknown as Record<string, unknown>).saved_to_db === true,
          save_error: (fresh as unknown as Record<string, unknown>).save_error ?? null,
          /** DB に無くて外した列（空なら全部読めた） */
          why: why ?? null,
          dropped_cols: (fresh as unknown as Record<string, unknown>).dropped_cols ?? null,
        }, { headers: CORS });
      }
    } catch (e) {
      console.warn("[human-learn-profile] その場で作れませんでした:", e instanceof Error ? e.message : String(e));
    }
  }
  if (!row) {
    /**
     * 2026-11-13: **なぜ作れなかったか**を返す（空だけ返すと原因が分からない）。
     *   画面・スクリプトから `why` を見れば、次の手が打てる。
     */
    return NextResponse.json({ ok: true, empty: true, scope, bundle: null, lines: [], why: why || "no_rows_or_build_failed" }, { headers: CORS });
  }

  let servedReadCount = Number(row.read_count) || 0;
  let servedReadAt: string | null = null;
  if (touch && guard) {
    // 守りの時: 読んだ印は前の印から10分たった時だけ・応答の後で（同じ1行への書き込みの取り合いを作らない）。
    //   拡張は realpro+itandi+all の3回 GET するので、10分以内の再読は回数を増やさない（2026-11-17 実測の水増し対策と同じ）。
    if (shouldTouchRead(row.read_at as string | null | undefined)) {
      servedReadAt = new Date().toISOString();
      servedReadCount = (Number(row.read_count) || 0) + 1;
      const markAt = servedReadAt;
      const markCount = servedReadCount;
      after(async () => {
        try { await supabase.from("human_learn_profile").update({ read_at: markAt, read_count: markCount }).eq("id", row.id as number); } catch { /* 印は残らなくてもよい */ }
      });
    } else {
      servedReadAt = typeof row.read_at === "string" ? row.read_at : null;
    }
  } else if (touch) {
    /**
     * ★ 2026-11-17: 拡張は realpro+itandi+all の3回 GET するので、無制限 +1 だと水増し。
     *   10分以内の再読は read_at だけ（回数は据え置き）。
     */
    try {
      servedReadAt = new Date().toISOString();
      const prev = Number(row.read_count) || 0;
      const prevAt = row.read_at ? Date.parse(String(row.read_at)) : 0;
      const recent = Number.isFinite(prevAt) && prevAt > 0 && Date.now() - prevAt < 10 * 60_000;
      servedReadCount = recent && prev > 0 ? prev : prev + 1;
      await supabase
        .from("human_learn_profile")
        .update({ read_at: servedReadAt, read_count: servedReadCount })
        .eq("id", row.id as number);
    } catch { /* 印は残らなくてもよい */ }
  }

  /**
   * ★ 2026-11-20 竹内さん「改善したら手順書が改善されるように」:
   *   決まり（auto-procedure-rules.ts）を直してデプロイしても、次に束を書くまで DB の手順書は古いまま拡張へ渡っていた。
   *   → 渡す時に作り方・決まりの版が古ければその場で作り直して渡す（DB は書かない・次の書き込みで揃う）。
   */
  let servedBundle = row.bundle;
  let playbookRefreshed: string | null = null;
  try {
    const { refreshPlaybookIfStale } = await import("@/app/lib/action-playbook");
    const rf = refreshPlaybookIfStale(row.bundle as Record<string, unknown> | null);
    if (rf.refreshed) { servedBundle = rf.bundle; playbookRefreshed = rf.why; }
  } catch (e) {
    console.warn("[human-learn-profile] 手順書の作り直し（渡す時）に失敗:", e instanceof Error ? e.message : String(e));
  }

  return NextResponse.json(
    {
      ok: true,
      empty: false,
      scope: row.scope,
      generated_at: (row.bundle as Record<string, unknown> | null)?.generated_at ?? row.created_at,
      source_rows: row.source_rows,
      source_from: row.source_from,
      source_to: row.source_to,
      ext_version: row.ext_version,
      lines: row.lines ?? [],
      bundle: servedBundle,
      playbook_refreshed: playbookRefreshed,
      read_count: servedReadCount,
      read_at: servedReadAt,
    },
    { headers: guard ? { ...CORS, ...cacheHeaders("bundle") } : CORS },
  );
}
