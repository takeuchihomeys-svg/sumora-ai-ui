// app/lib/shadow-auto-reply.ts — 影の自動返信（#812・純関数・記録だけ・2026-11-27 作業員A・L の持ち物を統括役の割り振りで）
//
// 竹内さんの決定 11/12（KB 2cd3c1c1・P1）「自動返信は場面ごとに段階を踏む」: ①関所（canAutoReply）の穴を塞ぐ ②当たりの高い場面だけ影で数える
//   ③ずれがほぼ0の場面から竹内さんの判断で1つずつ自動に。自動送信は off のまま（ここは本番の送信の道に触らない）。
// 元: line_watch_turns（毎晩の見張り・shadow-auto-gate が auto_eligible＝「自動だったら送っていたか」を書く）。物差しは L の #811（delegation-index）にそろえる:
//   同じ＝見張りの verdict が same・same_meaning／危ない間違い＝下書き→スタッフの文で 金額・日時・物件・約束 が変わった（dangerOfEdit）／AIX の番＝スタッフが AIX を押した。
// ① 穴（30日・本番の見張りの 763番・2026-11-27）: 関所を通る 319 のうち スタッフが AIX を押した 84（26%）・危ない直し 91・申込以降の場面 5。
//   最終チェックの完走は見張りの行の final_check からは決められない（本物の関所は会話の ai_draft_check を読む＝影の記録が本物より甘い）

export type ShadowTurn = {
  scene: string; wouldSend: boolean; verdict: string | null; draft: string | null; staffText: string | null; staffPressedAix: boolean;
  /** 危ない間違いの種類（L の dangerOfEdit の答え・呼ぶ側が渡す） */ danger: string[];
  /** 最終チェックを完走した証拠（null＝記録から決められない） */ finalCheckOk: boolean | null;
  convStatus?: string | null;
};
const SAME = new Set(["same", "same_meaning"]);
const JUDGED = new Set(["same", "same_meaning", "partial", "different"]);
export const isPostApplyScene = (scene: string) => /^対象外:申込以降/.test(scene);

// ── ① 関所の穴 ──────────────────────────────────────────
export type GateHoles = { passed: number; staffAix: number; danger: number; dangerKinds: Record<string, number>; postApplyScene: number; finalCheckUnknown: number; different: number };
/** 関所を通る（wouldSend）のに危ない番を数える（純関数） */
export function gateHoles(turns: readonly ShadowTurn[]): GateHoles {
  const ps = turns.filter((t) => t.wouldSend);
  const dk: Record<string, number> = {};
  for (const t of ps) if (!t.staffPressedAix) for (const k of t.danger) dk[k] = (dk[k] ?? 0) + 1;
  return {
    passed: ps.length, staffAix: ps.filter((t) => t.staffPressedAix).length,
    danger: ps.filter((t) => !t.staffPressedAix && t.danger.length > 0).length, dangerKinds: dk,
    postApplyScene: ps.filter((t) => isPostApplyScene(t.scene)).length,
    finalCheckUnknown: ps.filter((t) => t.finalCheckOk !== true).length,
    different: ps.filter((t) => t.verdict === "different").length,
  };
}

/** 穴を塞ぐ案（どれも既定 off・本番の関所 canAutoReply には入れない＝案の純関数。on にするのは竹内さんの判断の後に別の改修で） */
export type GateProposalInput = { scene: string; finalCheckState?: "ok" | "missing" | "incomplete" | "stale"; allowScenes: ReadonlySet<string> };
export function proposedGateStops(i: GateProposalInput, env: Record<string, string | undefined> = {}): string[] {
  const on = (k: string) => (env[k] ?? "").trim().toLowerCase() === "on";
  const out: string[] = [];
  // 穴A: AIX の番を返信にした（ブレインは返信・スタッフは AIX）は関所で見えない＝場面の許しの一覧（影で AIX の番が0だった場面）に無ければ止める
  if (on("AUTO_GATE_SCENE_ALLOW") && !i.allowScenes.has(i.scene)) out.push("scene_not_allowed");
  // 穴B: 場面が申込以降なのに会話の status がまだ申込以降でない番（status の skip をすり抜ける）
  if (on("AUTO_GATE_POSTAPPLY_SCENE") && isPostApplyScene(i.scene)) out.push("post_apply_scene");
  // 穴C: 最終チェックの完走の証拠を渡さない呼び方（finalCheckState が無い）を missing と同じに扱う（今は undefined だと調べない）
  if (on("AUTO_GATE_REQUIRE_FC_STATE") && i.finalCheckState == null) out.push("final_check_unknown");
  return out;
}

