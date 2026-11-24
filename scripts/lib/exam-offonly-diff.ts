// scripts/lib/exam-offonly-diff.ts — main の変更が「その試験の構成で off のまま動かない所」だけかを見分ける（純関数・LLM なし・DB なし）
// 2026-11-24 作業員A（竹内さん 11/24「試験の改善を優先する」・統括役の頼み: 作り直しの2番目の理由「段に効くファイルの変更」$13.2/7晩）
//   off の基準（main の前の答え）の段の鍵は、ブレインの入口からたどれるファイルの中身の hash。既定 off のスイッチの中だけの変更でも鍵が変わり、前を作り直していた。
//   ここでは変更の塊（hunk）ごとに「off の構成では通らない所か」を決まった形でだけ認める。迷う物は全部「作り直す側」（safe=false）。
//   認める形（どれか・塊の全部の行がそうである時だけ）:
//     comment … 足した／消した行がコメントか空行だけ
//     guarded … 塊が、最初に「if (!<off のスイッチ>) return …」で抜ける関数の中（その抜ける行より後ろ）だけ
//     offblock … 足しただけの塊が「if (<off のスイッチ>) { … }」の1つの塊（括弧がそろう）
//     newdecl … 足しただけの塊が、行頭からの新しい関数・型・import の宣言だけ（呼ぶ所は別の塊で見る）
//     newfile … 新しいファイルで、行頭の文が宣言・import・コメントだけ（読み込んだ時に何も動かない）
//     neutral … off なら偽を返す関数の値を const に置き、「!v &&」・${gate() ? … : ""}・...(gate() ? … : []) を差し込んだだけ（下の neutralHunk）
//   スイッチが off か: その構成の env の値、無ければコードの既定（読めない・割れている物は off とみなさない）
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; added: string[]; removed: string[] };
export type FileDiff = { path: string; isNew: boolean; isDeleted: boolean; hunks: Hunk[] };
export type OffCtx = {
  /** スイッチの名前 → この試験の構成で off か（読めない物は false） */
  switchOff: (name: string) => boolean;
  /** 関数の名前 → その関数が読むスイッチの名前（`export const xOn = (env) => env.X === "on"` の X。分からなければ null） */
  gateSwitch: (fn: string) => string | null;
  /** off なら偽を返す関数の名前（neutralFunctionsOf・無ければ neutral の形は見ない） */
  neutral?: ReadonlySet<string>;
};
export type HunkVerdict = { path: string; at: number; kind: "comment" | "guarded" | "offblock" | "newdecl" | "newfile" | "neutral" | "unsafe"; why: string };

/** git diff -U0 の文 → ファイルごとの塊 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: FileDiff | null = null, h: Hunk | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) { const m = line.match(/ b\/(.+)$/); cur = { path: m ? m[1] : "", isNew: false, isDeleted: false, hunks: [] }; out.push(cur); h = null; continue; }
    if (!cur) continue;
    if (line.startsWith("new file mode")) { cur.isNew = true; continue; }
    if (line.startsWith("deleted file mode")) { cur.isDeleted = true; continue; }
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hm) { h = { oldStart: +hm[1], oldLines: hm[2] === undefined ? 1 : +hm[2], newStart: +hm[3], newLines: hm[4] === undefined ? 1 : +hm[4], added: [], removed: [] }; cur.hunks.push(h); continue; }
    if (!h) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) h.added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) h.removed.push(line.slice(1));
  }
  return out;
}

const isComment = (l: string) => { const t = l.trim(); return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.endsWith("*/"); };
/** 行の中の「off のスイッチ」の印（env.X の読み・xOn() の呼び出し）。条件の形はここでは見ない（呼ぶ側で形を見る） */
function offGateOf(cond: string, ctx: OffCtx): string | null {
  const env = cond.match(/env\??\.([A-Z][A-Z0-9_]+)\b[^)]*===\s*["'](?:on|shadow)["']/);
  if (env && ctx.switchOff(env[1])) return env[1];
  const fn = cond.match(/^\s*(?:await\s+)?(?:[\w$]+\.)?([a-z]\w*)\([^()]*\)\s*$/);
  if (fn) { const sw = ctx.gateSwitch(fn[1]); if (sw && ctx.switchOff(sw)) return sw; }
  return null;
}
const braceDelta = (ls: readonly string[]) => ls.map((l) => l.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$/, "")).join("\n").split("").reduce((n, c) => n + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);

