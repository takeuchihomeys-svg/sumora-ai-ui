// scripts/lib/loss-signs.ts — 失注の兆しの地図（#805・純関数・LLM/DB なし・2026-11-27 作業員A）
//
// 離れた会話（他社に決めた・費用で止まった・途絶えた）の、離れる前の2〜3番に出ていた合図を数える。合図は 返事の間・通の長さ・言葉・温度。
//   合図ごとに「合図が出た番で離れた割合」と「出なかった番で離れた割合」を並べる（差＝合図の重み・言い切らない）。
//   竹内さんがそこから戻した一手と戻せた割合を、#804 の戻る道と同じ元（照らしの json の竹内さん本人の番の一手 act と outcome）で持たせる。
// 入力の番: 照らしの json（audit-route-progress-takeuchi）の行＝竹内さん本人の番。その番の直前のお客様の塊から合図を読む（台本が会話の通を読んで渡す）。
//   離れた番＝その番か、同じ会話の後の2番の内に outcome="left" がある（離れる前の2〜3番）。戻せた＝合図の出た番の後、同じ会話で前へ（advanced・back・engaged）
// ブレインへの渡し方はまだ決めない（統括役 11/27）。

export const LOSS_SIGNALS = ["間が延びた", "通が短くなった", "保留の言葉", "他社の言葉", "費用の言葉", "温度が下がった"] as const;
export type LossSignal = typeof LOSS_SIGNALS[number];
export type LossReason = "他社に決めた" | "費用で止まった" | "途絶えた" | "その他";

const HOLD_RE = /検討|考え(?:ます|させ|てみ)|また(?:連絡|ご連絡)|一旦|いったん|保留|見送|今回は|やめて|とりあえず大丈夫|また今度/;
const OTHER_RE = /他社|他の不動産|別の不動産|他で(?:決|見つ)|決まりました|決めました|契約しました|別の(?:会社|所|ところ)/;
const COST_RE = /高い|高く|予算|厳しい|払えな|初期費用|安く|値下げ|もう少し安/;
const WARM_RE = /[！!]|ありがとう|嬉し|楽しみ|いいですね|良いですね|気に入|😊|☺|🙇|✨|❤|♡|😆|🥰/;

/** その番の合図（純関数）。gapH＝こちらの通からお客様の返事までの時間・prevGapH＝前の番の同じ時間・len＝塊の字数・medLen＝その会話のお客様の塊の字数の中ほど・prevWarm＝前の塊に温度の言葉があったか */
export function lossSignalsOf(o: { texts: readonly string[]; gapH: number | null; prevGapH: number | null; len: number; medLen: number | null; prevWarm: boolean | null }): LossSignal[] {
  const t = o.texts.join("\n").normalize("NFKC");
  const out: LossSignal[] = [];
  if (o.gapH != null && (o.gapH >= 24 || (o.prevGapH != null && o.prevGapH > 0 && o.gapH >= Math.max(3, o.prevGapH * 3)))) out.push("間が延びた");
  if (o.medLen != null && o.medLen >= 20 && o.len > 0 && o.len <= o.medLen * 0.4) out.push("通が短くなった");
  if (HOLD_RE.test(t)) out.push("保留の言葉");
  if (OTHER_RE.test(t)) out.push("他社の言葉");
  if (COST_RE.test(t)) out.push("費用の言葉");
  if (o.prevWarm === true && !WARM_RE.test(t)) out.push("温度が下がった");
  return out;
}
export const isWarm = (texts: readonly string[]) => WARM_RE.test(texts.join("\n").normalize("NFKC"));
/** 離れた訳（最後のお客様の塊の言葉・無ければ途絶えた） */
export function lossReasonOf(lastTexts: readonly string[] | null): LossReason {
  if (!lastTexts || !lastTexts.length) return "途絶えた";
  const t = lastTexts.join("\n").normalize("NFKC");
  if (OTHER_RE.test(t)) return "他社に決めた";
  if (COST_RE.test(t)) return "費用で止まった";
  if (HOLD_RE.test(t)) return "途絶えた";
  return "その他";
}

export type LossTurn = { conv: string; at: string; signals: LossSignal[]; leftSoon: boolean; act: string | null; recovered: boolean };
export type SignalRow = { signal: LossSignal; withN: number; withLeft: number; withPct: number | null; withoutN: number; withoutLeft: number; withoutPct: number | null; diffPt: number | null };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
/** 合図ごとに、出た番と出なかった番の離れた割合（純関数） */
export function lossSignalTable(turns: readonly LossTurn[]): SignalRow[] {
  return LOSS_SIGNALS.map((s) => {
    const w = turns.filter((x) => x.signals.includes(s)), wo = turns.filter((x) => !x.signals.includes(s));
    const wl = w.filter((x) => x.leftSoon).length, wol = wo.filter((x) => x.leftSoon).length;
    const a = pct(wl, w.length), b = pct(wol, wo.length);
    return { signal: s, withN: w.length, withLeft: wl, withPct: a, withoutN: wo.length, withoutLeft: wol, withoutPct: b, diffPt: a != null && b != null ? Math.round((a - b) * 10) / 10 : null };
  });
}
/** 合図の出た番の竹内さんの一手と、その後に戻せた割合（#804 の戻る道と同じ元＝その番の act と、同じ会話の後の outcome） */
export function lossRecovery(turns: readonly LossTurn[]): Array<{ signal: LossSignal; acts: Array<{ act: string; n: number; back: number; pct: number | null }> }> {
  return LOSS_SIGNALS.map((s) => {
    const m = new Map<string, { n: number; back: number }>();
    for (const x of turns.filter((t) => t.signals.includes(s) && t.act)) { const o = m.get(x.act!) ?? { n: 0, back: 0 }; o.n++; if (x.recovered) o.back++; m.set(x.act!, o); }
    return { signal: s, acts: [...m].map(([act, o]) => ({ act, ...o, pct: pct(o.back, o.n) })).sort((p, q) => q.n - p.n) };
  });
}
/** 照らしの json の行から 離れた番（その番か後の2番に left）・戻せた（後の行に前へ）を付ける（純関数）。rows は同じ会話で時刻順 */
export function leftSoonAndRecovered(rows: ReadonlyArray<{ conv: string; at: string; outcome: string | null }>, i: number): { leftSoon: boolean; recovered: boolean } {
  const r = rows[i];
  const same = rows.filter((x) => x.conv === r.conv).sort((a, b) => a.at.localeCompare(b.at));
  const k = same.findIndex((x) => x.at === r.at);
  const next = same.slice(k, k + 3);
  const leftSoon = next.some((x) => x.outcome === "left");
  const recovered = same.slice(k).some((x) => x.outcome === "advanced" || x.outcome === "back") || (r.outcome === "engaged" && !leftSoon);
  return { leftSoon, recovered };
}
export function lossLines(table: readonly SignalRow[], rec: ReturnType<typeof lossRecovery>, reasons: Record<string, number>, n: number): string[] {
  return [
    `### 失注の兆しの地図（#805・竹内さん本人の番 ${n}・離れた訳 ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}）`,
    ...table.map((r) => `- ${r.signal}: 出た番 ${r.withN}（離れた ${r.withPct ?? "—"}%）／出なかった番 ${r.withoutN}（${r.withoutPct ?? "—"}%）・差 ${r.diffPt ?? "—"}pt`),
    ...rec.filter((x) => x.acts.length).map((x) => `- 戻す一手（${x.signal}）: ${x.acts.slice(0, 3).map((a) => `${a.act} ${a.back}/${a.n}`).join("・")}`),
  ];
}
