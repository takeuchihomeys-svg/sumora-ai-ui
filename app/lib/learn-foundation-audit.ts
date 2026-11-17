/**
 * 学習土台の欠落点検（2026-11-16）
 *
 * ★ 竹内さん「足りない土台／学習が整っているか／テストするたび改善／必要な仕組みを作る」:
 *   毎回の improve / weak-strengthen / Pro打合せで**同じ番号の土台**を数字で出す。
 *   推測で「整っている」と言わない。完了線と次手をセットにする。
 *
 * ⚠ DB を読む。書くのは呼び出し側（saveImprovement）が決める。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeHumanNearness, NEARNESS_ALLOW } from "./human-nearness";

export type FoundationItem = {
  id: string;
  ok: boolean;
  /** 完了線つきの現状 */
  line: string;
  /** 足りない時の次の1手 */
  next: string;
  /** 層 */
  layer: "free" | "human" | "cost" | "deploy";
};

export type FoundationAudit = {
  at: string;
  bundle_at: string | null;
  source_rows: number | null;
  screen_solid: number;
  ok_n: number;
  missing_n: number;
  items: FoundationItem[];
  /** 1行要約 */
  summary: string;
};

function countScreen(bundle: unknown): { solid: number; all: number; select: number; checkbox: number; keys: number } {
  const learned = (bundle as { shots?: { learned?: Record<string, unknown[]> } } | null)?.shots?.learned || {};
  let all = 0, solid = 0, select = 0, checkbox = 0;
  for (const list of Object.values(learned)) {
    for (const f of (Array.isArray(list) ? list : []) as Array<{ x?: number; y?: number; n?: number; kind?: string }>) {
      if (typeof f?.x === "number" && typeof f?.y === "number") {
        all++;
        if ((Number(f.n) || 0) >= 3) solid++;
      }
      const k = String(f.kind || "");
      if (k === "select") select++;
      if (k === "checkbox") checkbox++;
    }
  }
  return { keys: Object.keys(learned).length, all, solid, select, checkbox };
}

