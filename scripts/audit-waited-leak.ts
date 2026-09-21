// 「お待たせ致しました」が下書きに残っているのは漏れか、正しい場面か（読み取りのみ）
//
// 2026-09-21 竹内「お待たせ致しましたが下書きに残る経路を塞ぐ」
//
// ⚠ 先に設計知見を引いた結果、これは単純な禁止語ではない:
//   「禁止語は場面ごとに線を引く — 同じ語がAIXでは正しく通常返信では誤りだった」
//   「足した」が多い語は消してはいけない語（スタッフがわざわざ手で書いている）
//   60日1,805件の実測: 見積書送る 残21/消0/**足16** ／ 内覧日調整 残1/**消14**/足0 ／ 通常返信 0/**消5**/足1
//
// なので測るのは「何通あるか」ではなく **経路 × スタッフがどうしたか（残した/消した/足した）**。
//   消した が多い経路 = 漏れ（塞ぐ）
//   足した が多い経路 = 正しい（触らない）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-waited-leak.ts
import { createClient } from "@supabase/supabase-js";
import { isWaitedAllowed } from "../app/lib/waited-scope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";
const WAITED = /お待たせ(?:致|いた)?しました/;
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const ex = await page("ai_reply_examples",
    "id, ai_draft, sent_reply, entry_source, aix_action, was_ai_used, created_at", "created_at", days);
  const pairs = ex.filter((r) => {
    const d = String(r.ai_draft ?? "").trim(), s = String(r.sent_reply ?? "").trim();
    return d && s && !/^\[|^__/.test(d);
  });
  console.log(`=== 材料: 下書きと実送信が揃う ${pairs.length}件（直近${days}日）===\n`);

  // 経路 × 残した/消した/足した
  type Cell = { kept: number; removed: number; added: number; none: number };
  const byRoute = new Map<string, Cell>();
  const removedEx: string[] = [], addedEx: string[] = [];
  for (const r of pairs) {
    const d = WAITED.test(String(r.ai_draft)), s = WAITED.test(String(r.sent_reply));
    const action = String(r.aix_action ?? "").trim();
    const key = `${r.entry_source ?? "(不明)"}${action ? ` / ${action}` : ""}`;
    const c = byRoute.get(key) ?? { kept: 0, removed: 0, added: 0, none: 0 };
    if (d && s) c.kept++;
    else if (d && !s) { c.removed++; if (removedEx.length < 6) removedEx.push(`     [${key}]\n     下書き: ${mask(String(r.ai_draft)).slice(0, 110)}\n     実送信: ${mask(String(r.sent_reply)).slice(0, 110)}`); }
    else if (!d && s) { c.added++; if (addedEx.length < 4) addedEx.push(`     [${key}] 実送信: ${mask(String(r.sent_reply)).slice(0, 110)}`); }
    else c.none++;
    byRoute.set(key, c);
  }

  console.log(`=== ① 経路 × スタッフがどうしたか ===`);
  console.log(`   残した / 消した / 足した   経路                              判定`);
  const rows = [...byRoute.entries()].filter(([, c]) => c.kept + c.removed + c.added > 0)
    .sort((a, b) => (b[1].kept + b[1].removed + b[1].added) - (a[1].kept + a[1].removed + a[1].added));
  for (const [k, c] of rows) {
    const tot = c.kept + c.removed + c.added;
    const verdict = c.removed > c.kept + c.added ? "⚠ **漏れ**（スタッフが消している）"
      : c.added > 0 ? "✅ 正しい場面（スタッフが足している）"
      : c.kept > 0 ? "✅ 残している" : "";
    console.log(`   ${String(c.kept).padStart(4)} / ${String(c.removed).padStart(4)} / ${String(c.added).padStart(4)}   ${k.padEnd(34)} ${verdict}（対象${tot}件）`);
  }

  console.log(`\n=== ② 仕組みの線（waited-scope）と合っているか ===`);
  console.log(`   ${"経路".padEnd(36)} 仕組みは許しているか   実際にスタッフは`);
  for (const [k, c] of rows) {
    const action = k.includes(" / ") ? k.split(" / ")[1] : "";
    const allowed = action ? isWaitedAllowed(action) : false;
    const tot = c.kept + c.removed + c.added;
    if (tot < 2) continue;
    const staffKeeps = (c.kept + c.added) >= c.removed;
    const agree = allowed === staffKeeps;
    console.log(`   ${k.padEnd(36)} ${allowed ? "許す  " : "消す  "}            ${staffKeeps ? "残す/足す" : "消す    "}  ${agree ? "✅ 一致" : "❌ **食い違い**"}`);
  }

  console.log(`\n=== ③ 消された実物（漏れの候補・目で読む）===`);
  for (const s of removedEx) { console.log(`${"─".repeat(74)}`); console.log(s); }
  console.log(`\n=== ④ 足された実物（消してはいけない証拠）===`);
  for (const s of addedEx) { console.log(`${"─".repeat(74)}`); console.log(s); }

  console.log(`\n=== ⑤ 直近14日だけ（直した効果は時系列で）===`);
  const recent = pairs.filter((r) => Date.now() - new Date(String(r.created_at)).getTime() < 14 * 86400_000);
  let rk = 0, rr = 0, ra = 0;
  for (const r of recent) {
    const d = WAITED.test(String(r.ai_draft)), s = WAITED.test(String(r.sent_reply));
    if (d && s) rk++; else if (d && !s) rr++; else if (!d && s) ra++;
  }
  console.log(`   直近14日 ${recent.length}件: 残した ${rk} / 消した ${rr} / 足した ${ra}`);
  console.log(`   → 消した が多ければまだ漏れている。足した が多ければ消しすぎ`);

  // ⑥ 日別（waited-scope を入れたのは 2026-09-20。前後で分ける）
  console.log(`\n=== ⑥ 日別（JST）— waited-scope を入れたのは 2026-09-20 ===`);
  const day = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const byDay = new Map<string, { n: number; k: number; r: number; a: number; inDraft: number }>();
  for (const r of pairs) {
    const d = day(String(r.created_at));
    const b = byDay.get(d) ?? { n: 0, k: 0, r: 0, a: 0, inDraft: 0 };
    b.n++;
    const hasD = WAITED.test(String(r.ai_draft)), hasS = WAITED.test(String(r.sent_reply));
    if (hasD) b.inDraft++;
    if (hasD && hasS) b.k++; else if (hasD && !hasS) b.r++; else if (!hasD && hasS) b.a++;
    byDay.set(d, b);
  }
  console.log(`   日付        件数   下書きに有り        残/消/足`);
  for (const [d, v] of [...byDay.entries()].sort().slice(-14)) {
    const mark = d >= "2026-09-20" ? "  ← 直した後" : "";
    console.log(`   ${d}  ${String(v.n).padStart(4)}  ${String(v.inDraft).padStart(4)}件 (${pct(v.inDraft, v.n).padStart(6)})   ${v.k}/${v.r}/${v.a}${mark}`);
  }

  // ⑦ 許す場面なのに AI が書いていない（＝スタッフが手で足している）を経路別に
  console.log(`\n=== ⑦ 「許す場面なのに AI が書いていない」＝スタッフが手で足す手間 ===`);
  const addBy = new Map<string, { add: number; tot: number; allowed: boolean }>();
  for (const r of pairs) {
    const action = String(r.aix_action ?? "").trim();
    if (!action) continue;
    const key = action;
    const b = addBy.get(key) ?? { add: 0, tot: 0, allowed: isWaitedAllowed(action) };
    b.tot++;
    if (!WAITED.test(String(r.ai_draft)) && WAITED.test(String(r.sent_reply))) b.add++;
    addBy.set(key, b);
  }
  for (const [k, v] of [...addBy.entries()].filter(([, v]) => v.add > 0).sort((a, b) => b[1].add - a[1].add)) {
    console.log(`   ${k.padEnd(34)} 足した ${String(v.add).padStart(3)}/${String(v.tot).padEnd(4)} (${pct(v.add, v.tot)})  仕組みは${v.allowed ? "許す" : "**消す**"}`);
  }
  console.log(`   → 「許す」場面で足しているのは、AI が書いていないから（プロンプトで書かせる余地）`);

  // ⑧ 【本命】場面ごとに「実送信に入っている率」と「AI が書いている率」を並べる
  //    材料として渡す率はここから取る（設計知見「率の表を渡してモデルに選ばせる」）
  console.log(`\n=== ⑧ 場面ごとの率（実送信 vs AI の下書き）— 材料に使う数字 ===`);
  const byAction = new Map<string, { tot: number; sent: number; draft: number; allowed: boolean }>();
  for (const r of pairs) {
    const action = String(r.aix_action ?? "").trim() || (String(r.entry_source ?? "") === "line_reply" ? "（通常返信）" : "");
    if (!action) continue;
    const b = byAction.get(action) ?? { tot: 0, sent: 0, draft: 0, allowed: action === "（通常返信）" ? false : isWaitedAllowed(action) };
    b.tot++;
    if (WAITED.test(String(r.sent_reply))) b.sent++;
    if (WAITED.test(String(r.ai_draft))) b.draft++;
    byAction.set(action, b);
  }
  console.log(`   場面                               件数   実送信に有り    AI が書く     差`);
  for (const [k, v] of [...byAction.entries()].filter(([, v]) => v.tot >= 10).sort((a, b) => b[1].sent / b[1].tot - a[1].sent / a[1].tot)) {
    const sr = v.sent / v.tot, dr = v.draft / v.tot;
    const gap = (sr - dr) * 100;
    const mark = v.allowed && gap >= 10 ? "  ⚠ AI が書けていない" : !v.allowed && dr > 0.02 ? "  ⚠ 消せていない" : "";
    console.log(`   ${k.padEnd(34)} ${String(v.tot).padStart(4)}  ${pct(v.sent, v.tot).padStart(7)}     ${pct(v.draft, v.tot).padStart(7)}   ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pt${mark}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
