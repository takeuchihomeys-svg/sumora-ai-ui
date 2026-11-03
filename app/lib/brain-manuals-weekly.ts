// app/lib/brain-manuals-weekly.ts — ブレインの取扱説明書（brain_manuals）の毎週の書き直し（③・作業員1・11/04・既定 off）
//   KB P1 11/04「統括はそれぞれのブレインの動きを理解する」・作業員2の表（7つのブレイン×7項目＋短い形）。毎週 ① 強み と ⑦ 当たり を本番の数で書き直す（source=weekly）。
//   基準は竹内さんの番だけ（KB P1 41dadfe6）: 当たり・強い場面の数えは、こちらの最初の送信の書き手が takeuchi（sure）の番だけ。従業員の番は別の参考の数（基準にしない）。
//   中身は設計の言葉と数字だけ（会話の文・お客様の名前は入れない）。手で書いた本文（source=manual）は消さずに stats.base に残し、本番の数の1行を頭に足す。
//   測れるブレインだけ（見張りの番 line_watch_turns で答えが分かる物）: judge（返信か AIX かの道）・aix（AIX の種類）・compose（返信の文の一致）。他は書き直さない（未測のまま）。
//   純関数だけ（DB は scripts/brain-manuals-weekly.ts）。

export type ManualBrain = "judge" | "todo" | "aix" | "property_search" | "estimate" | "viewing" | "compose";
export type Writer = "takeuchi" | "employee" | null;

/** 見張りの番1つ（line_watch_turns ＋ こちらの最初の送信の書き手） */
export type WeeklyTurn = {
  writer: Writer;
  scene: string | null;
  /** ブレインの道（aix＝AIX と決めた・それ以外＝返信） */
  brainMode: string | null;
  brainAction: string | null;
  /** スタッフが押した AIX の種類（無ければ []） */
  staffAix: string[];
  /** 返信の一致（same・same_meaning・partial・different・na） */
  verdict: string | null;
  /** スタッフが答えた番か（答えていない番は数えない） */
  hasStaff: boolean;
};

export type Tally = { n: number; hit: number };
export type BrainTally = { takeuchi: Tally; employee: Tally; scenes: Record<string, Tally> };
export type WeeklyStats = Record<"judge" | "aix" | "compose", BrainTally>;

const empty = (): BrainTally => ({ takeuchi: { n: 0, hit: 0 }, employee: { n: 0, hit: 0 }, scenes: {} });

/** その番でブレインが当たったか（数えない番は null） */
export function hitOf(brain: "judge" | "aix" | "compose", t: WeeklyTurn): boolean | null {
  if (!t.hasStaff) return null;
  const brainAix = t.brainMode === "aix" && !!t.brainAction;
  const staffAix = t.staffAix.length > 0;
  if (brain === "judge") return brainAix === staffAix;
  if (brain === "aix") return brainAix && staffAix ? t.staffAix.includes(String(t.brainAction)) : null;
  // compose: ブレインもスタッフも返信の番だけ（AIX の番の文は AIX の側）。na は数えない
  if (brainAix || staffAix || !t.verdict || t.verdict === "na") return null;
  return t.verdict === "same" || t.verdict === "same_meaning";
}

export function tallyWeekly(turns: ReadonlyArray<WeeklyTurn>): WeeklyStats {
  const out: WeeklyStats = { judge: empty(), aix: empty(), compose: empty() };
  for (const t of turns) {
    for (const b of ["judge", "aix", "compose"] as const) {
      const h = hitOf(b, t);
      if (h === null) continue;
      if (t.writer === "takeuchi") {
        out[b].takeuchi.n++; if (h) out[b].takeuchi.hit++;
        const s = t.scene || "（場面なし）";
        const sc = (out[b].scenes[s] ??= { n: 0, hit: 0 });
        sc.n++; if (h) sc.hit++;
      } else if (t.writer === "employee") { out[b].employee.n++; if (h) out[b].employee.hit++; }
    }
  }
  return out;
}

const pct = (x: Tally) => (x.n ? Math.round((100 * x.hit) / x.n) : 0);
/** 場面の強い・弱い（竹内さんの番が min 件以上の場面だけ・上下3つ） */
export function sceneExtremes(bt: BrainTally, min = 5): { strong: string[]; weak: string[] } {
  const xs = Object.entries(bt.scenes).filter(([, v]) => v.n >= min).map(([k, v]) => ({ k, p: pct(v), n: v.n }));
  const fmt = (x: { k: string; p: number; n: number }) => `${x.k} ${x.p}%（${x.n}）`;
  return {
    strong: [...xs].sort((a, b) => b.p - a.p || b.n - a.n).slice(0, 3).map(fmt),
    weak: [...xs].sort((a, b) => a.p - b.p || b.n - a.n).slice(0, 3).map(fmt),
  };
}