/** 本番DBから土台10本を点検する */
export async function auditLearnFoundations(
  sb: SupabaseClient,
  opt: { daysOps?: number; daysAudit?: number } = {},
): Promise<FoundationAudit> {
  const daysOps = opt.daysOps ?? 2;
  const daysAudit = opt.daysAudit ?? 3;
  const sinceOps = new Date(Date.now() - daysOps * 86400_000).toISOString();
  const sinceAudit = new Date(Date.now() - daysAudit * 86400_000).toISOString();
  const items: FoundationItem[] = [];

  const { data: prof } = await sb
    .from("human_learn_profile")
    .select("created_at, source_rows, read_count, read_at, bundle")
    .eq("scope", "all")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sc = countScreen(prof?.bundle);
  const readOk = (Number(prof?.read_count) || 0) > 0;

  items.push({
    id: "F1_screen_pos",
    ok: sc.solid >= 30,
    line: `束の画面位置 solid=${sc.solid}（完了線≥30） select=${sc.select} checkbox=${sc.checkbox}`,
    next: sc.solid >= 30 ? "本番freshで消さない（learned引き継ぎ）" : "手元 reflect で復元",
    layer: "free",
  });
  items.push({
    id: "F2_ext_read",
    ok: readOk,
    line: `拡張が束を読んだ read_count=${prof?.read_count ?? 0}`,
    next: readOk ? "自動1回へ" : "拡張再読込→ポップアップで学習再取得",
    layer: "human",
  });

  let opsN = 0, wasN = 0, csN = 0, gN = 0;
  for (let i = 0; i < 3000; i += 1000) {
    const { data } = await sb
      .from("human_motion_learn")
      .select("shot_ops")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (!data?.length) break;
    for (const r of data) {
      const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
      for (const o of ops) {
        opsN++;
        if (typeof o.was === "boolean") wasN++;
        if (typeof o.cs === "string" && o.cs) csN++;
        if (typeof o.g === "number") gN++;
      }
    }
    if (data.length < 1000) break;
  }

  items.push({
    id: "F3_toggle_was_now",
    ok: wasN > 0,
    line: `外し/選び was付き ${wasN}/${opsN}（完了線≥1・理想はcheckbox過半）`,
    next: wasN > 0 ? "比率を上げる" : "2.8.37再読込後、通常で区or間取りの外しを1回録画（was明示送信）",
    layer: "human",
  });
  items.push({
    id: "F4_hand_cs",
    ok: csN > 0,
    line: `手の形 cs付き ${csN}/${opsN}（完了線≥1）`,
    next: csN > 0 ? "維持" : "2.8.37再読込＋通常でボタン1回録画（cs明示送信）",
    layer: "human",
  });

  /** F11: 間取り・所在地・駅沿線の「label押し」原子が録画に残っているか */
  let layoutLabel = 0, cityLabel = 0, stationLike = 0;
  for (let i = 0; i < 2000; i += 1000) {
    const { data } = await sb
      .from("human_motion_learn")
      .select("shot_ops")
      .eq("mode", "normal")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (!data?.length) break;
    for (const r of data) {
      for (const o of (Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [])) {
        const f = String(o.f || "");
        if (/room_layout|間取|｜label/.test(f) && /(LDK|DK|K｜|間取|room_layout)/.test(f)) layoutLabel++;
        if (/one_city|所在地絞り込み|確定してリスト|大阪市.+区/.test(f)) cityLabel++;
        if (/station_id|route_id|one_line|沿線・駅|駅名/.test(f)) stationLike++;
      }
    }
    if ((data?.length || 0) < 1000) break;
  }
  const areaAtomsOk = layoutLabel > 0 && cityLabel > 0;
  items.push({
    id: "F11_area_toggle_atoms",
    ok: areaAtomsOk,
    line: `場所原子 間取りlabel系=${layoutLabel} 所在地系=${cityLabel} 駅沿線系=${stationLike}（完了線: 間取り+所在地≥1）`,
    next: stationLike > 0
      ? "自動で前客外し→客条件だけを1回確認"
      : "駅・沿線の通常録画を1回足す（原子が空）／自動は label押し・軸違い関所を2.8.37で強化済",
    layer: "human",
  });

  /** F12: 連続客切替のボトルネック原子（fill/batch timeout・stalled） */
  let fillTo = 0, batchTo = 0, stalledN = 0, auditN = 0;
  {
    const { data: sa } = await sb
      .from("search_audits")
      .select("cause_key,status")
      .gte("created_at", sinceAudit)
      .limit(400);
    for (const a of sa || []) {
      auditN++;
      const ck = String(a.cause_key || "").toLowerCase();
      if (/fill_timeout/.test(ck)) fillTo++;
      else if (/batch_timeout/.test(ck)) batchTo++;
      else if (/stalled/.test(ck)) stalledN++;
    }
  }
  const switchOk = fillTo + batchTo < 5 && stalledN < 20;
  items.push({
    id: "F12_continuous_switch",
    ok: switchOk,
    line: `連続切替原子 fill_timeout=${fillTo} batch_timeout=${batchTo} stalled=${stalledN}（標本${auditN}・完了線: fill+batch<5 かつ stalled<20）`,
    next: switchOk
      ? "維持・連続2客で再測"
      : "2.8.40再読込→連続2客自動（前客外し徹底／fill_timeout時のfillRunning解除）",
    layer: "human",
  });

  /** F13: 統括Proが実際に使えているか（Abort 60s が usedPro=false の主因だった） */
  let proUsedN = 0, proMissN = 0, proAbortN = 0;
  {
    const { data: logs } = await sb
      .from("learn_supervisor_log")
      .select("meeting,created_at")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(30);
    for (const row of logs || []) {
      const ev = Array.isArray((row.meeting as { evidence?: Array<{ label?: string; value?: string }> })?.evidence)
        ? (row.meeting as { evidence: Array<{ label?: string; value?: string }> }).evidence
        : [];
      // 札は「統括Pro」単独か「統括Proまとめ」（変バグ（統括Pro）は別）
      const proEv = ev.find((e) => /^(統括Pro|統括Proまとめ)$/.test(String(e.label || "").trim()));
      const v = String(proEv?.value || "");
      if (!v) continue;
      if (/未使用|exception:|aborted|TimeoutError/i.test(v)) {
        proMissN++;
        if (/aborted|TimeoutError|timeout_ms=/i.test(v)) proAbortN++;
      } else {
        proUsedN++;
      }
    }
  }
  const proOk = proAbortN === 0 && (proUsedN > 0 || proMissN === 0);
  items.push({
    id: "F13_supervisor_pro_used",
    ok: proOk,
    line: `統括Pro used≈${proUsedN} miss=${proMissN} abort/timeout=${proAbortN}（完了線: abort=0 かつ used≥1 or miss=0）`,
    next: proOk
      ? "維持"
      : "SUPERVISOR_PRO_TIMEOUT_MS=180000 反映後に scripts/supervisor-pro.ts --meet=… で再測",
    layer: "free",
  });

  /**
   * F14〜F25: 沿線・駅外しの計測土台（2026-11-17 統括Pro）
   *   Pro生:「stClearWas/lnClearWas…0→1になる計測を最優先」「via_next/cursor/line_clear が全部0で区別不能」
   */
  let stClearCursor = 0, stThenLine = 0, stReselect = 0;
  let stViaNext = 0, lineAfterSt = 0, stClearBegin = 0;
  let orderOkN = 0, orderBadN = 0, orderSample = 0;
  {
    const { data: sa2 } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of sa2 || []) {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
      const idxOf = (re: RegExp) => {
        for (let i = 0; i < joined.length; i++) if (re.test(joined[i])) return i;
        return -1;
      };
      for (const j of joined) {
        if (/station_clear_cursor/i.test(j)) stClearCursor++;
        if (/station_then_line_clear/i.test(j)) stThenLine++;
        if (/station_reselect/i.test(j)) stReselect++;
        if (/station_clear_via_next/i.test(j)) stViaNext++;
        if (/line_clear_after_station/i.test(j)) lineAfterSt++;
        if (/station_place_clear_begin/i.test(j)) stClearBegin++;
      }
      const iBegin = idxOf(/station_place_clear_begin|station_clear_via_next/);
      const iSt = idxOf(/station_clear_cursor/);
      const iBack = idxOf(/station_clear_back_line|沿線の設定へ戻る/);
      const iLn = idxOf(/line_clear_after_station|station_then_line_clear/);
      // 録画正本: via/begin → 駅外し → 沿線の設定へ戻る → 沿線外し
      if (iSt >= 0 && iLn >= 0) {
        orderSample++;
        const backOk = iBack < 0 || (iSt < iBack && iBack < iLn);
        if (iSt < iLn && (iBegin < 0 || iBegin < iSt) && backOk) orderOkN++;
        else orderBadN++;
      } else if (iBegin >= 0 && iSt >= 0) {
        orderSample++;
        if (iBegin < iSt) orderOkN++;
        else orderBadN++;
      }
    }
  }
  const clearAtomN = stClearCursor + stThenLine + stViaNext + lineAfterSt + stClearBegin;
  const clearOk = stReselect === 0 || clearAtomN > 0;
  items.push({
    id: "F14_station_clear_cursor",
    ok: clearOk && (stReselect === 0 || clearAtomN > 0),
    line: `駅外し原子 cursor=${stClearCursor} 駅→沿線=${stThenLine} via=${stViaNext} line後=${lineAfterSt} begin=${stClearBegin} reselect=${stReselect}（完了線: reselect時は外し原子≥1）`,
    next: clearOk
      ? "連続2客で station_clear_via_next → station_clear_cursor → line_clear_after_station が出るか"
      : "2.8.46再読込→続き客駅検索。外しは駅の設定へ経由（沿線直外し禁止）",
    layer: "human",
  });

  /** F23: 沿線画面からの外しは「駅の設定へ進む」経由＋録画正本「沿線の設定へ戻る」 */
  let stBackLine = 0;
  {
    const { data: saBack } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of saBack || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/station_clear_back_line|沿線の設定へ戻る/i.test(j)) stBackLine++;
      }
    }
  }
  const viaOk = stReselect === 0 || stViaNext + stClearBegin > 0 || (stClearCursor > 0 && (lineAfterSt > 0 || stBackLine > 0));
  items.push({
    id: "F23_station_clear_via_next",
    ok: viaOk,
    line: `駅外し経由 via_next=${stViaNext} begin=${stClearBegin} back(沿線の設定へ戻る)=${stBackLine}（完了線: 駅作業時は via/begin≥1 または cursor+戻る/line後）`,
    next: viaOk
      ? "維持（F24で 駅→戻る→沿線 の順）"
      : "2.8.48再読込→続き客。監査に station_clear_via_next と station_clear_back_line（沿線の設定へ戻る）",
    layer: "human",
  });

  /** F24: 順序 経由/begin → 駅外し → 沿線外し */
  const orderOk = orderSample === 0 ? false : orderBadN === 0 && orderOkN > 0;
  items.push({
    id: "F24_station_clear_order",
    ok: orderOk,
    line: `外し順 OK=${orderOkN} NG=${orderBadN} 標本=${orderSample}（完了線: 標本≥1 かつ NG=0）`,
    next: orderOk
      ? "維持"
      : orderSample === 0
        ? "2.8.46で連続駅客1回（via→駅→沿線の3原子を出す）"
        : "順序NG: 沿線を駅より先に外していないか page-script 状態機械を確認",
    layer: "human",
  });

  /** F25: 録画opsで駅/沿線の外し(was)と選び・手の形(cs)を区別できる */
  let stClearWas = 0, lnClearWas = 0, stHasWas = 0, stHasCs = 0, stOpsN = 0, lnOpsN = 0;
  {
    const { data: opsRows } = await sb
      .from("human_motion_learn")
      .select("shot_ops,mode")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .limit(120);
    for (const r of opsRows || []) {
      for (const o of (Array.isArray(r.shot_ops) ? r.shot_ops as Array<Record<string, unknown>> : [])) {
        const f = String(o.f || o.t || "");
        const cls = String(o.cls || o.c || "");
        const blob = f + " " + cls;
        const isSt = /one_station|station_id|駅/.test(blob) && !/駅の設定/.test(blob);
        const isLn = /one_line|route_id|沿線/.test(blob) && !/駅の設定/.test(blob);
        if (!isSt && !isLn) continue;
        if (isSt) {
          stOpsN++;
          if (typeof o.was === "boolean") stHasWas++;
          if (o.was === true) stClearWas++;
          if (typeof o.cs === "string" && o.cs) stHasCs++;
        }
        if (isLn) {
          lnOpsN++;
          if (o.was === true) lnClearWas++;
        }
      }
    }
  }
  const wasOk = stClearWas + lnClearWas >= 1 && stHasWas >= 1;
  items.push({
    id: "F25_station_line_ops_was",
    ok: wasOk,
    line: `駅/沿線ops外し計測 stClearWas=${stClearWas} lnClearWas=${lnClearWas} stHasWas=${stHasWas} stHasCs=${stHasCs}（stOps=${stOpsN} lnOps=${lnOpsN}・完了線: ClearWas≥1 かつ HasWas≥1）`,
    next: wasOk
      ? "維持・csも≥1へ（手の形）"
      : "API(cs/was通す)デプロイ＋2.8.46再読込→通常or自動で駅/沿線の外し1回録画（was=trueがDBに残る）",
    layer: "deploy",
  });

  /**
   * F26: 操作間隔の自然さ（2026-11-17 統括Pro「間隔の自然さを測る指標」）
   *   人間実測: p50≈1005・CV≈0.64・topShare≈10%。
   *   機械的: 同一バケット偏り大・CVが極端に低い／高い。
   */
  let gapHumanN = 0, gapAutoN = 0, gapHumanCv = 0, gapAutoCv = 0, gapAutoTopShare = 0, gapAutoP50 = 0;
  {
    const { data: gapRows } = await sb
      .from("human_motion_learn")
      .select("mode,shot_ops")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .limit(200);
    const hGaps: number[] = [];
    const aGaps: number[] = [];
    for (const r of gapRows || []) {
      const mode = String((r as { mode?: string }).mode || "");
      const isAutoMode = /aix|auto/i.test(mode);
      for (const o of (Array.isArray((r as { shot_ops?: unknown }).shot_ops)
        ? ((r as { shot_ops: Array<Record<string, unknown>> }).shot_ops)
        : [])) {
        const g = Number(o.g);
        if (!Number.isFinite(g) || g <= 0 || g >= 20000) continue;
        const by = String(o.by || "");
        const isAuto = by === "auto" || (isAutoMode && by !== "human");
        (isAuto ? aGaps : hGaps).push(g);
      }
    }
    const cvOf = (arr: number[]) => {
      if (arr.length < 5) return 0;
      const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
      if (!mean) return 0;
      const v = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
      return Math.sqrt(v) / mean;
    };
    const topShareOf = (arr: number[]) => {
      if (!arr.length) return 0;
      const b: Record<number, number> = {};
      for (const g of arr) {
        const k = Math.round(g / 50) * 50;
        b[k] = (b[k] || 0) + 1;
      }
      const top = Object.values(b).sort((x, y) => y - x)[0] || 0;
      return top / arr.length;
    };
    gapHumanN = hGaps.length;
    gapAutoN = aGaps.length;
    gapHumanCv = Math.round(cvOf(hGaps) * 100) / 100;
    gapAutoCv = Math.round(cvOf(aGaps) * 100) / 100;
    gapAutoTopShare = Math.round(topShareOf(aGaps) * 100) / 100;
    if (aGaps.length) {
      const s = aGaps.slice().sort((x, y) => x - y);
      gapAutoP50 = s[Math.floor(s.length * 0.5)] || 0;
    }
  }
  // 完了線: 自動opsがまだ無い時は人間側CVが人間らしい(0.35〜1.1)なら土台OK扱いせず「自動走行待ち」
  const gapOk =
    gapAutoN >= 30
      ? gapAutoCv >= 0.4 && gapAutoCv <= 1.2 && gapAutoTopShare <= 0.22
      : false;
  items.push({
    id: "F26_gap_humanlike",
    ok: gapOk,
    line: `間隔自然さ 自動n=${gapAutoN} CV=${gapAutoCv} p50=${gapAutoP50} topShare=${Math.round(gapAutoTopShare * 100)}%／人間n=${gapHumanN} CV=${gapHumanCv}（完了線: 自動≥30かつCV0.4〜1.2かつtop≤22%）`,
    next: gapOk
      ? "維持"
      : gapAutoN < 30
        ? "2.8.47再読込→自動1回（opsにgが残ること・API/録画経路）"
        : "sigma広め・固定レンジ禁止を確認（駅外し・retry・bulk-dl）",
    layer: "human",
  });

  /**
   * ★ 2026-11-17 統括Pro「操作種別とカーソル有無を記録する土台」:
   *   op_path_* が監査 steps に残ること。無いと直接入力の優先順位がコード推測だけになる。
   */
  let pathCursorN = 0, pathNocursorN = 0, pathRetryN = 0, pathDirectMissN = 0, pathSample = 0;
  {
    const { data: saPath } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(30);
    for (const a of saPath || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (!/op_path_/.test(j)) continue;
        pathSample++;
        if (/op_path_text_cursor|op_path_text_move|op_path_select/.test(j)) pathCursorN++;
        if (/op_path_text_nocursor|op_path_direct/.test(j)) pathNocursorN++;
        if (/op_path_retry/.test(j)) pathRetryN++;
        if (/op_path_direct_miss/.test(j)) pathDirectMissN++;
      }
    }
  }
  items.push({
    id: "F27_op_path_kind",
    ok: pathSample >= 1 && pathNocursorN <= Math.max(2, Math.floor(pathCursorN * 0.25)),
    line: `操作経路 op_path標本=${pathSample} cursor系=${pathCursorN} nocursor/direct=${pathNocursorN} retry=${pathRetryN} miss=${pathDirectMissN}（完了線: ≥1 かつ nocursor≤cursorの1/4）`,
    next: pathSample === 0
      ? "2.8.50再読込→自動1回（賃料・徒歩・テキスト入力で op_path_* が出るか）"
      : pathNocursorN > Math.max(2, Math.floor(pathCursorN * 0.25))
        ? "op_path_text_nocursor / direct_miss の欄をカーソル経路へ"
        : "維持",
    layer: "human",
  });

  /** F28: 自動opsで g<400 が多すぎないか（人間は≈1.4%、自動は実測38%） */
  let autoFastN = 0, autoGapN = 0;
  {
    for (let i = 0; i < 2000; i += 1000) {
      const { data } = await sb
        .from("human_motion_learn")
        .select("shot_ops,mode")
        .gte("created_at", sinceOps)
        .order("created_at", { ascending: false })
        .range(i, i + 999);
      if (!data?.length) break;
      for (const r of data) {
        if (!/aix|auto/i.test(String(r.mode || ""))) continue;
        for (const o of (Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [])) {
          const g = Number(o.g);
          if (!(Number.isFinite(g) && g >= 0)) continue;
          autoGapN++;
          if (g > 0 && g < 400) autoFastN++;
        }
      }
      if (data.length < 1000) break;
    }
  }
  const autoFastPct = autoGapN ? Math.round((autoFastN / autoGapN) * 1000) / 10 : 0;
  items.push({
    id: "F28_auto_gap_floor",
    ok: autoGapN >= 30 && autoFastPct <= 12,
    line: `自動短間隔 g<400 = ${autoFastN}/${autoGapN}（${autoFastPct}%・完了線≤12%・標本≥30）`,
    next: autoGapN < 30
      ? "2.8.50再読込→自動1回（ops.gが残ること）"
      : autoFastPct > 12
        ? "固定450-1000帯・humanRand下限・_uiGapMin を確認"
        : "維持",
    layer: "human",
  });

  /**
   * ★ 2026-11-17 統括Pro「近さ加重スコア＋許可線をFとして固定／束に接続」:
   *   通常 vs 自動の差分を1本で測る。許可線: 近さ≥70・短間隔≤12%・human帯≥50%。
   */
  let nearLine = "近さ未計測";
  let nearOk = false;
  {
    const normalGaps: number[] = [];
    const autoGaps: number[] = [];
    for (let i = 0; i < 2000; i += 1000) {
      const { data } = await sb
        .from("human_motion_learn")
        .select("shot_ops,mode")
        .gte("created_at", sinceOps)
        .order("created_at", { ascending: false })
        .range(i, i + 999);
      if (!data?.length) break;
      for (const r of data) {
        const m = String(r.mode || "").toLowerCase();
        const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
        for (const o of ops) {
          const g = Number(o.g);
          if (!(Number.isFinite(g) && g >= 0)) continue;
          if (m === "aix" || m === "auto") autoGaps.push(g);
          else if (m === "normal") normalGaps.push(g);
        }
      }
      if (data.length < 1000) break;
    }
    if (normalGaps.length >= 30 && autoGaps.length >= 30) {
      const n = computeHumanNearness({ normalGaps, autoGaps });
      nearOk = n.allowed;
      nearLine = n.line;
    } else {
      nearLine = `標本不足 通常g=${normalGaps.length} 自動g=${autoGaps.length}（各≥30で測る）`;
    }
  }
  items.push({
    id: "F29_human_nearness",
    ok: nearOk,
    line: nearLine,
    next: nearOk
      ? "維持・録画→束→自動→再測を週次で回す"
      : `許可線未達（近さ≥${NEARNESS_ALLOW.scoreMin}・短間隔≤${NEARNESS_ALLOW.fast400MaxPct}%・human帯≥${NEARNESS_ALLOW.humanBandMinPct}%）→ 2.8.50再読込→自動1回→ scripts/human-nearness.ts`,
    layer: "human",
  });

  /**
   * ★ 2026-11-17 統括Pro「駅を外すと選ぶを区別する土台」＋竹内さん録画:
   *   通常正本SEQ: 沿線→駅の設定へ→駅外し→沿線の設定へ戻る→沿線。
   *   監査に intent_clear/select と go_without_line（エラー防止）が残ること。
   */
  let intentClearN = 0, intentSelectN = 0, goNoLineN = 0, backLineN = 0, viaNextN = 0;
  {
    const { data: saSt } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of saSt || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/station_intent_clear|line_intent_clear/.test(j)) intentClearN++;
        if (/station_intent_select|line_intent_select/.test(j)) intentSelectN++;
        if (/station_go_without_line|station_clear_blocked_no_line/.test(j)) goNoLineN++;
        if (/station_clear_back_line|沿線の設定へ戻る/.test(j)) backLineN++;
        if (/station_clear_via_next/.test(j)) viaNextN++;
      }
    }
  }
  items.push({
    id: "F30_station_clear_vs_select",
    ok: intentClearN >= 1 && intentSelectN >= 1 && viaNextN + backLineN >= 1,
    line: `駅外し/選び区別 clear意図=${intentClearN} select意図=${intentSelectN} via=${viaNextN} back=${backLineN} 沿線無し阻止=${goNoLineN}（完了線: clear≥1 かつ select≥1 かつ via|back≥1）`,
    next: intentClearN + intentSelectN === 0
      ? "2.8.51再読込→続き客駅検索（外し→選び）。監査に station_intent_clear/select"
      : viaNextN + backLineN === 0
        ? "外しは駅の設定へ→駅外し→沿線の設定へ戻る（正本SEQ）"
        : "維持",
    layer: "human",
  });

  /**
   * ★ 2026-11-17 学習→自動の反映経路:
   *   束の station scene_flows に「駅の設定へ進む／沿線の設定へ戻る」が載っているか、
   *   自動監査に learn_reflect_ok / learn_station_flow_hit が残るか。
   */
  let stationTransitInBundle = false;
  let stationStepsN = 0;
  {
    const steps = Array.isArray(prof?.bundle?.scene_flows)
      ? (prof!.bundle as { scene_flows?: Array<{ scene?: string; steps?: string[] }> }).scene_flows || []
      : [];
    for (const f of steps) {
      if (String(f.scene || "") !== "station") continue;
      const st = Array.isArray(f.steps) ? f.steps : [];
      stationStepsN = st.length;
      if (st.some((x) => /駅の設定へ進む|沿線の設定へ戻る|one_station|one_line/.test(String(x)))) {
        stationTransitInBundle = true;
      }
    }
  }
  let reflectOkN = 0, reflectGapN = 0, stationFlowHitN = 0;
  {
    const { data: saRf } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of saRf || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/learn_reflect_ok/.test(j)) reflectOkN++;
        if (/learn_reflect_gap/.test(j)) reflectGapN++;
        if (/learn_station_flow_hit/.test(j)) stationFlowHitN++;
      }
    }
  }
  items.push({
    id: "F31_learn_reflect_station",
    ok: stationTransitInBundle && (reflectOkN + stationFlowHitN >= 1),
    line: `学習→自動反映 束station遷移=${stationTransitInBundle ? "あり" : "無し"} stepsN=${stationStepsN} reflect_ok=${reflectOkN} flow_hit=${stationFlowHitN} gap=${reflectGapN}（完了線: 束に遷移あり かつ 自動でok/hit≥1）`,
    next: !stationTransitInBundle
      ? "human-learn-profile 再生成（sceneOfOp駅遷移＋録画steps優先マージ）→拡張で束取り直し"
      : reflectOkN + stationFlowHitN === 0
        ? "2.8.53再読込→自動1回（learn_reflect_ok / learn_station_flow_hit）"
        : "維持",
    layer: "free",
  });

  /** F15: カーソル aim有比率（押した位置・人間らしさ） */
  let aimYesN = 0, aimNoN = 0;
  {
    const { data: sa3 } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(20);
    for (const a of sa3 || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (!/cursor_aim/.test(j)) continue;
        if (/aim有/.test(j)) aimYesN++;
        else if (/aim無/.test(j)) aimNoN++;
      }
    }
  }
  const aimTotal = aimYesN + aimNoN;
  const aimPct = aimTotal ? Math.round((aimYesN / aimTotal) * 100) : 0;
  items.push({
    id: "F15_cursor_aim_hit",
    ok: aimTotal === 0 ? false : aimPct >= 40,
    line: `カーソルaim aim有=${aimYesN} aim無=${aimNoN}（${aimPct}%・完了線≥40%・標本${aimTotal}）`,
    next: aimPct >= 40
      ? "維持・70%へ（束のaim読込＋2.8.43）"
      : "2.8.43再読込→ポップアップで束取得→自動1回（aim無だらけなら束未読／learn_warm確認）",
    layer: "human",
  });

  /** F16: 検索開始時に束を温めているか（aim有0の主因だった空キャッシュ） */
  let warmN = 0, warmEmpty = 0;
  {
    const { data: sa4 } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(20);
    for (const a of sa4 || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (!/learn_warm/.test(j)) continue;
        warmN++;
        if (/points=0\b/.test(j)) warmEmpty++;
      }
    }
  }
  items.push({
    id: "F16_learn_warm",
    ok: warmN > 0 && warmEmpty === 0,
    line: `束温め learn_warm=${warmN} 空束=${warmEmpty}（完了線: ≥1 かつ空=0）`,
    next: warmN === 0
      ? "2.8.43再読込→自動1回（fill先頭で learn_warm 強制）"
      : warmEmpty > 0
        ? "ポップアップで学習再取得→points>0を確認"
        : "維持",
    layer: "human",
  });

  /** F17: 自動操作に was/cs が付いているか（100%への記録土台） */
  let autoOps = 0, autoWas = 0, autoCs = 0;
  for (let i = 0; i < 2000; i += 1000) {
    const { data } = await sb
      .from("human_motion_learn")
      .select("shot_ops")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (!data?.length) break;
    for (const r of data) {
      for (const o of (Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [])) {
        if (o.by !== "auto") continue;
        autoOps++;
        if (typeof o.was === "boolean") autoWas++;
        if (typeof o.cs === "string" && o.cs) autoCs++;
      }
    }
    if (data.length < 1000) break;
  }
  const autoCsPct = autoOps ? Math.round((autoCs / autoOps) * 100) : 0;
  items.push({
    id: "F17_auto_ops_cs_was",
    ok: autoOps === 0 ? false : autoCsPct >= 50 && autoWas > 0,
    line: `自動ops cs=${autoCs}/${autoOps}(${autoCsPct}%) was=${autoWas}（完了線: cs≥50% かつ was≥1）`,
    next: autoOps === 0
      ? "2.8.43再読込→録画ONで自動1回（by=autoが残るか）"
      : autoWas === 0
        ? "外し/選び1回（CustomEvent腕上げ→was）"
        : "cs比率を上げる",
    layer: "human",
  });

  /** F18: fill途中の段が監査に残っているか（完走前停止でも none を防ぐ） */
  let progN = 0, emptyStepsN = 0, auditSample = 0;
  {
    const { data: sa5 } = await sb
      .from("search_audits")
      .select("steps,status,cause_key")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of sa5 || []) {
      auditSample++;
      const steps = Array.isArray(a.steps) ? a.steps : [];
      if (steps.length === 0) emptyStepsN++;
      for (const s of steps) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/fill_progress/.test(j)) progN++;
      }
    }
  }
  items.push({
    id: "F18_fill_progress_steps",
    ok: emptyStepsN < 15 && (progN > 0 || emptyStepsN === 0),
    line: `途中段 fill_progress=${progN} steps空=${emptyStepsN}/${auditSample}（完了線: 空<15 かつ progress≥1 or 空=0）`,
    next: progN === 0
      ? "2.8.44再読込→自動1回（途中で fill_progress が出るか）"
      : emptyStepsN >= 15
        ? "fill-done到達と progress 中継を点検"
        : "維持",
    layer: "free",
  });

  /**
   * ★ 録画から改善する民の土台（F19〜F22）
   *   自動だけ溜まっても通常の手本が無い／キーが欠ける／写真が未読だと回らない。
   */
  let norm24 = 0, normOps24 = 0, normWas24 = 0, normCs24 = 0, normHuman24 = 0, normPf24 = 0, normOpened24 = 0;
  {
    const since24 = new Date(Date.now() - 86400_000).toISOString();
    const { data: nr } = await sb
      .from("human_motion_learn")
      .select("shot_ops,point_fields,shot_key")
      .eq("mode", "normal")
      .gte("created_at", since24)
      .order("created_at", { ascending: false })
      .limit(200);
    for (const r of nr || []) {
      if (!r.shot_key) continue;
      norm24++;
      const sops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
      if (sops.length) normOps24++;
      if (r.point_fields && typeof r.point_fields === "object" && Object.keys(r.point_fields as object).length) normPf24++;
      for (const o of sops) {
        if (typeof o.was === "boolean") normWas24++;
        if (typeof o.cs === "string" && o.cs) normCs24++;
        if (o.by === "human") normHuman24++;
        if (typeof o.opened === "string" && o.opened) normOpened24++;
      }
    }
  }
  items.push({
    id: "F19_normal_recording_fresh",
    ok: norm24 >= 5 && normOps24 >= 3,
    line: `通常録画24h 画像=${norm24} shot_ops付=${normOps24}（完了線: 画像≥5 かつ ops付≥3）`,
    next: norm24 < 5
      ? "通常モードで検索1回＋録画ON（手本を足す）"
      : "リアプロタブを再読込してから録画（古いcontentだとops欠ける）",
    layer: "human",
  });
  items.push({
    id: "F20_rec_ops_keys",
    ok: (normCs24 > 0 || csN > 0) && (normWas24 > 0 || wasN > 0),
    line: `録画キー 通常cs=${normCs24} was=${normWas24} byH=${normHuman24}／全体cs=${csN} was=${wasN}（完了線: cs≥1 かつ was≥1）`,
    next: (normCs24 === 0 && csN === 0)
      ? "API(cs通す)をデプロイ＋拡張2.8.44／タブ再読込後に録画1回"
      : "通常で区or間取りの外し1回（was）",
    layer: "deploy",
  });
  items.push({
    id: "F21_rec_point_fields",
    ok: normPf24 >= 1 || sc.solid >= 30,
    line: `押す位置 point_fields付き通常24h=${normPf24}／束solid=${sc.solid}（完了線: 通常≥1 or solid≥30）`,
    next: normPf24 >= 1 || sc.solid >= 30
      ? "維持"
      : "通常モードでボタンを数回押して録画（point_fieldsが残るか）",
    layer: "human",
  });
  items.push({
    id: "F22_rec_opened_dropdown",
    ok: normOpened24 > 0,
    line: `プルダウン展開 opened付き=${normOpened24}（完了線≥1）`,
    next: normOpened24 > 0
      ? "維持"
      : "API(opened通す)デプロイ後、通常で賃料などselectを1回録画",
    layer: "deploy",
  });

  items.push({
    id: "F5_gap_ms",
    ok: opsN === 0 ? false : gN > opsN * 0.3,
    line: `操作間隔 g付き ${gN}/${opsN}`,
    next: "録画側で g を落とさない",
    layer: "free",
  });

  const { data: audits } = await sb
    .from("search_audits")
    .select("created_at, status, mode, cause_key")
    .gte("created_at", sinceAudit)
    .order("created_at", { ascending: false })
    .limit(120);
  const bundleAt = Date.parse(String(prof?.created_at || 0));
  const afterBundle = (audits || []).filter((a) => {
    const t = Date.parse(String(a.created_at));
    return t > bundleAt && /aix|auto|brain_aix/i.test(String(a.mode || ""));
  });
  items.push({
    id: "F6_auto_after_bundle",
    ok: afterBundle.length > 0,
    line: `新束のあとの自動走行 ${afterBundle.length}件（完了線≥1）`,
    next: afterBundle.length ? "効果を数字確認" : "自動/AIXで1回検索",
    layer: "human",
  });

  /**
   * ★ 2026-11-17 統括Pro＋竹内「なんで連携できていない／土台追加」:
   *   録画→束→拡張→自動反映→終わりの合図 の一連を1本の土台で測る（F32）。
   */
  {
    let stepsNonEmpty = 0, stepsSample = 0, progressDbN = 0;
    const { data: saPipe } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of saPipe || []) {
      stepsSample++;
      const st = Array.isArray(a.steps) ? a.steps : [];
      if (st.length > 0) stepsNonEmpty++;
      for (const s of st) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/fill_progress|page:learn_reflect|page:fill_begin/.test(j)) progressDbN++;
      }
    }
    const stepsRate = stepsSample > 0 ? stepsNonEmpty / stepsSample : 0;
    const { fetchBundleReflectHint, buildLinkPipeline } = await import("@/app/lib/bundle-reflect");
    const hintPipe = await fetchBundleReflectHint(sb, { scope: "all" });
    const pipe = buildLinkPipeline({
      photoInStorage: Number((prof?.bundle as { shots?: { in_storage?: number } } | null)?.shots?.in_storage) || norm24,
      withOps: opsN,
      screenSolid: sc.solid,
      screenAll: sc.select + sc.checkbox + sc.solid,
      hint: hintPipe,
      full: true,
      stationTransit: stationTransitInBundle,
      learnReflectHit: reflectOkN + stationFlowHitN >= 1,
      stepsNonEmptyRate: stepsRate,
    });
    items.push({
      id: "F32_link_pipeline",
      ok: pipe.bottleneck_n == null,
      line: `連携一連 ${pipe.line}／progress痕跡=${progressDbN}（完了線: 8段すべて✓）`,
      next: pipe.bottleneck ? `止: ${pipe.bottleneck}` : "維持",
      layer: "free",
    });
  }

  let unreadN = 0;
  {
    const { data: u } = await sb
      .from("human_motion_learn")
      .select("shot_learn")
      .eq("mode", "normal")
      .not("shot_key", "is", null)
      .gte("created_at", sinceOps)
      .limit(500);
    unreadN = (u || []).filter((r) => !r.shot_learn).length;
  }
  items.push({
    id: "F7_unread_photos",
    ok: unreadN < 50,
    line: `未学習通常写真（標本500） ${unreadN}（完了線<50）`,
    next: unreadN < 50 ? "週次で消化" : "shot-learn / weak-strengthen --yes-cost",
    layer: "cost",
  });

  const { data: cmds } = await sb
    .from("automation_commands")
    .select("status")
    .gte("created_at", sinceAudit)
    .limit(200);
  const pending = (cmds || []).filter((c) => c.status === "pending").length;
  const done = (cmds || []).filter((c) => c.status === "done").length;
  items.push({
    id: "F8_commands_flow",
    ok: pending < 10 && done > 0,
    line: `指示 pending=${pending} done=${done}（pending完了線<10）`,
    next: pending >= 10 ? "拡張を自動/AIXで稼働（滞留消化）" : "維持",
    layer: "human",
  });

  const cause: Record<string, number> = {};
  for (const a of audits || []) {
    const k = String(a.cause_key || a.status || "?");
    cause[k] = (cause[k] || 0) + 1;
  }
  const stalled = cause["stalled:realpro:none"] || 0;
  const pet = cause["condition_drift:realpro:pet:missing"] || 0;
  items.push({
    id: "F9_stalled_signal",
    ok: stalled < 10,
    line: `stalled:realpro:none=${stalled}（完了線<10）`,
    next: "終わりの合図（fill-done/steps）経路を直す",
    layer: "free",
  });
  items.push({
    id: "F10_pet_condition",
    ok: pet < 3,
    line: `pet:missing=${pet}（完了線<3）`,
    next: "ペット可の見える化→チェック→検索前検証",
    layer: "free",
  });

  /**
   * ★ 2026-11-17 統括Proを全体の脳に: Pro が毎回判断できる材料が束・ログに揃っているか。
   *   完了線: foundation_auditあり・主要Fキー≥6・統括ログ24hにPro根拠あり・vision連携行あり。
   */
  {
    const fa = (prof?.bundle as { foundation_audit?: { key?: Record<string, unknown>; summary?: string } } | null)?.foundation_audit;
    const keyN = fa?.key && typeof fa.key === "object" ? Object.keys(fa.key).length : 0;
    const hasFa = !!(fa && (fa.summary || keyN > 0));
    const { data: logRows } = await sb
      .from("learn_supervisor_log")
      .select("meeting,created_at")
      .eq("scope", "all")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(20);
    let proInLog = 0;
    for (const r of logRows || []) {
      const ev = Array.isArray((r.meeting as { evidence?: Array<{ label?: string }> } | null)?.evidence)
        ? (r.meeting as { evidence: Array<{ label?: string }> }).evidence
        : [];
      if (ev.some((e) => /統括Pro|足りない土台/.test(String(e.label || "")))) proInLog++;
    }
    const supEv = Array.isArray((prof?.bundle as { supervisor?: { meeting?: { evidence?: Array<{ label?: string }> } } } | null)?.supervisor?.meeting?.evidence)
      ? (prof!.bundle as { supervisor: { meeting: { evidence: Array<{ label?: string }> } } }).supervisor.meeting.evidence
      : [];
    const hasVision = supEv.some((e) => /画像学習→統括Pro|学習APIの役割/.test(String(e.label || "")));
    const hasMech = supEv.some((e) => /学習の仕組み/.test(String(e.label || "")));
    const okBrain = hasFa && keyN >= 6 && proInLog >= 1 && hasVision && hasMech;
    items.push({
      id: "F34_pro_brain_ready",
      ok: okBrain,
      line: `統括Pro脳材料 fa=${hasFa ? "有" : "無"} key=${keyN} ログPro=${proInLog} vision=${hasVision ? "✓" : "✗"} 仕組み=${hasMech ? "✓" : "✗"}（完了線: fa・key≥6・ログPro≥1・vision・仕組み）`,
      next: !hasFa || keyN < 6
        ? "束に foundation_audit を載せる（profile / patch）"
        : proInLog < 1
          ? "supervisor-pro --save（Pro根拠をログへ・同束でもPro新規は更新）"
          : !hasVision || !hasMech
            ? "束の統括根拠に vision / 学習の仕組み を残す"
            : "維持",
      layer: "free",
    });

    /**
     * ★ F37 2026-11-17: 統括Proが設計知見RAGで学習・決まりを引いているか
     *   完了線: 直近2日の統括ログに「統括Pro RAG」かつ件数≥1、設計知見埋め込みが現行の95%以上。
     */
    let ragHitN = 0;
    let ragOkN = 0;
    {
      const { data: logsRag } = await sb
        .from("learn_supervisor_log")
        .select("meeting")
        .gte("created_at", sinceOps)
        .order("created_at", { ascending: false })
        .limit(40);
      for (const row of logsRag || []) {
        const ev = (row.meeting as { evidence?: Array<{ label?: string; value?: string }> } | null)
          ?.evidence || [];
        for (const e of ev) {
          if (!/統括Pro RAG/.test(String(e.label || ""))) continue;
          ragHitN++;
          if (/RAG [1-9]\d*件/.test(String(e.value || ""))) ragOkN++;
        }
      }
    }
    const { count: kbCur } = await sb
      .from("system_design_thinking")
      .select("id", { count: "exact", head: true })
      .eq("is_current", true);
    const { count: kbEmb } = await sb
      .from("system_design_thinking")
      .select("id", { count: "exact", head: true })
      .eq("is_current", true)
      .not("embedding", "is", null);
    const kbN = kbCur ?? 0;
    const embN = kbEmb ?? 0;
    const embPct = kbN ? Math.round((embN / kbN) * 100) : 0;
    const okRag = ragOkN >= 1 && embPct >= 95;
    items.push({
      id: "F37_pro_rag_brain",
      ok: okRag,
      line: `統括Pro RAG引き ログRAG成功=${ragOkN}/${ragHitN} 設計知見埋め込み=${embN}/${kbN}（${embPct}%）`
        + `（完了線: ログにRAG≥1件成功・埋め込み≥95%）`,
      next: embPct < 95
        ? "scripts/kb-embed.ts で埋め込みを埋める"
        : ragOkN < 1
          ? "supervisor-pro --save（RAG配線後の判断をログへ）"
          : "維持",
      layer: "free",
    });
  }

  /**
   * ★ 2026-11-17 竹内さん「学習・改善はデータベースに入るようになっているのか」＋統括Pro:
   *   学習の**保管**（shot_learn・束solid・統括ログ）と、**自動への反映印**（F31）は別。
   *   保管が生きているかを1本の土台で測る（消える／書けない穴を見逃さない）。
   */
  {
    const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { count: shotLearnN } = await sb
      .from("human_motion_learn")
      .select("id", { count: "exact", head: true })
      .not("shot_learn", "is", null)
      .gte("created_at", since7);
    const { count: logN } = await sb
      .from("learn_supervisor_log")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceOps);
    const { data: last2 } = await sb
      .from("human_learn_profile")
      .select("created_at,bundle,source_rows")
      .eq("scope", "all")
      .order("created_at", { ascending: false })
      .limit(5);
    const solidOf = (b: unknown) => {
      const learned = (b as { shots?: { learned?: unknown } } | null)?.shots?.learned;
      let solid = 0;
      if (learned && typeof learned === "object") {
        for (const list of Object.values(learned as Record<string, unknown>)) {
          for (const f of Array.isArray(list) ? list : []) {
            const rec = f as { x?: unknown; y?: unknown; n?: unknown };
            if (typeof rec?.x === "number" && typeof rec?.y === "number" && (Number(rec.n) || 0) >= 3) solid++;
          }
        }
      }
      return solid;
    };
    const solids = (last2 || []).map((r) => solidOf(r.bundle));
    const latestSolid = solids[0] ?? 0;
    const hadSolid = solids.some((n) => n >= 30);
    const wiped = latestSolid === 0 && hadSolid && solids.slice(1).some((n) => n >= 30);
    const slN = shotLearnN ?? 0;
    const lgN = logN ?? 0;
    const okPersist = slN >= 50 && latestSolid >= 30 && lgN >= 1 && !wiped;
    items.push({
      id: "F33_learn_db_persist",
      ok: okPersist,
      line: `学習DB保管 shot_learn7日=${slN} 最新束solid=${latestSolid} 統括ログ2日=${lgN}`
        + (wiped ? " ⚠履歴にsolidありなのに最新0（消失）" : "")
        + `（完了線: shot_learn≥50・solid≥30・ログ≥1・消失なし）`,
      next: wiped
        ? "束の学習引き継ぎ（直近20件）を確認／freshで消さない"
        : latestSolid < 30
          ? "弱い強化反映 or 履歴からlearned復元"
          : slN < 50
            ? "shot-learn / weak-strengthen で通常画像を書く"
            : lgN < 1
              ? "supervisor-pro --save で統括ログを残す"
              : "維持",
      layer: wiped || latestSolid < 30 ? "free" : "cost",
    });

    /**
     * ★ F35 2026-11-17: 消す書き込みの抜け穴監視
     *   直近12件で solid≥30 → 直後 solid=0 が1回でもあれば「拒否ゲート未効／未デプロイ」。
     *   完了線: その連鎖0 かつ 最新 solid≥30（履歴に良い束がある時）。
     */
    const { data: last12 } = await sb
      .from("human_learn_profile")
      .select("bundle,created_at,source_rows")
      .eq("scope", "all")
      .order("created_at", { ascending: false })
      .limit(12);
    const solidSeq = (last12 || []).map((r) => ({
      at: String(r.created_at || ""),
      rows: Number(r.source_rows) || 0,
      solid: solidOf(r.bundle),
    }));
    let wipeEvents = 0;
    for (let i = 0; i < solidSeq.length - 1; i++) {
      // 新しい→古いの並びに注意: i が新、i+1 が旧。旧≥30 で新=0 なら消失書き込み
      if (solidSeq[i + 1].solid >= 30 && solidSeq[i].solid === 0) wipeEvents++;
    }
    const histGood = solidSeq.some((x) => x.solid >= 30);
    const okWipeGate = wipeEvents === 0 && (!histGood || (solidSeq[0]?.solid ?? 0) >= 30);
    items.push({
      id: "F35_wipe_write_gate",
      ok: okWipeGate,
      line: `消す書き込みゲート 直近消失回数=${wipeEvents} 最新solid=${solidSeq[0]?.solid ?? 0}`
        + `（完了線: 消失0・履歴良い時は最新solid≥30）`,
      next: wipeEvents > 0
        ? "learn-bundle-preserve の拒否を全書き込み経路へ／本番デプロイ確認"
        : (solidSeq[0]?.solid ?? 0) < 30 && histGood
          ? "履歴からlearned復元（tmp-restore-link-bundle）"
          : "維持",
      layer: wipeEvents > 0 || ((solidSeq[0]?.solid ?? 0) < 30 && histGood) ? "free" : "cost",
    });

    /**
     * ★ F36 2026-11-17 統括Pro「抜けが後から出る構造原因＝書き込み関所が無い」:
     *   **最新の重い再生成**が solid≥30 か preserved_learned（過去の消失束に引きずられない）。
     *   直近3件の重い違反数は参考表示。完了線: 最新が関所通過 かつ 直近消失0。
     */
    let latestHeavyOk = true;
    let latestHeavyNote = "重い再生成なし";
    let heavyBadRecent = 0;
    let heavyRecentN = 0;
    for (const row of last12 || []) {
      const rowsN = Number(row.source_rows) || 0;
      if (rowsN < 5000) continue;
      const sol = solidOf(row.bundle);
      const preserved = !!(row.bundle as { shots?: { preserved_learned?: boolean } } | null)?.shots?.preserved_learned;
      const pass = sol >= 30 || preserved;
      if (heavyRecentN === 0) {
        latestHeavyOk = pass;
        latestHeavyNote = `最新重い rows=${rowsN} solid=${sol} preserved=${preserved}`;
      }
      if (heavyRecentN < 3) {
        heavyRecentN++;
        if (!pass) heavyBadRecent++;
      }
      if (heavyRecentN >= 3) break;
    }
    const okPathGate = latestHeavyOk && wipeEvents === 0;
    items.push({
      id: "F36_write_path_gate",
      ok: okPathGate,
      line: `書き込み関所 ${latestHeavyNote} 直近重い違反=${heavyBadRecent}/${Math.max(heavyRecentN, 1)} 消失=${wipeEvents}`
        + `（完了線: 最新の重い再生成が solid≥30|preserved かつ消失0）`,
      next: !okPathGate
        ? "全insertに inheritLinkFoundations／learn-write-path-gate テスト／本番デプロイ"
        : "維持（新経路追加時は関所テストを先に通す）",
      layer: !okPathGate ? "free" : "cost",
    });
  }

  const ok_n = items.filter((x) => x.ok).length;
  const missing_n = items.length - ok_n;
  const missIds = items.filter((x) => !x.ok).map((x) => x.id.replace(/^F\d+_/, "")).slice(0, 4);
  return {
    at: new Date().toISOString(),
    bundle_at: typeof prof?.created_at === "string" ? prof.created_at : null,
    source_rows: typeof prof?.source_rows === "number" ? prof.source_rows : null,
    screen_solid: sc.solid,
    ok_n,
    missing_n,
    items,
    summary: `土台 ${ok_n}/${items.length} ✓／欠 ${missing_n}` + (missIds.length ? `（${missIds.join("・")}…）` : ""),
  };
}

