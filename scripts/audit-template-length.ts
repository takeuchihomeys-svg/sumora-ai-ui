// AIX テンプレート（2通目）の長さ — 生成は実送信に比べてどれだけ長いか（読み取りのみ）
//
// 2026-09-20 竹内「AIX テンプレートで、この会話に合った文を生成ボタン押した際に生成される文が長すぎる。
//   実際の成約データや直近の会話をみて改善する」
//   実物（和樹さん・21:21 の2通目）:
//     「お送りさせて頂きましたお部屋の中でもジーメゾン泉大津ペルファットが特に和樹さんにオススメのお部屋となります！！
//       ペット2匹飼育可能となります😊！！
//       和樹さん達がお気に召されたお部屋ご内覧させて頂きますのでお気軽にお申し付けください😌！！」＝ 約100字・4行
//
// 設計知見「LLM 呼び出しの出口の型: 長さの上限をプロンプトに書く」。
//   ところが aix-template-generate のプロンプトには**長さの指示が1つも無い**。
//   まず実送信で線を引く（AIX 種類別・成約した会話かどうか別）。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const q = (a: number[], p: number) => (a.length ? a[Math.max(0, Math.min(a.length - 1, Math.floor(a.length * p)))] : NaN);
const lines = (s: string) => s.split("\n").filter((x) => x.trim()).length;

