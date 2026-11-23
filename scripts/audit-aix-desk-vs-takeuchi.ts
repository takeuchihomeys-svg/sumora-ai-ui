// scripts/audit-aix-desk-vs-takeuchi.ts — AIX の指揮官（AIX_DESK_COMMAND・shadow の記録 digest.ad）とブレインの案を、竹内さん本人の一手と並べる（読むだけ・LLM なし・費用0）
//
// 2026-11-23 作業員A（統括役の頼み・3つ目の穴「指揮官が shadow のままで効き目が数えられていない」）。
//   数える判断: digest.ad があり、こちらの最初の送信の直前の判断（その判断の後・送信の前に新しい判断が無い）。
//   竹内さん本人の一手: 判断の後〜次のお客様の発言（最大24時間）のこちらの送信が全部、端末の記録で takeuchi（staff-writer.deviceWriterOfWindow）。
//     最初の送信が AIX なら種類（その通の前10分〜後2分の aix_usage_logs）・手打ちなら「返信」。
//   比べる形: ①ad.changed（指揮官の pick がブレインと違う）＝ボタンで比べる ②ad.sb=promise／not_aix（指揮官は「今は AIX にしない」）＝返信か AIX かで比べる。
//   申込以降は外す（combo-daily の POST_APPLY_RE）。お客様の本文は出さない。
// 実行（22時以降）: npx tsx --env-file=<env> scripts/audit-aix-desk-vs-takeuchi.ts [--days=30] [--writer=all]
import { createClient } from "@supabase/supabase-js";
import { deviceWriterOfWindow, type DeviceWriterMsg } from "../app/lib/staff-writer";
import { POST_APPLY_RE } from "./lib/combo-daily";
import { aixBundle } from "../app/lib/aix-turn-judgment";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type D = { id: string; conversation_id: string; created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; digest: { ad?: { sb?: string | null; pick?: string | null; brain?: string | null; changed?: boolean } } | null };
type Msg = DeviceWriterMsg & { is_aix_generated: boolean | null; text: string | null };
/** ボタンの束（確認した と 物件確認した は別のボタン・ピッカーは見ない） */
const btn = (k: string | null | undefined) => aixBundle(k);

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30")) || 30;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const ds: D[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("id, conversation_id, created_at, suggested_action, suggested_reply_mode, digest").gte("created_at", since).not("digest->ad", "is", null).order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    ds.push(...((data ?? []) as D[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, D[]>();
  for (const d of ds) if (!isTestConversation(d.conversation_id)) byConv.set(d.conversation_id, [...(byConv.get(d.conversation_id) ?? []), d]);
  const rows: Array<Record<string, unknown>> = [];
  for (const [c, list] of byConv) {
    const lo = list[0].created_at, hi = new Date(Date.parse(list[list.length - 1].created_at) + 864e5).toISOString();
    const [mq, aq, allD] = await Promise.all([
      sb.from("messages").select("sender, created_at, staff_writer, staff_writer_source, is_aix_generated, text").eq("conversation_id", c).gte("created_at", new Date(Date.parse(lo) - 3 * 864e5).toISOString()).lt("created_at", hi).order("created_at").limit(5000),
      sb.from("aix_usage_logs").select("aix_type, check_pattern, sent_at, created_at").eq("conversation_id", c).gte("created_at", lo).lt("created_at", hi).limit(2000),
      sb.from("brain_decision_logs").select("created_at").eq("conversation_id", c).gte("created_at", lo).lt("created_at", hi).order("created_at").limit(5000),
    ]);
    const ms = (mq.data ?? []) as Msg[];
    const presses = ((aq.data ?? []) as Array<{ aix_type: string | null; check_pattern: string | null; sent_at: string | null; created_at: string }>).filter((p) => p.aix_type).map((p) => ({ at: Date.parse(p.sent_at ?? p.created_at), type: String(p.aix_type), cp: p.check_pattern }));
    const decTimes = ((allD.data ?? []) as Array<{ created_at: string }>).map((x) => Date.parse(x.created_at));
    for (const d of list) {
      const at = Date.parse(d.created_at);
      const next = ms.find((m) => m.sender === "customer" && Date.parse(m.created_at) > at);
      const end = Math.min(next ? Date.parse(next.created_at) : Infinity, at + 864e5);
      const win = ms.filter((m) => m.sender !== "customer" && Date.parse(m.created_at) > at && Date.parse(m.created_at) <= end);
      if (!win.length) continue;
      const firstAt = Date.parse(win[0].created_at);
      if (decTimes.some((t) => t > at && t < firstAt)) continue; // 送る直前の判断ではない
      if (ms.some((m) => m.sender !== "customer" && Date.parse(m.created_at) <= end && POST_APPLY_RE.test(String(m.text ?? "")))) continue;
      // --writer=all: 従業員の番も入れる（従業員は中身・道だけ正解＝KB の書き手の線。参考の数）
      if (arg("writer", "takeuchi") !== "all" && deviceWriterOfWindow(win, d.created_at, new Date(end).toISOString())?.writer !== "takeuchi") continue;
      const near = win[0].is_aix_generated ? presses.filter((p) => p.at >= firstAt - 10 * 6e4 && p.at <= firstAt + 2 * 6e4).sort((a, b) => Math.abs(a.at - firstAt) - Math.abs(b.at - firstAt))[0] : null;
      const tk = win[0].is_aix_generated ? (near ? btn(near.type) : "?") : "返信";
      const laterAix = win.find((m) => m.is_aix_generated);
      const ad = d.digest?.ad ?? {};
      const brainBtn = d.suggested_reply_mode === "aix" ? btn(ad.brain ?? d.suggested_action) : "返信";
      let form: string, deskSays: string, verdict: string;
      if (ad.changed && ad.pick) {
        form = "changed"; deskSays = String(btn(ad.pick));
        verdict = tk === deskSays && tk !== brainBtn ? "指揮官が正しい" : tk === brainBtn && tk !== deskSays ? "ブレインが正しい" : tk === brainBtn && tk === deskSays ? "どちらも" : "どちらも外れ";
      } else if (ad.sb === "promise" || ad.sb === "not_aix") {
        form = `sb:${ad.sb}`; deskSays = "返信";
        verdict = tk === "返信" && brainBtn !== "返信" ? "指揮官が正しい" : tk !== "返信" && tk === brainBtn ? "ブレインが正しい" : tk !== "返信" ? "どちらも外れ" : "どちらも";
      } else continue;
      rows.push({ conv: c.slice(0, 8), at: d.created_at.slice(0, 16), form, brain: brainBtn, desk: deskSays, deskPick: ad.pick ?? ad.sb, takeuchi: tk, laterAix: tk === "返信" && laterAix ? Math.round((Date.parse(laterAix.created_at) - at) / 6e4) : null, verdict });
    }
  }
  const t: Record<string, Record<string, number>> = {};
  for (const r of rows) { const k = String(r.form); (t[k] = t[k] ?? {})[String(r.verdict)] = (t[k][String(r.verdict)] ?? 0) + 1; }
  console.log(`指揮官（digest.ad）とブレインと竹内さん本人の一手（${days}日・端末の記録・送る直前の判断・申込以降を外す）: ${rows.length}番`);
  for (const [k, o] of Object.entries(t)) console.log(`  ${k}: ${JSON.stringify(o)}`);
  for (const r of rows) console.log(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
