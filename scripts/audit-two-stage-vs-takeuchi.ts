// scripts/audit-two-stage-vs-takeuchi.ts — 2026-10-13 棚卸しの表 2（2段の約束）を竹内さんの実送信で数え直す（読むだけ・LLM なし）
//   2段の規則（decision_source に two_stage_promise）が付いた番ごとに、ブレインの本質（digest.ltc＝生の値があればそれ・無ければ tc）が
//   約束（p>0）・AIX（a>0）・どちらも無い（閉じる・答える・触れない）のどれだったかと、12時間の内の最初のスタッフの送信（書き手・AIX で送ったか）・押された AIX を並べる。
//   ⚠ tc は reconcileTurnContractWithAix の後（規則で AIX が外れると aix→promise）＝「約束」は生の AIX を含みうる。「どちらも無い」は生でも約束・AIX が無い。
// 実行: npx tsx --env-file=.env.local scripts/audit-two-stage-vs-takeuchi.ts [--days=60] [--with-exhausted]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "60"));
const WITH_EXH = process.argv.includes("--with-exhausted");
const one = (s: string | null | undefined, n = 70) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

type Row = { id: string; conversation_id: string; analyzed_msg_ts: string | null; decision_source: string | null; digest: Record<string, unknown> | null };
const PROMISE_TEXT = /ピックアップ|確認させ|お送りさせ|作成し|出来次第|でき次第|次第お送り/;

function routeOf(tc: string | null): "promise" | "aix" | "no_promise" | "unknown" {
  if (!tc) return "unknown";
  const m = /^(\d+):r(\d+)p(\d+)a(\d+)n(\d+)(:c)?$/.exec(tc);
  if (!m) return "unknown";
  if (Number(m[3]) > 0) return "promise";
  if (Number(m[4]) > 0) return "aix";
  return Number(m[1]) > 0 || m[6] ? "no_promise" : "unknown";
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data, error } = await sb.from("brain_decision_logs").select("id, conversation_id, analyzed_msg_ts, decision_source, digest")
    .gte("created_at", since).not("analyzed_msg_ts", "is", null).or("decision_source.like.*two_stage_promise*,digest->>ds.like.*two_stage_promise*").limit(1000);
  if (error) throw error;
  const seen = new Set<string>();
  const rows = ((data ?? []) as Row[]).filter((r) => {
    const ds = String(r.decision_source ?? r.digest?.ds ?? "");
    if (!/two_stage_promise/.test(ds) || isTestConversation(r.conversation_id)) return false;
    if (!WITH_EXH && /search_exhausted/.test(ds)) return false;
    const k = `${r.conversation_id}|${r.analyzed_msg_ts}`; if (seen.has(k)) return false; seen.add(k); return true;
  });
  const tab = new Map<string, { n: number; staffPromise: number; staffAix: number; staffOther: number; none: number; takeuchiPromise: number; takeuchiAix: number; takeuchiOther: number }>();
  for (const r of rows) {
    const t = r.analyzed_msg_ts!; const end = new Date(Date.parse(t) + 12 * 3_600_000).toISOString();
    const { data: ms } = await sb.from("messages").select("staff_writer, is_aix_generated, text, created_at").eq("conversation_id", r.conversation_id).eq("sender", "staff").gt("created_at", t).lt("created_at", end).order("created_at").limit(1);
    const { data: us } = await sb.from("aix_usage_logs").select("aix_type").eq("conversation_id", r.conversation_id).gt("created_at", t).lt("created_at", end).order("created_at");
    const m = (ms ?? [])[0] as { staff_writer: string | null; is_aix_generated: boolean | null; text: string | null } | undefined;
    const ltc = (r.digest?.ltc as string | undefined) ?? null;
    const route = routeOf(ltc ?? ((r.digest?.tc as string | undefined) ?? null));
    const kind = /two_stage_promise\(([^)]+)\)/.exec(String(r.decision_source ?? r.digest?.ds ?? ""))?.[1] ?? "?";
    const key = `${route}${ltc ? "(生)" : ""}`;
    const c = tab.get(key) ?? { n: 0, staffPromise: 0, staffAix: 0, staffOther: 0, none: 0, takeuchiPromise: 0, takeuchiAix: 0, takeuchiOther: 0 };
    c.n++;
    const act = !m ? "none" : m.is_aix_generated ? "aix" : PROMISE_TEXT.test(m.text ?? "") ? "promise" : "other";
    if (act === "none") c.none++; else if (act === "aix") c.staffAix++; else if (act === "promise") c.staffPromise++; else c.staffOther++;
    if (m?.staff_writer === "takeuchi") { if (act === "aix") c.takeuchiAix++; else if (act === "promise") c.takeuchiPromise++; else c.takeuchiOther++; }
    tab.set(key, c);
    console.log([kind, key, ltc ?? r.digest?.tc ?? "-", `la=${r.digest?.la ?? "-"}`, m ? `${m.staff_writer}/${m.is_aix_generated ? "AIX" : "手打ち"}:${act}「${one(m.text, 50)}」` : "スタッフ送信なし", `押下=${(us ?? []).map((u: { aix_type: string }) => u.aix_type).join(",") || "-"}`].join("\t"));
  }
  console.log(`\n2段の番 ${rows.length}（${WITH_EXH ? "出し切りを含む" : "出し切りを除く"}・${DAYS}日）`);
  console.log(["ブレインの本質", "番", "約束の返信", "AIXで送信", "他の返信", "送信なし", "竹内:約束", "竹内:AIX", "竹内:他"].join("\t"));
  for (const [k, c] of tab) console.log([k, c.n, c.staffPromise, c.staffAix, c.staffOther, c.none, c.takeuchiPromise, c.takeuchiAix, c.takeuchiOther].join("\t"));
}
main().catch((e) => { console.error(e); process.exit(1); });
