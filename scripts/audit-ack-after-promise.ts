// scripts/audit-ack-after-promise.ts
// 2026-10-02 ⑫（竹内「DEEPSEEKで一連の流れを実際にYUMAにLINEで送りまくって、弱い部分あるか見つける」）の1巡目で見つけた穴の線引き:
//   こちらが約束（募集状況の確認・見積書・物件ピックアップ）を送った後、お客様がお礼・了承だけ返した番で、ブレインは約束の AIX
//   （promise:check → 物件確認した 等＝reply_mode=aix で下書きなし）を選ぶ。再生 flow2_t02 のスタッフは「はい😊！！確認出来次第ご連絡させて頂きますので…」と手打ちしていた。
//   本番のスタッフはこの番で①短い受けの手打ち ②約束の AIX をすぐ押す（果たす）③何も送らず後で果たす のどれが多いかを数える（読むだけ・LLM なし）。
// 実行: npx tsx --env-file=.env.local scripts/audit-ack-after-promise.ts [--days=120] [--show=40]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { classifyStaffTextFacts } from "../app/lib/action-ledger";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "120"));
const SHOW = Number(arg("show", "40"));
/** お礼・了承だけの短い番（質問・依頼・条件なし） */
export const ACK_ONLY_RE = /^(?:[\s\S]{0,6})(?:ありがとう|有難う|お願いします|お願い致します|お願いいたします|了解|わかりました|分かりました|承知|はーい|はい|待って(?:ます|おります)|よろしく)[\s\S]{0,20}$/;
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t));
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses);
  const cell = new Map<string, { n: number; ackText: number; fulfilAix: number; fulfilText: number; otherAix: number; none: number; ex: string[] }>();
  for (const [cid, ms] of mBy) {
    if (isTestConversation(cid)) continue;
    const ps = pBy.get(cid) ?? [];
    if (ps.some((p) => p.aix_type === "application_push")) continue; // 申込に進んだ会話は申込以降を含むので外す（簡便）
    for (let i = 1; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender !== "customer" || ms[i - 1].sender === "customer") continue;
      // 直前のこちらの束（お客様の番の直前のスタッフの通・AIX を除く手打ち）に未履行の約束
      const prevStaff: string[] = [];
      for (let j = i - 1; j >= 0 && ms[j].sender !== "customer"; j--) if (!ms[j].is_aix_generated) prevStaff.unshift(ms[j].text ?? "");
      const kinds = new Set(prevStaff.flatMap((t) => classifyStaffTextFacts(t, null).filter((e) => e.status === "promised").map((e) => e.kind)));
      const kind = kinds.has("confirmation_promised") ? "check" : kinds.has("estimate_declared") ? "estimate" : kinds.has("pickup_declared") ? "pickup" : null;
      if (!kind) continue;
      const turn: string[] = [];
      for (let j = i; j < ms.length && ms[j].sender === "customer"; j++) turn.push(ms[j].text ?? "");
      const tt = turn.join("\n").trim();
      if (!tt || /[?？]/.test(tt) || /https?:\/\/|\[画像\]/.test(tt) || !ACK_ONLY_RE.test(tt.replace(/\s+/g, ""))) continue;
      const w = staffWindowOf({ customerTurnAt: m.created_at, msgs: ms, presses: ps });
      if (!w.closed) continue;
      const c = cell.get(kind) ?? { n: 0, ackText: 0, fulfilAix: 0, fulfilText: 0, otherAix: 0, none: 0, ex: [] };
      c.n++;
      const bp = w.presses.filter((p) => p.burst).map((p) => p.aix_type);
      const bt = w.texts.filter((t) => t.burst).map((t) => t.text).join(" / ");
      const fulfilKinds: Record<string, string[]> = { check: ["property_check_result", "acknowledge_check"], estimate: ["estimate_sheet"], pickup: ["property_send", "property_recommendation"] };
      let label: string;
      if (bp.some((a) => fulfilKinds[kind].includes(a))) { c.fulfilAix++; label = "約束の AIX"; }
      else if (bp.length) { c.otherAix++; label = `他の AIX ${bp.join("+")}`; }
      else if (bt && bt.length <= 90 && !/🌟|号室|ご査収|御見積書となります|募集中となります|募集終了/.test(bt)) { c.ackText++; label = "短い受けの手打ち"; }
      else if (bt) { c.fulfilText++; label = "中身のある手打ち（結果・物件）"; }
      else { c.none++; label = "送らず"; }
      if (c.ex.length < SHOW) c.ex.push(`${cid.slice(0, 8)} ${label}｜C:${tt.replace(/\n/g, " ").slice(0, 40)}｜S:${bt.replace(/\n/g, " ").slice(0, 80)}`);
      cell.set(kind, c);
    }
  }
  for (const [k, c] of cell) {
    console.log(`\n約束=${k} n=${c.n} 短い受けの手打ち ${c.ackText}・約束の AIX をすぐ ${c.fulfilAix}・中身のある手打ち ${c.fulfilText}・他の AIX ${c.otherAix}・送らず ${c.none}`);
    for (const e of c.ex) console.log(`   ${e}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
