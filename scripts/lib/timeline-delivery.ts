// scripts/lib/timeline-delivery.ts — 時系列の帳面（meta.situation_now.timeline）の欄ごとに、ブレインの材料と書き手の注記に届く数を数える（純関数・LLM なし・DB なし）
//
// 2026-11-23 作業員L（台帳 #7・統括役の頼み: 数の名前は writer_link と同じ形で作業員P の地図 #610 の葉に）
//   欄: words（お客様の時の言葉）・viewings（時刻のある予定＝内覧）・promises（終日の予定＝約束と連絡の日・済みでない物）・holds（時間確保・TIMELINE_VIEWING_HOLD）
//   ブレイン … situation-timeline.timelineBlock の出し方（時の言葉は帳面の8つ全部・内覧はこれから全部＋過ぎた3つ・約束と連絡は済みでない5つ・時間確保はこれから）
//   書き手 … situation-now.situationWriterNote の出し方（時の言葉は新しい3つ・内覧は12時間前より後で済みでない3つ・約束と連絡は SITUATION_WRITER_TIMELINE_PROMISES=on の時だけ今日以降3つ）
//   数の名前: writer_link:timeline:<欄>:to_brain／writer_link:timeline:<欄>:to_writer（value は届いた項目の %・n は項目の数・scope=reply）
type Env = Record<string, string | undefined>;
export type TlField = "words" | "viewings" | "promises" | "holds";
export const TL_FIELDS: readonly TlField[] = ["words", "viewings", "promises", "holds"];
type Sn = { timeline?: { words?: unknown[]; viewings?: Array<{ at: string; done?: boolean }>; promises?: Array<{ at: string }>; holds?: Array<{ at: string; done?: boolean }> } } | null | undefined;
export type TlCount = Record<TlField, { n: number; toBrain: number; toWriter: number; /** 2026-11-26（#466）: 書き手に渡す対象の数（無ければ n） */ nW?: number; /** 書き手への配線が off（数えない） */ wOff?: boolean }>;

const jstDayStart = (ms: number) => Date.parse(new Date(ms + 9 * 36e5).toISOString().slice(0, 10) + "T00:00:00+09:00");

/** 1番の帳面 → 欄ごとの項目の数と届く数 */
export function timelineDeliveryOf(sn: Sn, nowMs: number, env: Env = {}): TlCount {
  const out = Object.fromEntries(TL_FIELDS.map((k) => [k, { n: 0, toBrain: 0, toWriter: 0 }])) as TlCount;
  const tl = sn?.timeline;
  if (!tl) return out;
  const words = tl.words ?? [];
  out.words = { n: words.length, toBrain: words.length, toWriter: Math.min(3, words.length) };
  const day = jstDayStart(nowMs);
  const vs = tl.viewings ?? [];
  const vFuture = vs.filter((v) => Date.parse(v.at) >= day && !v.done).length;
  const vW = vs.filter((v) => !v.done && Date.parse(v.at) >= nowMs - 12 * 36e5).length;
  out.viewings = { n: vs.length, toBrain: vFuture + Math.min(3, vs.length - vFuture), toWriter: Math.min(3, vW), nW: vW };
  const ps = tl.promises ?? []; // situation_now は済みでない物だけを残している
  const writerOn = (env.SITUATION_WRITER_TIMELINE_PROMISES ?? "").trim().toLowerCase() === "on";
  out.promises = { n: ps.length, toBrain: Math.min(5, ps.length), toWriter: writerOn ? Math.min(3, ps.filter((p) => Date.parse(p.at) >= day).length) : 0, wOff: !writerOn };
  const hs = tl.holds ?? [];
  out.holds = { n: hs.length, toBrain: hs.filter((h) => Date.parse(h.at) >= day && !h.done).length, toWriter: 0 };
  return out;
}

/** 番ごとの数を足す */
export function sumTimelineDelivery(rows: ReadonlyArray<TlCount>): TlCount {
  const out = Object.fromEntries(TL_FIELDS.map((k) => [k, { n: 0, toBrain: 0, toWriter: 0 }])) as TlCount;
  for (const r of rows) for (const k of TL_FIELDS) { out[k].n += r[k].n; out[k].toBrain += r[k].toBrain; out[k].toWriter += r[k].toWriter; out[k].nW = (out[k].nW ?? 0) + (r[k].nW ?? r[k].n); if (r[k].wOff) out[k].wOff = true; }
  return out;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
/** quality_daily に書ける行（作業員N2・P が書く） */
export function timelineMetricRows(sum: TlCount, hours: number): Array<{ metric: string; scope: string; value: number | null; n: number; detail: Record<string, unknown> }> {
  const out: Array<{ metric: string; scope: string; value: number | null; n: number; detail: Record<string, unknown> }> = [];
  for (const k of TL_FIELDS) {
    const c = sum[k];
    if (!c.n) continue;
    out.push({ metric: `writer_link:timeline:${k}:to_brain`, scope: "reply", value: pct(c.toBrain, c.n), n: c.n, detail: { hours } });
    // 2026-11-26 作業員L（#466）: 書き手の分母は渡す対象（内覧は 12時間前より後で済みでない物）・配線が off の欄は書き手の行を出さない（作っていない）
    if (!c.wOff && (c.nW ?? c.n) > 0) out.push({ metric: `writer_link:timeline:${k}:to_writer`, scope: "reply", value: pct(c.toWriter, c.nW ?? c.n), n: c.nW ?? c.n, detail: { hours } });
  }
  return out;
}
