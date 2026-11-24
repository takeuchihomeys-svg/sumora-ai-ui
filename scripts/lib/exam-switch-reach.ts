// scripts/lib/exam-switch-reach.ts — 試験の組で、on にしたスイッチの材料が1問でも立ったかを出す（純関数・LLM なし・DB なし）
//
// 2026-11-23 作業員A（台帳 #648・統括役の決め）: 昨夜の ess-1122r-pickupwhy-p1/p2（PICKUP_WHY_TO_BRAIN・SIP_JUDGE）は9問とも
//   写しに送った資料の読み（sent_image_properties）が0行で、SIP_JUDGE は1度も効いていなかったのに「試験で確かめた」事になっていた。
//   結果に材料の印が無い・材料0の問題しか無い組を、試験の結果ごとに出す。
// 対応表 SWITCH_REACH: スイッチ → 効いた印（brain.material_marks の欄）・要る材料（試験の写しで入れた台帳の表＝ledger.inserted）。
//   印がまだ無いスイッチ・指示文が全問に入るスイッチは「確かめられない」と出す（答えの比べでしか見られない）。
export type SwitchReachDef = {
  /** brain.material_marks の欄（1問でも >0 なら効いた） */
  mark?: string;
  /** その印が入ったコミット（試験の HEAD がこれを含まない時は「印が入る前の版」） */
  markSince?: string;
  /** 要る材料（試験の写しで入れた表・ledger.inserted の欄）。どの問題も0行なら「材料0＝効いていない」 */
  needs?: string[];
  /** 指示文の差し替えなど全問に入る（印では見られない） */
  promptAll?: boolean;
  /** 2026-11-23: 結果の brain（meta）にこの欄があれば効いた（material_marks に印が無い部品・TURN_READ の turn_read・LATENT_FIVE の latent_five） */
  metaKey?: string;
  /** 印は同じ材料の1行の有無まで（細かい行の有無は見えない） */
  partial?: string;
  /**
   * 2026-11-25 作業員L（台帳 #684・統括役の決め「表は1本に」）: そのスイッチが直す番（本番の照らしの余地を数える所）。コードの条件で決まる物だけ・推して埋めない。
   *   turn＝お客様の番の文で決まる（下の TURN_TESTS の名前・app/lib の同じ関数で判定）／scene＝照らしの場面（line_watch_turns.scene_key）のどれか
   */
  fixes?: { turn?: TurnTestId; scene?: readonly string[] };
};
/** 番の文の判定の名前（scripts/lib/exam-room.ts が app/lib/decisions-1103 の関数で判定する） */
export type TurnTestId = "closed_thanks" | "layout_ask" | "far_other";
export const SWITCH_REACH: Record<string, SwitchReachDef> = {
  // 2026-11-24 作業員L（統括役の頼み・7晩でよく出たスイッチ）: 文書の要点（brain-core の focusDocDigestOn の段）は、主のお部屋の資料（property_pickups.image_lines）と
  //   こちらが送った資料の画像の読み取り（sent_image_properties・FOCUS_DOC_SENT_IMAGE）が材料。どちらも0行の番は「focus-doc-digest-empty」で何も足さない
  BRAIN_FOCUS_DOC_DIGEST: { needs: ["property_pickups", "sent_image_properties"] },
  // 2026-11-24 作業員L（統括役の頼み・よく出るのに表に無い5つ）: コードで材料が決まるのは PROPERTY_THREAD_PHOTO_SENT だけ。
  //   property-thread.ts の photo_sent は AIX の記録（brain-core が aix_usage_logs から引く aixLogs）の property_check_result・interior_photo の行からだけ作る＝aix_usage_logs が0行なら効かない。
  //   入れない4つ（推して埋めない）: QUOTED_IMAGE_PROPERTY_READ＝その番のお客様がこちらの画像を引用した時（messages の引用・台帳の表でない）／
  //   EQUIPMENT_WISH_LOOKUP＝お客様の文の言い方（detectEquipmentQuestion の wish）・対象はお客様の画像（messages）からも／SITUATION_TIMELINE_WIDE＝お客様の発言40通（毎番ある）／
  //   INFO_FILL_MAP＝地図の駅の埋まり（毎番プロンプトに足す）
  PROPERTY_THREAD_PHOTO_SENT: { needs: ["aix_usage_logs"] },
  PICKUP_WHY_TO_BRAIN: { mark: "pickup_why", markSince: "4b86a9d72", needs: ["property_pickups"] },
  SIP_JUDGE: { mark: "pickup_why_sip", markSince: "4b86a9d72", needs: ["sent_image_properties"] },
  EXAM_LEDGER_SIP: { needs: ["sent_image_properties"] },
  EXAM_LEDGER_CHECK_TASKS: { needs: ["line_tasks"] },
  CHECK_RESULT_STATE: { needs: ["line_tasks"] },
  SITUATION_NOW_FULFILLABLE: { mark: "now_fulfillable" },
  CONDUCTOR_TOPIC_STATE: { mark: "topic_state" },
  ACK_FORM_BRAIN: { mark: "ack_confirm" },
  ACK_CONFIRM_AIX_PATH: { mark: "ack_confirm", partial: "了承の材料の行が出た番まで（道の1行の有無は見えない）" },
  ACK_PICKUP_AIX_PATH: { mark: "ack_confirm", partial: "了承の材料の行が出た番まで（ピックアップの道の1行の有無は見えない）" },
  ACK_FORM_COUNT_WITH_AIX: { mark: "ack_confirm", partial: "了承の材料の行が出た番まで（数の1行の有無は見えない）" },
  // 2026-11-23 作業員A（統括役の頼み・N2 の数え: 昨夜 $3.82 のうち $3.42 が「効いたか分からない」回）: 今夜流すスイッチに記録だけの印（off では付かない・on でも動きは変えない）
  BRAIN_RULE6_OPEN_PROMISE: { mark: "rule6_open", markSince: "5351dc589", partial: "差し替えた⑥が指示文に入ったか（全問に同じ文＝効き目は答えの比べ）" },
  // fixes（2026-11-25 作業員L・#684）: decisions-1103 の closedThanksLine・layoutAskLine・farOtherFirstLine が1行を出す番だけ＝その番の文で決まる
  BRAIN_CLOSED_THANKS_NO_REPLY: { mark: "d1103_n15", markSince: "5351dc589", fixes: { turn: "closed_thanks" } },
  BRAIN_LAYOUT_ASK_TEMPORARY: { mark: "d1103_n17", markSince: "5351dc589", fixes: { turn: "layout_ask" } },
  BRAIN_FAR_OTHER_FIRST: { mark: "d1103_n19", markSince: "5351dc589", fixes: { turn: "far_other" } },
  BRAIN_FULFIL_TURN: { mark: "fulfil_turn", markSince: "5351dc589" },
  BRAIN_MESSAGE_PLAN: { metaKey: "message_plan" },
  OUR_PARTS_PROMISE_WIDE: { mark: "our_parts_wide", markSince: "5351dc589", partial: "交渉する・電話する の項目が状況の our_items に入った番まで" },
  INFO_FILL_MAP: { mark: "info_fill", markSince: "5351dc589" },
  EQUIPMENT_WISH_LOOKUP: { mark: "equip_wish", markSince: "5351dc589" },
  // 2026-11-23 作業員A（統括役の頼み・#662 の「持つ」が欠けた土台の部品）
  TURN_READ: { metaKey: "turn_read" },
  LATENT_FIVE: { metaKey: "latent_five" },
  CONDUCTOR_EXCHANGE_LEDGER_BRAIN: { mark: "exchange", markSince: "474e7fe63" },
  DELIVERY_CHECK: { metaKey: "delivery_check" },
};

