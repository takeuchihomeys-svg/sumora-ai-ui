// app/lib/sql-split.ts — migrate-schema の SQL を exec_sql 1回ぶんずつに分ける
//
// ドル引用符（$$ … $$ / $func$ … $func$）の中のセミコロンでは分けない（単純な split(";") だと関数の本体が壊れる）。
// 2026-10-17: 「-- @atomic-begin」〜「-- @atomic-end」の間は分けずに1回の呼び出しにする。exec_sql は `EXECUTE sql` なので
//   複数の文を1回で流せて、1回の呼び出し＝1つのトランザクション（途中で失敗・時間切れなら全部戻る）。
//   関数の戻り値を変える時の DROP FUNCTION → CREATE FUNCTION はこの中に置く（別々の呼び出しだと間で止まった時に関数が消える。
//   10/17 match_design_thinking_exact が消えた事故）。それ以外は CREATE OR REPLACE だけで書く。

export const ATOMIC_BEGIN = "-- @atomic-begin";
export const ATOMIC_END = "-- @atomic-end";

export function splitSql(sql: string): string[] {
  const stmts: string[] = [];
  let buf = "";
  let inDollar = false;
  let atomic = false;
  const flush = () => { if (buf.trim()) stmts.push(buf.trim()); buf = ""; };
  for (const line of sql.split("\n")) {
    const t = line.trim();
    if (!inDollar && t === ATOMIC_BEGIN) { flush(); atomic = true; continue; }
    if (!inDollar && t === ATOMIC_END) { flush(); atomic = false; continue; }
    // $$ の出現数が奇数なら引用符ブロックの開始/終了
    const dollarCount = (line.match(/\$\$|\$func\$/g) || []).length;
    if (dollarCount % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!atomic && !inDollar && /;\s*$/.test(line.trimEnd())) flush();
  }
  flush();
  return stmts;
}

/** 関数の宣言の引数の数（括弧の深さ0のカンマで数える・vector(1536) の括弧は数えない） */
function countArgs(argText: string): number {
  if (!argText.trim()) return 0;
  let depth = 0, n = 1;
  for (const ch of argText) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) n++;
  }
  return n;
}

/** 名前の後ろの括弧の中身（対応する閉じ括弧まで） */
function argsAfter(text: string, from: number): string | null {
  const open = text.indexOf("(", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return null;
}

/**
 * 危ない組を探す: 1回の呼び出しで「DROP FUNCTION X(引数)」だけをして、後ろの別の呼び出しで同じ X（同じ引数の数）を作るもの。
 * 間で止まると X が消えたままになる。返すのは「関数名/引数の数」の一覧（無ければ空）。
 */
export function findSplitDropCreate(stmts: string[]): string[] {
  const out: string[] = [];
  const dropRe = /^\s*DROP\s+FUNCTION\s+IF\s+EXISTS\s+([a-z_][a-z0-9_]*)\s*\(/i;
  const noComments = (x: string) => x.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  stmts = stmts.map(noComments);
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (/\bCREATE\b/i.test(s)) continue; // 同じ呼び出しに CREATE がある＝@atomic の組
    const m = s.match(dropRe);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const dropArgs = argsAfter(s, m.index ?? 0);
    const k = countArgs(dropArgs ?? "");
    for (let j = i + 1; j < stmts.length; j++) {
      const cm = stmts[j].match(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "i"));
      if (!cm) continue;
      if (countArgs(argsAfter(stmts[j], cm.index ?? 0) ?? "") === k) { out.push(`${name}/${k}`); break; }
    }
  }
  return out;
}