/** 塊を囲む関数の頭（上へ）と、その関数の最初の数行の「off なら抜ける」行 */
function guardAbove(newLines: readonly string[], at: number, ctx: OffCtx): { sw: string; guardLine: number } | null {
  // at は 1 始まりの新しい側の行。上へ一番近い「行頭（字下げ0〜2）の関数の頭」まで
  for (let j = Math.min(at - 2, newLines.length - 1); j >= 0 && j >= at - 400; j--) {
    const l = newLines[j];
    if (/^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/.test(l)) {
      for (let k = j + 1; k <= Math.min(j + 4, newLines.length - 1); k++) {
        const g = newLines[k].match(/^\s*if\s*\(\s*!\s*(.+?)\s*\)\s*return\b/);
        if (g) { const sw = offGateOf(g[1], ctx); if (sw) return { sw, guardLine: k + 1 }; }
        const g2 = newLines[k].match(/^\s*if\s*\(\s*\(?\s*(?:\w+\.)?env\??\.([A-Z][A-Z0-9_]+)[^)]*\)?\s*!==\s*["']on["']\s*\)\s*return\b/);
        if (g2 && ctx.switchOff(g2[1])) return { sw: g2[1], guardLine: k + 1 };
      }
      return null;
    }
    if (/^\S/.test(l) && !isComment(l)) return null; // 関数の外の行頭の文・前の塊の閉じ（行頭の }）に当たった＝囲む関数ではない
  }
  return null;
}
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function\s+\w+|const\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|<|function)|type\s+\w+|interface\s+\w+)|^import\s|^export\s+(?:type\s+)?\{/;

/** 1つのファイルの1つの塊の判定。newText はその commit の新しい側のファイルの中身 */
export function classifyHunk(f: FileDiff, h: Hunk, newText: string, ctx: OffCtx): HunkVerdict {
  const at = h.newStart;
  const v = (kind: HunkVerdict["kind"], why: string): HunkVerdict => ({ path: f.path, at, kind, why });
  const changed = [...h.added, ...h.removed];
  if (changed.every(isComment)) return v("comment", "コメント・空行だけ");
  const nl = newText.split(/\r?\n/);
  // 足しただけで、off のスイッチの if の塊1つ
  if (!h.removed.length && h.added.length) {
    const body = h.added.filter((l) => !isComment(l));
    const head = body[0] ?? "";
    const m = head.match(/^\s*if\s*\((.+)\)\s*\{\s*$/);
    if (m && braceDelta(body) === 0 && /^\s*\}\s*$/.test(body[body.length - 1] ?? "") && !body.some((l) => /\}\s*else\b/.test(l))) { const sw = offGateOf(m[1], ctx); if (sw) return v("offblock", `if (${sw} が off) の塊を足しただけ`); }
    // 行頭からの宣言だけ（中身の行は字下げ・括弧がそろう）
    const tops = h.added.filter((l) => /^\S/.test(l) && !isComment(l) && !/^[}\])];?,?\s*$/.test(l));
    if (tops.length && tops.every((l) => DECL_RE.test(l)) && braceDelta(h.added) === 0 && !h.added.some((l) => /^\S/.test(l) && /\)\s*;\s*$/.test(l) && !DECL_RE.test(l))) {
      // import は副作用のある読み込み（import "x"）を外す
      if (h.added.some((l) => /^import\s+["']/.test(l))) return v("unsafe", "副作用の読み込み（import \"…\"）");
      return v("newdecl", "新しい宣言・import だけ（呼ぶ所は別の塊）");
    }
  }
  // off なら偽の値を差し込んだだけ（neutral）
  if (ctx.neutral) { const w = neutralHunk(h, ctx.neutral); if (w) return v("neutral", w); }
  // off なら抜ける関数の中（抜ける行より後ろ）
  const g = guardAbove(nl, at, ctx);
  if (g && at > g.guardLine && !changed.some((l) => /^\S/.test(l) && !isComment(l))) return v("guarded", `関数の頭で ${g.sw} が off なら抜ける（${g.guardLine}行）より後ろだけ`);
  return v("unsafe", "off の所だけと言えない");
}