async function page(table: string, select: string, order: string, days: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 14; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 120);

  // ── ① 生成文 vs 実送信（AIX 由来の組）──
  const ex = await page("ai_reply_examples", "ai_draft, sent_reply, entry_source, aix_action, conversation_id, created_at", "created_at", days);
  const both = ex.filter((r) => {
    const d = String(r.ai_draft ?? ""), s = String(r.sent_reply ?? "");
    return d && s && d !== "__SHOWN__" && d.length > 6 && s.length > 6 && String(r.entry_source ?? "").includes("aix");
  });
  console.log(`=== ① 生成文と実送信の長さ（AIX 由来 ${both.length}組・直近${days}日）===`);
  const dl = both.map((r) => String(r.ai_draft).length).sort((a, b) => a - b);
  const sl = both.map((r) => String(r.sent_reply).length).sort((a, b) => a - b);
  console.log(`   生成  : 中央値 ${q(dl, 0.5)}字（25% ${q(dl, 0.25)} / 75% ${q(dl, 0.75)} / 90% ${q(dl, 0.9)}）`);
  console.log(`   実送信: 中央値 ${q(sl, 0.5)}字（25% ${q(sl, 0.25)} / 75% ${q(sl, 0.75)} / 90% ${q(sl, 0.9)}）`);
  const diffs = both.map((r) => String(r.sent_reply).length - String(r.ai_draft).length).sort((a, b) => a - b);
  console.log(`   差（実送信 − 生成）: 中央値 ${q(diffs, 0.5)}字（25% ${q(diffs, 0.25)} / 75% ${q(diffs, 0.75)}）`);
  const longer = both.filter((r) => String(r.ai_draft).length > String(r.sent_reply).length + 30).length;
  console.log(`   生成が実送信より30字以上長い: ${longer}組 (${((longer / both.length) * 100).toFixed(1)}%)`);

  // 経路別
  console.log(`\n   --- 経路別（生成 → 実送信 の中央値）---`);
  const byKey = new Map<string, { d: number[]; s: number[] }>();
  for (const r of both) {
    const k = `${r.entry_source} / ${r.aix_action ?? "-"}`;
    if (!byKey.has(k)) byKey.set(k, { d: [], s: [] });
    byKey.get(k)!.d.push(String(r.ai_draft).length);
    byKey.get(k)!.s.push(String(r.sent_reply).length);
  }
  for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1].d.length - a[1].d.length).slice(0, 12)) {
    const d = [...v.d].sort((a, b) => a - b), s = [...v.s].sort((a, b) => a - b);
    const mark = q(d, 0.5) > q(s, 0.5) + 20 ? "  ← 生成が長い" : "";
    console.log(`     ${k.padEnd(40)} ${String(v.d.length).padStart(4)}組  ${String(q(d, 0.5)).padStart(4)}字 → ${String(q(s, 0.5)).padStart(4)}字${mark}`);
  }

  // ── ② AIX の2通目（実送信）の長さ ＝ 目指す形 ──
  //   1通目（AIX）の直後30分以内のスタッフ送信を2通目とみなす
  const logs = await page("aix_usage_logs", "conversation_id, aix_type, sent_at, created_at", "created_at", days);
  const convIds = [...new Set(logs.map((l) => String(l.conversation_id ?? "")).filter(Boolean))];
  const msgs: Array<{ conversation_id: string; text: string | null; created_at: string }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    const chunk = convIds.slice(i, i + 20);
    for (let p = 0; p < 10; p++) {
      const { data } = await sb.from("messages").select("conversation_id, text, created_at")
        .in("conversation_id", chunk).eq("sender", "staff")
        .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
        .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as typeof msgs;
      if (r.length === 0) break;
      msgs.push(...r);
      if (r.length < 1000) break;
    }
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  for (const [, l] of byConv) l.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const seconds: Array<{ aix: string; text: string }> = [];
  for (const l of logs) {
    const c = String(l.conversation_id ?? "");
    const t = Date.parse(String(l.sent_at ?? l.created_at));
    const list = byConv.get(c) ?? [];
    const first = list.find((m) => Math.abs(Date.parse(m.created_at) - t) <= 5 * 60_000 && (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    if (!first) continue;
    const ft = Date.parse(first.created_at);
    const second = list.find((m) => Date.parse(m.created_at) > ft && Date.parse(m.created_at) <= ft + 30 * 60_000 && (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    if (!second) continue;
    seconds.push({ aix: String(l.aix_type ?? "?"), text: String(second.text) });
  }
  console.log(`\n=== ② 実送信の2通目 ${seconds.length}通（目指す長さ）===`);
  const all = seconds.map((s) => s.text.length).sort((a, b) => a - b);
  const allLines = seconds.map((s) => lines(s.text)).sort((a, b) => a - b);
  console.log(`   全体: 中央値 ${q(all, 0.5)}字（25% ${q(all, 0.25)} / 75% ${q(all, 0.75)} / 90% ${q(all, 0.9)}） 行数 中央値 ${q(allLines, 0.5)}行`);
  console.log(`\n   --- AIX 種類別 ---`);
  const byAix = new Map<string, number[]>();
  const byAixLines = new Map<string, number[]>();
  for (const s of seconds) {
    if (!byAix.has(s.aix)) { byAix.set(s.aix, []); byAixLines.set(s.aix, []); }
    byAix.get(s.aix)!.push(s.text.length);
    byAixLines.get(s.aix)!.push(lines(s.text));
  }
  for (const [k, v] of [...byAix.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    const a = [...v].sort((x, y) => x - y);
    const ln = [...(byAixLines.get(k) ?? [])].sort((x, y) => x - y);
    console.log(`     ${k.padEnd(28)} ${String(v.length).padStart(4)}通  中央値 ${String(q(a, 0.5)).padStart(4)}字（75% ${String(q(a, 0.75)).padStart(4)} / 90% ${String(q(a, 0.9)).padStart(4)}） ${q(ln, 0.5)}行`);
  }

  // ── ③ 成約した会話の2通目だけ（＝成約データ）──
  const { data: won } = await sb.from("conversations").select("id").eq("status", "closed_won").limit(2000);
  const wonIds = new Set(((won ?? []) as Array<{ id: string }>).map((r) => r.id));
  const wonSeconds: number[] = [];
  const wonLines: number[] = [];
  for (const l of logs) {
    const c = String(l.conversation_id ?? "");
    if (!wonIds.has(c)) continue;
    const t = Date.parse(String(l.sent_at ?? l.created_at));
    const list = byConv.get(c) ?? [];
    const first = list.find((m) => Math.abs(Date.parse(m.created_at) - t) <= 5 * 60_000 && (m.text ?? "").length > 15);
    if (!first) continue;
    const ft = Date.parse(first.created_at);
    const second = list.find((m) => Date.parse(m.created_at) > ft && Date.parse(m.created_at) <= ft + 30 * 60_000 && (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    if (!second) continue;
    wonSeconds.push(String(second.text).length);
    wonLines.push(lines(String(second.text)));
  }
  wonSeconds.sort((a, b) => a - b); wonLines.sort((a, b) => a - b);
  console.log(`\n=== ③ 成約した会話の2通目 ${wonSeconds.length}通（成約データ）===`);
  console.log(`   中央値 ${q(wonSeconds, 0.5)}字（25% ${q(wonSeconds, 0.25)} / 75% ${q(wonSeconds, 0.75)} / 90% ${q(wonSeconds, 0.9)}） 行数 中央値 ${q(wonLines, 0.5)}行`);

  // ── ④ 竹内さんが見せた実物に近い長さの分布（100字前後は何%か）──
  const band = (lo: number, hi: number) => all.filter((n) => n >= lo && n < hi).length;
  console.log(`\n=== ④ 実送信2通目の長さの分布 ===`);
  for (const [lo, hi] of [[0, 60], [60, 100], [100, 140], [140, 180], [180, 240], [240, 10000]] as Array<[number, number]>) {
    const n = band(lo, hi);
    const bar = "█".repeat(Math.round((n / all.length) * 40));
    console.log(`     ${String(lo).padStart(3)}〜${hi === 10000 ? "   " : String(hi).padStart(3)}字  ${String(n).padStart(4)}通 (${((n / all.length) * 100).toFixed(1)}%) ${bar}`);
  }
  console.log(`\n   ※ 竹内さんが見せた実物（和樹さん）は約100字・4行`);
}
main().catch((e) => { console.error(e); process.exit(1); });
