// scripts/audit-1013-greeting-once-per-day.ts
// 2026-10-13 竹内さん（ゆーた 969f0162）「挨拶はお客さん1人につき1日一度で、2度目からは挨拶抜きで LINE を入れること」の見本の数え（読むだけ・LLM なし）。
//   A. 竹内さん（staff_writer=takeuchi）の手打ち: その日2通目以降（前に今日の会話文・挨拶の入った通がある）に挨拶がある数＝竹内さんの形
//   B. AI の下書き（ai_reply_examples.ai_draft＝画面に出た文）: 今日すでに挨拶・会話文を送った後の番で、下書きの先頭に「お世話になっております」がある数
//      ＋サーバーの下書き（reply_context_snapshot.draftHead）には無かった＝画面が足した数
//   C. 直した後（画面は DB の今日の送信で決め直す＝refreshDraftGreetingForNow を送った時刻より前の送信で当てる）: 2回目の挨拶 0・その日最初なのに外す 0 か
// 実行: npx tsx --env-file=.env.local scripts/audit-1013-greeting-once-per-day.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { staffTalkedToday, countsAsTalkOrGreeting } from "../app/lib/daily-greeting";
import { refreshDraftGreetingForNow } from "../app/lib/time-greeting";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").slice(7));
const JST = 9 * 3600_000;
const jstDay = (t: number) => new Date(t + JST).toISOString().slice(0, 10);
const headGreet = (t: string | null | undefined) => /お世話になっております/.test((t ?? "").split("\n").filter((l) => l.trim()).slice(0, 2).join("\n"));

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };

