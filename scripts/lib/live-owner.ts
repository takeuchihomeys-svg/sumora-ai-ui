// scripts/lib/live-owner.ts — 持ち主の名前を今いる作業員に読み替える表（純関数・1か所・作業員N2・2026-11-22・統括役の頼み）
//
// 統括役 11/22 朝（毎朝の1枚から）: 直しの候補の持ち主が、連携の地図（app/lib/linkage-map.ts）などの昔の名前（作業員1・作業員K・作業員9 など）のままで出ていた。
//   読み替え: 統括役の決め（作業員K → 作業員K2・作業員1／4／7／25 → 作業員L）。それ以外のもういない作業員は、行の段（read・writer・tool_rank など）の持ち主
//   （owner-feedback-check の STAGE_OWNER と同じ割り振り）に、それも無ければ統括役へ。今いる作業員の名前はそのまま。
//   作業員が増えた・減った時はここ（LIVE_WORKERS・OLD_WORKER_TO_LIVE）だけを直す。

/** 今いる作業員（2026-11-22 統括役の分担） */
// 2026-11-23 統括役の分担（4人体制）
export const LIVE_WORKERS: readonly string[] = ["作業員P", "作業員A", "作業員L", "作業員N2"];

/** もういない作業員 → 今の作業員（統括役の決め 11/22） */
export const OLD_WORKER_TO_LIVE: Readonly<Record<string, string>> = {
  // 2026-11-23 統括役の決め（4人体制の付け替え）: K2→P・M→A・H→N2・G→L・N→N2・R→A・K→P
  作業員K: "作業員P", 作業員K2: "作業員P", 作業員M: "作業員A", 作業員H: "作業員N2", 作業員G: "作業員L", 作業員N: "作業員N2", 作業員R: "作業員A",
  作業員1: "作業員L", 作業員4: "作業員L", 作業員7: "作業員L", 作業員25: "作業員L",
};

/** 連携の地図の段 → 持ち主（owner-feedback-check.STAGE_OWNER と同じ・ここを元にする） */
export const STAGE_TO_LIVE: Readonly<Record<string, string>> = {
  in: "作業員L", read: "作業員L", sent: "作業員L", next: "作業員L", bridge: "作業員L",
  // 2026-11-23: 段の持ち主も付け替え先に（M→A・H→N2・K2→P）
  writer: "作業員A", conductor: "作業員A", staff: "作業員A", check: "作業員N2", tool_cond: "作業員P", tool_rank: "作業員P", tool_api: "作業員P", tool_react: "作業員P",
};

/**
 * 持ち主を今いる作業員1人に（純関数）。
 * @param owner 名前（「作業員L・作業員H」のように複数でもよい・括弧の注記は無視）か段の鍵
 * @param id 行の id（「read.facts」なら段 read）。名前で決まらない時に段で決める
 */
export function currentOwnerOf(owner: string | null | undefined, id?: string | null): string {
  const raw = String(owner ?? "").trim();
  if (STAGE_TO_LIVE[raw]) return STAGE_TO_LIVE[raw];
  const names = raw.replace(/（[^）]*）/g, "").split(/[・,、\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    const m = OLD_WORKER_TO_LIVE[n] ?? n;
    if (LIVE_WORKERS.includes(m)) return m;
  }
  if (raw === "統括役" || names.includes("統括役")) return "統括役";
  const stage = String(id ?? "").split(".")[0];
  if (STAGE_TO_LIVE[stage]) return STAGE_TO_LIVE[stage];
  return "統括役";
}
