// scripts/audit-ack-form-takeuchi.ts — 了承の返事（ack_form）の物差し: 竹内さんの実送信で「前の約束→お客様の了承だけ→竹内さんの返事」の番を集める（読むだけ・LLM なし）
//   2026-10-15 作る人（zenryoku-ack-1015）: ブレインが ack_form を決めた番の下書きがそれに従うかを試す材料（scripts/yuma-ack-form-follow-test.ts が読む）。
//   竹内さんの返事の形: wait_line＝「〜次第」の文がある／receive_only＝無い。言い直し＝前の約束の文とほぼ同じ文（近さ 0.72 以上）を書いた。
//   届け物（物件・見積・URL・画像）を返した番は外す（了承の返事ではない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-ack-form-takeuchi.ts [--days=90] [--out=scripts/.replay-out/ack-form-takeuchi.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { ackFormFacts } from "../app/lib/repeat-brain-align";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "90"));
const OUT = arg("out", "");

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
export const WAIT_FORM_RE = /(?:次第|(?:出来|でき)(?:ましたら|たら)|出ましたら(?=[^。！!\n]{0,12}(?:お送り|ご連絡させて)))/;
const DELIVERY_RE = /https?:\/\/|\[(?:画像|ファイル)\]|🌟|ご査収|御見積|お見積書/;

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const all: M[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated").gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw error;
    all.push(...((data ?? []) as M[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, M[]>();
  for (const m of all) { if (isTestConversation(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const cases: Array<Record<string, unknown>> = [];
  for (const [cid, ms] of byConv) {
    for (let i = 1; i < ms.length; i++) {
      const r = ms[i];
      if (r.sender === "customer" || r.staff_writer !== "takeuchi" || r.is_aix_generated) continue;
      if (ms[i - 1].sender !== "customer") continue;
      const upto = ms.slice(Math.max(0, i - 14), i);
      const f = ackFormFacts(upto.map((m) => ({ sender: m.sender, text: m.text, created_at: m.created_at })));
      if (!f || f.customer !== "了承だけ") continue;
      const reply = String(r.text ?? "");
      if (DELIVERY_RE.test(reply)) continue;
      // 竹内さんの返事が次のお客様の発言の前に2通以上なら1通目だけ（了承の返事）
      const form = WAIT_FORM_RE.test(reply) ? "wait_line" : "receive_only";
      cases.push({ conv: cid, at: r.created_at, family: f.family, promiseForm: f.form, promise: f.promise, minutes: f.minutes, takeuchiForm: form, reply: reply.slice(0, 200),
        history: upto.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated })) });
    }
  }
  const tab = new Map<string, { wait: number; recv: number }>();
  for (const c of cases) { const k = `${c.family}・${c.promiseForm}`; const t = tab.get(k) ?? { wait: 0, recv: 0 }; if (c.takeuchiForm === "wait_line") t.wait++; else t.recv++; tab.set(k, t); }
  console.log(`竹内さんの了承の返事 ${cases.length}番（${DAYS}日・届け物を除く）`);
  for (const [k, t] of tab) console.log(`  ${k}: 待ちの形 ${t.wait}・受けだけ ${t.recv}`);
  for (const c of cases) console.log(`${String(c.conv).slice(0, 8)} ${String(c.at).slice(0, 16)} [${c.family}・${c.promiseForm}] 約束「${c.promise}」→ ${c.takeuchiForm}「${String(c.reply).replace(/\n/g, "／").slice(0, 70)}」`);
  if (OUT) { writeFileSync(OUT, JSON.stringify(cases, null, 1)); console.log(`→ ${OUT}`); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