const LABEL: Record<"judge" | "aix" | "compose", string> = { judge: "返信か AIX かの道", aix: "AIX の種類", compose: "返信の文（同じ・同じ意味）" };
/** 少ない時の印（竹内さんの番が20件未満＝KB 4d9a0518 の線に届かない） */
export const THIN_N = 20;

export type ExistingRow = { brain: string; item: string; body: string; source: string; stats: Record<string, unknown> | null };
export type ManualUpsert = { brain: ManualBrain; item: "hit_rate" | "strengths"; body: string; stats: Record<string, unknown>; source: "weekly" };

/** 手で書いた本文（manual）を残す元: 前に weekly で書いた行なら stats.base・manual の行ならその本文 */
function baseOf(prev: ExistingRow | undefined): string {
  if (!prev) return "";
  if (prev.source === "weekly") return typeof prev.stats?.base === "string" ? (prev.stats.base as string) : "";
  return prev.body;
}

/** 書き直す行（judge・aix・compose の ⑦当たり と ①強み）。本番の数の1行を頭に・元の本文は後ろに残す */
export function weeklyRows(stats: WeeklyStats, existing: ReadonlyArray<ExistingRow>, o: { days: number; day: string }): ManualUpsert[] {
  const rows: ManualUpsert[] = [];
  const prevOf = (b: string, i: string) => existing.find((r) => r.brain === b && r.item === i);
  for (const b of ["judge", "aix", "compose"] as const) {
    const bt = stats[b];
    const tk = bt.takeuchi, em = bt.employee;
    const thin = tk.n < THIN_N;
    const hitLine = `本番（${o.day}・直近${o.days}日・竹内さんの番だけ）: ${LABEL[b]} ${tk.hit}/${tk.n}（${pct(tk)}%）${thin ? "・少ない" : ""}。参考（従業員の番・基準にしない）: ${em.hit}/${em.n}${em.n ? `（${pct(em)}%）` : ""}。`;
    const prevH = prevOf(b, "hit_rate"), baseH = baseOf(prevH);
    rows.push({ brain: b, item: "hit_rate", body: baseH ? `${hitLine}\n${baseH}` : hitLine, source: "weekly", stats: { base: baseH, day: o.day, days: o.days, takeuchi: tk, employee: em, thin } });
    const ex = sceneExtremes(bt);
    if (ex.strong.length || ex.weak.length) {
      const sLine = `本番で強い場面（竹内さんの番・5件以上）: ${ex.strong.join("・") || "なし"}／弱い場面: ${ex.weak.join("・") || "なし"}。`;
      const prevS = prevOf(b, "strengths"), baseS = baseOf(prevS);
      rows.push({ brain: b, item: "strengths", body: baseS ? `${sLine}\n${baseS}` : sLine, source: "weekly", stats: { base: baseS, day: o.day, days: o.days, strong: ex.strong, weak: ex.weak } });
    }
  }
  return rows;
}

/** 書き手の解決: こちらの最初の送信（customer_turn_at の後・staff_first_at まで）の staff_writer。sure だけ・無ければ null */
export function writerOfTurn(turnAt: string, staffFirstAt: string | null, staffMsgs: ReadonlyArray<{ created_at: string; staff_writer: string | null; staff_writer_confidence: string | null }>): Writer {
  if (!staffFirstAt) return null;
  const a = Date.parse(turnAt), b = Date.parse(staffFirstAt) + 60_000;
  const m = staffMsgs.filter((x) => { const t = Date.parse(x.created_at); return t >= a && t <= b; }).sort((x, y) => x.created_at.localeCompare(y.created_at))[0];
  if (!m || m.staff_writer_confidence !== "sure") return null;
  return m.staff_writer === "takeuchi" ? "takeuchi" : m.staff_writer === "employee" ? "employee" : null;
}

/** 既定 off（BRAIN_MANUALS_WEEKLY=on の時だけ DB に書く・それ以外は計画だけ） */
export const brainManualsWeeklyOn = (env: Record<string, string | undefined> = process.env) => (env.BRAIN_MANUALS_WEEKLY ?? "").trim().toLowerCase() === "on";
