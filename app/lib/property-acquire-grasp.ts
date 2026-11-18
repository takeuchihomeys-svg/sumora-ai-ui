/**
 * 物件取得・送付済みの把握（2026-11-18 竹内さん）
 *
 *   「送付済みの物件のところで詰まってしまったのが原因なのでは」
 *   「送付済みはちゃんと送ったと把握する／取得タイミングと連携／把握する力を強化」
 *
 * ★ なぜ要るか
 *   送付済みを飛ばす＝失敗ではない。把握しないと「詰まった」と誤認し、次頁・次客へ進めない。
 *   取得開始前（fill-done/pending）と取得中（送付済スキップ）を分けて測る。
 *
 * ⚠ 純関数。
 */

export type AcquireGraspPhase =
  | "wait_fill"
  | "armed"
  | "sent_loaded"
  | "sent_marked"
  | "filter"
  | "press_start"
  | "all_sent"
  | "all_sent_page"
  | "page_done"
  | "batch_done";

export type AcquireGraspInput = {
  /** 監査 status */
  auditStatus?: string | null;
  /** search_armed / fill-done */
  searchArmed?: boolean | null;
  fillDone?: boolean | null;
  /** 物件PDF押しが始まったか */
  acquireStarted?: boolean | null;
  /** 送付済みで飛ばした件数 */
  sentSkipped?: number | null;
  /** 送付済み印を付けた件数 */
  sentMarked?: number | null;
  /** 実際に送った件数 */
  pressedSent?: number | null;
  /** 未送付として押す候補 */
  allowedN?: number | null;
  /** timings / steps に acq_ や all-filtered があるか */
  timingKeys?: string[] | null;
  stepText?: string | null;
};

export type AcquireGraspAtom = {
  id: string;
  problem: string;
  grasp_need: string;
  next: string;
  cost: "free" | "ext" | "human";
};

export type AcquireGraspReport = {
  /** HONOKA型: 取得開始前で止まったか */
  stuck_before_acquire: boolean;
  /** 送付済みで次へ進めず詰まった疑い */
  stuck_on_sent: boolean;
  /** 送付済みを把握できているか */
  sent_grasped: boolean;
  atoms: AcquireGraspAtom[];
  phases_ok: string[];
  phases_gap: string[];
  line: string;
  next_line: string;
};

function hasKey(keys: string[] | null | undefined, re: RegExp): boolean {
  return (keys || []).some((k) => re.test(String(k || "")));
}

/**
 * 物件取得の把握状態を判定する。
 */
export function buildAcquireGraspReport(inp: AcquireGraspInput): AcquireGraspReport {
  const status = String(inp.auditStatus || "");
  const armed = inp.searchArmed === true || inp.fillDone === true;
  const started = inp.acquireStarted === true;
  const skipped = Number(inp.sentSkipped) || 0;
  const marked = Number(inp.sentMarked) || 0;
  const pressed = Number(inp.pressedSent) || 0;
  const allowed = Number(inp.allowedN);
  const keys = inp.timingKeys || [];
  const joined = String(inp.stepText || "") + " " + keys.join(" ");

  const stuck_before_acquire =
    (status === "started" && !started)
    || (inp.fillDone === false && inp.searchArmed !== true && /blocked_need_fill_done|wait_fill/.test(joined))
    || (!armed && !started && status === "started");

  const stuck_on_sent =
    !stuck_before_acquire
    && (
      (/送付済|all-filtered|all_sent/.test(joined) && pressed === 0 && skipped > 0 && !/次|next|page_done|batch_done|all_sent_page/.test(joined))
      || (skipped > 0 && allowed === 0 && !hasKey(keys, /acq_all_sent|acq_page_done|auto_next_page|batch/))
    );

  const sent_grasped =
    marked > 0
    || skipped > 0
    || hasKey(keys, /acq_sent|sent_loaded|sent_marked|all_sent/)
    || /送付済み.*把握|sentMarked|送付済除外/.test(joined);

  const atoms: AcquireGraspAtom[] = [];
  const push = (a: AcquireGraspAtom) => {
    if (atoms.some((x) => x.id === a.id)) return;
    atoms.push(a);
  };

  if (stuck_before_acquire) {
    push({
      id: "before_acquire",
      problem: "物件取得が始まる前で止まっている（送付済み以前）",
      grasp_need: "search_armed / fill-done / Case C の取得タイミング把握",
      next: "検索click直前の生存印→armed→送付済読込→PDF押しの順を印で追う",
      cost: "ext",
    });
  }
  if (stuck_on_sent) {
    push({
      id: "stuck_on_sent",
      problem: "送付済み行で次へ進めず詰まっている疑い",
      grasp_need: "送付済み＝送ったと把握し、未送付／次頁／客完了へ進む",
      next: "all_sent 把握印→次頁。1件目送付済みでも2件目へ（飛ばしを数える）",
      cost: "ext",
    });
  }
  if (!sent_grasped && (started || skipped > 0 || marked > 0 || /送付/.test(joined))) {
    push({
      id: "sent_ungrasped",
      problem: "送付済みを飛ばしているが『送った』と把握した印が薄い",
      grasp_need: "sent_loaded / sent_marked / filter の把握台帳",
      next: "画面印＋DB送付済件数を把握印に残してから押す",
      cost: "ext",
    });
  }
  if (sent_grasped && skipped > 0 && pressed === 0 && !stuck_on_sent) {
    push({
      id: "all_sent_ok",
      problem: "この頁は送付済みのみ（失敗ではない）",
      grasp_need: "all_sent → 次頁 or 客完了の連携",
      next: "次頁へ進む／上限なら batch_done。0件送信を失敗と数えない",
      cost: "free",
    });
  }

  const phases_ok: string[] = [];
  const phases_gap: string[] = [];
  const check = (id: string, ok: boolean) => {
    if (ok) phases_ok.push(id);
    else phases_gap.push(id);
  };
  check("armed", armed || hasKey(keys, /acq_armed|armed/));
  check("sent_grasp", sent_grasped);
  check("filter_or_press", started || hasKey(keys, /acq_filter|acq_press|auto_pdf_start/) || pressed > 0);
  check("next_link", !stuck_on_sent && (hasKey(keys, /acq_page_done|acq_all_sent|auto_next|batch_done/) || pressed > 0 || skipped === 0));

  const line = stuck_before_acquire
    ? `物件取得把握: 開始前で停止（送付済み以前）／armed=${armed} status=${status || "?"}`
    : stuck_on_sent
      ? `物件取得把握: 送付済みで詰まり疑い skipped=${skipped} pressed=${pressed}`
      : `物件取得把握: 送付済把握${sent_grasped ? "✓" : "✗"} skipped=${skipped} pressed=${pressed} allowed=${Number.isFinite(allowed) ? allowed : "?"}`;

  const next_line = atoms[0]?.next
    || (phases_gap[0] ? `段 ${phases_gap[0]} を把握印で埋める` : "維持（取得→送付済把握→次手の連携OK）");

  return {
    stuck_before_acquire,
    stuck_on_sent,
    sent_grasped,
    atoms: atoms.slice(0, 8),
    phases_ok,
    phases_gap,
    line,
    next_line,
  };
}
