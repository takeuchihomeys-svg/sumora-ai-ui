// scripts/audit-promise-wording.ts
// 2026-10-02 竹内さんの決定（2段の場面: 先に約束の返信・後で AIX）「言い回しも実際のLINEにある」:
//   人が書いた送信（AIX の文を除く・AI の下書きをそのまま送った物も除く）で、約束（物件ピックアップ・確認・見積書）を書いた文の言い回しを数える。
//   約束の見分けは行動台帳（action-ledger.classifyStaffTextFacts）と同じ。言い回しは約束の文（evidence）を数字・物件名・名前を伏せて丸めた形。読むだけ・LLM なし。
//   ＋ ブレインが 物件確認した／確認します を出した番で、スタッフがその場で AIX【物件確認した】を押したか・約束の返信だったかを、時刻（JST）・平日/土日・
//     お客様が物件を持ち込んだ（URL・画像）か で分けて数える（「すぐ確認できる時は物件確認した」の線引き）
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-wording.ts [--days=120] [--top=12]
import { createClient } from "@supabase/supabase-js";
import { classifyStaffTextFacts } from "../app/lib/action-ledger";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "120")), TOP = Number(arg("top", "12"));
type M = WindowMsg & { conversation_id: string; image_url?: string | null };
type P = WindowPress & { conversation_id: string };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const shape = (s: string) => s.normalize("NFKC")
  .replace(/[0-9０-９][0-9０-９,.]*\s*(?:万円|万|円|件|号室|帖|分|階|日|時)/g, "N")
  .replace(/[ァ-ヶーA-Za-z0-9・]{3,}(?:\s*N)?/g, "〇")
  .replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〇さん")
  .replace(/[😊😌✨🌟🙇]/g, "").replace(/\s+/g, "").replace(/！+/g, "！！");
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses, exs, decs] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, image_url").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<{ conversation_id: string | null; sent_reply: string | null; was_ai_used: boolean | null }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, sent_reply, was_ai_used").gte("created_at", since).range(f, t)),
    readAll<{ conversation_id: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null }>((f, t) => sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, suggested_action, suggested_reply_mode").gte("created_at", since).in("suggested_action", ["property_check_result", "acknowledge_check"]).range(f, t)),
  ]);
  // AI の下書きをそのまま送った文（人が書いていない）
  const aiUnedited = new Set(exs.filter((e) => e.was_ai_used && e.sent_reply).map((e) => (e.sent_reply ?? "").trim()));
  const forms: Record<string, Map<string, { n: number; ex: string }>> = { pickup_declared: new Map(), confirmation_promised: new Map(), estimate_declared: new Map() };
  let humanN = 0;
  for (const m of msgs) {
    if (m.sender === "customer" || m.is_aix_generated || !(m.text ?? "").trim() || isTestConversation(m.conversation_id)) continue;
    if (aiUnedited.has((m.text ?? "").trim())) continue;
    humanN++;
    for (const e of classifyStaffTextFacts(m.text ?? "", null)) {
      if (e.status !== "promised" || !(e.kind in forms)) continue;
      const sen = (m.text ?? "").split(/\n|(?<=！！)/).find((l) => l.includes((e.evidence ?? "").slice(0, 8))) ?? e.evidence ?? "";
      const k = shape(sen);
      if (!k) continue;
      const cur = forms[e.kind].get(k) ?? { n: 0, ex: sen.trim() };
      cur.n++; forms[e.kind].set(k, cur);
    }
  }
  console.log(`人の手打ち ${humanN}通（AI の下書きのままの送信を除く）`);
  for (const [kind, mp] of Object.entries(forms)) {
    const tot = [...mp.values()].reduce((a, b) => a + b.n, 0);
    console.log(`\n■ ${kind} 合計 ${tot}`);
    for (const [k, v] of [...mp].sort((a, b) => b[1].n - a[1].n).slice(0, TOP)) console.log(`  ${String(v.n).padStart(4)}  ${k.slice(0, 70)}   例: ${v.ex.replace(/\n/g, " ").slice(0, 70)}`);
  }
  // ── 物件確認した／確認します の番で、その場で物件確認した か 約束の返信か ──
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { if (!mp.has(r.conversation_id)) mp.set(r.conversation_id, []); mp.get(r.conversation_id)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses);
  const cell = new Map<string, { now: number; promise: number; other: number }>();
  const seen = new Set<string>();
  for (const d of decs) {
    if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id)) continue;
    const key = `${d.conversation_id}|${d.analyzed_msg_ts}`; if (seen.has(key)) continue; seen.add(key);
    const ms = mBy.get(d.conversation_id) ?? []; const ps = pBy.get(d.conversation_id) ?? [];
    if (ps.some((p) => p.aix_type === "application_push" && p.created_at <= d.analyzed_msg_ts!)) continue;
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts, msgs: ms, presses: ps });
    if (!w.closed) continue;
    const bp = w.presses.filter((p) => p.burst).map((p) => p.aix_type);
    const bt = w.texts.filter((t) => t.burst).map((t) => t.text).join("\n");
    const turn = ms.filter((m) => m.sender === "customer" && m.created_at >= d.analyzed_msg_ts!).slice(0, 4);
    const brought = turn.some((m) => /https?:\/\//.test(m.text ?? "") || !!m.image_url || /^\[画像\]/.test(m.text ?? ""));
    const jst = new Date(Date.parse(w.staffFirstAt ?? d.analyzed_msg_ts) + 9 * 3600_000);
    const h = jst.getUTCHours(); const wd = jst.getUTCDay();
    const hours = h < 10 ? "〜10時" : h < 18 ? "10〜18時" : "18時〜";
    const k = `${brought ? "持ち込み" : "送った物件など"}・${wd === 0 || wd === 6 ? "土日" : "平日"}・${hours}`;
    const c = cell.get(k) ?? { now: 0, promise: 0, other: 0 };
    if (bp.includes("property_check_result")) c.now++;
    else if (bt && classifyStaffTextFacts(bt, null).some((e) => e.kind === "confirmation_promised" && e.status === "promised")) c.promise++;
    else c.other++;
    cell.set(k, c);
  }
  console.log("\n■ ブレイン=物件確認した/確認します の番: スタッフが その場で物件確認した／確認の約束の返信／他");
  for (const [k, c] of [...cell].sort()) console.log(`  ${k.padEnd(22)} その場で ${c.now}・約束の返信 ${c.promise}・他 ${c.other}`);
})();