(async () => {
  const since = new Date(Date.now() - (DAYS + 1) * 86_400_000).toISOString();
  const msgs: Msg[] = [];
  for (let f = 0; f < 500_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id,sender,text,created_at,staff_writer,is_aix_generated").eq("sender", "staff").gte("created_at", since).order("created_at").range(f, f + 999);
    if (error) throw error; msgs.push(...((data ?? []) as Msg[])); if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const priorToday = (cid: string, t: number, excludeText?: string) => (byConv.get(cid) ?? []).filter((m) => {
    const mt = Date.parse(m.created_at);
    if (!(mt < t) || jstDay(mt) !== jstDay(t)) return false;
    if (excludeText && (m.text ?? "").trim() === excludeText.trim() && t - mt < 180_000) return false;
    return true;
  }).map((m) => ({ sender: "staff", text: m.text, rawCreatedAt: m.created_at }));

  // ── A. 竹内さんの手打ち ──
  const cutoff = Date.now() - DAYS * 86_400_000;
  let aFirst = 0, aFirstG = 0, aSecond = 0, aSecondG = 0; const aEx: string[] = [];
  for (const m of msgs) {
    const t = Date.parse(m.created_at);
    if (t < cutoff || m.staff_writer !== "takeuchi" || m.is_aix_generated || !countsAsTalkOrGreeting(m.text)) continue;
    const prior = priorToday(m.conversation_id, t);
    if (staffTalkedToday(prior, t)) { aSecond++; if (headGreet(m.text)) { aSecondG++; if (aEx.length < 8) aEx.push(`${m.conversation_id.slice(0, 8)} ${m.created_at.slice(0, 16)} ${(m.text ?? "").replace(/\n/g, " / ").slice(0, 70)}`); } }
    else { aFirst++; if (headGreet(m.text)) aFirstG++; }
  }
  console.log(`A. 竹内さんの手打ち（${DAYS}日・AIX を除く会話文）: その日最初 ${aFirst}通（挨拶あり ${aFirstG}）／その日2通目以降 ${aSecond}通（挨拶あり ${aSecondG}）`);
  for (const e of aEx) console.log("   2通目以降に挨拶: " + e);

  // ── B・C. AI の下書き ──
  type Ex = { conversation_id: string | null; ai_draft: string | null; sent_reply: string | null; created_at: string; sent_at: string | null; reply_context_snapshot: Record<string, unknown> | null };
  const exs: Ex[] = [];
  for (let f = 0; f < 200_000; f += 500) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id,ai_draft,sent_reply,created_at,sent_at,reply_context_snapshot").gte("created_at", new Date(cutoff).toISOString()).not("ai_draft", "is", null).order("created_at").range(f, f + 499);
    if (error) throw error; exs.push(...((data ?? []) as Ex[])); if ((data ?? []).length < 500) break;
  }
  let n = 0, greeted = 0, bad = 0, badScreen = 0, badServer = 0, after = 0, firstN = 0, firstDraftG = 0, wrongRemove = 0, staffKeptOnGreeted = 0, draftMatchStaffBefore = 0, draftMatchStaffAfter = 0;
  const bEx: string[] = []; const kEx: string[] = []; let badRecent = 0;
  for (const r of exs) {
    if (!r.conversation_id || !r.ai_draft?.trim() || r.ai_draft.startsWith("__")) continue;
    const t = Date.parse(r.sent_at ?? r.created_at);
    if (!Number.isFinite(t)) continue;
    n++;
    const prior = priorToday(r.conversation_id, t - 1000, r.sent_reply ?? undefined);
    const fact = staffTalkedToday(prior, t);
    const fixed = refreshDraftGreetingForNow(r.ai_draft, { messages: prior, name: "", now: t, ensureDaily: true, allowAdd: true }).text;
    // 今回の直し（2回目を外す向き）だけを当てた文＝その日最初の番は下書きのまま（足す向きは 10/08 の決定で今回は変えていない）
    const removedOnly = fact ? fixed : r.ai_draft;
    const recent = t >= Date.parse("2026-10-07T15:00:00Z");
    const staffG = headGreet(r.sent_reply);
    if (headGreet(r.ai_draft) === staffG) draftMatchStaffBefore++;
    if (headGreet(removedOnly) === staffG) draftMatchStaffAfter++;
    if (fact) {
      greeted++;
      if (staffG) { staffKeptOnGreeted++; if (kEx.length < 12) kEx.push(`${r.conversation_id.slice(0, 8)} ${new Date(t + JST).toISOString().slice(5, 16)} 送信: ${(r.sent_reply ?? "").replace(/\n/g, " / ").slice(0, 50)} ／ 今日の前の送信: ${prior.map((m) => (m.text ?? "").replace(/\n/g, " ").slice(0, 25)).join(" | ").slice(0, 120)}`); }
      if (headGreet(r.ai_draft)) {
        bad++; if (recent) badRecent++;
        const td = ((r.reply_context_snapshot ?? {}) as { tpo_debug?: { draftHead?: string } }).tpo_debug ?? (r.reply_context_snapshot as { draftHead?: string } | null);
        const serverHead = (td as { draftHead?: string } | null)?.draftHead;
        if (typeof serverHead === "string" && !headGreet(serverHead)) badScreen++; else badServer++;
        if (recent) bEx.push(`${r.conversation_id.slice(0, 8)} ${new Date(t + JST).toISOString().slice(5, 16)} 下書き: ${r.ai_draft.replace(/\n/g, " / ").slice(0, 60)} ／ 送信: ${(r.sent_reply ?? "").replace(/\n/g, " / ").slice(0, 40)}`);
      }
      if (headGreet(fixed)) after++;
    } else {
      firstN++;
      if (headGreet(r.ai_draft)) { firstDraftG++; if (!headGreet(fixed)) wrongRemove++; }
    }
  }
  console.log(`B. AI の下書き（${DAYS}日・${n}件）: 今日すでに挨拶・会話文を送った後の番 ${greeted}件 → 下書きに2回目の「お世話になっております」 ${bad}件（サーバーの下書きには無く画面が足した ${badScreen}／サーバーから ${badServer}）`);
  console.log(`   うち 10/08 以降（画面が足す ensureDaily の後）: ${badRecent}件`);
  console.log(`   その番でスタッフが挨拶を残して送った ${staffKeptOnGreeted}件`);
  for (const e of kEx) console.log("   残した: " + e);
  for (const e of bEx) console.log("   " + e);
  console.log(`C. 直した後（DB の今日の送信で決め直す）: 2回目の挨拶 ${after}件／その日最初の番 ${firstN}件のうち下書きに挨拶 ${firstDraftG}・誤って外す ${wrongRemove}件`);
  console.log(`   下書きの挨拶の有無がスタッフの送信と合う（2回目を外す直しだけ当てる）: 前 ${draftMatchStaffBefore}/${n} → 後 ${draftMatchStaffAfter}/${n}`);
})();