// ── ② 場面ごとの影の数え ─────────────────────────────────
/** Wilson の下限（95%）。n=0 は null */
export function wilsonLower(k: number, n: number, z = 1.96): number | null {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n;
  return Math.round(((p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d) * 1000) / 1000;
}
export type SceneReadiness = { scene: string; n: number; judged: number; same: number; sameRate: number | null; lower: number | null; staffAix: number; danger: number; ready: boolean; why: string };
/** 11/12 の候補の条件: 判定 n≥minN・同じの下限≥lowerMin・AIX の番 0・危ない間違い 0・申込に近い場面でない */
export function sceneReadiness(turns: readonly ShadowTurn[], o: { minN?: number; lowerMin?: number } = {}): SceneReadiness[] {
  const minN = o.minN ?? 20, lowerMin = o.lowerMin ?? 0.95;
  const by = new Map<string, ShadowTurn[]>();
  for (const t of turns.filter((x) => x.wouldSend)) by.set(t.scene, [...(by.get(t.scene) ?? []), t]);
  return [...by].map(([scene, xs]) => {
    const judged = xs.filter((x) => JUDGED.has(String(x.verdict))), same = judged.filter((x) => SAME.has(String(x.verdict))).length;
    const lower = wilsonLower(same, judged.length);
    const staffAix = xs.filter((x) => x.staffPressedAix).length, danger = xs.filter((x) => !x.staffPressedAix && x.danger.length > 0).length;
    const reasons = [judged.length < minN ? `判定 ${judged.length}（${minN} から）` : "", lower != null && lower < lowerMin ? `下限 ${Math.round(lower * 1000) / 10}%（${lowerMin * 100}% から）` : "", staffAix ? `AIX の番 ${staffAix}` : "", danger ? `危ない間違い ${danger}` : "", isPostApplyScene(scene) ? "申込以降" : ""].filter(Boolean);
    return { scene, n: xs.length, judged: judged.length, same, sameRate: judged.length ? Math.round((same / judged.length) * 1000) / 10 : null, lower, staffAix, danger, ready: reasons.length === 0, why: reasons.join("・") || "候補の条件を満たす" };
  }).sort((a, b) => b.n - a.n);
}
/** 影の記録の1行（送らずに送ったつもりで残す: 送ったつもりの文・スタッフが実際に送った文・同じだったか・危ない間違い） */
export type ShadowRecord = { scene: string; would_text: string; staff_text: string | null; same: boolean | null; danger: string[]; staff_aix: boolean };
export function shadowRecordOf(t: ShadowTurn): ShadowRecord | null {
  if (!t.wouldSend || !t.draft) return null;
  return { scene: t.scene, would_text: t.draft.slice(0, 600), staff_text: t.staffText ? t.staffText.slice(0, 600) : null, same: JUDGED.has(String(t.verdict)) ? SAME.has(String(t.verdict)) : null, danger: t.danger, staff_aix: t.staffPressedAix };
}
export function shadowLines(h: GateHoles, rs: readonly SceneReadiness[]): string[] {
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
  return [
    `### 影の自動返信（#812・関所を通る ${h.passed}）`,
    `- 穴: スタッフが AIX を押した ${h.staffAix}（${pct(h.staffAix, h.passed)}）・危ない直し ${h.danger}（${Object.entries(h.dangerKinds).map(([k, v]) => `${k} ${v}`).join("・") || "—"}）・申込以降の場面 ${h.postApplyScene}・最終チェックの完走が記録から分からない ${h.finalCheckUnknown}`,
    `- 候補の場面（判定 n≥20・同じの下限≥95%・AIX の番 0・危ない間違い 0）: ${rs.filter((r) => r.ready).map((r) => r.scene).join("・") || "なし"}`,
    ...rs.slice(0, 6).map((r) => `- ${r.scene}: 通る ${r.n}・同じ ${r.same}/${r.judged}（${r.sameRate ?? "—"}%・下限 ${r.lower != null ? Math.round(r.lower * 1000) / 10 : "—"}%）→ ${r.why}`),
  ];
}
