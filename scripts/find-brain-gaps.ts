// scripts/find-brain-gaps.ts
// ブレインと返信 AI の「抜け」を実データから探す常設スクリプト（読み取りのみ）。2026-09-12 竹内
//   「思った通りに行かない返信が出た時にブレインの原因を見つけて改善できるように、抜けている部分を見つけていく作業」を
//   スクショが届くのを待たずに先回りで回すための道具。見つけ方は設計知見「抜けの見つけ方（ブレイン原因診断の型）」と同じ5種類:
//     G1 分類の穴        … スタッフが手打ちで返した場面で、返信の型（PAIR_MATRIX のセル）が選ばれていない（KENYOU「〇〇は無しで」）
//     G2 再分析の引き金の穴 … スタッフが AIX を押した時、ブレインがその前の顧客発言を分析していない（cached で古い判断が残った）
//     G3 判断の穴        … ブレインは分析したが AIX なし／別の AIX と判断し、スタッフは AIX を押した
//     G4 約束→AIX の抜け … 最後がスタッフの宣言（約束）で、スタッフが次に AIX を押したのに、約束→AIX の規則が何も返さない（Sさん「募集状況確認させて頂きます」）
//     G5 矯正の誤発火    … ブレインの決定論の矯正（decision_source=correction:*）が出た後、スタッフが別の AIX を押した（画像のみ→見積書）
//     G6 古い事実の注入  … 会話のセーブデータ（conversation_checkpoints）が止まっている＝ブレイン・最終チェックが古い事実で動く
//                          （2026-09-13: 出力の上限で JSON が切れ、長い会話ほど止まっていた。total − 最新の message_count_at_creation ≥ 15 を数える）
//   件数の多い順に「穴の種類 × 押された AIX／顧客の分類」で束ね、例を数件ずつ出す（本文は先頭60字だけ。個人情報を含むので出力を共有しない）。
//
// 実行: npx tsx --env-file=.env.local scripts/find-brain-gaps.ts [--days=30] [--top=4] [--only=G1,G4]
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, classifyStaffTextForLedger, type LedgerAixRow } from "@/app/lib/action-ledger";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, MSG_SEP } from "@/app/lib/reply-context";
import { isConditionFormMessage } from "@/app/lib/line-reply-prompts";
import { resolveStaffPromiseAix } from "@/app/lib/aix-task-link";
import { customerRequestedPropertyCheck } from "@/app/lib/aix-scene-evidence";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? "true"); }
const DAYS = Number(args.get("days") ?? "30");
const TOP = Number(args.get("top") ?? "4");
const ONLY = new Set((args.get("only") ?? "G1,G2,G3,G4,G5,G6").split(","));
/** brain_decision_logs に analyzed_msg_ts・decision_source が入り始めた時刻（これより前の押下は G2/G3/G5 の判定に使えない＝ログが無いだけで穴に見える） */
const BRAIN_LOG_SINCE = Date.parse(args.get("brain-since") ?? "2026-09-12T03:54:00Z");

type Msg = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Aix = { aix_type: string | null; check_pattern: string | null; created_at: string; sent_at: string | null; conversation_id: string };
type Log = { created_at: string; suggested_action: string | null; decision_source: string | null; analyzed_msg_ts: string | null; analysis_mode: string | null };
type Finding = { gap: string; key: string; cust: string; staff: string; note: string };

const t = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
const ms = (s: string | null | undefined) => { const v = Date.parse(s ?? ""); return Number.isFinite(v) ? v : NaN; };
const isMedia = (s: string | null) => /^\[(?:画像|動画|スタンプ|ファイル)\]/.test((s ?? "").trim());

