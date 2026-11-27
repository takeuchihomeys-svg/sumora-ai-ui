// scripts/lib/rule-code-drift.ts — 決まり（設計知見）とコードの食い違いの見張り（台帳 #818・純関数＋ファイルの読み・LLM なし）
// 2026-11-27 作業員L（統括役の頼み）: 実例＝10/21 の A1「すぐ AIX で返す」の行は 11/05 に退役していたのに、コードの決め打ち TWO_STAGE_ANSWERABLE_DIRECT は既定 on のままだった。
//   ①退役した行（is_current=false）に書かれたスイッチが、コードで今も既定 on（または段階で all）＝「決まりは退役・コードは生きている」
//   ②現行の P0/P1 の行に書かれたスイッチが、コードで既定 off のまま・またはコードに無い＝「決まりは生きている・コードは止まっている」
//   スイッチの名前は大文字と _ の語（3つ以上の部分か、既知の頭）。関数の名前は `名前(` の形だけ（拾い過ぎを避ける）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 文の中のスイッチの名前（純関数）。A_B だけの短い物・よくある語（JST_ISO 等）は拾わない */
const NOT_SWITCH = /^(?:JST|UTC|ISO|URL|API|HTTP|JSON|SQL|PDF|LINE|AIX|RAG|LLM|TPO|OCR|UUID|TODO|NOTE)(?:_[A-Z0-9]+)?$|^(?:NEXT_PUBLIC|SUPABASE|ANTHROPIC|OPENAI|DEEPSEEK|VERCEL|CRON)_/;
export function switchNamesInText(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(/(?<![A-Za-z0-9_])([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,})(?![A-Za-z0-9_])/g)) {
    const n = m[1];
    if (n.length < 8 || NOT_SWITCH.test(n)) continue;
    out.add(n);
  }
  return [...out].sort();
}

