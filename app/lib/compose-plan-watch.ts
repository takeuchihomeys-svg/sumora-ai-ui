// app/lib/compose-plan-watch.ts — 文の設計図と書き手に渡った注記の控え（line_watch_turns.materials.reply.compose_plan に残す要約・純関数・作業員22・2026-11-13）
//
// 統括役 11/13（点検役の文の組み立ての点検で見つかった測りの土台の穴）: 文の設計図（compose-sentence-plan）は console.info に出るだけで DB に残らず、
//   書き手に渡った注記（sentencePlanNote・renderTurnContractNote）も番ごとに後から取り出せない＝「材料が渡っていない」「渡ったが使われない」を本番で測れなかった。
//   新しい列は作らず、line_watch_turns.materials（jsonb）の reply.compose_plan に足す（line-watch-materials-server.noteWatchMaterials）。
// 残す物: 設計図の digest と行ごとの役目・何を・どうやって・次へ・どこから／書き手の注記の指紋と先頭200字（設計図・本質の帯）／handoffLeaks の結果／
//   届いたかの数（delivery-check）／値のある下の欄の名前（decided-subfields）。お客様の文は設計図の「何を」に入るので、40字までに切る。
// スイッチ: WATCH_COMPOSE_PLAN（2026-11-21 から既定 on・=off で何も残さない）。
type Env = Record<string, string | undefined>;
// 2026-11-21 統括役の決め（記録だけのスイッチは既定 on の決まり）: 既定 on・止める WATCH_COMPOSE_PLAN=off。連携の地図 conductor.compose_plan／compose_roles の値の来る所（#483）
export const watchComposePlanOn = (env: Env = typeof process !== "undefined" ? process.env : {}): boolean => (env.WATCH_COMPOSE_PLAN ?? "").trim().toLowerCase() !== "off";

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
  /** roles: 指示書の欄を役目ごとに書き手へ渡した注記（compose-brief-roles.briefRolesNote・設計図の注記の中に入る物を別に控える・2026-11-21 作業員M #483） */
  note: { plan: { fp: string; len: number; head: string } | null; contract: { fp: string; len: number; head: string } | null; roles?: { fp: string; len: number; head: string } | null; situation?: { fp: string; len: number; head: string } | null };
  leaks: Array<{ key: string; missing: number }>;
  delivery: { rate: string; subRate: string } | null;
  subs: string[];
  /** 2026-11-21 作業員L（#466）: 設計図が運ぶ欄ごとの 値の数・注記に入らなかった数・値の語（文は写さない） */
  carried?: Array<{ key: string; n: number; missing: number; toks: string[] }>;
};
const cut = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const noteOf = (s: string | null | undefined) => (s && s.trim() ? { fp: fingerprint(s), len: s.length, head: s.slice(0, 200) } : null);
export function composePlanWatchOf(o: {
  digest?: string | null; rows?: ReadonlyArray<PlanRowLite> | null; planNote?: string | null; contractNote?: string | null; rolesNote?: string | null; situationNote?: string | null;
  leaks?: ReadonlyArray<{ key: string; missing: ReadonlyArray<string> }> | null; delivery?: { rate: string; subRate: string } | null; subs?: ReadonlyArray<string> | null;
  carried?: ReadonlyArray<{ key: string; n: number; missing: number; toks: ReadonlyArray<string> }> | null;
}): ComposePlanWatch {
  return {
    digest: cut(o.digest, 200),
    rows: (o.rows ?? []).slice(0, 8).map((r) => ({ rank: r.rank, role: r.role, part: cut(r.part, 40), how: cut(r.how, 40), next: cut(r.next, 30), from: cut(r.from, 20) })),
    note: { plan: noteOf(o.planNote), contract: noteOf(o.contractNote), ...(o.rolesNote !== undefined ? { roles: noteOf(o.rolesNote) } : {}), ...(o.situationNote !== undefined ? { situation: noteOf(o.situationNote) } : {}) },
    leaks: (o.leaks ?? []).map((l) => ({ key: l.key, missing: l.missing.length })),
    delivery: o.delivery ?? null,
    subs: [...(o.subs ?? [])].slice(0, 40),
    ...(o.carried?.length ? { carried: o.carried.slice(0, 40).map((c) => ({ key: c.key, n: c.n, missing: c.missing, toks: c.toks.slice(0, 6).map((t) => t.slice(0, 12)) })) } : {}),
  };
}
