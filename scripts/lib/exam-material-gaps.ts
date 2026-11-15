// scripts/lib/exam-material-gaps.ts — 試験の外れの番ごとに「どの材料の欄が無かった／食い違ったか」を答案の記録だけで出す（純関数・LLM なし）
//
// 2026-11-15 作業員I（竹内さん 11/15「実際のブレインに質の高いデータを渡せるように」・統括役の頼み）:
//   外れの切り分け（exam-miss-stage）は「どの段で道が変わったか」だけを弱い所の台帳に入れていた。本番の材料を直すには、その番で
//   ① 台帳の写しが問題の時点の行より少なかった（材料が試験に届いていない＝試験の道具の穴か、本番でも届かない材料か）
//   ② ブレインの依頼の答えの出所が無い・推測（basis が none／guess）＝本番でも材料の欄が無い
//   ③ 前と今で最初に入力が違った LLM の呼び出し（inputDiff.firstChanged）＝直した所がどの材料を変えたか
//   を札で残す（お客様の文・名前は入れない＝依頼の種類と話題の札・表の名前と数だけ）。
// テスト: scripts/lib/__tests__/exam-material-gaps.test.ts

export type GapRow = {
  id: string;
  ledger?: { inserted?: Record<string, number>; errors?: unknown[] } | null;
  brain?: { turn_contract?: { asks?: Array<{ kind?: unknown; about?: unknown; basis?: unknown; route?: unknown }> } | null } | null;
  inputDiff?: { firstChanged?: string | null } | null;
};
export type GapProblem = { id: string; ledger?: Record<string, unknown[]> | null };

const NO_BASIS = new Set(["none", "guess", "unknown", "assumption", "推測"]);

/** 1つの問題の回（rows）と問題の写し（problem）から、材料の欄の穴の札（重ねない・多い順） */
export function materialGapsOf(rows: ReadonlyArray<GapRow>, problem: GapProblem | null | undefined): string[] {
  const c = new Map<string, number>();
  const add = (k: string) => c.set(k, (c.get(k) ?? 0) + 1);
  for (const r of rows) {
    const want = problem?.ledger ?? {};
    const have = r.ledger?.inserted ?? {};
    for (const [t, rowsOfT] of Object.entries(want)) {
      const w = Array.isArray(rowsOfT) ? rowsOfT.length : 0;
      const h = Number(have[t] ?? 0);
      if (w > 0 && h < w) add(`台帳の写しが足りない: ${t} ${h}/${w}`);
    }
    if ((r.ledger?.errors?.length ?? 0) > 0) add(`台帳の写しの失敗 ${r.ledger!.errors!.length}件`);
    for (const a of r.brain?.turn_contract?.asks ?? []) {
      const b = String(a.basis ?? "").trim().toLowerCase();
      if (String(a.route ?? "") === "none") continue;
      if (!b || NO_BASIS.has(b)) add(`答えの出所が無い: ${String(a.kind ?? "?")}・${String(a.about ?? "?")}${b ? `（${b}）` : ""}`);
    }
    if (r.inputDiff?.firstChanged) add(`前と今で最初に入力が違った呼び出し: ${r.inputDiff.firstChanged}`);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (rows.length > 1 ? `${k}（${n}/${rows.length}回）` : k)).slice(0, 8);
}
