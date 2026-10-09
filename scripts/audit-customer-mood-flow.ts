// scripts/audit-customer-mood-flow.ts — 気持ちの流れ（app/lib/customer-mood-flow.ts）を実データで確かめる（読むだけ・LLM なし）
//   ①流れの変化（遅く・短く・！が消えた・追った後）× その後（こちらの次の送信に返事が来たか・申込に届いたか）
//   ②気持ちの見立て（決まった計算）× ブレインの emotion（brain_decision_logs.digest.emo）の一致
//   ③気持ち × 竹内さんの返し方（staff_writer='takeuchi' の最初の手打ち・48時間以内）: 長さ・誘い（内覧/申込）・受けの一文・ご検討/ごゆっくり・絵文字
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-mood-flow.ts [--days=120] [--show=離れかけ] [--n=15]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { customerBursts, resolveMoodFlow, type MoodMsg } from "../app/lib/customer-mood-flow";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120")); const SHOW = arg("show", ""); const N = Number(arg("n", "15"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 600_000; i += 1000) { const { data, error } = await q(i); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  return out;
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await all<M>((i) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").order("id").range(i, i + 999));
  const logs = await all<{ conversation_id: string; created_at: string; analyzed_msg_ts: string | null; digest: { emo?: string } | null }>((i) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, digest").gte("created_at", since).not("digest", "is", null).order("created_at").range(i, i + 999));
  const outs = await all<{ conversation_id: string; applied_at: string | null }>((i) => sb.from("deal_outcomes").select("conversation_id, applied_at").not("applied_at", "is", null).range(i, i + 999));
  const appliedAt = new Map<string, number>(); for (const o of outs) { const t = Date.parse(o.applied_at!); const p = appliedAt.get(o.conversation_id); if (p == null || t < p) appliedAt.set(o.conversation_id, t); }
  const { data: convs } = await sb.from("conversations").select("id, status, line_source_type");
  const skip = new Set((convs ?? []).filter((c: any) => c.line_source_type === "group").map((c: any) => c.id));
  const by = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id) || skip.has(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const logBy = new Map<string, typeof logs>(); for (const l of logs) (logBy.get(l.conversation_id) ?? logBy.set(l.conversation_id, []).get(l.conversation_id)!).push(l);

  type Row = { cid: string; at: number; hint: string; downward: number; changes: string[]; reaction: string | null; brainEmo: string | null; next: { replied: boolean | null }; applied: boolean; tk: string | null; quote: string };
  const rows: Row[] = [];
  for (const [cid, list] of by) {
    const mm: MoodMsg[] = list.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated }));
    const bursts = customerBursts(mm);
    // 申込より後の束は数えない
    const ap = appliedAt.get(cid) ?? Infinity;
    let idx = 0;
    for (const b of bursts) {
      const end = Date.parse(b.endAt); const start = Date.parse(b.startAt);
      if (start >= ap) break;
      // この束の終わりまでのメッセージで流れを測る
      while (idx < mm.length && Date.parse(mm[idx].createdAt) <= end) idx++;
      const f = resolveMoodFlow(mm.slice(0, idx));
      if (!f || !f.now.usable) continue;
      // ブレイン: 束の始まり〜終わり+30分に作られた判断の emo（最後の物）
      const bl = (logBy.get(cid) ?? []).filter((l) => { const t = Date.parse(l.created_at); return t >= start && t <= end + 30 * 60_000; }).map((l) => l.digest?.emo).filter((x): x is string => !!x);
      // こちらの次の送信（48時間以内）と、それへの返事
      const after = list.filter((x) => Date.parse(x.created_at) > end);
      const firstStaff = after.find((x) => x.sender !== "customer");
      let replied: boolean | null = null;
      if (firstStaff && Date.parse(firstStaff.created_at) - end <= 48 * 3600_000) {
        const ft = Date.parse(firstStaff.created_at);
        const nextCust = after.find((x) => x.sender === "customer" && Date.parse(x.created_at) > ft);
        replied = nextCust ? Date.parse(nextCust.created_at) - ft <= 7 * 86_400_000 : (Date.now() - ft > 7 * 86_400_000 ? false : null);
      }
      const tkMsg = after.find((x) => x.sender !== "customer" && !x.is_aix_generated && Date.parse(x.created_at) - end <= 48 * 3600_000 && (x.text ?? "").length > 5);
      const tk = tkMsg && tkMsg.staff_writer === "takeuchi" && after.indexOf(tkMsg) === after.findIndex((x) => x.sender !== "customer") ? tkMsg.text : null;
      rows.push({ cid, at: start, hint: f.hint, downward: f.downward, changes: f.changes, reaction: f.reaction ? `${f.reaction.to}:${f.reaction.kind}` : null, brainEmo: bl.length ? bl[bl.length - 1] : null, next: { replied }, applied: ap !== Infinity, tk, quote: f.now.texts.join(" ").replace(/\s+/g, " ").slice(0, 70) });
    }
  }
  console.log(`束（使える・申込より前）: ${rows.length}・会話 ${new Set(rows.map((r) => r.cid)).size}・${DAYS}日`);

  // ① 流れの変化 × その後
  console.log("\n① 下向きの変化の数 × こちらの次の送信に7日以内に返事／その会話が申込に届いた");
  for (const d of [0, 1, 2, 3]) {
    const g = rows.filter((r) => (d === 3 ? r.downward >= 3 : r.downward === d));
    const known = g.filter((r) => r.next.replied != null);
    console.log(`  下向き ${d}${d === 3 ? "+" : ""}: ${g.length}束・返事あり ${pct(known.filter((r) => r.next.replied).length, known.length)}（${known.length}）・申込に届いた会話 ${pct(g.filter((r) => r.applied).length, g.length)}`);
  }
  const ch = new Map<string, Row[]>(); for (const r of rows) for (const c of r.changes) { const k = c.replace(/（.*$/, "").replace(/\d+日に分けて/, "N日に分けて"); (ch.get(k) ?? ch.set(k, []).get(k)!).push(r); }
  console.log("  変化ごと:");
  for (const [k, g] of [...ch].sort((a, b) => b[1].length - a[1].length)) { const known = g.filter((r) => r.next.replied != null); console.log(`    ${k.padEnd(30)} ${g.length}束・返事あり ${pct(known.filter((r) => r.next.replied).length, known.length)}・申込 ${pct(g.filter((r) => r.applied).length, g.length)}`); }
  const rx = new Map<string, Row[]>(); for (const r of rows) if (r.reaction) (rx.get(r.reaction) ?? rx.set(r.reaction, []).get(r.reaction)!).push(r);
  console.log("  前の提案への反応:");
  for (const [k, g] of [...rx].sort((a, b) => b[1].length - a[1].length)) { const known = g.filter((r) => r.next.replied != null); console.log(`    ${k.padEnd(14)} ${g.length}束・返事あり ${pct(known.filter((r) => r.next.replied).length, known.length)}・申込 ${pct(g.filter((r) => r.applied).length, g.length)}`); }

  // ② 見立て × ブレイン
  console.log("\n② 決まった計算の見立て × ブレインの emotion（ブレインの判断がある束）");
  const hs = new Map<string, Map<string, number>>();
  for (const r of rows) if (r.brainEmo) { const m = hs.get(r.hint) ?? hs.set(r.hint, new Map()).get(r.hint)!; m.set(r.brainEmo, (m.get(r.brainEmo) ?? 0) + 1); }
  for (const [h, m] of hs) { const tot = [...m.values()].reduce((a, b) => a + b, 0); console.log(`  ${h.padEnd(5)} ${tot}: ${[...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, tot)}`).join("・")}`); }
  const down2 = rows.filter((r) => r.downward >= 2 && r.brainEmo);
  console.log(`  下向き2以上でブレインが「前向き」: ${down2.filter((r) => r.brainEmo === "前向き").length}/${down2.length}`);

  // ③ 気持ち × 竹内さんの返し方
  console.log("\n③ 見立て × 竹内さんの最初の手打ち（48時間以内・その束の次のこちらの送信が竹内さんの手打ち）");
  const feat = (t: string) => ({
    len: t.replace(/\s/g, "").length,
    invite: /ご内覧|内覧|ご案内させて/.test(t) && /(?:ご案内させて|ご内覧頂|ご都合よろしい)/.test(t),
    apply: /お申込み?(?:頂|いただ|で|し)|お部屋(?:を)?(?:抑え|押さえ)/.test(t),
    receive: /ありがとう御座います|ありがとうございます|ご安心|かしこまりました/.test(t),
    calm: /ごゆっくり|ご検討|お気軽に|いつでも/.test(t),
    emoji: (t.match(/\p{Extended_Pictographic}/gu) ?? []).length,
  });
  const groups = new Map<string, ReturnType<typeof feat>[]>();
  for (const r of rows) if (r.tk) (groups.get(r.hint) ?? groups.set(r.hint, []).get(r.hint)!).push(feat(r.tk));
  for (const [h, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const n = g.length; const lens = g.map((x) => x.len).sort((a, b) => a - b);
    console.log(`  ${h.padEnd(5)} n=${n} 長さ中央 ${lens[Math.floor(n / 2)]}字・内覧の誘い ${pct(g.filter((x) => x.invite).length, n)}・申込 ${pct(g.filter((x) => x.apply).length, n)}・受け ${pct(g.filter((x) => x.receive).length, n)}・ごゆっくり/ご検討/いつでも ${pct(g.filter((x) => x.calm).length, n)}・絵文字0 ${pct(g.filter((x) => x.emoji === 0).length, n)}`);
  }
  const dg = new Map<string, ReturnType<typeof feat>[]>();
  for (const r of rows) if (r.tk) { const k = r.downward >= 2 ? "下向き2+" : r.downward === 1 ? "下向き1" : "変化なし"; (dg.get(k) ?? dg.set(k, []).get(k)!).push(feat(r.tk)); }
  for (const [h, g] of dg) { const n = g.length; const lens = g.map((x) => x.len).sort((a, b) => a - b); console.log(`  ${h.padEnd(7)} n=${n} 長さ中央 ${lens[Math.floor(n / 2)]}字・内覧の誘い ${pct(g.filter((x) => x.invite).length, n)}・申込 ${pct(g.filter((x) => x.apply).length, n)}・受け ${pct(g.filter((x) => x.receive).length, n)}・ごゆっくり等 ${pct(g.filter((x) => x.calm).length, n)}`); }

  if (SHOW) {
    console.log(`\n== 実物（${SHOW}）`);
    for (const r of rows.filter((x) => x.hint === SHOW || x.changes.some((c) => c.includes(SHOW))).slice(-N)) console.log(`  ${new Date(r.at + 9 * 3600e3).toISOString().slice(5, 16)} ${r.cid.slice(0, 6)} 脳=${r.brainEmo ?? "-"} ${r.changes.join("／")}｜「${r.quote}」→ 竹:${(r.tk ?? "-").replace(/\s+/g, " ").slice(0, 80)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
