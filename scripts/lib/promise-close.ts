// scripts/lib/promise-close.ts — 約束の「完了」の側の物差し（純関数・LLM なし・DB なし）
//
// 2026-11-15 作業員L（竹内さん 11/15「約束の部分も把握や完了の部分が今弱い」）。
//   今の行動台帳（sent_facts）は、約束（confirmation_promised・pickup_declared・estimate_declared）が status=promised のまま変わらず、
//   果たした通（confirmation_reported・properties_sent・estimate_sent）は別の行で、約束の id と結び付く列が無い（11/15 の DB: 約束の行は1行も done にならない）。
//   ここでは「同じ会話で後に出た同じ種類の済みの行」を時間の順だけで結び（＝今の読み手と同じ近似）、約束→完了の時間・期日内の割合・開いたまま・重ねた約束を数える。
//   時間の順で結んだ物は「どの物件の確認か」まで合っているとは限らない（結び付きの土台が無い＝連携の地図の行 sent.promise_close）。
export const PROMISE_TO_DONE: Readonly<Record<string, string>> = { confirmation_promised: "confirmation_reported", pickup_declared: "properties_sent", estimate_declared: "estimate_sent" };
export type FactLite = { conversation_id: string | null; kind: string; status: string; sent_at: string };
export type PromiseClose = { kind: string; n: number; done: number; open: number; openOver2d: number; within24h: number; medianH: number | null; redo2d: number };

export function promiseCloseTally(facts: ReadonlyArray<FactLite>, nowMs: number): PromiseClose[] {
  const byConv = new Map<string, FactLite[]>();
  for (const f of facts) { if (!f.conversation_id) continue; const a = byConv.get(f.conversation_id) ?? []; a.push(f); byConv.set(f.conversation_id, a); }
  const acc = new Map<string, { n: number; done: number; open: number; openOver2d: number; within24h: number; hours: number[]; redo2d: number }>();
  for (const rows of byConv.values()) {
    rows.sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
    rows.forEach((p, i) => {
      const doneKind = PROMISE_TO_DONE[p.kind];
      if (p.status !== "promised" || !doneKind) return;
      const t = acc.get(p.kind) ?? { n: 0, done: 0, open: 0, openOver2d: 0, within24h: 0, hours: [], redo2d: 0 };
      t.n++;
      const at = Date.parse(p.sent_at);
      const d = rows.slice(i + 1).find((x) => x.status === "done" && x.kind === doneKind);
      if (d) { const h = (Date.parse(d.sent_at) - at) / 3_600_000; t.done++; t.hours.push(h); if (h <= 24) t.within24h++; }
      else { t.open++; if (nowMs - at > 2 * 86_400_000) t.openOver2d++; }
      if (rows.slice(i + 1).some((q) => q.kind === p.kind && q.status === "promised" && Date.parse(q.sent_at) - at < 2 * 86_400_000)) t.redo2d++;
      acc.set(p.kind, t);
    });
  }
  return [...acc.entries()].map(([kind, t]) => {
    const hs = [...t.hours].sort((a, b) => a - b);
    return { kind, n: t.n, done: t.done, open: t.open, openOver2d: t.openOver2d, within24h: t.within24h, medianH: hs.length ? Math.round(hs[Math.floor(hs.length / 2)] * 10) / 10 : null, redo2d: t.redo2d };
  });
}
export function promiseCloseLine(rows: ReadonlyArray<PromiseClose>): string {
  const s = (k: keyof PromiseClose) => rows.reduce((a, r) => a + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  return `約束の完了（30日）: 約束 ${s("n")}・果たした ${s("done")}（24時間以内 ${s("within24h")}）・開いたまま ${s("open")}（2日を過ぎた ${s("openOver2d")}）・2日以内に重ねた ${s("redo2d")}・約束の行と果たした通の結び付き 0（列が無い）`;
}