/**
 * 2026-11-25 作業員L（統括役の決め・#683 と #684 の表を1本に）: 1つのスイッチの行を引く入口。
 *   needs・mark・metaKey・fixes は上の表（コードで決まる物）。learned は作業員A の「前の on の回から覚えた問題」（exam-learned-reach）で、
 *   置き場（A が決める）から読むまでは空で返す（＝覚えが無い＝絞らない）。
 */
export type ReachRowOf = SwitchReachDef & { sw: string; inTable: boolean; learned: ReadonlyMap<string, "none" | "hit" | "unknown"> };
export function reachRowOf(sw: string, o: { table?: Record<string, SwitchReachDef>; learned?: (sw: string) => ReadonlyMap<string, "none" | "hit" | "unknown"> | null } = {}): ReachRowOf {
  const def = (o.table ?? SWITCH_REACH)[sw];
  return { ...(def ?? {}), sw, inTable: !!def, learned: o.learned?.(sw) ?? new Map() };
}

export type ReachRow = { id: string; marks?: Record<string, number> | null; ledger?: Record<string, number> | null; /** 結果の brain（meta）に値のある欄の名前 */ metaKeys?: readonly string[] | null };
export type ReachStatus = "reached" | "not_reached" | "no_material" | "mark_after_head" | "prompt_all" | "unknown";
export const REACH_JA: Record<ReachStatus, string> = {
  reached: "効いた（印が立った問題あり）",
  not_reached: "効いていない（印の立った問題 0）",
  no_material: "効いていない（要る材料が写しに0行）",
  mark_after_head: "確かめられない（印が入る前の版で回した）",
  prompt_all: "確かめられない（指示文が全問に入る・答えの比べだけ）",
  unknown: "確かめられない（対応表に無い）",
};
export type SwitchReach = { sw: string; status: ReachStatus; problems: number; hit: string[]; withMaterial: string[]; note?: string };

