// scripts/lib/auto-send-line-core.ts — 場面ごとの自動送信の線（土台の7つ ⑥・2026-11-03 作業員1）の純関数
//   project_shadow_auto_reply（9/29 竹内さん了承）: 場面ごとの一致率で自動送信を解禁する。ここは「どの場面が線に届いているか」の数え方だけ（送る仕組みは別）。
//   線（2026-11-03 夕 竹内さんの決定・KB P1）: 2週続けて候補の場面だけ、竹内さんに解禁を伺う（askScenes）
//     候補   … 判定のある番が30番以上・一致の Wilson 下限（95%）が 85% 以上・返信か AIX かの外れ（道の外れ）0・最終チェックの block 0
//     近い   … 一致の点が 85% 以上だが、数か下限が足りない
//     遠い   … それ以外
//   一致 = same・same_meaning ／ 外れ = partial・different ／ 数えない = na・未判定
export type SceneTally = { scene: string; n: number; match: number; pathMiss: number; blocks: number };
export type SceneLine = SceneTally & { rate: number; lower: number; grade: "候補" | "近い" | "遠い"; why: string };

/** Wilson の下限（95%・z=1.96） */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (!n) return 0;
  const p = k / n, d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}
export const AUTO_LINE = { minN: 30, lower: 0.85 } as const;

export function gradeScene(t: SceneTally): SceneLine {
  const rate = t.n ? t.match / t.n : 0, lower = wilsonLower(t.match, t.n);
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const base = `${t.match}/${t.n}・一致 ${pct(rate)}・下限 ${pct(lower)}${t.pathMiss ? `・道の外れ ${t.pathMiss}` : ""}${t.blocks ? `・最終チェックの block ${t.blocks}` : ""}`;
  if (t.n >= AUTO_LINE.minN && lower >= AUTO_LINE.lower && t.pathMiss === 0 && t.blocks === 0) return { ...t, rate, lower, grade: "候補", why: base };
  if (rate >= AUTO_LINE.lower) return { ...t, rate, lower, grade: "近い", why: `${base}（${t.n < AUTO_LINE.minN ? `あと ${AUTO_LINE.minN - t.n}番` : t.pathMiss ? "道の外れがある" : t.blocks ? "block がある" : "下限が足りない"}）` };
  return { ...t, rate, lower, grade: "遠い", why: base };
}

/** 見張りの1番を場面の数に足す */
export function tallyTurns(rows: Array<{ scene_key: string | null; verdict: string | null; verdict_detail: Record<string, unknown> | null; final_check: Record<string, unknown> | null }>): SceneTally[] {
  const m = new Map<string, SceneTally>();
  for (const r of rows) {
    const v = r.verdict;
    if (!(v === "same" || v === "same_meaning" || v === "partial" || v === "different")) continue;
    const scene = r.scene_key || "（場面なし）";
    const x = m.get(scene) ?? { scene, n: 0, match: 0, pathMiss: 0, blocks: 0 };
    x.n++;
    if (v === "same" || v === "same_meaning") x.match++;
    const d = r.verdict_detail ?? {};
    // 道の外れ（返信か AIX かの外れ）: 見張りの aix_verdict が unexpected（AI は返信・スタッフは AIX）か other（違う AIX）、
    //   または AI が AIX でスタッフが押さず文も外れた（not_pressed・partial／different）。11/03 の14日の実測の分け方
    const av = String(d.aix_verdict ?? "");
    if (av === "unexpected" || av === "other" || (d.path === "AIX" && av === "not_pressed" && (v === "partial" || v === "different"))) x.pathMiss++;
    const issues = (r.final_check?.issues ?? []) as Array<{ severity?: string }>;
    if (Array.isArray(issues) && issues.some((i) => i?.severity === "block")) x.blocks++;
    m.set(scene, x);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

/** 2週続けて候補: 今回の候補のうち、7〜13日前の回でも候補だった場面（前の回が無ければ空＝まだ伺わない） */
export function askScenes(nowCands: string[], runs: Array<{ day: string; cands: string[] }>, today: string): { scenes: string[]; prevDay: string | null } {
  const dd = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
  const prev = runs.filter((r) => { const d = dd(today, r.day); return d >= 7 && d <= 13; }).sort((a, b) => b.day.localeCompare(a.day))[0];
  return prev ? { scenes: nowCands.filter((s) => prev.cands.includes(s)), prevDay: prev.day } : { scenes: [], prevDay: null };
}
