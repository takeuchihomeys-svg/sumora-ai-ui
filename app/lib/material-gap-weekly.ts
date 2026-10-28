// app/lib/material-gap-weekly.ts — 毎週の原因の表（scripts/line-watch-miss-causes.ts）の章「材料の足りなさ」「知識の弱さ（B の候補）」の集計（純関数）
//
// 2026-10-29 竹内さん（KB P1「材料が足りない所と知識が弱い所を、仕組みで把握して見つけ出し続ける」）・作業員1:
//   ①材料: brain_decision_logs.digest の mm（ブレインの自己申告「判断に要ったのに無かった物」・brain-material-self-report.ts）と
//      mx（DB から読めなかった材料の鍵・brain-material-miss.ts）を、直近7日／その前の7日で数える
//   ②知識: 作業員5の拾い出し（下書きはぼかした・実送信は具体の事実で答えた番）の出力（JSON の行）を章にする。形は KnowledgeGapRow
import { BRAIN_MATERIAL_LABELS } from "./brain-material-miss";

export type DigestRow = { created_at: string; digest: { mm?: unknown; mx?: unknown } | null };
export type GapWindow = { decisions: number; reported: number; nonEmpty: number; names: Map<string, number>; readMiss: number; readKeys: Map<string, number> };
const DAY = 86_400_000;

function emptyWin(): GapWindow { return { decisions: 0, reported: 0, nonEmpty: 0, names: new Map(), readMiss: 0, readKeys: new Map() }; }

/** 名前のゆれを少し寄せる（空白を詰め・前後の記号を落とす） */
export function normalizeGapName(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "").replace(/^[・\-「『]+|[」』。]+$/g, "");
}

export function tallyMaterialGaps(rows: readonly DigestRow[], nowMs: number): { last7: GapWindow; prev7: GapWindow } {
  const last7 = emptyWin(), prev7 = emptyWin();
  for (const r of rows) {
    const age = nowMs - Date.parse(r.created_at);
    const w = age >= 0 && age < 7 * DAY ? last7 : age >= 7 * DAY && age < 14 * DAY ? prev7 : null;
    if (!w) continue;
    w.decisions++;
    const mm = r.digest?.mm;
    if (Array.isArray(mm)) {
      w.reported++;
      const names = mm.filter((x): x is string => typeof x === "string").map(normalizeGapName).filter(Boolean);
      if (names.length) w.nonEmpty++;
      for (const n of new Set(names)) w.names.set(n, (w.names.get(n) ?? 0) + 1);
    }
    const mx = r.digest?.mx;
    if (Array.isArray(mx) && mx.length) {
      w.readMiss++;
      for (const k of new Set(mx.filter((x): x is string => typeof x === "string"))) w.readKeys.set(k, (w.readKeys.get(k) ?? 0) + 1);
    }
  }
  return { last7, prev7 };
}

const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");

/** 章「材料の足りなさ」の Markdown の行 */
export function renderMaterialGapChapter(t: { last7: GapWindow; prev7: GapWindow }, top = 12): string[] {
  const { last7: a, prev7: b } = t;
  const out = ["## 材料の足りなさ（ブレインの自己申告・読めなかった材料）", ""];
  out.push("| 物差し | 直近7日 | 前の7日 |", "|---|---|---|");
  out.push(`| ブレインの判断 | ${a.decisions} | ${b.decisions} |`);
  out.push(`| 自己申告がある判断 | ${a.reported}（${pct(a.reported, a.decisions)}） | ${b.reported}（${pct(b.reported, b.decisions)}） |`);
  out.push(`| 足りない物を1つ以上挙げた | ${a.nonEmpty}（${pct(a.nonEmpty, a.reported)}） | ${b.nonEmpty}（${pct(b.nonEmpty, b.reported)}） |`);
  out.push(`| DB から読めなかった材料がある | ${a.readMiss}（${pct(a.readMiss, a.decisions)}） | ${b.readMiss}（${pct(b.readMiss, b.decisions)}） |`);
  out.push("", "足りなかった物（直近7日の多い順・カッコは前の7日）:");
  const names = [...a.names].sort((x, y) => y[1] - x[1]).slice(0, top);
  if (!names.length) out.push("- なし（自己申告が始まる前か、足りない物の申告なし）");
  for (const [n, c] of names) out.push(`- ${n}: ${c}（前 ${b.names.get(n) ?? 0}）`);
  const fresh = names.filter(([n]) => !b.names.has(n)).map(([n]) => n);
  if (fresh.length && b.reported > 0) out.push(`- 新しく出た: ${fresh.join("・")}`);
  if (a.readKeys.size) out.push("", `読めなかった材料: ${[...a.readKeys].sort((x, y) => y[1] - x[1]).map(([k, c]) => `${BRAIN_MATERIAL_LABELS[k] ?? k} ${c}`).join("・")}`);
  return out;
}

/** 作業員5の知識の拾い出しの1行（JSON）。verified＝実送信で裏が取れた（KB の候補）／false＝竹内さんへの ○× の質問 */
export type KnowledgeGapRow = { id: number | string; at?: string; scene?: string | null; draft: string; staff: string; candidate: string; verified: boolean };

/** 章「知識の弱さ（B の候補）」の Markdown の行（rows が null＝出力がまだ無い） */
export function renderKnowledgeGapChapter(rows: readonly KnowledgeGapRow[] | null, prevCount: number | null = null): string[] {
  const out = ["## 知識の弱さ（下書きはぼかした・実送信は具体の事実で答えた番＝文の外れ B の候補）", ""];
  if (!rows) { out.push("- （拾い出しの出力が無い: --knowledge=<JSON> で渡す・作業員5の毎週のスクリプト）"); return out; }
  const v = rows.filter((r) => r.verified).length;
  out.push(`拾った番 ${rows.length}${prevCount != null ? `（前 ${prevCount}）` : ""}・実送信で裏が取れた知識の候補 ${v}・竹内さんへの確認 ${rows.length - v}`, "");
  for (const r of rows.slice(0, 20)) {
    out.push(`- #${r.id}${r.scene ? ` ${r.scene}` : ""}${r.verified ? "" : "（要確認）"} 候補: ${r.candidate}`);
    out.push(`  下書き: ${r.draft.replace(/\s+/g, " ").slice(0, 60)}｜実送信: ${r.staff.replace(/\s+/g, " ").slice(0, 60)}`);
  }
  return out;
}
