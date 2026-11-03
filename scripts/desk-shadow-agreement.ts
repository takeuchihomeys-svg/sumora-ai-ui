// scripts/desk-shadow-agreement.ts — AIX の統括・逆向きの相談（shadow・記録だけ）の答えと、スタッフが実際に押した AIX の一致を数える（11/03 夜 指揮役の条件③）
//   読むのは brain_decision_logs の直近 N 日（既定 7）で digest に ad（統括）か ac（相談）がある行だけ＋スタッフの答え（actual_aix_type・cron brain-aix-eval が結ぶ）。
//   特に統括の差し戻し promise（desk-on2 で 16/30）が、スタッフが AIX を押さなかった（返信・約束で受けた）番と合うかを見る。読むだけ・LLM なし・費用 0
//   夜に: exam-conductor.ts --add --runner=cmd --night --label=desk-agreement --cmd="scripts/desk-shadow-agreement.ts --days=7"
//   出力: .claude/exam-cache/desk-shadow/<日付>.md（鍵と数だけ・お客様の文は無い）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { examCacheRoot } from "./lib/llm-cassette";
import { tallyDeskByWriter, type DeskRow } from "./lib/desk-shadow-core";
import { writerOfTurn } from "../app/lib/brain-manuals-weekly";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "7");

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: DeskRow[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, actual_aix_type, actual_at, digest->ad, digest->ac").gte("created_at", since).or("digest->ad.not.is.null,digest->ac.not.is.null").order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as DeskRow[]).filter((r) => !isTestConversation(r.conversation_id)));
    if ((data ?? []).length < 1000) break;
  }
  // 2026-11-04 竹内さんの番だけ（KB 41dadfe6）: この番のこちらの最初の送信（判断の後・押した時刻まで・無ければ24時間）の書き手で分ける
  const convs = [...new Set(rows.map((r) => r.conversation_id))];
  const msgs = new Map<string, Array<{ created_at: string; staff_writer: string | null; staff_writer_confidence: string | null }>>();
  for (let i = 0; i < convs.length; i += 50) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, staff_writer, staff_writer_confidence").in("conversation_id", convs.slice(i, i + 50)).neq("sender", "customer").gte("created_at", since).order("created_at").range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const m of (data ?? []) as Array<{ conversation_id: string; created_at: string; staff_writer: string | null; staff_writer_confidence: string | null }>) { const l = msgs.get(m.conversation_id) ?? []; l.push(m); msgs.set(m.conversation_id, l); }
      if ((data ?? []).length < 1000) break;
    }
  }
  for (const r of rows) r.writer = writerOfTurn(r.created_at, r.actual_at ?? new Date(Date.parse(r.created_at) + 86_400_000).toISOString(), msgs.get(r.conversation_id) ?? []);
  const tw = tallyDeskByWriter(rows);
  const t = tw.takeuchi;
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const L = [`# AIX の統括・相談（shadow）と竹内さんの一致（${day}・直近 ${DAYS}日・${rows.length}行・竹内さんの番だけ数える＝KB 41dadfe6・従業員の番 ${rows.filter((r) => r.writer === "employee").length}行は下に参考・書き手不明 ${tw.unknown}行は数えない）`, "", "## 統括（ブレインが AIX と決めた番）", ...t.commander.map((x) => `- ${x.k}: ${x.n}（スタッフの答えが分かる ${x.known}・統括と合う ${x.agree}${x.known ? `＝${Math.round((100 * x.agree) / x.known)}%` : ""}）`),
    "", "## 相談（ブレインが返信と決めかけた番）", ...t.consult.map((x) => `- ${x.k}: ${x.n}（分かる ${x.known}・合う ${x.agree}${x.known ? `＝${Math.round((100 * x.agree) / x.known)}%` : ""}）`),
    "", "## 参考（従業員の番・基準にしない）", ...tw.employee.commander.map((x) => `- 統括 ${x.k}: ${x.n}（分かる ${x.known}・合う ${x.agree}）`), ...tw.employee.consult.map((x) => `- 相談 ${x.k}: ${x.n}（分かる ${x.known}・合う ${x.agree}）`),
    "", "合うの決め方: 統括が「同じ」→スタッフがブレインと同じ AIX を押した／promise・not_aix→スタッフが AIX を押さなかった／違う札→スタッフがその札のボタンを押した。相談: keep→押さなかった／鍵→そのボタンを押した"];
  const out = join(examCacheRoot(), "desk-shadow");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${day}.md`), L.join("\n") + "\n");
  console.log(L.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
