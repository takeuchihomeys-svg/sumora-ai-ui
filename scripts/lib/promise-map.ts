// scripts/lib/promise-map.ts — 「約束」の分野の地図（木）: 竹内さん本人の約束を、本当に果たしていない物だけにして 種類 → 場面 → 外れの型 → 原因 に割る（純関数・DB も LLM もなし）
//
// 2026-11-23 作業員L（竹内さんの決定 11/23・KB 0f38f47f P1「申込までの地図で作った型をほかの分野でも」・統括役の割り振り＝約束の分野）。
//   根の名前（作業員P の地図と合わせる・P と相談中）: promise:kept_true（竹内さん本人の約束のうち、期限の内に果たした割合）
//   元の数え: B1（scripts/audit-promise-kept.ts・作業員N の線）の1約束1行。今日の直し（過去の報告・条件つき・会話が閉じた・要件で絞る確認）は B1 の側で済んでいる
//   外す物: 判定なし（日程・電話・その他）・期限前（まだ）。残るのは 期限内に果たした（ok）・遅れて果たした（late）・期限を過ぎて果たしていない（overdue）
//   原因の4つ（P の地図と同じ鍵）: material＝約束が統括・ブレインに届いていない（行動台帳に約束の行が無い）／misread＝約束の種類を読み違えた（台帳と見張りの種類が違う）／
//     counting＝数え方（カレンダーの【必ず】は済み・台帳は閉じた＝こちらが見えていない果たし方）／judgment＝材料は届いていたのに果たされなかった（統括が拾えなかった）
export type PromiseMapState = "in_time" | "late" | "overdue" | "pending" | "n/a";
export type PromiseMapRow = { conv: string; at: string; kind: string; writer: string; state: PromiseMapState; by?: string | null; scene?: string | null; sceneKey?: string | null };
export type PromiseMapMiss = "ok" | "late" | "overdue";
export type PromiseMapCause = "material" | "misread" | "counting" | "judgment";
export const PROMISE_MAP_ROOT = "promise:kept_true";
export const PROMISE_MAP_MISS_JA: Record<PromiseMapMiss, string> = { ok: "期限の内に果たした", late: "遅れて果たした", overdue: "期限を過ぎて果たしていない" };
export const PROMISE_MAP_CAUSE_JA: Record<PromiseMapCause, string> = {
  material: "材料が届いていない（行動台帳に約束の行が無い）", misread: "約束の種類の読み違い（台帳と見張りで違う）",
  counting: "数え方（カレンダーの【必ず】は済み・台帳は閉じた）", judgment: "材料は届いていたのに果たされなかった（統括が拾えなかった）",
};
/** 外れの番の、台帳とカレンダーの印（呼ぶ側が会話と時刻で読む） */
export type PromiseEvidence = { ledgerKind: string | null; ledgerClosed: boolean; calendarDone: boolean | null };
const WATCH_TO_LEDGER: Record<string, string> = { pickup: "pickup_declared", check: "confirmation_promised", estimate: "estimate_declared" };
/** 数え方（counting）は「期限を過ぎて果たしていない」と数えたのに台帳・カレンダーでは閉じている時だけ（遅れて果たした番は果たしてはいるので数え方にしない） */
export function promiseMissCause(row: Pick<PromiseMapRow, "kind"> & { state?: PromiseMapState }, ev: PromiseEvidence | undefined): PromiseMapCause {
  if (!ev || !ev.ledgerKind) return "material";
  if (row.state !== "late" && (ev.ledgerClosed || ev.calendarDone === true)) return "counting";
  if (WATCH_TO_LEDGER[row.kind] && ev.ledgerKind !== WATCH_TO_LEDGER[row.kind]) return "misread";
  return "judgment";
}
export type PromiseMapTurn = { id: string; kind: string; scene: string; miss: PromiseMapMiss; cause: PromiseMapCause | null };
/** B1 の行 → 地図の番（竹内さん本人・判定のある物だけ） */
export function promiseMapTurns(rows: ReadonlyArray<PromiseMapRow>, evOf: (r: PromiseMapRow) => PromiseEvidence | undefined, o: { writer?: string } = {}): PromiseMapTurn[] {
  const w = o.writer ?? "takeuchi";
  return rows.filter((r) => r.writer === w && (r.state === "in_time" || r.state === "late" || r.state === "overdue")).map((r) => {
    const miss: PromiseMapMiss = r.state === "in_time" ? "ok" : r.state === "late" ? "late" : "overdue";
    return { id: `${r.conv}@${r.at}`, kind: r.kind, scene: r.scene || "other", miss, cause: miss === "ok" ? null : promiseMissCause(r, evOf(r)) };
  });
}
export type PromiseMapNode = { key: string; parent: string | null; depth: number; dim: "kind" | "scene" | "miss" | "cause" | null; val: string | null; n: number; ok: number; misses: number; value: number | null };
const pct1 = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
/** 木（P の地図と同じ形: 子の n・外れを足すと親に戻る。一致の葉には原因の子を作らない） */
export function buildPromiseTree(turns: ReadonlyArray<PromiseMapTurn>, root = PROMISE_MAP_ROOT): PromiseMapNode[] {
  const out: PromiseMapNode[] = [];
  const dims: Array<"kind" | "scene" | "miss" | "cause"> = ["kind", "scene", "miss", "cause"];
  const walk = (rows: ReadonlyArray<PromiseMapTurn>, key: string, parent: string | null, depth: number, dim: PromiseMapNode["dim"], val: string | null) => {
    const ok = rows.filter((r) => r.miss === "ok").length;
    out.push({ key, parent, depth, dim, val, n: rows.length, ok, misses: rows.length - ok, value: pct1(ok, rows.length) });
    const next = dims[depth];
    if (!next) return;
    if (next === "cause" && rows.every((r) => r.miss === "ok")) return;
    const groups = new Map<string, PromiseMapTurn[]>();
    for (const r of rows) { const v = String(r[next] ?? "-"); groups.set(v, [...(groups.get(v) ?? []), r]); }
    for (const [v, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) walk(rs, `${key}/${next}=${v}`, key, depth + 1, next, v);
  };
  walk(turns, root, null, 0, null, null);
  return out;
}
/** ②土台の表の1行（葉＝種類 × 場面） */
export type FoundationCell = "ok" | "gap" | "n/a";
export type PromiseFoundationRow = { leaf: string; n: number; misses: number; rule: FoundationCell; material: FoundationCell; measure: FoundationCell; exam: FoundationCell; deliveredToBrain: string };
const JUDGEABLE = new Set(["pickup", "check", "estimate"]);
/** 葉ごとの土台（決まり＝KB の現行の行がある・材料＝統括の材料に届く種類・物差し＝B1 で判定できる・試験の問題がある）と、統括ブレインへの届き方 */
export function promiseFoundationRows(nodes: ReadonlyArray<PromiseMapNode>, o: { kbKinds: ReadonlySet<string>; examKinds: ReadonlySet<string>; overdueMaterialOn: boolean }): PromiseFoundationRow[] {
  return nodes.filter((x) => x.dim === "scene").map((x) => {
    const kind = (x.key.match(/kind=([^/]+)/) ?? [])[1] ?? "";
    const judge = JUDGEABLE.has(kind);
    return {
      leaf: x.key, n: x.n, misses: x.misses,
      rule: o.kbKinds.has(kind) ? "ok" : "gap",
      material: judge && o.overdueMaterialOn ? "ok" : "gap",
      measure: judge ? "ok" : "gap",
      exam: o.examKinds.has(kind) ? "ok" : "gap",
      // ③: 期限を過ぎた約束は入口の統括の材料の1行（CONDUCTOR_OVERDUE_PROMISES）に入る。使われたかは本番の記録に残らない（runtime ログの brain:overdue-promises だけ）
      deliveredToBrain: !judge ? "届かない（判定のない種類）" : o.overdueMaterialOn ? "届く（統括の材料・使われたかは記録なし）" : "届かない（スイッチ off）",
    };
  });
}
