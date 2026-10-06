// scripts/audit-aix-template-gen-vs-sent.ts
// ✨テンプレート生成（aix-template-generate・AIX の2通目／テンプレート）が作った文（aix_generate_log）と、
// その後 30分以内にスタッフが同じ会話で実際に送った文（messages）を並べて、ズレを数える（読むだけ・LLM なし・費用0）。
// AIX 本体（aix/action）の下書きと送った文は scripts/audit-aix-draft-vs-sent.ts（ai_reply_examples の組）。
//
// 2026-10-06 竹内「AIXテンプレートのズレの問題。質がかなり低い。…実際のLINEと比べて根本的にずれている部分をみつけて改善する」
// ■ 組の作り方: 生成1回 → 生成の後 30分以内のスタッフの送信のうち一番近い1通（2文字組の Dice）。0.5 未満は「使っていない（別の文を送った）」
// ■ 個人情報: 名前・数字を伏せた行だけ出す。会話 ID は出さない。YUMA は外す
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-template-gen-vs-sent.ts [--days=60] [--show=8] [--source=aix-template-generate|aix-action]
import { createClient } from "@supabase/supabase-js";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "60"), 10);
const SHOW = parseInt(String(args.show ?? "8"), 10);
const SRC = String(args.source ?? "aix-template-generate");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const norm = (s: string) => String(s ?? "").replace(EMOJI, "").replace(/[\s　]+/g, "").trim();
const maskLine = (l: string) => String(l ?? "").replace(EMOJI, "").replace(/https?:\/\/\S+/g, "<URL>").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "<TEL>")
  .replace(/[^\s、。！!？?・「」『』（）()]{1,12}(さん|様|さま)/g, "〇〇$1").replace(/[0-9０-９][0-9０-９,，.．]*/g, "#").replace(/[\s　]+/g, " ").trim();
const lines = (s: string) => String(s ?? "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
function dice(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x && !y) return 1; if (!x || !y) return 0;
  const bg = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = bg(x), B = bg(y); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 1;
}
const kept = (l: string, other: string[]) => other.some((o) => norm(o) === norm(l) || dice(o, l) >= 0.8);

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  let q = sb.from("aix_generate_log").select("id, action_type, conversation_id, status, generated_text, created_at, conditions_snapshot").gte("created_at", since).neq("conversation_id", YUMA_CONVERSATION_ID).not("generated_text", "is", null).order("id").limit(5000);
  q = SRC === "aix-template-generate" ? q.eq("conditions_snapshot->>source", "aix-template-generate") : q.is("conditions_snapshot->>source", null);
  const { data: gens, error } = await q;
  if (error) throw new Error(error.message);
  const G = (gens ?? []) as Row[];
  const convs = [...new Set(G.map((g) => String(g.conversation_id)))];
  const msgs: Row[] = [];
  // ⚠ 1回の select は 1000行で切れる（PostgREST の上限）→ ページを送って全部読む
  for (let i = 0; i < convs.length; i += 30) {
    for (let p = 0; p < 200; p++) {
      const { data, error: e2 } = await sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", convs.slice(i, i + 30)).neq("sender", "customer").gte("created_at", since).order("id").range(p * 1000, p * 1000 + 999);
      if (e2) throw new Error(e2.message);
      msgs.push(...((data ?? []) as Row[]));
      if (!data || data.length < 1000) break;
    }
  }
  const byConv = new Map<string, Row[]>(); for (const m of msgs) { const k = String(m.conversation_id); if (!byConv.has(k)) byConv.set(k, []); byConv.get(k)!.push(m); }
  type P = { type: string; scen: string; gen: string; sent: string | null; d: number };
  const pairs: P[] = [];
  for (const g of G) {
    const t = Date.parse(g.created_at);
    const cand = (byConv.get(String(g.conversation_id)) ?? []).filter((m) => m.text && Date.parse(m.created_at) >= t - 60_000 && Date.parse(m.created_at) <= t + 30 * 60_000);
    let best: Row | null = null, bd = 0;
    for (const m of cand) { const d = dice(g.generated_text, m.text); if (d > bd) { bd = d; best = m; } }
    pairs.push({ type: String(g.action_type ?? "-"), scen: String(g.conditions_snapshot?.scenario ?? g.check_pattern ?? "-"), gen: String(g.generated_text), sent: best?.text ?? null, d: bd });
  }
  const groups = new Map<string, P[]>(); for (const p of pairs) { const k = `${p.type}${p.scen !== "-" ? `/${p.scen}` : ""}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(p); }
  console.log(`=== ${SRC}（${DAYS}日・生成 ${pairs.length}）: 生成 → 30分以内の一番近いスタッフの送信 ===`);
  console.log(`種類/場面                                  生成  使った(近さ≥0.5)  そのまま  近さ(使った)  長さ比(使った)`);
  for (const [k, xs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    if (xs.length < 3) continue;
    const used = xs.filter((p) => p.d >= 0.5);
    const same = used.filter((p) => norm(p.gen) === norm(p.sent ?? "")).length;
    const sim = used.reduce((a, p) => a + p.d, 0) / (used.length || 1);
    const lr = used.reduce((a, p) => a + norm(p.sent ?? "").length / Math.max(1, norm(p.gen).length), 0) / (used.length || 1);
    console.log(`${k.padEnd(42)}${String(xs.length).padStart(4)}  ${pct(used.length / xs.length).padStart(6)}            ${pct(same / (used.length || 1)).padStart(5)}    ${sim.toFixed(2)}         ${lr.toFixed(2)}`);
  }
  for (const [k, xs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const used = xs.filter((p) => p.d >= 0.5);
    if (used.length < 3) continue;
    const removed = new Map<string, number>(), added = new Map<string, number>();
    for (const p of used) {
      const gl = lines(p.gen), sl = lines(p.sent ?? "");
      for (const l of gl) if (!kept(l, sl)) { const m = maskLine(l); if (m.length >= 4) removed.set(m, (removed.get(m) ?? 0) + 1); }
      for (const l of sl) if (!kept(l, gl)) { const m = maskLine(l); if (m.length >= 4) added.set(m, (added.get(m) ?? 0) + 1); }
    }
    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, SHOW);
    console.log(`\n── ${k}（使った ${used.length}）`);
    console.log(`  消された行:`); for (const [l, c] of top(removed)) console.log(`    ${String(c).padStart(3)} ${l.slice(0, 100)}`);
    console.log(`  足された行:`); for (const [l, c] of top(added)) console.log(`    ${String(c).padStart(3)} ${l.slice(0, 100)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
