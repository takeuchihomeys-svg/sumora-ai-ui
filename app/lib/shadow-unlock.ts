// app/lib/shadow-unlock.ts
// 影の関所の当たりの表（純関数・LLM なし）— 場面×自信の組ごとに「番の数・一致・変えずに送った・影が送っていた番の当たり」を数える。
//
// 2026-11-11 作業員6（統括役の E2・3）: 自動送信は「確かな番だけ自動・残りは人へ」（project_strengthening_plan_20261111 E）。
//   場面×自信の組で、影の記録の数・変えずに送った割合を数え、どの場面のどの型が弱いかを見つける物差しにする（測るだけ）。
//   2026-11-11 竹内さんの決定「まだ今まで通りのやり方で行っていく」＝自動送信は始めない。50番・95% は物差しの目盛りで、解禁の提案や送信にはつながない。
//   今ある場面ごとの線（line-watch-daily UNLOCK: 28日・30番・一致 90%）とは別の、より厳しい物差し（変えずに送った＝文の100%一致）。
//
// 数え方:
//   n        … 判定できた番（verdict が same / same_meaning / partial / different）
//   match    … 一致（same / same_meaning）
//   asIs     … スタッフが下書きを変えずに送った番（verdict_detail.sim ≥ 0.995）。返信の道の物差し
//   shadowN  … 影の関所が「送っていた」番（auto_eligible.would_send）
//   shadowAsIs / shadowMatch … そのうち変えずに送った／一致した番＝自動で送っていたら当たっていた番
//   shadowMissing … 影の関所に材料が足りなかった番（auto_eligible.missing に ground_extra 以外がある）

export const SHADOW_UNLOCK = { minN: 50, minAsIs: 0.95, nearN: 25, nearAsIs: 0.85 } as const;

export type UnlockTurn = {
  scene_key: string | null;
  verdict: string | null;
  verdict_detail: { sim?: number | string | null; path?: string | null } | null;
  auto_eligible?: { would_send?: boolean; confidence?: { band?: string | null } | null } | null;
  final_check?: { confidence?: { band?: string | null; score?: number | null } | null } | null;
};

export type UnlockRow = {
  scene: string; band: string;
  n: number; match: number; asIs: number; simN: number;
  shadowN: number; shadowMatch: number; shadowAsIs: number;
  /** 解禁の線に届いた（影が送っていた番が 50番以上・変えずに送った 95% 以上） */
  reached: boolean;
  /** あと少し（25番以上で 85% 以上） */
  near: boolean;
  /** 線までの残り（人が読む1行） */
  remaining: string;
};

const JUDGED = new Set(["same", "same_meaning", "partial", "different"]);
const MATCH = new Set(["same", "same_meaning"]);

/** 番の自信の段。影の記録（auto_eligible.confidence）→ 控えの final_check.confidence の順。無ければ "none" */
export function bandOfTurn(t: UnlockTurn): string {
  return t.auto_eligible?.confidence?.band ?? t.final_check?.confidence?.band ?? "none";
}

const isAsIs = (t: UnlockTurn) => {
  const s = Number(t.verdict_detail?.sim);
  return Number.isFinite(s) && s >= 0.995;
};

export function shadowUnlockTable(turns: ReadonlyArray<UnlockTurn>, opt: { byBand?: boolean } = {}): UnlockRow[] {
  const by = new Map<string, UnlockRow>();
  for (const t of turns) {
    if (!t.verdict || !JUDGED.has(t.verdict)) continue;
    const scene = t.scene_key ?? "(場面なし)";
    const band = opt.byBand === false ? "all" : bandOfTurn(t);
    const k = `${scene}|${band}`;
    const r = by.get(k) ?? by.set(k, { scene, band, n: 0, match: 0, asIs: 0, simN: 0, shadowN: 0, shadowMatch: 0, shadowAsIs: 0, reached: false, near: false, remaining: "" }).get(k)!;
    const m = MATCH.has(t.verdict), a = isAsIs(t);
    r.n++; if (m) r.match++; if (a) r.asIs++;
    if (t.verdict_detail?.sim != null) r.simN++;
    if (t.auto_eligible?.would_send === true) { r.shadowN++; if (m) r.shadowMatch++; if (a) r.shadowAsIs++; }
  }
  const out = [...by.values()];
  for (const r of out) {
    const rate = r.shadowN ? r.shadowAsIs / r.shadowN : 0;
    r.reached = r.shadowN >= SHADOW_UNLOCK.minN && rate >= SHADOW_UNLOCK.minAsIs;
    r.near = !r.reached && r.shadowN >= SHADOW_UNLOCK.nearN && rate >= SHADOW_UNLOCK.nearAsIs;
    const rem: string[] = [];
    if (r.shadowN < SHADOW_UNLOCK.minN) rem.push(`あと ${SHADOW_UNLOCK.minN - r.shadowN}番`);
    if (rate < SHADOW_UNLOCK.minAsIs) rem.push(`変えずに送った ${Math.round(rate * 100)}%→95%`);
    r.remaining = r.reached ? "目盛り（50番・95%）に届いた（測るだけ）" : rem.join("・");
  }
  return out.sort((a, b) => b.shadowN - a.shadowN || b.n - a.n);
}

/** 自信の段ごとの当たり（場面をまとめる）。自信が当たる＝高い段ほど一致・変えずに送ったが高い、かを見る表 */
export function confidenceCalibration(turns: ReadonlyArray<UnlockTurn>): Array<{ band: string; n: number; matchRate: number; asIsRate: number }> {
  const rows = shadowUnlockTable(turns.map((t) => ({ ...t, scene_key: "all" })));
  return rows.map((r) => ({ band: r.band, n: r.n, matchRate: r.n ? r.match / r.n : 0, asIsRate: r.n ? r.asIs / r.n : 0 }))
    .sort((a, b) => ["high", "mid", "low", "none"].indexOf(a.band) - ["high", "mid", "low", "none"].indexOf(b.band));
}
