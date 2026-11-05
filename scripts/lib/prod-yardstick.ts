// scripts/lib/prod-yardstick.ts — 本番の記録を毎晩の物差しにする（ブレインの答え×竹内さんの最初の一手・LLM なし）。純関数だけ
//
// 2026-11-05 作業員8（竹内さんの了承の 2「本番の記録を毎晩の物差しにする（LLM なし・下がった場面だけ試験）」）:
//   audit-prod-as-exam.ts（つなぎの芯・11/04）が数える「番ごとの当たり（ブレインの道の系統＝竹内さんの最初の一手の系統）」を、
//   ①前の窓と今の窓（例: 直す前の7日／直した後）で場面ごとに比べ、はっきり下がった場面だけを出す（数が少ない場面は「待つ」）
//   ②下がった場面の試験の問題だけを流す（場面 → 問題の対応は呼ぶ側が渡す）
//   を決める。本番は brain_version ごとの番が 1〜11番と少ない（11/04）ので、版ごとではなく窓で比べる。
//   竹内さんの決定（KB P1・11/05「竹内さんの送り方は基準・絶対の正解ではない」）: 竹内さんと違っても、原則で見て良い番（答える・信頼・訴求の抜けが0）は
//   外れに数えず「超えた候補」に並べる（竹内さんの承認の後に正解へ）。原則の見方は呼ぶ側が principleOk で渡す（無ければ普通の外れ）。
//   KB: a62a4164③（本番の記録を試験に）・2acd77de（竹内さんの番）・e9d2303e（決定論を先に）

export type YardTurn = {
  scene: string | null;
  /** ブレインの道の系統（返信／確認／見積／物件／内覧…）＝ audit-prod-as-exam の aixFamily */
  brain: string;
  /** 竹内さん（か書き手）の最初の一手の系統 */
  staff: string;
  writer: string;
  /** 原則の揃い方（答える・信頼・訴求の抜けが0）。true＝竹内さんと違っても良い番の候補 */
  principleOk?: boolean | null;
  at: string;
};
export type SceneCount = { n: number; hit: number; beyond: number; miss: number };

/** 1番の扱い: 当たり／超えた候補／外れ */
export function judgeTurn(t: YardTurn): "hit" | "beyond" | "miss" {
  if (t.brain === t.staff) return "hit";
  return t.principleOk === true ? "beyond" : "miss";
}

/** 場面ごとの数え（writer を絞る時は writers に入れる・既定は竹内さん本人＝KB 41dadfe6「基準は竹内さんの番だけ」） */
export function countByScene(turns: YardTurn[], opts: { writers?: string[] } = {}): Map<string, SceneCount> {
  const ws = new Set(opts.writers ?? ["takeuchi"]);
  const m = new Map<string, SceneCount>();
  for (const t of turns) {
    if (!ws.has(t.writer)) continue;
    const k = t.scene ?? "（場面なし）";
    const v = m.get(k) ?? { n: 0, hit: 0, beyond: 0, miss: 0 };
    v.n++; v[judgeTurn(t)]++;
    m.set(k, v);
  }
  return m;
}

/** Wilson の幅（95%）。率は「当たり＋超えた候補」を良い番として数える */
export function wilson(good: number, n: number, z = 1.96): { lo: number; hi: number; p: number } {
  if (n <= 0) return { lo: 0, hi: 1, p: 0 };
  const p = good / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - w) / d), hi: Math.min(1, (c + w) / d), p };
}

export type SceneDrift = { scene: string; before: SceneCount; after: SceneCount; pBefore: number; pAfter: number; verdict: "down" | "up" | "same" | "few" };

/**
 * 前の窓と今の窓の場面ごとの比べ。はっきり下がった＝今の上の幅が前の下の幅より下（幅が重ならない）。
 *   minN（既定 5）未満の場面は few（待つ・竹内さんに聞く。従業員の番で埋めない）。
 */
export function sceneDrift(before: Map<string, SceneCount>, after: Map<string, SceneCount>, opts: { minN?: number } = {}): SceneDrift[] {
  const minN = opts.minN ?? 5;
  const out: SceneDrift[] = [];
  const empty: SceneCount = { n: 0, hit: 0, beyond: 0, miss: 0 };
  for (const s of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(s) ?? empty, a = after.get(s) ?? empty;
    const wb = wilson(b.hit + b.beyond, b.n), wa = wilson(a.hit + a.beyond, a.n);
    let verdict: SceneDrift["verdict"] = "same";
    if (b.n < minN || a.n < minN) verdict = "few";
    else if (wa.hi < wb.lo) verdict = "down";
    else if (wa.lo > wb.hi) verdict = "up";
    out.push({ scene: s, before: b, after: a, pBefore: wb.p, pAfter: wa.p, verdict });
  }
  return out.sort((x, y) => (x.verdict === "down" ? -1 : 0) - (y.verdict === "down" ? -1 : 0) || y.after.n - x.after.n);
}

/** 下がった場面の問題だけ（場面 → 問題の id は呼ぶ側が渡す）。回帰の必須（mustIds）は必ず足す */
export function problemsForDrift(drift: SceneDrift[], problemsByScene: Map<string, string[]>, mustIds: string[] = []): string[] {
  const ids = new Set(mustIds);
  for (const d of drift) if (d.verdict === "down") for (const id of problemsByScene.get(d.scene) ?? []) ids.add(id);
  return [...ids];
}

/**
 * 割れの表（統括役 11/05 了承）: 同じ番で、本番の Claude の答え（brain_decision_logs の道の系統）と試験の DeepSeek の答え（同じ番から作った問題の答案）が
 *   同じ系統か。場面ごとの一致率。一致率が低い場面は、DeepSeek の試験の悪化0を本番の Claude で信じきれない＝claudeCheckPlan の (c) に渡す。LLM なし
 */
export function modelSplitTable(pairs: Array<{ scene: string | null; claude: string; deepseek: string }>): Map<string, { n: number; agree: number; rate: number }> {
  const m = new Map<string, { n: number; agree: number; rate: number }>();
  for (const p of pairs) {
    const k = p.scene ?? "（場面なし）";
    const v = m.get(k) ?? { n: 0, agree: 0, rate: 0 };
    v.n++; if (p.claude === p.deepseek) v.agree++; v.rate = v.agree / v.n;
    m.set(k, v);
  }
  return m;
}

/** 超えた候補の一覧（竹内さんの承認待ち。承認の後に試験の正解へ） */
export function beyondCandidates(turns: YardTurn[], opts: { writers?: string[] } = {}): YardTurn[] {
  const ws = new Set(opts.writers ?? ["takeuchi"]);
  return turns.filter((t) => ws.has(t.writer) && judgeTurn(t) === "beyond");
}
