// app/lib/conductor-turn-vectors.ts — 入口の統括の「近い過去の番」の表（conductor_turn_vectors）の1行の作り方（⑤(a)・作業員1・11/04・純関数）
//   設計: 作業員2 conductor-brain-shape.md 追記2（KB P1 641c85f3「ベクトルで近い過去の番の当たりで重み」）。基準は竹内さんの番だけ（KB 41dadfe6）。
//   状況の文は、再生の試験の材料（scripts/conductor-intake-replay-build.ts）と同じ材料・同じ伏せ（compose-name-mask＋maskPII は呼ぶ側）で作る＝試験と本番で同じ文。
//   中身: 場面・段階・伏せた今の番のお客様の発言（120字まで）・直前のこちらの送信の種類（AIX の種類／返信）。会話の文はここで切るだけで、倉庫（git）には載せない。

export const SITUATION_CUSTOMER_MAX = 120;
/** 申込の書類の手前まで（replay-build と同じ線）。この語が出た番は表に入れない */
export const APPLY_DOCS_RE = /(申込(?:書|フォーマット)|本人確認書類|免許証|マイナンバー|源泉徴収|給与明細|生年月日|勤務先)/;

/** 状況の文（埋め込む文）。伏せは呼ぶ側で済ませた文を渡す */
export function turnSituationText(o: { scene: string | null; stage: string | null; customerMasked: string; lastStaffKind: string | null }): string {
  const cust = o.customerMasked.replace(/\s+/g, " ").trim().slice(0, SITUATION_CUSTOMER_MAX);
  return [
    `場面: ${o.scene || "不明"}`,
    `段階: ${o.stage || "不明"}`,
    `直前のこちら: ${o.lastStaffKind || "なし"}`,
    `お客様: ${cust}`,
  ].join("\n");
}

/** こちらの一手（正解）: AIX の種類（あれば）か返信 */
export type TurnActual = { route: "aix" | "reply"; aix: string | null; picker: string | null };
export function actualOf(o: { isAix: boolean; aixType: string | null; checkPattern: string | null }): TurnActual {
  return o.isAix ? { route: "aix", aix: o.aixType ?? "aix_unknown", picker: o.checkPattern ?? null } : { route: "reply", aix: null, picker: null };
}

/** ブレインごとに合ったか（見張りの番がある時だけ・無ければ {}）。judge＝道・aix＝AIX の種類 */
export function hitsOf(actual: TurnActual, watch: { brainMode: string | null; brainAction: string | null } | null): Record<string, boolean> {
  if (!watch) return {};
  const brainAix = watch.brainMode === "aix" && !!watch.brainAction;
  const out: Record<string, boolean> = { judge: brainAix === (actual.route === "aix") };
  if (brainAix && actual.route === "aix") out.aix = watch.brainAction === actual.aix;
  return out;
}

/** 表の1行（埋め込みは呼ぶ側で足す） */
export type TurnVectorRow = {
  source_key: string; source: "messages" | "watch"; conversation_id: string; property_customer_id: string | null;
  scene: string; stage: string | null; situation: string; fp: string[]; actual: TurnActual; hits: Record<string, boolean>;
  writer: "takeuchi" | "employee" | "unknown"; turn_at: string;
};
export function turnVectorRow(o: {
  sendId: string; conversationId: string; propertyCustomerId: string | null; scene: string | null; stage: string | null;
  customerMasked: string; lastStaffKind: string | null; fp: string[]; actual: TurnActual; hits: Record<string, boolean>;
  writer: string | null; turnAt: string;
}): TurnVectorRow {
  return {
    source_key: `msg:${o.sendId}`, source: "messages", conversation_id: o.conversationId, property_customer_id: o.propertyCustomerId,
    scene: o.scene || "不明", stage: o.stage, situation: turnSituationText(o), fp: o.fp, actual: o.actual, hits: o.hits,
    writer: o.writer === "takeuchi" ? "takeuchi" : o.writer === "employee" ? "employee" : "unknown", turn_at: o.turnAt,
  };
}

/** 2026-11-04 統括役（竹内さんに「今夜から埋め始める」）: 既定 on（表を埋めるだけ・読む側はまだ無い・夜 01:50 だけ・約 $0.01/日）。=off で止める */
export const conductorTurnVectorsOn = (env: Record<string, string | undefined> = process.env) => (env.CONDUCTOR_TURN_VECTORS ?? "").trim().toLowerCase() !== "off";
