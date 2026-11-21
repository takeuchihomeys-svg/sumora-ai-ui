// scripts/lib/field-uptake.ts — 統括が渡した欄ごとに「書き手に届いた割合」「下書きに入った割合」を数える（純関数・LLM なし・DB なし）
//
// 2026-11-21 作業員L（台帳 #466・統括役の頼み）: 本番の番の記録（line_watch_turns.materials.reply.compose_plan・WATCH_COMPOSE_PLAN）の carried
//   （設計図が運ぶ欄ごとの 値の数・注記に入らなかった数・値の語）と、その番の下書き（draft_last）を突き合わせる。
//   届いた＝その欄の値が書き手の注記に全部入った（missing=0）／入った＝値の語（valueTokens）のどれかが下書きにある（語の無い欄は「測れない」）
export type CarriedRow = { key: string; n: number; missing: number; toks: string[] };
export type TurnRec = { carried?: CarriedRow[] | null; draft?: string | null };
export type FieldTally = { key: string; turns: number; delivered: number; inDraft: number; measurable: number };

const sq = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s、。・「」（）()／/：:→＝！!？?,]/g, "");

export function tallyFieldUptake(turns: ReadonlyArray<TurnRec>): FieldTally[] {
  const m = new Map<string, FieldTally>();
  for (const t of turns) {
    const d = sq(t.draft ?? "");
    for (const c of t.carried ?? []) {
      const f = m.get(c.key) ?? { key: c.key, turns: 0, delivered: 0, inDraft: 0, measurable: 0 };
      f.turns++;
      if (c.missing === 0) f.delivered++;
      const toks = (c.toks ?? []).map(sq).filter((x) => x.length >= 2);
      if (toks.length && d) { f.measurable++; if (toks.some((x) => d.includes(x))) f.inDraft++; }
      m.set(c.key, f);
    }
  }
  return [...m.values()].sort((a, b) => b.turns - a.turns);
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
export function formatFieldUptake(rows: ReadonlyArray<FieldTally>, n: number): string {
  const L = [`統括→書き手の欄ごと（番 ${n}）: 欄・値のある番・書き手に届いた・下書きに入った（測れた番のうち）`];
  for (const r of rows) L.push(`${r.key.padEnd(28)} ${String(r.turns).padStart(3)}番 → 届いた ${r.delivered}（${pct(r.delivered, r.turns)}） → 入った ${r.inDraft}/${r.measurable}（${pct(r.inDraft, r.measurable)}）`);
  return L.join("\n");
}
