// scripts/audit-knowledge-phrase.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-knowledge-phrase.ts [--cat=phrase] [--show=15]
//
// 2026-09-19 竹内（慶次事例）「ナレッジの部分から進める」:
//   ナレッジのカテゴリ別に「具体条件が埋まっている率」を測る。
//   phrase（言い回しの手本＝そのまま写させる物）は、顧客名を〇〇に伏せているのに条件は生のまま。
//   pattern / principle / style は説明文なので、具体条件は「例」として意味がある。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const catQ = arg("cat");
const show = Number(arg("show", "15"));

const COND_WORDS = ["ペット", "駐車場", "オートロック", "独立洗面", "バストイレ別", "宅配ボックス", "ウォークインクローゼット", "楽器", "事務所", "二人入居", "ルームシェア", "同棲", "喫煙", "角部屋", "分譲", "ガスコンロ"];
/** 家賃・間取り・徒歩分・築年の具体値 */
const SPEC_RE = /[0-9０-９]+(?:\.[0-9０-９]+)?\s*(?:万円|円)|[0-9０-９]\s*[LDKSlks]{1,4}(?![a-zA-Z])|徒歩\s*[0-9０-９]+\s*分|築\s*[0-9０-９]+\s*年|[0-9０-９]+\s*㎡/;
/** エリア・駅名らしい語 */
const AREA_RE = /[一-龥ァ-ヶa-zA-Z0-9]{2,8}(?:駅|区|市内|市|町|沿線|線)/;

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("ai_reply_knowledge")
      .select("id, category, content, conversation_state, importance, used_count, apply_count, correct_count, wrong_count")
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    rows.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  const cats = [...new Set(rows.map((r) => String(r.category ?? "(null)")))];
  console.log(`=== カテゴリ別「具体値が埋まっている率」（全 ${rows.length}件）===\n`);
  console.log(`  ${"カテゴリ".padEnd(20)} ${"件数".padStart(6)} ${"設備条件".padStart(8)} ${"家賃/間取り".padStart(10)} ${"エリア/駅".padStart(10)}  ${"〇〇で伏せ済み".padStart(12)}`);
  for (const c of cats) {
    const rs = rows.filter((r) => String(r.category ?? "(null)") === c);
    const cond = rs.filter((r) => COND_WORDS.some((w) => String(r.content ?? "").includes(w))).length;
    const spec = rs.filter((r) => SPEC_RE.test(String(r.content ?? ""))).length;
    const area = rs.filter((r) => AREA_RE.test(String(r.content ?? ""))).length;
    const ph = rs.filter((r) => /〇〇|○○|◯◯/.test(String(r.content ?? ""))).length;
    const p = (x: number) => `${((100 * x) / Math.max(rs.length, 1)).toFixed(0)}%`;
    console.log(`  ${c.padEnd(20)} ${String(rs.length).padStart(6)} ${p(cond).padStart(8)} ${p(spec).padStart(10)} ${p(area).padStart(10)}  ${p(ph).padStart(12)}`);
  }

  if (catQ) {
    const rs = rows.filter((r) => String(r.category ?? "") === catQ)
      .filter((r) => COND_WORDS.some((w) => String(r.content ?? "").includes(w)) || SPEC_RE.test(String(r.content ?? "")))
      .sort((a, b) => Number(b.used_count ?? 0) - Number(a.used_count ?? 0));
    console.log(`\n=== ${catQ} で具体値が入っている ${rs.length}件（使われた順）===`);
    rs.slice(0, show).forEach((r, i) => {
      console.log(`\n[${i + 1}] used=${r.used_count} apply=${r.apply_count} correct=${r.correct_count} wrong=${r.wrong_count} state=${r.conversation_state} imp=${r.importance}`);
      console.log(`    ${String(r.content ?? "").replace(/\n/g, " / ").slice(0, 220)}`);
    });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
