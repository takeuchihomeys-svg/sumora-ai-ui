// 「自分が送った文」を台帳が正しく理解しているか（読み取りのみ）
//
// 2026-09-20 竹内「ちゃんとお客さんの状況に合わせた返信、自分が送った文のことも踏まえたうえで
//   ズレは起きていないかな？**自分で送った文を理解していないことがたまにある**から」
//   「ブレインのもれがないかも合わせて確認する」
//
// 設計知見（穴:G2）:
//   「事実は起きた時に一番よく知っている所で1回書く — 送信時の記録（sent_facts）を一次証拠にし、
//     本文の推測は記録前の補いだけにする」
//   「【根本原因】『送った内容』は送った時に記録せず、毎回本文から推測し直していた」
//
// 測る3つ:
//   ① sent_facts のカバー率（送った物が記録されているか＝書く側の穴）
//   ② 台帳の事実 vs 実際の送信記録（AIX ログ）の食い違い（読む側の誤り）
//   ③ ブレインに台帳が届いているか
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, type LedgerAixRow, type LedgerMessage, type LedgerTask } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const days = Number(process.env.DAYS ?? 30);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // ── ① sent_facts のカバー率 ──
  const { data: sf, error: sfErr } = await sb.from("sent_facts")
    .select("conversation_id, sent_at, origin, aix_type, kind, status, line_message_id")
    .gte("sent_at", since).limit(6000);
  if (sfErr) {
    console.log(`⚠ sent_facts が読めない: ${sfErr.message}`);
  }
  const facts = (sf ?? []) as unknown as Array<Record<string, unknown>>;

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null; line_message_id?: string | null }> = [];
  for (let p = 0; p < 24; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, line_message_id")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }
  const staffMsgs = msgs.filter((m) => m.sender === "staff" && m.text && !/^\[(画像|動画|スタンプ|通話)/.test(m.text));
  console.log(`=== 直近${days}日 ===`);
  console.log(`スタッフの送信（文字）: ${staffMsgs.length}通`);
  console.log(`sent_facts の記録      : ${facts.length}件`);
  const byOrigin = new Map<string, number>();
  for (const f of facts) byOrigin.set(String(f.origin ?? "?"), (byOrigin.get(String(f.origin ?? "?")) ?? 0) + 1);
  console.log(`  内訳: ${[...byOrigin.entries()].map(([k, n]) => `${k}=${n}`).join(" / ")}`);
  const byKind = new Map<string, number>();
  for (const f of facts) byKind.set(String(f.kind ?? "?"), (byKind.get(String(f.kind ?? "?")) ?? 0) + 1);
  console.log(`  種類: ${[...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}=${n}`).join(" / ")}`);

  // 送信ごとに記録があるか（line_message_id で対応）
  const factByLmid = new Set(facts.map((f) => String(f.line_message_id ?? "")).filter(Boolean));
  const withLmid = staffMsgs.filter((m) => m.line_message_id);
  const covered = withLmid.filter((m) => factByLmid.has(String(m.line_message_id)));
  console.log(`\n① 送信に紐づく記録: ${covered.length}/${withLmid.length}通（${withLmid.length ? ((covered.length / withLmid.length) * 100).toFixed(1) : "-"}%）`);
  console.log(`   ※ line_message_id を持つ送信のみで見た数字`);

  // ── ② 台帳の事実 vs AIX の実記録 ──
  const aix: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 8; p++) {
    const { data } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, generated_text")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    aix.push(...r);
    if (r.length < 1000) break;
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  const aixByConv = new Map<string, LedgerAixRow[]>();
  for (const a of aix) {
    const c = String(a.conversation_id ?? "");
    if (!aixByConv.has(c)) aixByConv.set(c, []);
    aixByConv.get(c)!.push({ aix_type: String(a.aix_type ?? ""), created_at: String(a.created_at ?? ""), sent_at: (a.sent_at as string | null) ?? null, generated_text: (a.generated_text as string | null) ?? null });
  }

  // 会話ごとに「最後のお客様発言の時点」で台帳を組み、AIX の実記録と突き合わせる
  let n = 0;
  let estSentMismatch = 0, estSentMiss = 0;   // 見積: 台帳が送付済みと言うが AIX 記録なし / AIX 記録があるのに台帳が知らない
  let propMismatch = 0, propMiss = 0;
  const examples: string[] = [];
  for (const [cid, list] of byConv) {
    const lastCust = [...list].reverse().find((m) => m.sender === "customer");
    if (!lastCust) continue;
    const rows = aixByConv.get(cid) ?? [];
    const idx = list.indexOf(lastCust);
    const ledger = buildActionLedger({
      recentAixRows: rows,
      messages: list.slice(0, idx + 1).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at } as LedgerMessage)),
      lineTasks: [] as LedgerTask[], lastCustomerAt: lastCust.created_at, now: Date.parse(lastCust.created_at),
    });
    n++;
    const f = ledger.facts;
    // AIX の実記録（送信済みのものだけ）
    const aixEstimate = rows.some((r) => r.aix_type === "estimate_sheet" && r.sent_at);
    const aixProperty = rows.some((r) => /^property_(send|recommendation)/.test(r.aix_type ?? "") && r.sent_at);

    if (f.estimateSent && !aixEstimate) {
      // 本文だけで「送った」と判定している（AIX 記録なし）
      estSentMismatch++;
      if (examples.length < 8) {
        const ev = ledger.entries.filter((e) => e.kind === "estimate_sent").map((e) => `${e.source}:${e.evidence.slice(0, 40)}`).join(" / ");
        examples.push(`  [見積] 台帳=送付済み だが AIX 記録なし  根拠: ${ev}`);
      }
    }
    if (!f.estimateSent && aixEstimate) { estSentMiss++; if (examples.length < 12) examples.push(`  [見積] AIX で送っているのに台帳が知らない (conv=${cid.slice(0, 8)})`); }
    if (f.propertiesSentCount > 0 && !aixProperty) propMismatch++;
    if (f.propertiesSentCount === 0 && aixProperty) {
      propMiss++;
      if (examples.length < 16) examples.push(`  [物件] AIX で送っているのに台帳が0件 (conv=${cid.slice(0, 8)})`);
    }
  }
  console.log(`\n② 台帳の事実 vs AIX の実記録（会話 ${n}件）`);
  console.log(`   見積: 台帳「送付済み」だが AIX 記録なし（本文からの推測）: ${estSentMismatch}件`);
  console.log(`   見積: AIX で送ったのに台帳が知らない（**漏れ**）        : ${estSentMiss}件`);
  console.log(`   物件: 台帳「送付あり」だが AIX 記録なし（手打ち送付）  : ${propMismatch}件`);
  console.log(`   物件: AIX で送ったのに台帳が0件（**漏れ**）            : ${propMiss}件`);
  for (const e of examples) console.log(e);

  // ── ③ ブレインに台帳が届いているか ──
  const { data: bl } = await sb.from("brain_decision_logs").select("digest, created_at").gte("created_at", since).limit(2000);
  const logs = (bl ?? []) as unknown as Array<Record<string, unknown>>;
  let withLedger = 0;
  for (const l of logs) {
    const d = (l.digest ?? {}) as Record<string, unknown>;
    const s = JSON.stringify(d);
    if (/物件送付|見積|台帳|ledger/.test(s)) withLedger++;
  }
  console.log(`\n③ ブレインの判断ログ ${logs.length}件のうち、台帳らしき情報を含む: ${withLedger}件（${logs.length ? ((withLedger / logs.length) * 100).toFixed(1) : "-"}%）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