/** on にしたスイッチごとの届き（rows は問題ごとに1行に寄せた物でよい・同じ id の回は OR で寄せる） */
export function switchReachOf(onSwitches: readonly string[], rows: readonly ReachRow[], headHas: (commit: string) => boolean = () => true, table: Record<string, SwitchReachDef> = SWITCH_REACH): SwitchReach[] {
  const byId = new Map<string, { marks: Record<string, number>; ledger: Record<string, number>; metaKeys: Set<string> }>();
  for (const r of rows) {
    const cur = byId.get(r.id) ?? { marks: {}, ledger: {}, metaKeys: new Set<string>() };
    for (const k of r.metaKeys ?? []) cur.metaKeys.add(k);
    for (const [k, v] of Object.entries(r.marks ?? {})) cur.marks[k] = Math.max(cur.marks[k] ?? 0, Number(v) || 0);
    for (const [k, v] of Object.entries(r.ledger ?? {})) cur.ledger[k] = Math.max(cur.ledger[k] ?? 0, Number(v) || 0);
    byId.set(r.id, cur);
  }
  const ids = [...byId.keys()];
  return onSwitches.map((sw): SwitchReach => {
    const d = table[sw];
    const base = { sw, problems: ids.length, hit: [] as string[], withMaterial: [] as string[] };
    if (!d) return { ...base, status: "unknown" };
    const withMaterial = d.needs?.length ? ids.filter((id) => d.needs!.some((t) => (byId.get(id)!.ledger[t] ?? 0) > 0)) : ids;
    if (d.needs?.length && withMaterial.length === 0) return { ...base, status: "no_material", withMaterial, note: `要る材料: ${d.needs.join("・")}` };
    if (d.promptAll) return { ...base, status: "prompt_all", withMaterial };
    if (d.metaKey && !d.mark) { const hit = ids.filter((id) => byId.get(id)!.metaKeys.has(d.metaKey!)); return { ...base, status: hit.length ? "reached" : "not_reached", hit, withMaterial, note: `印は結果の ${d.metaKey} の欄` }; }
    if (!d.mark) return { ...base, status: "reached", withMaterial, note: "材料はある（印は無い）" };
    if (d.markSince && !headHas(d.markSince)) return { ...base, status: "mark_after_head", withMaterial, note: `印 ${d.mark} は ${d.markSince} から` };
    const hit = ids.filter((id) => (byId.get(id)!.marks[d.mark!] ?? 0) > 0);
    return { ...base, status: hit.length ? "reached" : "not_reached", hit, withMaterial, note: d.partial };
  });
}

/** 結果のメタ（envFp.pairs）から on にしたスイッチ（値が on の物） */
export function onSwitchesOfMeta(meta: { envFp?: { pairs?: Record<string, string> } } | null | undefined): string[] {
  return Object.entries(meta?.envFp?.pairs ?? {}).filter(([, v]) => String(v).trim().toLowerCase() === "on").map(([k]) => k).sort();
}