export type CodeDefault = "on" | "off" | "staged" | "absent";
/** 1つのファイルの中のスイッチの既定（純関数）: !== "off" ＝既定 on・=== "on" ＝既定 off・stagedOn/stageOn("X", …, {kind:"all"}|STAGE_ALL) ＝段階で all（on と数える） */
export function switchDefaultsInCode(code: string): Map<string, CodeDefault> {
  const m = new Map<string, CodeDefault>();
  const set = (n: string, d: CodeDefault) => { const prev = m.get(n); if (!prev || prev === "absent" || (prev === "off" && d === "on")) m.set(n, d); };
  for (const x of code.matchAll(/env\.([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)[^;\n]{0,60}?!==\s*"off"/g)) set(x[1], "on");
  for (const x of code.matchAll(/env\.([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)[^;\n]{0,60}?===\s*"on"/g)) set(x[1], "off");
  for (const x of code.matchAll(/isOffSwitch\(\s*(?:process\.)?env\.([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)/g)) set(x[1], "on");
  for (const x of code.matchAll(/\b(?:stagedOn|stageOn|stageOnNow)\(\s*["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]([^)\n]{0,160})/g)) set(x[1], /STAGE_ALL|kind:\s*"all"/.test(x[2]) ? "on" : "staged");
  return m;
}
/** コード全体のスイッチの既定（app/lib・app/api）。同じ名前が on と off の両方で読まれる時は on（どこかで生きている） */
/** 2026-11-27（統括役の決め 6）: 戻す口のスイッチ（=on で昔の動きに戻す＝既定 off が決まりの通り）の名前（純関数） */
export function revertSwitchesInText(text: string): string[] {
  const out = new Set<string>();
  const t = String(text ?? "");
  for (const m of t.matchAll(/戻す[^\n]{0,30}?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*=\s*on\b/g)) out.add(m[1]);
  for (const m of t.matchAll(/([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*=\s*on\s*(?:で|＝)\s*(?:旧|昔|戻|前の動き|今まで)/g)) out.add(m[1]);
  for (const m of t.matchAll(/([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*は[^\n]{0,40}?戻[しす]口/g)) out.add(m[1]);
  return [...out].sort();
}
/** 2026-11-27（統括役の決め 3）: 行の中で「このスイッチは台帳でやめた」と書かれたスイッチ（純関数）＝スイッチの退役で、決めの退役ではない */
export function droppedSwitchesInText(text: string): string[] {
  const out = new Set<string>();
  for (const line of String(text ?? "").split(/\n/)) if (/台帳[^\n]{0,6}でやめた|台帳 #\d+（[^）]*(?:やめ|凍結|要らない|悪化)/.test(line)) for (const n of switchNamesInText(line)) out.add(n);
  return [...out].sort();
}
export function scanCodeDefaults(roots: readonly string[]): { defaults: Map<string, CodeDefault>; where: Map<string, string[]>; seen: Set<string>; revert: Set<string> } {
  const defaults = new Map<string, CodeDefault>(), where = new Map<string, string[]>(), seen = new Set<string>(), revert = new Set<string>();
  const walk = (d: string) => {
    let names: string[] = []; try { names = readdirSync(d); } catch { return; }
    for (const f of names) {
      if (f === "__tests__" || f === "node_modules" || f.startsWith(".")) continue;
      const p = join(d, f); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f)) {
        let c = ""; try { c = readFileSync(p, "utf8"); } catch { continue; }
        for (const x of c.matchAll(/[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+/g)) seen.add(x[0]);
        for (const n of revertSwitchesInText(c)) revert.add(n);
        for (const [n, v] of switchDefaultsInCode(c)) {
          const prev = defaults.get(n); if (!prev || (prev !== "on" && v === "on") || (prev === "staged" && v === "off")) defaults.set(n, v);
          const w = where.get(n) ?? []; if (w.length < 3) w.push(p.replace(/\\/g, "/").replace(/^.*?\/(app\/)/, "$1")); where.set(n, w);
        }
      }
    }
  };
  for (const r of roots) walk(r);
  return { defaults, where, seen, revert };
}

export type KbRow = { id: string; title: string | null; insight: string | null; rationale: string | null; applied_to: string | null; tags: string[] | null; is_current: boolean; priority: number | null; retired_reason: string | null; superseded_by: string | null };
export type Drift = { /** 同じスイッチが書かれた現行の行の数（0 なら退役だけが書いている＝食い違いの見込みが強い） */ currentMentions?: number; kind: "退役・コードは生きている" | "決まりは生きている・コードは止まっている" | "決まりは生きている・コードに無い"; id: string; title: string; priority: number | null; sw: string; code: CodeDefault; where: string[]; retiredReason?: string | null; supersededBy?: string | null };
/** 食い違いの組（純関数）。①退役した行×コードで既定 on ②現行の P0/P1×コードで既定 off・または無い */
/** 文の中でスイッチとして書かれているか（純関数）: NAME=on|off|shadow か、NAME の近くに「既定」 */
export function writtenAsSwitch(text: string, name: string): boolean {
  if (!/^[A-Z0-9_]+$/.test(name)) return false; // スイッチの名前は大文字・数字・_ だけ（正規表現の記号は入らない）
  return new RegExp(`${name}\\s*=\\s*(?:on|off|shadow|dry)\\b|${name}[^\\n]{0,12}既定`).test(text);
}
export function ruleCodeDrift(rows: readonly KbRow[], code: { defaults: ReadonlyMap<string, CodeDefault>; where: ReadonlyMap<string, string[]>; seen?: ReadonlySet<string>; revert?: ReadonlySet<string> }): Drift[] {
  const out: Drift[] = [];
  const text = (r: KbRow) => [r.title, r.insight, r.rationale, r.applied_to, ...(r.tags ?? [])].join("\n");
  // 同じスイッチが現行の行にも書かれている数（①は出したまま数を添える＝新しい行が生かしているのか、言い換えただけかは人が見る）
  const curCount = new Map<string, number>();
  for (const r of rows) if (r.is_current) for (const n of switchNamesInText(text(r))) curCount.set(n, (curCount.get(n) ?? 0) + 1);
  for (const r of rows) {
    const names = switchNamesInText(text(r));
    for (const sw of names) {
      const d = code.defaults.get(sw) ?? "absent";
      const base = { id: r.id, title: String(r.title ?? "").slice(0, 80), priority: r.priority, sw, code: d, where: code.where.get(sw) ?? [] };
      if (!r.is_current && d === "on") out.push({ ...base, kind: "退役・コードは生きている", currentMentions: curCount.get(sw) ?? 0, retiredReason: r.retired_reason, supersededBy: r.superseded_by });
      // 止まっている: 戻す口（=on で昔に戻す＝off が決まりの通り）・行に「台帳でやめた」と書いたスイッチ（スイッチの退役）は出さない
      const tx = text(r);
      if (r.is_current && (r.priority === 0 || r.priority === 1) && d === "off" && !code.revert?.has(sw) && !revertSwitchesInText(tx).includes(sw) && !droppedSwitchesInText(tx).includes(sw)) out.push({ ...base, kind: "決まりは生きている・コードは止まっている" });
      // コードに無い: コードのどこにも名前が無く（定数や名簿の名前でもない）、文の中でスイッチとして書かれている物だけ（拾い過ぎを避ける）
      if (r.is_current && (r.priority === 0 || r.priority === 1) && d === "absent" && !code.seen?.has(sw) && writtenAsSwitch(text(r), sw)) out.push({ ...base, kind: "決まりは生きている・コードに無い" });
    }
  }
  return out;
}
/** 台帳に積む題（純関数・題で重ねない） */
export function driftLedgerTitle(d: Drift): string {
  return `決まりとコードの食い違い: ${d.sw}（${d.kind}・設計知見 ${d.id.slice(0, 8)}）`;
}

// ─── 2026-11-27: 決まりの文にスイッチの名前が無くても、コードのコメントが設計知見の id（8字）を根拠に書いている所は照らせる ─────
//   実例: turn-contract.ts の「設計知見 5aa28356」（10/21 A1・11/05 に退役）の8行下で TWO_STAGE_ANSWERABLE_DIRECT を既定 on で読んでいた
export const ID_WINDOW_LINES = 10;
/** 1つのファイルの中の「id（8字）→ 近く（±ID_WINDOW_LINES 行）で読んでいるスイッチと既定」（純関数） */
export function idLinkedSwitchesInCode(code: string, window = ID_WINDOW_LINES): Array<{ id8: string; sw: string; code: CodeDefault; line: number }> {
  const lines = code.split(/\r?\n/), out: Array<{ id8: string; sw: string; code: CodeDefault; line: number }> = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/(?<![0-9a-f])([0-9a-f]{8})(?![0-9a-f])/g)) {
      if (!/[a-f]/.test(m[1]) || !/[0-9]/.test(m[1])) continue; // 数字だけ・文字だけは id でない見込み
      const seg = lines.slice(Math.max(0, i - window), i + window + 1).join("\n");
      for (const [sw, d] of switchDefaultsInCode(seg)) out.push({ id8: m[1], sw, code: d, line: i + 1 });
    }
  });
  return out;
}
export function scanIdLinks(roots: readonly string[]): Array<{ id8: string; sw: string; code: CodeDefault; file: string; line: number }> {
  const out: Array<{ id8: string; sw: string; code: CodeDefault; file: string; line: number }> = [];
  const walk = (d: string) => {
    let names: string[] = []; try { names = readdirSync(d); } catch { return; }
    for (const f of names) {
      if (f === "__tests__" || f === "node_modules" || f.startsWith(".")) continue;
      const p = join(d, f); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f)) { let c = ""; try { c = readFileSync(p, "utf8"); } catch { continue; } for (const x of idLinkedSwitchesInCode(c)) out.push({ ...x, file: p.split("\\").join("/").replace(/^.*?\/(app\/)/, "$1") }); }
    }
  };
  for (const r of roots) walk(r);
  return out;
}
/** 退役した行の id をコードが根拠に書いていて、その近くのスイッチが既定 on（純関数・同じ組は1つ） */
export function idLinkDrift(rows: readonly KbRow[], links: ReadonlyArray<{ id8: string; sw: string; code: CodeDefault; file: string; line: number }>): Array<Drift & { file: string; line: number }> {
  const retired = new Map(rows.filter((r) => !r.is_current).map((r) => [r.id.slice(0, 8), r]));
  const seen = new Set<string>(), out: Array<Drift & { file: string; line: number }> = [];
  for (const l of links) {
    const r = retired.get(l.id8); if (!r || l.code !== "on") continue;
    const k = `${l.id8}|${l.sw}`; if (seen.has(k)) continue; seen.add(k);
    out.push({ kind: "退役・コードは生きている", id: r.id, title: String(r.title ?? "").slice(0, 80), priority: r.priority, sw: l.sw, code: l.code, where: [`${l.file}:${l.line}（id を根拠に）`], retiredReason: r.retired_reason, supersededBy: r.superseded_by, file: l.file, line: l.line });
  }
  return out;
}

/** 2026-11-27 作業員L（台帳 #822 の続き・統括役の決め 2）: 現行の P0/P1 の決まり同士の「一部の上書き」の見張り（純関数・記録だけ・要確認に出すだけで直さない）。
 *   きっかけ: 10/15 の fd949dd7（家族の相談でも柔らかい1文を添える）を 10/18 の 5bb9f76a が家族の番だけ上書きしたのに、古い行に追記も superseded_by も無く、
 *   試験が古い方のまま落ち続けた（#818 の決まり×コードの見張りは、2つのスイッチが両方 on で合っているので拾えない）。
 *   拾う形: 2つの現行の行（P0/P1）が applied_to に同じ関数（camelCase の名前）を持ち、新しい方（rows の並びの後ろ＝作った順）の本文に上書きの語があり、
 *   古い方の本文に新しい方の id の頭8字が無く superseded_by も無い。 */
export const OVERRIDE_WORDS = /食い違っていた|食い違う|上書き|この番では置かない|では置かない|を外す|から外す|ではなく.{0,10}にする|に変える|置き換え/;
export function fnNamesInAppliedTo(appliedTo: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of String(appliedTo ?? "").matchAll(/\b([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/g)) if (m[1].length >= 6) out.add(m[1]);
  return [...out].sort();
}
export type PartialOverride = { oldId: string; newId: string; oldTitle: string; newTitle: string; fns: string[]; word: string };
export function partialOverrides(rowsInCreatedOrder: readonly KbRow[]): PartialOverride[] {
  const live = rowsInCreatedOrder.filter((r) => r.is_current && (r.priority ?? 2) <= 1);
  const fnsOf = new Map(live.map((r) => [r.id, fnNamesInAppliedTo(r.applied_to)]));
  const out: PartialOverride[] = [];
  for (let j = 0; j < live.length; j++) {
    const nw = live[j]; const w = `${nw.insight ?? ""} ${nw.title ?? ""}`.match(OVERRIDE_WORDS); if (!w) continue;
    const nf = fnsOf.get(nw.id) ?? []; if (!nf.length) continue;
    for (let i = 0; i < j; i++) {
      const old = live[i]; const shared = (fnsOf.get(old.id) ?? []).filter((f) => nf.includes(f)); if (!shared.length) continue;
      if (old.superseded_by || `${old.insight ?? ""} ${old.title ?? ""}`.includes(nw.id.slice(0, 8))) continue;
      out.push({ oldId: old.id, newId: nw.id, oldTitle: String(old.title ?? ""), newTitle: String(nw.title ?? ""), fns: shared, word: w[0] });
    }
  }
  return out;
}
