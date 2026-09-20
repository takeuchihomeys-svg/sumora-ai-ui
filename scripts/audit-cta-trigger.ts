// 2通目に CTA（内覧・申込の誘い）を付けるのはどんな時か（読み取りのみ）
//
// 2026-09-21 竹内「付けるかはブレインが判断する。お客さんの反応見て刺さっているなら、誘導する。
//   成約データや直近の会話を見て分析する」
//
// ■ 先に分かっていること（設計知見）
//   ・purchase_signal_level は**使えない**: 「peak は申込しそうではなく申込したを言っていた」
//     （最初の peak より前に申込済みが10件中8件・中央値 -8.4日＝事後の追認）。
//     段階としても機能せず（strong 7%・soft 0%）、判定がある会話も49%しかない。
//   ・だから「刺さっている」は**お客様の直近の発言**から決定論で見るのが確実。
//     分類は reply-context の classifyCustomerResponse に一本化する（四者同名）。
//
// ■ 測ること
//   AIX の1通目 → 30分以内の2通目 のペアで、**2通目の直前のお客様の発言**を分類し、
//   その分類ごとに「スタッフが2通目に CTA を付けた率」を出す。
//   ＝ スタッフが「刺さっている」と判断した反応が数字で出る。
import { createClient } from "@supabase/supabase-js";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 2通目の CTA（実送信で測った形） */
const CTA_VIEWING = /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます|ご内覧(?:頂|いただ)け|内覧[^\n。！!]{0,8}(?:承り|調整)/;
const CTA_APPLY = /お?申(?:し)?込[^\n。！!]{0,14}(?:押さえ|抑え|完了|進め|手続)/;
const CTA_ANY = new RegExp(`${CTA_VIEWING.source}|${CTA_APPLY.source}`);

