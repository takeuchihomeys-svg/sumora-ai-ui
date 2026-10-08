// scripts/audit-r10-aix-text-vs-sent.ts — 10巡目（10/08 竹内「AIX での文も実際送っているように送るために、改善した方が良い部分が分かれば俺に送って」）
//   AIX の生成文（aix_generate_log.generated_text＝作った時の文。aix_usage_logs.generated_text は送った文で上書きされている＝10/08 に全部同じと分かった）と、実際にお客様へ送った AIX の通（messages.is_aix_generated・同じ会話・押下の前後）の差を
//   ボタン×ピッカー（aix-catalog.catalogKeyOfPress）ごと・書き手（竹内さん／従業員）ごとに型（text-diff-types.diffTexts）で数える。読むだけ・LLM なし・直さない。
// 実行: npx tsx --env-file=.env.local scripts/audit-r10-aix-text-vs-sent.ts [--since=2026-06-26] [--samples=2]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { catalogKeyOfPress } from "../app/lib/aix-catalog";
import { diffTexts, dice, coreOf, DIFF_TYPE_JA, type DiffType } from "../app/lib/text-diff-types";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-06-26T00:00:00Z");
const SAMPLES = Number(arg("samples", "2"));
const ms = (s: string) => Date.parse(s);
const mask = (s: string) => s.replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/https?:\/\/\S+/g, "〈URL〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉");
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 900_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
type P = { conversation_id: string; aix_type: string; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; created_at: string; was_edited: boolean | null };
type M = { conversation_id: string; created_at: string; text: string | null; staff_writer: string | null };
(async () => {
  type G = { conversation_id: string; action_type: string; generated_text: string | null; generated_at: string };
  const [ps, msgs, gens] = await Promise.all([
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, generated_text, created_at, was_edited").gte("created_at", SINCE).not("generated_text", "is", null).order("created_at").range(f, t)),
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, created_at, text, staff_writer").eq("is_aix_generated", true).gte("created_at", SINCE).order("created_at").range(f, t)),
    readAll<G>((f, t) => sb.from("aix_generate_log").select("conversation_id, action_type, generated_text, generated_at").gte("generated_at", SINCE).not("generated_text", "is", null).order("generated_at").range(f, t)),
  ]);
  const gBy = new Map<string, G[]>(); for (const g of gens) { const k = `${g.conversation_id}|${g.action_type}`; if (!gBy.has(k)) gBy.set(k, []); gBy.get(k)!.push(g); }
  const mBy = new Map<string, M[]>(); for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  type Row = { key: string; writer: string; same: boolean; sim: number; types: DiffType[]; gen: string; sent: string; added: string[]; removed: string[] };
  const rows: Row[] = [];
  for (const p of ps) {
    if (isTestConversation(p.conversation_id)) continue;
    // 押した時刻の前60分以内の、同じ会話・同じボタンの最後の生成（作り直した時は最後の版＝スタッフが見て直した元）
    const g = (gBy.get(`${p.conversation_id}|${p.aix_type}`) ?? []).filter((x) => ms(x.generated_at) <= ms(p.created_at) + 60_000 && ms(x.generated_at) >= ms(p.created_at) - 60 * 60_000).pop();
    const gen = String(g?.generated_text ?? "").trim(); if (gen.length < 10) continue;
    const cands = (mBy.get(p.conversation_id) ?? []).filter((m) => ms(m.created_at) >= ms(p.created_at) - 15 * 60_000 && ms(m.created_at) <= ms(p.created_at) + 20 * 60_000 && (m.text ?? "").trim().length >= 10 && !/^\[(?:画像|動画|ファイル)\]/.test(m.text ?? ""));
    if (!cands.length) continue;
    // 生成文に一番近い通（AIX は画像＋文の複数通。文の通だけ）
    const best = cands.map((m) => ({ m, s: dice(coreOf(gen), coreOf(m.text ?? "")) })).sort((a, b) => b.s - a.s)[0];
    if (best.s < 0.25) continue; // 別の通（資料の文・2通目の固定文）
    const d = diffTexts(gen, best.m.text ?? "");
    rows.push({ key: catalogKeyOfPress({ ...p, text: gen }).key, writer: best.m.staff_writer ?? "unknown", same: d.same || d.sameCore, sim: d.sim, types: d.types, gen, sent: best.m.text ?? "", added: d.detail.added, removed: d.detail.removed });
  }
  const groups = new Map<string, Row[]>(); for (const r of rows) { const k = r.key.split("/").slice(0, 2).join("/"); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  console.log(`# AIX の生成文×実送信（${SINCE.slice(0, 10)}〜）組 ${rows.length}（竹内さん ${rows.filter((r) => r.writer === "takeuchi").length}・従業員 ${rows.filter((r) => r.writer === "employee").length}）`);
  console.log(`ボタン×ピッカー｜n（竹内）｜そのまま（芯が同じ）全体／竹内｜似ている度 竹内｜竹内さんの直しの型 上位`);
  for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    if (rs.length < 3) continue;
    const tk = rs.filter((r) => r.writer === "takeuchi");
    const tc = new Map<string, number>(); for (const r of tk.filter((x) => !x.same)) for (const t of r.types) tc.set(t, (tc.get(t) ?? 0) + 1);
    const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "-");
    console.log(`  ${k.padEnd(44)} n=${String(rs.length).padStart(3)}（${tk.length}）｜${Math.round((rs.filter((r) => r.same).length / rs.length) * 100)}%／${tk.length ? Math.round((tk.filter((r) => r.same).length / tk.length) * 100) : "-"}%｜${avg(tk.map((r) => r.sim))}｜${[...tc].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${DIFF_TYPE_JA[t as DiffType]} ${c}`).join("・")}`);
  }
  console.log(`\n## 竹内さんが足した文・消した文（ボタンごとに多い物・2回以上）`);
  for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const tk = rs.filter((r) => r.writer === "takeuchi" && !r.same); if (tk.length < 3) continue;
    const norm = (s: string) => coreOf(s).replace(/[0-9０-９]+/g, "N").slice(0, 40);
    const add = new Map<string, number>(), rem = new Map<string, number>();
    for (const r of tk) { for (const a of new Set(r.added.map(norm))) add.set(a, (add.get(a) ?? 0) + 1); for (const a of new Set(r.removed.map(norm))) rem.set(a, (rem.get(a) ?? 0) + 1); }
    const top = (m: Map<string, number>) => [...m].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, c]) => `「${mask(s)}」${c}`).join("・") || "-";
    console.log(`  ${k}（竹内さんが直した ${tk.length}）\n    足した: ${top(add)}\n    消した: ${top(rem)}`);
    for (const r of tk.slice(0, SAMPLES)) console.log(`    例 生成「${mask(r.gen).replace(/\n/g, "⏎").slice(0, 110)}」\n       送信「${mask(r.sent).replace(/\n/g, "⏎").slice(0, 110)}」`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
