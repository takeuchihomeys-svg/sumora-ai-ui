// scripts/audit-example-pii-unlabeled-address.ts — ラベル無しの住所＋人の情報（example-pii-guard.unlabeledPersonalAddresses）を
//   手本（customer_message・sent_reply・ai_draft）とナレッジ（title・content）の全件に当て、新しく伏せる文を全部並べる（読むだけ・LLM なし）
// 2026-10-09 RAG のゴミ調査の続き（4be4d338・e066500b 等: ご家族の氏名＋「岡山県岡山市中区…66-11」が残っていた）。
//   ・新しく伏せる文: 全件を1行ずつ（個人の値は伏せて表示）→ 目で読んで誤伏せ0を確かめる
//   ・住所の形はあるが伏せない文（人の印が無い・物件の住所の印がある）: 件数と例 → 物件の住所を誤って伏せていないか／伏せ漏れが無いか
//   ・--sql=<path> で、既存の行を伏せる UPDATE の案（控えの表つき・id を1件ずつ）を書く（実行はしない）
// 実行: npx tsx --env-file=.env.local scripts/audit-example-pii-unlabeled-address.ts [--sql=<path>]
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { unlabeledPersonalAddresses, examplePiiReason, sanitizeExampleText } from "../app/lib/example-pii-guard";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const ADDR_RE = /[一-龥ぁ-んヶ]{1,6}(?:市|区|郡|町|村)[一-龥ぁ-んァ-ヶ0-9０-９]{0,14}?[0-9０-９]{1,4}(?:丁目|番地?)?\s*[-‐－ー−]\s*[0-9０-９]{1,4}/;
const show = (s: string) => s.replace(/\s+/g, " ").replace(/0[789]0[-‐－ー]?\d{4}[-‐－ー]?\d{4}/g, "〇携帯〇").replace(/(?:19|20)\d{2}[.／/年]\d{1,2}[.／/月]\d{1,2}/g, "〇生年〇").slice(0, 170);
async function pageAll<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { const r = await sb.from(table).select(cols).order("id").range(i, i + 999); if (r.error) throw r.error; out.push(...((r.data ?? []) as T[])); if ((r.data ?? []).length < 1000) break; }
  return out;
}
(async () => {
  const sqlPath = process.argv.find((x) => x.startsWith("--sql="))?.split("=")[1];
  const ex = await pageAll<Record<string, string | null>>("ai_reply_examples", "id, entry_source, customer_message, sent_reply, ai_draft");
  const kn = await pageAll<Record<string, string | null>>("ai_reply_knowledge", "id, hypothesis_status, title, content");
  const targets: Array<{ table: string; id: string; field: string; text: string; tag: string }> = [];
  for (const r of ex) for (const f of ["customer_message", "sent_reply", "ai_draft"]) if (r[f]) targets.push({ table: "ai_reply_examples", id: r.id!, field: f, text: r[f]!, tag: r.entry_source ?? "" });
  for (const r of kn) for (const f of ["title", "content"]) if (r[f]) targets.push({ table: "ai_reply_knowledge", id: r.id!, field: f, text: r[f]!, tag: r.hypothesis_status ?? "" });
  const newly: typeof targets = [], skipped: typeof targets = [];
  for (const t of targets) {
    const hits = unlabeledPersonalAddresses(t.text);
    const reason = examplePiiReason(t.text);
    if (hits.length && /^ラベル無し/.test(reason?.reason ?? "")) newly.push(t);
    else if (!hits.length && ADDR_RE.test(t.text)) skipped.push(t);
  }
  console.log(`対象の文 ${targets.length}（手本 ${ex.length}行×3欄・ナレッジ ${kn.length}行×2欄）`);
  console.log(`\n■ 新しく伏せる文 ${newly.length}`);
  for (const t of newly) console.log(`  ${t.table === "ai_reply_examples" ? "手本" : "ナレッジ"} ${t.id.slice(0, 8)} ${t.field} [${t.tag}] 住所=${unlabeledPersonalAddresses(t.text).map((a) => a.replace(/[0-9０-９]/g, "#")).join("/")}｜${show(t.text)}`);
  console.log(`\n■ 住所の形はあるが伏せない文 ${skipped.length}（人の印が無い・物件の住所）例:`);
  const seen = new Set<string>();
  for (const t of skipped) { const m = t.text.match(ADDR_RE)![0]; const i = t.text.indexOf(m); const ctx = t.text.slice(Math.max(0, i - 25), i + m.length + 15).replace(/\s+/g, " "); if (seen.has(ctx)) continue; seen.add(ctx); console.log(`  ${t.table === "ai_reply_examples" ? "手本" : "ナレッジ"} ${t.id.slice(0, 8)} ${t.field}｜…${ctx}…`); }
  if (sqlPath) {
    const lines = [
      `-- ラベル無しの住所＋人の情報を伏せる案（2026-10-09 scripts/audit-example-pii-unlabeled-address.ts・未実行）`,
      `-- 置き換え後の本文は sanitizeExampleText（保存時の歯止めと同じ関数）の結果。控えに元の本文を残す。戻し方は末尾`,
      `CREATE TABLE IF NOT EXISTS rag_pii_unlabeled_address_backup (tbl text, id uuid, field text, original text, backed_up_at timestamptz DEFAULT now(), PRIMARY KEY (tbl, id, field));`,
    ];
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    for (const t of newly) {
      const side = t.field === "customer_message" ? "customer" : "staff";
      const s = sanitizeExampleText(t.text, side);
      if (!s.changed) continue;
      lines.push(`INSERT INTO rag_pii_unlabeled_address_backup (tbl, id, field, original) SELECT '${t.table}', id, '${t.field}', ${t.field} FROM ${t.table} WHERE id = '${t.id}' ON CONFLICT DO NOTHING;`);
      lines.push(`UPDATE ${t.table} SET ${t.field} = ${q(s.text)}${t.table === "ai_reply_examples" ? ", pii_redacted_at = now()" : ", pii_redacted_at = now()"} WHERE id = '${t.id}';`);
    }
    lines.push(`\n-- 戻し方: UPDATE ai_reply_examples a SET customer_message = b.original FROM rag_pii_unlabeled_address_backup b WHERE b.tbl='ai_reply_examples' AND b.field='customer_message' AND a.id=b.id;（sent_reply・ai_draft・ナレッジの content も同じ形）`);
    lines.push(`-- ⚠ 埋め込み（embedding）は元の本文から作られている。伏せた行は backfill で埋め込みを作り直す（scripts/backfill の型）か、そのままでも本文は伏せ済みで LLM には渡らない`);
    writeFileSync(sqlPath, lines.join("\n") + "\n");
    console.log(`\n（伏せる SQL の案を ${sqlPath} に書いた・実行はしていない）`);
  }
})();
