/**
 * 新規客ごとの「思考」（決定論・LLMなし・費用0）
 *
 * 2026-11-23 統括Pro:
 *   客ごとに統括Pro(LLM)を毎回呼ぶのは、まず1客で効果を測ってから。
 *   先に質が上がる無料の思考＝場所モード・前客の外し・手順書版ずれを客ごとに決める。
 *
 * 完了線（この関数）: placeMode が決まり、forceClear* と playbookStale が理由付きで出る。
 */

export type CustomerSearchThinkInput = {
  customerId?: string | null;
  areaMode?: string | null;
  desiredArea?: string | null;
  /** 前客の番号（fill開始前に固定した物） */
  prevCid?: string | null;
  /** 前客の場所モード station|area|none */
  prevWantMode?: string | null;
  /** 自動が読んだ手順書の版 */
  playbookSeenRv?: string | null;
  /** コード／束の決まり版 */
  codePlaybookRv?: string | null;
};

export type CustomerSearchThink = {
  placeMode: "station" | "area" | "none";
  forceClearStations: boolean;
  forceClearWards: boolean;
  playbookStale: boolean;
  designatedLock: boolean;
  reasons: string[];
  summary: string;
};

function wantFromAreaMode(areaMode: string | null | undefined, desiredArea: string | null | undefined): "station" | "area" | "none" {
  const m = String(areaMode || "").toLowerCase();
  if (m === "station" || m === "stations") return "station";
  if (m === "ward" || m === "area" || m === "city") return "area";
  const d = String(desiredArea || "");
  if (/駅/.test(d) && !/[市区町村]/.test(d.replace(/駅/g, ""))) return "station";
  if (/[市区]/.test(d) || /区、|区・/.test(d)) return "area";
  if (d.trim()) return "area";
  return "none";
}

/** 純関数：このお客さんで何を優先して外す／止めるか */
export function thinkCustomerSearch(input: CustomerSearchThinkInput): CustomerSearchThink {
  const cid = String(input.customerId || "").trim();
  const placeMode = wantFromAreaMode(input.areaMode, input.desiredArea);
  const prevCid = String(input.prevCid || "").trim();
  const prevWant = String(input.prevWantMode || "").toLowerCase();
  const seen = String(input.playbookSeenRv || "").trim();
  const code = String(input.codePlaybookRv || "").trim();
  const reasons: string[] = [];

  const switched = !!(prevCid && cid && prevCid !== cid);
  const forceClearStations =
    placeMode === "area" && (switched || prevWant === "station");
  if (forceClearStations) {
    reasons.push(
      switched
        ? `前客${prevCid.slice(0, 8)}→地域：駅残を開いて外す`
        : "前客が駅モード→地域：駅残を開いて外す",
    );
  }

  const forceClearWards =
    placeMode === "station" && (switched || prevWant === "area" || prevWant === "ward");
  if (forceClearWards) {
    reasons.push(
      switched
        ? `前客${prevCid.slice(0, 8)}→駅：区・町残を外す`
        : "前客が地域→駅：区・町残を外す",
    );
  }

  const playbookStale = !!(code && seen && seen !== code);
  if (playbookStale) reasons.push(`手順書旧版 seen=${seen.slice(0, 8)}≠code=${code.slice(0, 8)}`);
  if (!seen && code) reasons.push("手順書未読（playbook_seen無し）");

  const designatedLock = !!cid;
  if (designatedLock) reasons.push(`指定客ロック cid=${cid.slice(0, 8)}`);

  /**
   * ★ 2026-11-23 竹内さん「所在地と沿線駅は並行しない・どちらか」:
   *   客ごとも入れる側を1本で言う（理解の抜け防止）。
   */
  const xorJa =
    placeMode === "area" ? "所在地だけ" : placeMode === "station" ? "沿線・駅だけ" : "場所なし";
  reasons.unshift(`入れる側=${xorJa}（並行しない・XOR）`);

  const summary =
    `客思 place=${placeMode} xor=${xorJa}` +
    (forceClearStations ? " clearSt=Y" : "") +
    (forceClearWards ? " clearWd=Y" : "") +
    (playbookStale ? " pb=stale" : seen ? " pb=ok" : " pb=?") +
    (reasons.length ? "／" + reasons.join("・") : "");

  return {
    placeMode,
    forceClearStations,
    forceClearWards,
    playbookStale,
    designatedLock,
    reasons,
    summary: summary.slice(0, 220),
  };
}