/** 新しいファイル: 行頭の文が宣言・import・コメント・閉じ括弧だけ（読み込んだ時に何も動かない） */
export function newFileInert(text: string): boolean {
  return text.split(/\r?\n/).every((l) => !/^\S/.test(l) || isComment(l) || DECL_RE.test(l) || /^[}\])][;,)]*\s*$/.test(l) || /^\s*$/.test(l)) && !/^import\s+["']/m.test(text);
}

/** 変更全部の判定（1つでも unsafe なら作り直す）。texts はパス → 新しい側の中身 */
export function offOnlyChange(files: readonly FileDiff[], texts: ReadonlyMap<string, string>, ctx: OffCtx): { safe: boolean; verdicts: HunkVerdict[] } {
  const vs: HunkVerdict[] = [];
  for (const f of files) {
    if (f.isDeleted) { vs.push({ path: f.path, at: 0, kind: "unsafe", why: "ファイルを消した" }); continue; }
    const t = texts.get(f.path);
    if (t === undefined) { vs.push({ path: f.path, at: 0, kind: "unsafe", why: "新しい側の中身が読めない" }); continue; }
    if (f.isNew) { vs.push({ path: f.path, at: 0, kind: newFileInert(t) ? "newfile" : "unsafe", why: newFileInert(t) ? "新しいファイル（宣言だけ）" : "新しいファイルの行頭に動く文がある" }); continue; }
    for (const h of f.hunks) vs.push(classifyHunk(f, h, t, ctx));
  }
  return { safe: vs.length > 0 && vs.every((x) => x.kind !== "unsafe"), verdicts: vs };
}

/** ソースからゲートの関数 → スイッチ（`export const fooOn = (env…) => (env.FOO ?? "")…` か `export function fooOn(…) { return (env.FOO …` の2行以内） */
export function gateSwitchesOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const ls = text.split(/\r?\n/);
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(/^(?:export\s+)?(?:const\s+(\w+)\s*=|function\s+(\w+)\s*\()/);
    if (!m) continue;
    const name = m[1] ?? m[2];
    const w: string[] = [ls[i]];
    for (let k = i + 1; k < Math.min(ls.length, i + 3) && !/^(?:export\s+)?(?:const|function|async)\s/.test(ls[k]); k++) w.push(ls[k]); // 次の宣言の前まで
    const win = w.join("\n");
    const sws = [...new Set([...win.matchAll(/env\??\.([A-Z][A-Z0-9_]+)\b/g)].map((x) => x[1]))];
    if (sws.length === 1 && /=>|return/.test(win)) out.set(name, sws[0]);
  }
  return out;
}