/** コンソール用に整形 */
export function formatFoundationAudit(a: FoundationAudit): string[] {
  const lines = [
    `■ 学習土台 ${a.summary}`,
    `  束 ${a.bundle_at ?? "-"} rows=${a.source_rows ?? "-"} solid=${a.screen_solid}`,
  ];
  for (const f of a.items) {
    lines.push(`  ${f.ok ? "✓" : "✗"} ${f.id}: ${f.line}`);
    if (!f.ok) lines.push(`     → [${f.layer}] ${f.next}`);
  }
  return lines;
}

/**
 * ★ 2026-11-17 竹内さん「統括は土台を理解して統括できるように」:
 *   点検の全文は長いので、統括・Pro に渡す**圧縮形**にする。
 *   キー土台（近さ・駅反映・連携一連・steps）は必ず残す。
 */
export type FoundationForSupervisor = {
  ok_n: number;
  missing_n: number;
  total: number;
  summary: string;
  screen_solid: number;
  /** 欠けている土台（最大12） */
  missing: Array<{ id: string; line: string; next: string; layer: string }>;
  /** 重要土台の現状（欠けていても載せる） */
  key: Record<string, { ok: boolean; line: string }>;
};

const KEY_FOUNDATION_IDS = [
  "F29_human_nearness",
  "F30_station_clear_vs_select",
  "F31_learn_reflect_station",
  "F32_link_pipeline",
  "F33_learn_db_persist",
  "F34_pro_brain_ready",
  "F35_wipe_write_gate",
  "F36_write_path_gate",
  "F37_pro_rag_brain",
  "F6_auto_after_bundle",
  "F14_station_clear_cursor",
  "F18_fill_progress_steps",
  "F9_stalled_signal",
  "F28_auto_gap_floor",
  "F4_hand_cs",
  "F8_commands_flow",
  "F27_op_path_kind",
] as const;

export function compactFoundationForSupervisor(a: FoundationAudit): FoundationForSupervisor {
  const byId = new Map(a.items.map((i) => [i.id, i]));
  const key: FoundationForSupervisor["key"] = {};
  for (const id of KEY_FOUNDATION_IDS) {
    const it = byId.get(id);
    if (it) key[id] = { ok: it.ok, line: it.line.slice(0, 220) };
  }
  const missing = a.items
    .filter((i) => !i.ok)
    .slice(0, 12)
    .map((i) => ({
      id: i.id,
      line: i.line.slice(0, 180),
      next: i.next.slice(0, 120),
      layer: i.layer,
    }));
  return {
    ok_n: a.ok_n,
    missing_n: a.missing_n,
    total: a.items.length,
    summary: a.summary,
    screen_solid: a.screen_solid,
    missing,
    key,
  };
}