(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL / key が未設定（--env-file=.env.local）"); process.exit(2); }
  const sb = createClient(url, key);
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

  // 対象会話: 期間内にスタッフが送信した会話
  const convIds = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("sender", "staff").gte("created_at", since).range(from, from + 999);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ conversation_id: string }>) convIds.add(r.conversation_id);
    if (!data || data.length < 1000) break;
  }
  const findings: Finding[] = [];
  let pressCount = 0, staffReplyCount = 0, brainJudgedPress = 0, g6Checked = 0;
  const queue = [...convIds];
  const worker = async () => {
    for (let cid = queue.shift(); cid; cid = queue.shift()) {
      const [m, a, l, tk] = await Promise.all([
        sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(400),
        sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, conversation_id").eq("conversation_id", cid).order("created_at", { ascending: true }).limit(300),
        sb.from("brain_decision_logs").select("created_at, suggested_action, decision_source, analyzed_msg_ts, analysis_mode").eq("conversation_id", cid).order("created_at", { ascending: true }).limit(500),
        sb.from("line_tasks").select("task_type, status, created_at, completed_at, result").eq("conversation_id", cid).limit(300),
      ]);
      if (m.error || a.error || l.error || tk.error) { console.warn("skip", cid, (m.error ?? a.error ?? l.error ?? tk.error)?.message); continue; }
      // ── G6: セーブデータが止まっていないか（11通以上で未作成、または最新から15通以上進んでいる）──
      if (ONLY.has("G6")) {
        const [cnt, cp] = await Promise.all([
          sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", cid),
          sb.from("conversation_checkpoints").select("message_count_at_creation, created_at").eq("conversation_id", cid).order("checkpoint_index", { ascending: false }).limit(1).maybeSingle(),
        ]);
        const total = cnt.count ?? 0;
        const at = (cp.data as { message_count_at_creation: number } | null)?.message_count_at_creation ?? 0;
        if (total > 10 && total - at >= 15) {
          findings.push({ gap: "G6 古い事実の注入", key: total - at >= 40 ? "セーブデータが40通以上遅れ" : "セーブデータが15通以上遅れ", cust: `全${total}通`, staff: at ? `セーブ ${at}通目まで` : "セーブ未作成", note: cid.slice(0, 8) });
        }
        g6Checked++;
      }
      const msgs = ((m.data ?? []) as Msg[]).reverse().filter((x) => typeof x.text === "string");
      const aix = (a.data ?? []) as Aix[];
      const logs = (l.data ?? []) as Log[];
      const before = (at: number) => msgs.filter((x) => ms(x.created_at) < at);

      // ── G2〜G5: スタッフが押した AIX ごとに、直前のブレインの判断と突き合わせる ──
      for (const p of aix) {
        const pressAt = ms(p.sent_at ?? p.created_at);
        if (!(pressAt >= ms(since)) || !p.aix_type) continue;
        pressCount++;
        const prev = before(pressAt - 1000);
        const lastCust = [...prev].reverse().find((x) => x.sender === "customer");
        const lastMsg = prev[prev.length - 1];
        const lastStaff = [...prev].reverse().find((x) => x.sender === "staff" && !isMedia(x.text));
        const log = [...logs].reverse().find((g) => ms(g.created_at) < pressAt);
        const brainAction = log?.suggested_action || "";
        const custAt = ms(lastCust?.created_at);
        // 最後がスタッフの宣言（約束）→ G4
        if (lastMsg && lastMsg.sender === "staff" && !isMedia(lastMsg.text)) {
          const entry = classifyStaffTextForLedger(lastMsg.text ?? "", lastMsg.created_at);
          if (entry?.status === "promised" && brainAction !== p.aix_type) {
            const ledger = buildActionLedger({
              // 押した AIX 自身は除く（aix_usage_logs は生成時刻 created_at が送信時刻 sent_at より前なので、created_at で絞ると押下自身が「履行済み」に数えられる）
              recentAixRows: aix.filter((r) => r !== p && ms(r.sent_at ?? r.created_at) < pressAt - 1000) as LedgerAixRow[],
              messages: prev.slice(-30).map((x) => ({ sender: x.sender, text: x.text ?? "", createdAt: x.created_at, isAix: !!x.is_aix_generated })),
              lineTasks: ((tk.data ?? []) as Array<{ task_type: string; status: string; created_at: string }>).filter((r) => ms(r.created_at) < pressAt),
              lastCustomerAt: lastCust?.created_at ?? null, now: pressAt,
            });
            const oldest = prev.map((x) => ({ sender: x.sender, text: x.text }));
            const rule = resolveStaffPromiseAix(ledger.facts, oldest, {
              customerRequestedCheck: customerRequestedPropertyCheck({ recentMessages: oldest, sentPropertyCount: ledger.facts.propertiesSentCount }),
            });
            if (rule?.action !== p.aix_type) {
              findings.push({ gap: "G4 約束→AIX の抜け", key: `${entry.kind} → 押された ${p.aix_type}`, cust: t(lastCust?.text), staff: t(lastMsg.text),
                note: `規則=${rule?.action ?? "なし"} ブレイン=${brainAction || "なし"}` });
              continue;
            }
          }
        }
        if (brainAction === p.aix_type) continue; // 一致
        if (pressAt < BRAIN_LOG_SINCE) continue; // ブレインの判断ログが揃う前（穴かどうか判定できない）
        brainJudgedPress++;
        if (!log || !Number.isFinite(custAt) || ms(log.analyzed_msg_ts ?? log.created_at) < custAt - 1000) {
          if (lastCust) findings.push({ gap: "G2 再分析の引き金の穴", key: `押された ${p.aix_type}`, cust: t(lastCust.text), staff: t(lastStaff?.text),
            note: `最後の分析=${log ? log.created_at.slice(5, 16) : "なし"} 顧客=${lastCust.created_at.slice(5, 16)}` });
          continue;
        }
        if ((log.decision_source ?? "").startsWith("correction:")) {
          findings.push({ gap: "G5 矯正の誤発火", key: `${log.decision_source} → 押された ${p.aix_type}`, cust: t(lastCust?.text), staff: t(lastStaff?.text), note: `ブレイン=${brainAction}` });
          continue;
        }
        findings.push({ gap: "G3 判断の穴", key: `ブレイン ${brainAction || "AIXなし"} → 押された ${p.aix_type}`, cust: t(lastCust?.text), staff: t(lastStaff?.text),
          note: `source=${log.decision_source ?? "-"}` });
      }

      // ── G1: スタッフが手打ちで返した場面で、返信の型（セル）が選ばれていない ──
      for (let i = 0; i < msgs.length; i++) {
        const s = msgs[i];
        if (s.sender !== "staff" || s.is_aix_generated || isMedia(s.text) || ms(s.created_at) < ms(since)) continue;
        if (i > 0 && msgs[i - 1].sender === "staff") continue; // 分割送信の2通目以降
        const units: string[] = [];
        for (let j = i - 1; j >= 0 && msgs[j].sender !== "staff"; j--) if (msgs[j].sender === "customer" && !isMedia(msgs[j].text)) units.unshift(msgs[j].text ?? "");
        if (!units.length) continue;
        staffReplyCount++;
        const prevStaff = [...msgs.slice(0, i)].reverse().find((x) => x.sender === "staff");
        const at = ms(s.created_at);
        const aixRows = aix.filter((r) => ms(r.created_at) < at - 1000) as LedgerAixRow[];
        const ledger = buildActionLedger({
          recentAixRows: aixRows,
          messages: msgs.slice(Math.max(0, i - 30), i).map((x) => ({ sender: x.sender, text: x.text ?? "", createdAt: x.created_at, isAix: !!x.is_aix_generated })),
          lineTasks: ((tk.data ?? []) as Array<{ task_type: string; status: string; created_at: string }>).filter((r) => ms(r.created_at) < at),
          lastCustomerAt: msgs[i - 1]?.created_at ?? null, now: at,
        });
        const cust = units.join(MSG_SEP);
        const staff = classifyLastStaffTurn(prevStaff?.text ?? "", { recentAixRows: aixRows, lastStaffAt: prevStaff?.created_at ?? null, ledger });
        const sub = analyzeSubstance(cust, units, { staffAskedQuestion: staff.kind === "question_to_customer" });
        const customer = classifyCustomerResponse(sub, staff, { ledger, isConditionPresented: isConditionFormMessage(cust), recentStaffText: prevStaff?.text ?? "" });
        const pair = resolveTurnPair(staff, customer, sub, prevStaff?.text ?? "", { ledger });
        if (pair.rule) continue;
        findings.push({ gap: "G1 分類の穴", key: `直前=${staff.kind} × 顧客=${customer.kind}`, cust: t(cust.split(MSG_SEP).join(" ／ ")), staff: t(s.text), note: `実質=${sub.kinds.join("・") || "なし"}` });
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  console.log(`期間 ${DAYS} 日・会話 ${convIds.size}・押された AIX ${pressCount}（うちブレインの判断ログが揃った後で不一致 ${brainJudgedPress}）・手打ち返信 ${staffReplyCount}`);
  console.log(`※ G2/G3/G5 は ${new Date(BRAIN_LOG_SINCE).toISOString().slice(0, 16)} 以降の押下だけ（それ以前はログが無く判定できない）。G1/G4 は全期間`);
  const gaps = ["G1 分類の穴", "G2 再分析の引き金の穴", "G3 判断の穴", "G4 約束→AIX の抜け", "G5 矯正の誤発火", "G6 古い事実の注入"].filter((g) => ONLY.has(g.slice(0, 2)));
  for (const g of gaps) {
    const rows = findings.filter((f) => f.gap === g);
    const denom = g.startsWith("G1") ? staffReplyCount : g.startsWith("G4") ? pressCount : g.startsWith("G6") ? g6Checked : brainJudgedPress;
    console.log(`\n■ ${g}: ${rows.length} 件（${denom ? ((100 * rows.length) / denom).toFixed(1) : "0"}%）`);
    const byKey = new Map<string, Finding[]>();
    for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    for (const [k, rs] of [...byKey].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      console.log(`  ${String(rs.length).padStart(4)}  ${k}`);
      for (const r of rs.slice(0, TOP)) console.log(`        顧客「${r.cust}」\n        スタッフ「${r.staff}」 ${r.note}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(2); });