async function page(table: string, select: string, order: string, days: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 16; p++) {
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
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const logs = await page("aix_usage_logs", "conversation_id, aix_type, sent_at, created_at", "created_at", days);
  const convIds = [...new Set(logs.map((l) => String(l.conversation_id ?? "")).filter(Boolean))];

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    const chunk = convIds.slice(i, i + 20);
    for (let p = 0; p < 12; p++) {
      const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
        .in("conversation_id", chunk)
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

  const { data: won } = await sb.from("conversations").select("id").eq("status", "closed_won").limit(3000);
  const wonIds = new Set(((won ?? []) as Array<{ id: string }>).map((r) => r.id));

  type Case = { aix: string; kind: string; secondary: string[]; positive: string | null; cta: "viewing" | "apply" | "none"; won: boolean; custText: string; second: string };
  const cases: Case[] = [];
  for (const l of logs) {
    const c = String(l.conversation_id ?? "");
    const t = Date.parse(String(l.sent_at ?? l.created_at));
    const list = byConv.get(c) ?? [];
    const staff = list.filter((m) => m.sender === "staff" && (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    const first = staff.find((m) => Math.abs(Date.parse(m.created_at) - t) <= 5 * 60_000);
    if (!first) continue;
    const ft = Date.parse(first.created_at);
    const second = staff.find((m) => Date.parse(m.created_at) > ft && Date.parse(m.created_at) <= ft + 30 * 60_000);
    if (!second) continue;
    // 2通目の直前のお客様の発言（1通目より前でもよい＝この往復のきっかけ）
    const cust = [...list].reverse().find((m) => m.sender === "customer" && Date.parse(m.created_at) < ft && (m.text ?? "").trim().length > 0);
    if (!cust) continue;
    const custText = String(cust.text ?? "");
    // 分類は返信生成と同じ関数（四者同名）
    const prevStaff = [...list].reverse().find((m) => m.sender === "staff" && Date.parse(m.created_at) < Date.parse(cust.created_at));
    const staffTurn = classifyLastStaffTurn(prevStaff?.text ?? "", { lastStaffAt: prevStaff?.created_at ?? null });
    const sub = analyzeSubstance(custText, undefined, { staffAskedQuestion: staffTurn.kind === "question_to_customer" });
    const cr = classifyCustomerResponse(sub, staffTurn);
    const s2 = String(second.text);
    const cta: Case["cta"] = CTA_APPLY.test(s2) ? "apply" : CTA_VIEWING.test(s2) ? "viewing" : "none";
    cases.push({
      aix: String(l.aix_type ?? "?"), kind: cr.kind, secondary: cr.secondary ?? [],
      positive: cr.positive?.kind ?? null, cta, won: wonIds.has(c), custText, second: s2,
    });
  }

  console.log(`=== 2通目の CTA と「直前のお客様の反応」（直近${days}日 ${cases.length}組）===\n`);
  const withCta = cases.filter((c) => c.cta !== "none");
  console.log(`   CTA あり: ${withCta.length}組 (${pct(withCta.length, cases.length)})  内覧 ${cases.filter((c) => c.cta === "viewing").length} / 申込 ${cases.filter((c) => c.cta === "apply").length}\n`);

  // ── ① お客様の反応の種類ごとの CTA 率 ──
  console.log(`── お客様の反応（classifyCustomerResponse.kind）ごとの CTA 率`);
  console.log(`   ${"反応".padEnd(22)} 件数   CTAあり      内覧      申込`);
  const byKind = new Map<string, Case[]>();
  for (const c of cases) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind)!.push(c);
  }
  const base = withCta.length / cases.length;
  for (const [k, set] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (set.length < 10) continue;
    const n = set.filter((c) => c.cta !== "none").length;
    const d = n / set.length - base;
    const mark = Math.abs(d) >= 0.08 ? (d > 0 ? "  ← 刺さっている" : "  ← 付けない") : "";
    console.log(`   ${k.padEnd(22)} ${String(set.length).padStart(4)}  ${pct(n, set.length).padStart(7)}  ${pct(set.filter((c) => c.cta === "viewing").length, set.length).padStart(7)}  ${pct(set.filter((c) => c.cta === "apply").length, set.length).padStart(7)}${mark}`);
  }

  // ── ② positive の中身ごと ──
  console.log(`\n── 前向きな反応の中身（positive.kind）ごとの CTA 率`);
  const byPos = new Map<string, Case[]>();
  for (const c of cases) {
    const k = c.positive ?? "(なし)";
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k)!.push(c);
  }
  for (const [k, set] of [...byPos.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (set.length < 8) continue;
    const n = set.filter((c) => c.cta !== "none").length;
    console.log(`   ${k.padEnd(22)} ${String(set.length).padStart(4)}  ${pct(n, set.length).padStart(7)}  内覧 ${pct(set.filter((c) => c.cta === "viewing").length, set.length).padStart(6)}  申込 ${pct(set.filter((c) => c.cta === "apply").length, set.length).padStart(6)}`);
  }

  // ── ③ 成約した会話だけ ──
  const wonCases = cases.filter((c) => c.won);
  console.log(`\n── 成約した会話（${wonCases.length}組）の CTA 率: ${pct(wonCases.filter((c) => c.cta !== "none").length, wonCases.length)}`);
  const wonByKind = new Map<string, Case[]>();
  for (const c of wonCases) {
    if (!wonByKind.has(c.kind)) wonByKind.set(c.kind, []);
    wonByKind.get(c.kind)!.push(c);
  }
  for (const [k, set] of [...wonByKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (set.length < 4) continue;
    console.log(`   ${k.padEnd(22)} ${String(set.length).padStart(3)}組  CTA ${pct(set.filter((c) => c.cta !== "none").length, set.length)}`);
  }

  // ── ④ AIX 種類別 ──
  console.log(`\n── AIX 種類別の CTA 率`);
  const byAix = new Map<string, Case[]>();
  for (const c of cases) {
    if (!byAix.has(c.aix)) byAix.set(c.aix, []);
    byAix.get(c.aix)!.push(c);
  }
  for (const [k, set] of [...byAix.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (set.length < 15) continue;
    console.log(`   ${k.padEnd(28)} ${String(set.length).padStart(4)}組  CTA ${pct(set.filter((c) => c.cta !== "none").length, set.length).padStart(7)}  内覧 ${pct(set.filter((c) => c.cta === "viewing").length, set.length).padStart(6)}  申込 ${pct(set.filter((c) => c.cta === "apply").length, set.length).padStart(6)}`);
  }

  // ── ⑤ 実物（CTA を付けた時のお客様の発言）──
  console.log(`\n── CTA を付けた時の「直前のお客様の発言」（12件・目で読む）`);
  for (const c of withCta.slice(0, 12)) {
    console.log(`   [${c.kind}${c.positive ? `/${c.positive}` : ""}] 客「${c.custText.replace(/\n/g, " ").slice(0, 60)}」`);
    console.log(`      → 2通目(${c.cta}): ${c.second.replace(/\n/g, " ／ ").slice(0, 80)}`);
  }
  console.log(`\n── CTA を付けなかった時の発言（8件）`);
  for (const c of cases.filter((x) => x.cta === "none").slice(0, 8)) {
    console.log(`   [${c.kind}${c.positive ? `/${c.positive}` : ""}] 客「${c.custText.replace(/\n/g, " ").slice(0, 60)}」`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
