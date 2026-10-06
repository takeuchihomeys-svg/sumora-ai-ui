// scripts/audit-viewing-invite-prefill.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-invite-prefill.ts   （DAYS=120 既定・読み取りのみ・DUMP=1 で全件）
//
// 2026-10-05 竹内（ゆいと事例）「日程はお客さんから指定がなければいれない」:
//   過去の AIX【内覧へ！】（aix_generate_log の viewing_invite）の回で、
//     ① 開いた時のお客様の最新の発言に日の指定があったか（viewing-invite-prefill.customerViewingDateSpec・その時点の時刻で読む）
//     ② 生成文に日程（「直近ですと」・M/D(曜) HH:MM の行）が入っていたか＝旧の先入れの結果
//     ③ スタッフが実際に送った文（生成から30分以内のこちらの次の1通）に日程があったか
//     ④ 新しい決まりで開いた時に何が入るか（none＝空・dates＝その日・range＝幅の中）
//   を数え、指定なしの回の実物を並べて目で読む。
import { createClient } from "@supabase/supabase-js";
import { customerViewingDateSpec, stripUnbackedScheduleLines } from "../app/lib/viewing-invite-prefill";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 120);
const DUMP = process.env.DUMP === "1";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const one = (s: string | null | undefined, n = 160) => (s ?? "").replace(/\n+/g, " / ").slice(0, n);
const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const hasSchedule = (t: string | null | undefined) => stripUnbackedScheduleLines(t ?? "").removed.length > 0;

type Gen = { conversation_id: string; created_at: string; generated_text: string | null };
type Msg = { sender: string; text: string | null; created_at: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const gens: Gen[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("aix_generate_log").select("conversation_id, created_at, generated_text")
      .eq("action_type", "viewing_invite").gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    gens.push(...((data ?? []) as Gen[]));
    if ((data ?? []).length < 1000) break;
  }
  const rows = gens.filter((g) => g.conversation_id && g.conversation_id !== YUMA);
  console.log(`AIX【内覧へ！】の生成 ${rows.length}件（${DAYS}日・YUMA 除く）`);

  const byConv = new Map<string, Msg[]>();
  for (const cid of [...new Set(rows.map((r) => r.conversation_id))]) {
    const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", cid).gte("created_at", new Date(Date.parse(since) - 30 * 86400_000).toISOString()).order("created_at").limit(3000);
    byConv.set(cid, (data ?? []) as Msg[]);
  }

  const tally: Record<string, { n: number; genSched: number; sentSched: number; sentKnown: number }> = {};
  const samples: string[] = [];
  for (const g of rows) {
    const ms = byConv.get(g.conversation_id) ?? [];
    const t = Date.parse(g.created_at);
    const before = ms.filter((m) => Date.parse(m.created_at) <= t);
    const spec = customerViewingDateSpec(before, t);
    const sent = ms.find((m) => m.sender !== "customer" && Date.parse(m.created_at) > t && Date.parse(m.created_at) - t <= 30 * 60_000 && (m.text ?? "").trim() && !/^\[画像\]/.test(m.text ?? ""));
    const k = spec.kind;
    const row = (tally[k] ??= { n: 0, genSched: 0, sentSched: 0, sentKnown: 0 });
    row.n++;
    const gs = hasSchedule(g.generated_text);
    if (gs) row.genSched++;
    if (sent) { row.sentKnown++; if (hasSchedule(sent.text)) row.sentSched++; }
    if (k === "none" && (DUMP || samples.length < 25)) {
      const lastC = [...before].reverse().find((m) => m.sender === "customer");
      samples.push(`  ${jst(g.created_at)} ${g.conversation_id.slice(0, 8)} 客「${one(lastC?.text, 60)}」\n     旧の生成: ${gs ? "日程あり" : "日程なし"}｜送った: ${sent ? (hasSchedule(sent.text) ? "日程あり" : "日程なし") : "（30分以内の送信なし）"}｜${one(sent?.text ?? g.generated_text, 110)}`);
    }
    if (k !== "none" && DUMP) {
      samples.push(`  [${k}] ${jst(g.created_at)} ${g.conversation_id.slice(0, 8)} ${spec.kind === "dates" ? spec.dates.map((d) => d.label).join("・") : spec.kind === "range" ? spec.label : ""}｜送った: ${one(sent?.text, 100)}`);
    }
  }
  console.log("\n指定の種類ごと（旧の生成に日程があった回／スタッフが送った文に日程があった回）:");
  for (const [k, v] of Object.entries(tally)) {
    console.log(`  ${k.padEnd(6)} ${String(v.n).padStart(4)}件  生成に日程 ${v.genSched}（${Math.round((v.genSched / v.n) * 100)}%）  送信 ${v.sentKnown}件中 日程あり ${v.sentSched}（${v.sentKnown ? Math.round((v.sentSched / v.sentKnown) * 100) : 0}%）`);
  }
  console.log("\n新しい決まり: none＝開いた時にどの日も入れない（スタッフが選ぶ）／dates＝その日だけ・内覧日指定あり／range＝幅の中の空いている日を最大3つ");
  console.log("\n指定なし（none）の回の実物:");
  for (const s of samples) console.log(s);
}
main().catch((e) => { console.error(e); process.exit(1); });
