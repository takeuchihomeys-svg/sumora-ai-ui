// app/lib/compose-plan-watch.ts — 文の設計図と書き手に渡った注記の控え（line_watch_turns.materials.reply.compose_plan に残す要約・純関数・作業員22・2026-11-13）
//
// 統括役 11/13（点検役の文の組み立ての点検で見つかった測りの土台の穴）: 文の設計図（compose-sentence-plan）は console.info に出るだけで DB に残らず、
//   書き手に渡った注記（sentencePlanNote・renderTurnContractNote）も番ごとに後から取り出せない＝「材料が渡っていない」「渡ったが使われない」を本番で測れなかった。
//   新しい列は作らず、line_watch_turns.materials（jsonb）の reply.compose_plan に足す（line-watch-materials-server.noteWatchMaterials）。
// 残す物: 設計図の digest と行ごとの役目・何を・どうやって・次へ・どこから／書き手の注記の指紋と先頭200字（設計図・本質の帯）／handoffLeaks の結果／
//   届いたかの数（delivery-check）／値のある下の欄の名前（decided-subfields）。お客様の文は設計図の「何を」に入るので、40字までに切る。
// スイッチ: WATCH_COMPOSE_PLAN（既定 off＝何も残さない）。
type Env = Record<string, string | undefined>;
export const watchComposePlanOn = (env: Env = typeof process !== "undefined" ? process.env : {}): boolean => (env.WATCH_COMPOSE_PLAN ?? "").trim().toLowerCase() === "on";

/** 文字列の指紋（FNV-1a 32bit・16進8字）。同じ注記かを番ごとに比べるだけ */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
export type PlanRowLite = { rank: string; role: string; part?: string | null; how?: string | null; next?: string | null; from?: string | null };
export type ComposePlanWatch = {
  digest: string | null;
  rows: Array<{ rank: string; role: string; part: string | null; how: string | null; next: string | null; from: string | null }>;
  note: { plan: { fp: string; len: number; head: string } | null; contract: { fp: string; len: number; head: string } | null };
  leaks: Array<{ key: string; missing: number }>;
  delivery: { rate: string; subRate: string } | null;
  subs: string[];
};
const cut = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const noteOf = (s: string | null | undefined) => (s && s.trim() ? { fp: fingerprint(s), len: s.length, head: s.slice(0, 200) } : null);
export function composePlanWatchOf(o: {
  digest?: string | null; rows?: ReadonlyArray<PlanRowLite> | null; planNote?: string | null; contractNote?: string | null;
  leaks?: ReadonlyArray<{ key: string; missing: ReadonlyArray<string> }> | null; delivery?: { rate: string; subRate: string } | null; subs?: ReadonlyArray<string> | null;
}): ComposePlanWatch {
  return {
    digest: cut(o.digest, 200),
    rows: (o.rows ?? []).slice(0, 8).map((r) => ({ rank: r.rank, role: r.role, part: cut(r.part, 40), how: cut(r.how, 40), next: cut(r.next, 30), from: cut(r.from, 20) })),
    note: { plan: noteOf(o.planNote), contract: noteOf(o.contractNote) },
    leaks: (o.leaks ?? []).map((l) => ({ key: l.key, missing: l.missing.length })),
    delivery: o.delivery ?? null,
    subs: [...(o.subs ?? [])].slice(0, 40),
  };
}
