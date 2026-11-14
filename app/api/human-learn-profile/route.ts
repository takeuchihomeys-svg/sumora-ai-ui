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
  const bundle = compactBundle(buildHumanLearnBundle(rows as never));
  if (!bundle.source.rows) { try { note?.("empty_bundle"); } catch (_) {} return null; }
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
