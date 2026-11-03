// scripts/lib/desk-shadow-core.ts — AIX の統括・相談（shadow）とスタッフの答えの一致の数え方（純関数・テストは scripts/__tests__/desk-shadow.test.ts）
export type DeskRow = {
  conversation_id: string; created_at: string; suggested_action: string | null; actual_aix_type: string | null; actual_at: string | null;
  ad?: { brain?: string | null; pick?: string | null; sb?: string | null; skip?: string } | null;
  ac?: { answer?: string | null; key?: string | null; skip?: string } | null;
};
type Bucket = { k: string; n: number; known: number; agree: number };
const btn = (key: string | null | undefined) => String(key ?? "").split("/")[0];

/** スタッフの答えが分かる＝actual_at がある（押した・押さなかったを brain-aix-eval が結んだ）。押していなければ actual_aix_type が null */
export function tallyDeskAgreement(rows: DeskRow[]): { commander: Bucket[]; consult: Bucket[] } {
  const cm = new Map<string, Bucket>(), cs = new Map<string, Bucket>();
  const add = (m: Map<string, Bucket>, k: string, known: boolean, agree: boolean) => { const b = m.get(k) ?? { k, n: 0, known: 0, agree: 0 }; b.n++; if (known) { b.known++; if (agree) b.agree++; } m.set(k, b); };
  for (const r of rows) {
    const known = !!r.actual_at;
    const pressed = r.actual_aix_type ? String(r.actual_aix_type) : null;
    if (r.ad && !r.ad.skip) {
      const sbk = r.ad.sb, pick = r.ad.pick, brain = r.ad.brain;
      if (sbk === "promise" || sbk === "not_aix") add(cm, `差し戻し ${sbk}`, known, !pressed);
      else if (pick && pick !== brain) add(cm, "違う札", known, !!pressed && pressed === btn(pick));
      else add(cm, "同じ", known, !!pressed && pressed === btn(brain));
    }
    if (r.ac && !r.ac.skip) {
      const a = String(r.ac.answer ?? "keep");
      if (a === "keep") add(cs, "keep（返信のまま）", known, !pressed);
      else if (a === "promise") add(cs, "promise", known, !pressed);
      else add(cs, "AIX の鍵", known, !!pressed && pressed === btn(r.ac.key));
    }
  }
  const sort = (m: Map<string, Bucket>) => [...m.values()].sort((a, b) => b.n - a.n);
  return { commander: sort(cm), consult: sort(cs) };
}
