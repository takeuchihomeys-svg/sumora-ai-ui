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
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { selectDroppingMissing } from "@/app/lib/supabase-safe-select";

export const dynamic = "force-dynamic";

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
   */
  "shot_taken", "shot_key",
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
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
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
   *   ⚠ 重くしない上限は残す（6000行・2ページ×3回の範囲）。
   */
  const MAX_ROWS = 6000;
  for (let i = 0; i < MAX_ROWS; i += 1000) {
    const sel = await selectDroppingMissing(
      SELECT.split(", "),
      (colsCsv) => fetchPage(colsCsv, i, i + 999),
      { onDrop: (c, e) => { droppedCols.push(c); console.warn("[human-learn-profile] 列が無いので外します:", c, e?.message ?? ""); } },
    );
    if (sel.error) { try { note?.("select: " + sel.error.message); } catch (_) {} return null; }
    rows.push(...((sel.data ?? []) as unknown[]));
    if (!sel.data || sel.data.length < 1000) break;
  }
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
    const since24 = new Date(Date.now() - 24 * 3600_000).toISOString();
    let aq = supabase
      .from("search_audits")
      .select("created_at, status, site, mode, area_mode, cause_key, error, severity, steps, result, ext_version")
      .gte("created_at", since24)
      .order("created_at", { ascending: false })
      .limit(300);
    if (scope && scope !== "all") aq = aq.eq("site", scope);
    const ar = await aq;
    if (!ar.error) auditsSummary = summarizeAudits((ar.data ?? []) as never, { sinceMs: 24 * 3600_000 });
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
  let improvements: { total: number; by_area: Array<{ area: string; n: number }> } | null = null;
  try {
    const { improvementSummary } = await import("@/app/lib/learn-improvements");
    const imp = await improvementSummary(1);
    if (!imp.error) improvements = { total: imp.total, by_area: imp.byArea };
  } catch (e) {
    console.warn("[human-learn-profile] 今日の強化を読めません:", e instanceof Error ? e.message : String(e));
  }
  /** 2026-11-14: 録画の記録（`human_motion_learn`）も同じ7日で見る（try の外でも使う） */
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
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
        .select("site, mode, field_order, point_fields")
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
          const names = order.length ? order : pf;
          if (names.length < 2) continue;
          /**
           * ⚠ 名前に `click:` 等の動詞が無いので、`click:` を付けて**同じ形**にする
           *   （`learnSceneFlows` が `"click:名前"` を前提にしているため）。
           *   `img` / `body` は欄ではないので**場面に入れない**（sceneOfOp が other を返す）。
           */
          runs2.push(names.slice(0, 40).map((n) => ({ k: "click:" + n, t: null, by: "human" })));
        }
        if (runs2.length) {
          const flows2 = learnSceneFlows(runs2 as never);
          /**
           * `filled.ops` から作った場面と**合わせる**（同じ場面は回数と手数を足す）。
           * ⚠ 順番は `filled.ops`（時刻つき＝正確）を優先する。
           */
          const byScene = new Map<string, import("@/app/lib/learn-flow-steps").SceneFlow>();
          for (const f of (sceneFlows ?? [])) byScene.set(f.scene, { ...f });
          for (const f of flows2) {
            const cur = byScene.get(f.scene);
            if (!cur) { byScene.set(f.scene, f); continue; }
            cur.runs += f.runs;
            cur.ops += f.ops;
            cur.raw_ops = (cur.raw_ops ?? 0) + (f.raw_ops ?? 0);
            // 順番は filled.ops の物を残す（時刻で学んだ方が正確）。無い時だけ録画の物。
            if (!cur.steps.length) cur.steps = f.steps;
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
  const since7d = new Date(Date.now() - 7 * 86400_000).toISOString();
  let commandsSummary: import("@/app/lib/learn-command-summary").CommandSummary | null = null;
  try {
    const { summarizeCommands } = await import("@/app/lib/learn-command-summary");
    const cr = await supabase
      .from("automation_commands")
      .select("created_at, picked_up_at, completed_at, status, sites, command_type, error_message")
      .gte("created_at", since7d)
      .order("created_at", { ascending: false })
      .limit(600);
    if (!cr.error) commandsSummary = summarizeCommands((cr.data ?? []) as never, { sinceMs: 7 * 86400_000 });
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
  let prevAdvice: { at: string | null; rows: number; next: number; points: number; opens: number; weak: number } | null = null;
  try {
    const { data: prevRows } = await supabase
      .from("learn_supervisor_log")
      .select("created_at, next_n, points_n, opens_n, weak_n, rows")
      .eq("scope", scope && scope !== "all" ? scope : "all")
      .order("created_at", { ascending: false })
      .limit(1);
    const p = (prevRows ?? [])[0] as Record<string, unknown> | undefined;
    if (p) {
      prevAdvice = {
        at: typeof p.created_at === "string" ? p.created_at : null,
        rows: Number(p.rows) || 0,
        next: Number(p.next_n) || 0,
        points: Number(p.points_n) || 0,
        opens: Number(p.opens_n) || 0,
        weak: Number(p.weak_n) || 0,
      };
    }
  } catch (e) {
    console.warn("[human-learn-profile] 前回の判断を読めません:", e instanceof Error ? e.message : String(e));
  }
  const bundle = compactBundle(buildHumanLearnBundle(rows as never, Date.now(), auditsSummary, commandsSummary, {
    scene_flows: sceneFlows,
    scene_missing: sceneMissing,
    scene_missing_names: sceneMissingNames,
    stopped_scene: stoppedScene,
    improvements,
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
  /**
   * 2026-11-13 竹内さん「なんで連携できていないのか」:
   *   DB に無い列があって外した時は、**外した列を返す**（黙って落とさない）。
   *   呼ぶ側が「なぜ押す順番が 0 通りなのか」をその場で分かるようにする。
   */
  const dropped = Array.from(new Set(droppedCols));
  if (dropped.length) (bundle as unknown as Record<string, unknown>).dropped_cols = dropped;
  // DB にも残す（同じ scope の古い行は消す＝いつも1つだけ）
  /**
   * 2026-11-13 竹内さん「これ学習したところはデータベースに保管されるようになっているのか。
   *   データベースを学習面でも強化していくようにする」:
   *   ⚠ 旧は `try {} catch {}` で**失敗しても黙って捨てて**いたので、保管できていなくても気づけなかった。
   *   → 失敗したら**理由を返す**（`save_error`）。呼ぶ側（私・点検）が分かるようにする。
   *   ⚠ 消してから入れるので、**入れるのに失敗すると前の束も消える**。
   *     → 先に**入れてから**、古い物を消す（消す順を逆にした）。失敗しても前の束が残る。
   */
  let saveError: string | null = null;
  let saved = false;
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

  const r = await supabase
    .from("human_learn_profile")
    .select("id, created_at, scope, source_rows, source_from, source_to, ext_version, bundle, lines, read_count")
    .eq("scope", scope)
    .order("created_at", { ascending: false })
    .limit(1);

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
  const row = (r.data ?? [])[0] as Record<string, unknown> | undefined;
  /**
   * 2026-11-13 竹内さん「連携するようにする」（学習が22:20のcron待ちで、すぐ確かめられない）:
   *   束が**無い**時と、**古い**時（前回から30分以上たっている）は、
   *   **その場で記録から作る**（cron を待たない）。作った物は DB に残すので次からは速い。
   *   ⚠ 重くしない: 直近3日・最大3000行まで。作れなければ今まで通り（空を返す）。
   */
  const stale = !row || (Date.now() - Date.parse(String(row.created_at ?? 0)) > 30 * 60 * 1000);
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
   *     ＝ **新しい学びが永久に届かない**（実測: `realpro` の束が 13:54 のまま2時間動かなかった）。
   *
   *   → **`touch=0` は「作らない」**。DBにある束の版（`generated_at`）だけ返す（1行読むだけ＝速い）。
   *     作るのは ① `fresh=1` ② touch あり（実際に読む時）③ 束が**1件も無い**時。
   *     ⚠ 束が1件も無い時は作る（拡張が「何も無い」で止まらないように）。
   */
  if (!touch && !forceFresh && row) {
    return NextResponse.json({
      ok: true, empty: false, scope, light: true,
      generated_at: (row.bundle && typeof row.bundle === "object")
        ? ((row.bundle as Record<string, unknown>).generated_at ?? row.created_at)
        : row.created_at,
      source_rows: row.source_rows,
      read_count: row.read_count ?? 0,
    }, { headers: CORS });
  }
  let why: string | null = null;
  if (stale || forceFresh) {
    try {
      const fresh = await buildNow(scope, (m) => { why = m; });
      if (fresh) {
        return NextResponse.json({
          ok: true, empty: false, scope, generated_now: true,
          generated_at: fresh.generated_at,
          source_rows: fresh.source.rows,
          source_from: fresh.source.from,
          source_to: fresh.source.to,
          ext_version: null,
          lines: fresh.lines,
          bundle: fresh,
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

  if (touch) {
    try {
      await supabase
        .from("human_learn_profile")
        .update({ read_at: new Date().toISOString(), read_count: (Number(row.read_count) || 0) + 1 })
        .eq("id", row.id as number);
    } catch { /* 印は残らなくてもよい */ }
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
      bundle: row.bundle,
    },
    { headers: CORS },
  );
}
