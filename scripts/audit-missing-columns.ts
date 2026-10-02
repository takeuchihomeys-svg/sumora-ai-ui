// scripts/audit-missing-columns.ts — 表に無い列で並べる・絞るクエリを探す（読むだけ・静かに壊れる種類）
// 実行: npx tsx --env-file=.env.local scripts/audit-missing-columns.ts
//
// 2026-10-02 ⑯: sent_properties を .order("created_at") で引いていた（列は sent_at）ため、supabase-js がエラーを返し、
//   受け手が error を見ずに data=null で何もしなかった（お客様の「興味あり」が全期間0件・物件確認の募集状況も書かれない）。
//   同じ種類（.order/.eq/.gte… の列が表に無い）をコード全体から探す。列が有るかは、その列だけを select して確かめる
//   （エラー＝無い列。PostgREST の OpenAPI は公開キーでは読めない）。
//   限界: from("表") の後ろ 1,500字の中の、同じ式のつながり（次の from( か空行か「;改行」まで）だけを見る。
//   変数の表名・rpc・文字列で組んだ列・select の中の列（取る列）は見ない。
import { execSync } from "child_process";
import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const FROM_RE = /\.from\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]\s*\)/g;
const FILTER_RE = /\.(order|eq|neq|gt|gte|lt|lte|in|is|not|like|ilike|contains|overlaps|match)\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]/g;
const STOP_RE = /\.from\(|\n\s*\n|;\s*\n/;

(async () => {
  const files = execSync("git ls-files app chrome-extension scripts", { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx|js)$/.test(f) && !/__tests__|migrate-schema|audit-missing-columns/.test(f));
  const uses: Array<{ f: string; line: number; table: string; op: string; col: string }> = [];
  for (const f of files) {
    let src: string;
    try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const m of src.matchAll(FROM_RE)) {
      const start = (m.index ?? 0) + m[0].length;
      let chunk = src.slice(start, start + 1500);
      const next = chunk.search(STOP_RE);
      if (next > 0) chunk = chunk.slice(0, next);
      for (const fm of chunk.matchAll(FILTER_RE)) {
        const around = chunk.slice(Math.max(0, (fm.index ?? 0) - 60), (fm.index ?? 0) + 80);
        if (/referencedTable|foreignTable/.test(around)) continue;
        uses.push({ f, line: src.slice(0, start + (fm.index ?? 0)).split("\n").length, table: m[1], op: fm[1], col: fm[2] });
      }
    }
  }
  const pairs = [...new Set(uses.map((u) => `${u.table}.${u.col}`))];
  const missing = new Set<string>();
  const noTable = new Set<string>();
  for (const pr of pairs) {
    const [table, col] = pr.split(".");
    const { error } = await db.from(table).select(col).limit(1);
    if (!error) continue;
    if (/relation .* does not exist|Could not find the table/i.test(error.message)) { noTable.add(table); continue; }
    if (/column .* does not exist|Could not find .*column/i.test(error.message)) missing.add(pr);
  }
  const hits = uses.filter((u) => missing.has(`${u.table}.${u.col}`));
  console.log(`■ 表に無い列での並べ・絞り: ${hits.length}か所（調べた組 ${pairs.length}・表が無い ${noTable.size}）`);
  for (const h of hits) console.log(`  ${h.f}:${h.line}  ${h.table}.${h.op}("${h.col}")`);
  if (noTable.size) console.log(`  （コードにあるが DB に無い表: ${[...noTable].join("・")}）`);
})();
