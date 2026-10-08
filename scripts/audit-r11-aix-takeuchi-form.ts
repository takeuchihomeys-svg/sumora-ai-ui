// scripts/audit-r11-aix-takeuchi-form.ts — 11巡目（10/08 竹内「AIX テンプレートの文の質も竹内が送っている形で。スタッフの方は質があんまりなので、AIX テンプレート竹内の方に寄せる」）
//
//   AIX の種類×ピッカーごとに、竹内さんが送った AIX の通（messages.is_aix_generated・staff_writer='takeuchi'）の多数派の形
//   （冒頭の行・締めの行・決まった言い回しの行・絵文字・改行・長さ）を出し、その時の生成文（aix_generate_log の最後の版）との差の型を件数順に。
//   従業員（employee）の送信は正にしない（数だけ出す）。読むだけ・LLM なし・直さない。
//   生成元を分ける: aix/action（1通目）と aix-template-generate（✨2通目・conditions_snapshot.source）。
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-aix-takeuchi-form.ts [--since=2026-06-26] [--recent=2026-09-15] [--out=scripts/.replay-out/r11-aix-pairs.jsonl] [--key=property_recommendation/新規ピックアップ] [--samples=0]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { catalogKeyOfPress } from "../app/lib/aix-catalog";
import { diffTexts, dice, coreOf, emojisOf, newlineOf, DIFF_TYPE_JA, type DiffType } from "../app/lib/text-diff-types";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-06-26T00:00:00Z");
const RECENT = arg("recent", "2026-09-15T00:00:00Z");
const OUT = arg("out", "scripts/.replay-out/r11-aix-pairs.jsonl");
const ONLY = arg("key", "");
const SAMPLES = Number(arg("samples", "0"));
const RECENT_ONLY = process.argv.includes("--recent-only");
const ms = (s: string) => Date.parse(s);
const mask = (s: string) => s.replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/https?:\/\/\S+/g, "〈URL〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉");
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 900_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
type P = { conversation_id: string; aix_type: string; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; created_at: string };
type M = { conversation_id: string; created_at: string; text: string | null; staff_writer: string | null; sender: string; is_aix_generated: boolean | null };
type G = { conversation_id: string; action_type: string; generated_text: string | null; generated_at: string; conditions_snapshot: Record<string, unknown> | null };