// ── 2026-11-24 夕 作業員A: 「off なら何もしない関数」を挟んだだけの変更（今の書き方で一番多い形）──
//   neutral … 塊が次の行だけ:
//     ① 新しい const v = <off なら偽の値になる式>（off なら偽を返す関数・off のゲートを && でつないだ物）
//     ② if (v) の1行の文（off なら通らない）
//     ③ 前の行に「!v &&」や ${gate() ? … : ""}・...(gate() ? … : [] / {}) を差し込んだだけ（off なら前と同じ値）
//   off なら偽を返す関数: 関数の頭の4行以内に「if (!<off のゲート>) return false|null|undefined|""|0|[]|{}」がある物か、off のゲートそのもの
export function neutralFunctionsOf(sources: Iterable<string>, ctx: Pick<OffCtx, "switchOff" | "gateSwitch">): Set<string> {
  const out = new Set<string>();
  for (const text of sources) {
    const ls = text.split(/\r?\n/);
    for (let i = 0; i < ls.length; i++) {
      const m = ls[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
      if (!m) continue;
      const name = (m[1] ?? m[2])!;
      const sw = ctx.gateSwitch(name);
      if (sw && ctx.switchOff(sw)) { out.add(name); continue; }
      for (let k = i + 1; k <= Math.min(i + 4, ls.length - 1); k++) {
        const g = ls[k].match(/^\s*if\s*\(\s*!\s*(?:[\w$]+\.)?([a-z]\w*)\([^()]*\)\s*\)\s*return\s*(false|null|undefined|""|''|0|\[\]|\{\})?\s*;/);
        if (g) { const s2 = ctx.gateSwitch(g[1]); if (s2 && ctx.switchOff(s2)) out.add(name); break; }
      }
    }
  }
  return out;
}
/** 式が off なら偽か（neutral な関数の呼び出しを && でつないだ・前に !! や await import(...) が付いてもよい） */
function falsyWhenOff(expr: string, neutral: ReadonlySet<string>): boolean {
  const parts = expr.replace(/;\s*$/, "").split(/&&/).map((x) => x.trim());
  return parts.some((p) => {
    const m = p.replace(/^\(?\s*await\s+import\([^)]*\)\s*\)\s*\.?/, "").match(/^(?:\(\s*)?(?:await\s+)?(?:\(\s*await\s+import\([^)]*\)\s*\)\.)?(?:[\w$]+\.)?([a-zA-Z]\w*)\(/);
    return !!m && neutral.has(m[1]);
  });
}
/** 前の行 → 後の行が「差し込んだだけ」の時の差し込んだ文（違えば null） */
function insertionOf(before: string, after: string): string | null {
  let p = 0; while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0; while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  if (p + s !== before.length) return null; // 前の行から消えた字がある
  return after.slice(p, after.length - s);
}
export function neutralHunk(h: Hunk, neutral: ReadonlySet<string>): string | null {
  const add = h.added.filter((l) => !isComment(l)), rem = h.removed.filter((l) => !isComment(l));
  const vars = new Set<string>();
  const rest: string[] = [];
  for (const l of add) {
    const d = l.match(/^\s*(?:const|let)\s+(\w+)\s*=\s*(.+)$/);
    if (d && !rem.some((r) => r.includes(`${d[1]} =`)) && falsyWhenOff(d[2], neutral)) { vars.add(d[1]); continue; }
    rest.push(l);
  }
  const used = rest.filter((l) => { const m = l.match(/^\s*if\s*\(\s*(\w+)\s*\)\s*(?!\{).*;\s*$/); return !(m && vars.has(m[1]) && l.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").split(";").length === 2); }); // 1行に文が1つだけ（if (v) a(); b(); の b は off でも動く）
  if (used.length !== rem.length) return used.length === 0 && rem.length === 0 && vars.size ? "新しい off の値の宣言だけ" : null;
  const okIns = (ins: string) => {
    const t = ins.trim();
    if (!t) return true;
    // 「!v &&」だけ（v が偽なら true && X＝X）。「X && !v」「|| v」「v ||」は値が変わり得る（true／false・別の偽の値になる）ので認めない
    const v = t.match(/^!\s*(\w+)\s*&&$/);
    if (v) return vars.has(v[1]);
    const tpl = t.match(/^\$\{\s*(?:[\w$]+\.)?([a-zA-Z]\w*)\([^()]*\)\s*\?[\s\S]*:\s*(?:""|''|``)\s*\}$/);
    if (tpl) return neutral.has(tpl[1]);
    const spread = t.match(/^\.\.\.\(\s*(?:[\w$]+\.)?([a-zA-Z]\w*)\([^()]*\)\s*\?[\s\S]*:\s*(?:\[\]|\{\})\s*\),?$/);
    if (spread) return neutral.has(spread[1]);
    return false;
  };
  for (let i = 0; i < rem.length; i++) { const ins = insertionOf(rem[i], used[i]); if (ins === null || !okIns(ins)) return null; }
  return `off なら偽の値（${[...vars].join("・") || "関数"}）を差し込んだだけ`;
}
