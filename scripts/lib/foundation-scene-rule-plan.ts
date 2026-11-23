// scripts/lib/foundation-scene-rule-plan.ts — 土台ごとの場面の決まりの空きを、どの台本で数えるかの計画（純関数・作業員N2・2026-11-23・台帳 #505）
//   竹内さん本人の番を場面で分けて「過半数の形」を出す台本がある土台だけ流す。無い土台は「形の決め方が無い」と持ち主に返す（作ってから足す）。
export type GapRow = { id: string; name: string; owner: string; emptyScenes: string[] };
export type ScenePlan = { id: string; name: string; owner: string; scenes: string[]; cmd: string[] | null; files: string[]; why: string };

/** 土台の場面（foundation-scene-grid の鍵）→ 見張りの番の場面（line_watch_turns.scene_key・audit-ask-route-takeuchi の --kb-scenes） */
export const GRID_TO_WATCH_SCENE: Record<string, string> = {
  ack: "返信:短い了承・お礼", considering: "返信:検討中・一時保留", question: "返信:質問", conditions: "返信:条件提示",
  property_share: "返信:持ち込み物件", property_send: "AIX:property_send", cost: "AIX:cost_explain", viewing: "返信:内覧調整", apply: "AIX:application_push", // 費用・申込は返信の場面の鍵が無い（30日で0）＝AIX の場面
};

export function sceneRulePlanOf(rows: ReadonlyArray<GapRow>, o: { days: number; outDir: string }): ScenePlan[] {
  const d = `--days=${o.days}`;
  const f = (name: string) => `${o.outDir}/${name}`;
  return rows.filter((r) => r.emptyScenes.length).map((r) => {
    const base = { id: r.id, name: r.name, owner: r.owner, scenes: r.emptyScenes };
    switch (r.id) {
      case "n.asks": {
        const ws = r.emptyScenes.map((s) => GRID_TO_WATCH_SCENE[s]).filter(Boolean);
        return { ...base, cmd: ["scripts/audit-ask-route-takeuchi.ts", d, `--kb-scenes=${ws.join(",")}`, `--kb-draft=${f("n.asks.kb.json")}`], files: ["n.asks.kb.json"], why: "要件の送り方の形（作業員M）" };
      }
      case "n.appeal":
      case "n.feeling":
        return { ...base, cmd: ["scripts/audit-scene-feeling-appeal.ts", d, `--scenes=${r.emptyScenes.join(",")}`, `--kb-json=${f(`${r.id}.kb.json`)}`, `--confirm-md=${f(`${r.id}.confirm.md`)}`], files: [`${r.id}.kb.json`, `${r.id}.confirm.md`], why: "気持ち・訴求の場面ごとの形（作業員K2）" };
      case "n.chrono":
        return { ...base, cmd: ["scripts/audit-time-reply-scene.ts", d, "--max-conv=400"], files: [], why: "時の言葉への返し方（作業員L・数だけ＝案の JSON は L が作る）" };
      case "n.trust":
        return { ...base, cmd: ["scripts/audit-promise-kept.ts", d, `--out=${f("n.trust.json")}`], files: ["n.trust.json"], why: "約束を期限内に果たしたかを場面ごとに（案の JSON はまだ）" };
      default:
        return { ...base, cmd: null, files: [], why: "竹内さん本人の番を場面で分けて形を数える台本が無い（持ち主が形を決めて台本を作る）" };
    }
  });
}