/** 行の型（名前・物件名・数字を伏せる）＝決まった言い回しの行を数える物差し */
export function lineShape(line: string, names: string[]): string {
  let s = line.normalize("NFKC").trim();
  for (const n of names) if (n && n.length >= 2) s = s.split(n).join("〇〇");
  s = s.replace(/^[^\s、。！!？?]{1,14}さん/, "〇〇さん");
  s = s.replace(/【[^】]{1,40}】/g, "【物件】").replace(/🌟[^\n]{1,50}/g, "🌟物件");
  s = s.replace(/[0-9][0-9,.]*/g, "N").replace(/\s+/g, "");
  return s.slice(0, 60);
}
const OSEWA = /お世話になっております/;
function openerOf(t: string): string {
  const f = (t.trim().split(/\n/)[0] ?? "").normalize("NFKC");
  if (/^🌟/.test(f)) return "🌟物件名";
  if (/^【/.test(f)) return "【物件名】";
  if (/^[①-⑳]/.test(f)) return "①【物件名】";
  if (/^[^\s、。！!]{1,14}さん(?:お世話になっております)/.test(f)) return "〇〇さんお世話になっております";
  if (/^[^\s、。！!]{1,14}さん(?:お待たせ)/.test(f)) return "〇〇さんお待たせ致しました";
  if (/^[^\s、。！!]{1,14}さん[！!]*$/.test(f)) return "〇〇さん（改行）";
  if (/^[^\s、。！!]{1,14}さん/.test(f)) return "〇〇さん＋本文";
  if (OSEWA.test(f)) return "お世話になっております";
  if (/^お待たせ/.test(f)) return "お待たせ致しました";
  if (/^はい/.test(f)) return "はい";
  if (/^かしこまりました/.test(f)) return "かしこまりました";
  if (/^(?:ご連絡)?ありがとうございます/.test(f)) return "ありがとうございます";
  if (/^(?:新着で)/.test(f)) return "新着で…";
  if (/^お送り/.test(f)) return "お送り…";
  return `その他:${f.slice(0, 12)}`;
}
function closerOf(t: string): string {
  const ls = t.trim().split(/\n/).map((x) => x.trim()).filter(Boolean);
  const l = (ls[ls.length - 1] ?? "").normalize("NFKC");
  if (/お手隙の際にご査収/.test(l)) return "お手隙の際にご査収ください";
  if (/お手隙の際にご確認/.test(l)) return "お手隙の際にご確認ください";
  if (/ご都合よろしい(?:お)?日にち/.test(l)) return "ご都合よろしいお日にち…（内覧誘導）";
  if (/お申込み?(?:し|で)?お部屋(?:抑|押)/.test(l)) return "お申込みでお部屋抑え…（申込誘導）";
  if (/何卒よろしくお願い/.test(l)) return "何卒よろしくお願い致します";
  if (/よろしくお願い/.test(l)) return "よろしくお願い致します";
  if (/^※/.test(l)) return "※注記";
  if (/節約出来ます/.test(l)) return "節約出来ます";
  if (/^[・]/.test(l)) return "・箇条書き";
  return `その他:${l.slice(0, 14)}`;
}
const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m: Map<string, number>, n: number, total: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} ${c}（${Math.round((c / Math.max(1, total)) * 100)}%）`).join("｜");

(async () => {
  const [ps, msgs, gens] = await Promise.all([
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, generated_text, created_at").gte("created_at", SINCE).order("created_at").range(f, t)),
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, created_at, text, staff_writer, sender, is_aix_generated").neq("sender", "customer").gte("created_at", SINCE).order("created_at").range(f, t)),
    readAll<G>((f, t) => sb.from("aix_generate_log").select("conversation_id, action_type, generated_text, generated_at, conditions_snapshot").gte("generated_at", SINCE).not("generated_text", "is", null).order("generated_at").range(f, t)),
  ]);
  const convIds = [...new Set(ps.map((p) => p.conversation_id))];
  const names = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null }>) names.set(c.id, c.customer_name ?? "");
  }
  const gBy = new Map<string, G[]>(); for (const g of gens) { const k = `${g.conversation_id}|${g.action_type}`; if (!gBy.has(k)) gBy.set(k, []); gBy.get(k)!.push(g); }
  const mBy = new Map<string, M[]>(); for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }

  type Row = { key: string; src: "action" | "template"; writer: string; at: string; conv: string; sim: number; same: boolean; types: DiffType[]; gen: string; sent: string; added: string[]; removed: string[] };
  const rows: Row[] = [];
  // 竹内さんの送信の形（押下ごとの送った文の通・生成と組にならなくても数える）
  type Sent = { key: string; writer: string; at: string; text: string; conv: string; src: "action" | "template" | "?" };
  const sents: Sent[] = [];
  const usedMsg = new Set<string>();
  for (const p of ps) {
    if (isTestConversation(p.conversation_id)) continue;
    const pt = ms(p.created_at);
    const okText = (m: M) => (m.text ?? "").trim().length >= 10 && !/^\[(?:画像|動画|ファイル)\]/.test(m.text ?? "");
    const candsAction = (mBy.get(p.conversation_id) ?? []).filter((m) => m.is_aix_generated && ms(m.created_at) >= pt - 15 * 60_000 && ms(m.created_at) <= pt + 20 * 60_000 && okText(m));
    // ✨2通目（aix-template-generate）は押下の後に作られ、テンプレの画面から送る（is_aix_generated が付かない）＝スタッフの通を広く
    const candsTpl = (gt: number) => (mBy.get(p.conversation_id) ?? []).filter((m) => ms(m.created_at) >= gt - 60_000 && ms(m.created_at) <= gt + 30 * 60_000 && okText(m));
    const gl = (gBy.get(`${p.conversation_id}|${p.aix_type}`) ?? []).filter((x) => {
      const isTpl = String(x.conditions_snapshot?.source ?? "") === "aix-template-generate";
      return isTpl ? ms(x.generated_at) >= pt - 5 * 60_000 && ms(x.generated_at) <= pt + 40 * 60_000 : ms(x.generated_at) <= pt + 60_000 && ms(x.generated_at) >= pt - 60 * 60_000;
    });
    const lastOf = (src: "action" | "template") => gl.filter((g) => (String(g.conditions_snapshot?.source ?? "") === "aix-template-generate") === (src === "template")).pop();
    const keyText = String(lastOf("action")?.generated_text ?? p.generated_text ?? "");
    const key = catalogKeyOfPress({ ...p, text: keyText }).key;
    const nm = names.get(p.conversation_id) ?? "";
    for (const src of ["action", "template"] as const) {
      const g = lastOf(src);
      const gen = String(g?.generated_text ?? "").trim(); if (gen.length < 10) continue;
      const cands = src === "action" ? candsAction : candsTpl(ms(g!.generated_at));
      const best = cands.map((m) => ({ m, s: dice(coreOf(gen), coreOf(m.text ?? "")) })).sort((a, b) => b.s - a.s)[0];
      if (!best || best.s < 0.25) continue;
      const mk = `${best.m.conversation_id}|${best.m.created_at}`;
      if (usedMsg.has(mk)) continue; usedMsg.add(mk);
      const d = diffTexts(gen, best.m.text ?? "");
      rows.push({ key, src, writer: best.m.staff_writer ?? "unknown", at: p.created_at, conv: p.conversation_id, sim: d.sim, same: d.same || d.sameCore, types: d.types, gen: mask(gen), sent: mask(best.m.text ?? ""), added: d.detail.added, removed: d.detail.removed });
      sents.push({ key, writer: best.m.staff_writer ?? "unknown", at: best.m.created_at, text: best.m.text ?? "", conv: p.conversation_id, src });
      void nm;
    }
  }
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`# AIX の生成文×実送信（${SINCE.slice(0, 10)}〜・近い期間 ${RECENT.slice(0, 10)}〜）組 ${rows.length}（竹内さん ${rows.filter((r) => r.writer === "takeuchi").length}・従業員 ${rows.filter((r) => r.writer === "employee").length}）→ ${OUT}`);

  const groups = new Map<string, Row[]>();
  for (const r of rows) { const k = `${r.key.split("/").slice(0, 2).join("/")}［${r.src === "template" ? "✨2通目" : "1通目"}］`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    if (ONLY && !k.startsWith(ONLY)) continue;
    const tk = rs.filter((r) => r.writer === "takeuchi" && (!RECENT_ONLY || r.at >= RECENT));
    if (tk.length < 3) continue;
    const tkR = tk.filter((r) => r.at >= RECENT);
    const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "-");
    console.log(`\n## ${k}  組 ${rs.length}（竹内 ${tk.length}・うち ${RECENT.slice(5, 10)}〜 ${tkR.length}・従業員 ${rs.filter((r) => r.writer === "employee").length}）`);
    console.log(`  そのまま 竹内 ${tk.filter((r) => r.same).length}/${tk.length}（近い期間 ${tkR.filter((r) => r.same).length}/${tkR.length}）・似ている度 竹内 ${avg(tk.map((r) => r.sim))}（近い期間 ${avg(tkR.map((r) => r.sim))}）`);
    // 竹内さんの送信の形
    const op = new Map<string, number>(), cl = new Map<string, number>(), em = new Map<string, number>(), ln = new Map<string, number>(), shape = new Map<string, number>();
    const gop = new Map<string, number>(), gcl = new Map<string, number>(), gshape = new Map<string, number>();
    for (const r of tk) {
      const nmList = [names.get(r.conv) ?? ""];
      bump(op, openerOf(r.sent)); bump(cl, closerOf(r.sent));
      bump(gop, openerOf(r.gen)); bump(gcl, closerOf(r.gen));
      const e = emojisOf(r.sent); bump(em, e.length ? [...new Set(e)].join("") : "なし");
      const nl = newlineOf(r.sent); bump(ln, `${Math.min(nl.lines, 12)}行・空行${Math.min(nl.blank, 4)}`);
      for (const l of new Set(r.sent.split("\n").map((x) => lineShape(x, nmList)).filter((x) => x.length >= 4))) bump(shape, l);
      for (const l of new Set(r.gen.split("\n").map((x) => lineShape(x, nmList)).filter((x) => x.length >= 4))) bump(gshape, l);
    }
    console.log(`  冒頭 竹内: ${top(op, 4, tk.length)}\n  冒頭 生成: ${top(gop, 4, tk.length)}`);
    console.log(`  締め 竹内: ${top(cl, 4, tk.length)}\n  締め 生成: ${top(gcl, 4, tk.length)}`);
    console.log(`  絵文字 竹内: ${top(em, 4, tk.length)}｜行 竹内: ${top(ln, 3, tk.length)}`);
    // 決まった言い回しの行（竹内さんの送信で 25%以上）と生成での割合
    const fixed = [...shape].filter(([, c]) => c >= Math.max(2, tk.length * 0.25)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  竹内さんの決まった行（25%以上）／生成の同じ行:`);
    for (const [l, c] of fixed) console.log(`    ${Math.round((c / tk.length) * 100)}%／${Math.round(((gshape.get(l) ?? 0) / tk.length) * 100)}%  「${l}」`);
    const genOnly = [...gshape].filter(([l, c]) => c >= Math.max(2, tk.length * 0.2) && (shape.get(l) ?? 0) < c * 0.5).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (genOnly.length) { console.log(`  生成に多く竹内さんが残さない行（生成 20%以上・竹内さん半分未満）:`); for (const [l, c] of genOnly) console.log(`    生成 ${Math.round((c / tk.length) * 100)}%／竹内 ${Math.round(((shape.get(l) ?? 0) / tk.length) * 100)}%  「${l}」`); }
    const tc = new Map<string, number>(); for (const r of tk.filter((x) => !x.same)) for (const t of r.types) bump(tc, DIFF_TYPE_JA[t]);
    console.log(`  差の型（竹内さんの直し）: ${top(tc, 8, tk.length)}`);
    const norm = (s: string) => coreOf(s).replace(/[0-9０-９]+/g, "N").slice(0, 40);
    const add = new Map<string, number>(), rem = new Map<string, number>();
    for (const r of tk.filter((x) => !x.same)) { for (const a of new Set(r.added.map(norm))) bump(add, a); for (const a of new Set(r.removed.map(norm))) bump(rem, a); }
    const t2 = (m: Map<string, number>) => [...m].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, c]) => `「${mask(s)}」${c}`).join("・") || "-";
    console.log(`  足した: ${t2(add)}\n  消した: ${t2(rem)}`);
    for (const r of (SAMPLES ? tk.filter((x) => !x.same).slice(-SAMPLES) : [])) console.log(`    例 ${r.at.slice(0, 10)} 生成「${r.gen.replace(/\n/g, "⏎").slice(0, 200)}」\n               送信「${r.sent.replace(/\n/g, "⏎").slice(0, 200)}」`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
