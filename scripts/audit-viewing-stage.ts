// scripts/audit-viewing-stage.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-stage.ts          （DAYS=180 既定・読み取りのみ）
//       DUMP=1 …… 合わなかった回を全部／CONV=8a77820b …… その会話の段階の移り変わりを1通ずつ
//
// 2026-09-30 竹内さん「内覧調整→日にち決定→待ち合わせ場所＝確定 の流れをちゃんとできるように・先走らないように」
//
// 内覧の流れの段階の関数（app/lib/viewing-flow.ts resolveViewingFlow）を過去の会話に当て、スタッフが実際に押した AIX の順と合うかを見る:
//   A. スタッフが AIX【内覧調整】【待ち合わせ場所】を押した瞬間の「直前までの材料」で段階と次の AIX の候補を出し、押した AIX と比べる
//      前（今の場面の証拠 aix-scene-evidence）／後（段階の関数）を並べる
//   B. 候補日のやり取り中（proposing / date_agreed）にお客様が別の話をした回で、段階が進まない（次の AIX の候補なし）か
//   C. 待ち合わせを押した時の段階の内訳（confirmed の後にもう一度＝変更／date_agreed／proposing のまま 等）
//   件数だけでなく、合わなかった回の実物を読む
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, type LedgerAixRow, type LedgerMessage } from "../app/lib/action-ledger";
import { viewingFlowNextAix, VIEWING_FLOW_STAGE_JA, type ViewingFlow } from "../app/lib/viewing-flow";
import { detectAixSceneEvidence } from "../app/lib/aix-scene-evidence";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 180);
const DUMP = process.env.DUMP === "1";
const CONV = process.env.CONV ?? "";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
type Aix = LedgerAixRow & { conversation_id: string; aix_type: string; created_at: string; sent_at: string | null; generated_text: string | null };
type Conv = { id: string; status: string | null; line_source_type: string | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); const r = data ?? []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const one = (s: string | null | undefined, n = 150) => (s ?? "").replace(/\n+/g, " / ").slice(0, n);
const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

function flowAt(ms: Msg[], ax: Aix[], tMs: number): { flow: ViewingFlow; lastCust: string; lastCustAt: string | null; msgs: LedgerMessage[] } {
  const msgs: LedgerMessage[] = ms.filter((m) => Date.parse(m.created_at) < tMs).slice(-60).map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at }));
  const rows = ax.filter((r) => Date.parse(r.sent_at ?? r.created_at) < tMs);
  const lastC = [...msgs].reverse().find((m) => m.sender === "customer");
  const ledger = buildActionLedger({ messages: msgs, recentAixRows: rows, lastCustomerAt: lastC?.createdAt ?? null, now: tMs });
  // 今回のお客様の連投
  let i = msgs.length - 1; while (i >= 0 && msgs[i].sender !== "customer") i--;
  const turn: string[] = []; for (; i >= 0 && msgs[i].sender === "customer"; i--) turn.unshift(msgs[i].text);
  return { flow: ledger.facts.viewingFlow!, lastCust: turn.join("\n"), lastCustAt: lastC?.createdAt ?? null, msgs };
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = await pageAll<Conv>((a, b) => sb.from("conversations").select("id, status, line_source_type").range(a, b));
  const ok = new Set(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  const aixAll = await pageAll<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, generated_text, check_pattern, property_names, estimate_sent, template_name, line_message_id, prop_statuses").gte("created_at", since).order("created_at", { ascending: true }).range(a, b));
  const msgs = await pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", since).order("created_at", { ascending: true }).range(a, b));
  const byConv = new Map<string, Msg[]>(); for (const m of msgs) if (ok.has(m.conversation_id)) (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  const aixByConv = new Map<string, Aix[]>(); for (const r of aixAll) if (ok.has(r.conversation_id)) (aixByConv.get(r.conversation_id) ?? aixByConv.set(r.conversation_id, []).get(r.conversation_id)!).push(r);

  if (CONV) {
    for (const [cid, ms] of byConv) {
      if (!cid.startsWith(CONV)) continue;
      const ax = aixByConv.get(cid) ?? [];
      console.log(`=== ${cid} の段階の移り変わり（各発言の直後の段階）===`);
      let prev = "";
      for (const m of ms) {
        const t = Date.parse(m.created_at) + 1000;
        const { flow } = flowAt(ms, ax, t);
        const a = ax.find((r) => Math.abs(Date.parse(r.sent_at ?? r.created_at) - Date.parse(m.created_at)) < 3 * 60_000);
        const key = `${flow.stage}|${flow.label}|${flow.lastReply}|${flow.currentReply}|${flow.askedDay}|${flow.confirmed}`;
        if (key === prev) continue;
        prev = key;
        console.log(`${jst(m.created_at)} ${m.sender === "customer" ? "客" : a ? `AIX:${a.aix_type}` : "ス"} ${one(m.text, 90)}\n      → ${flow.stage}${flow.confirmed ? "(確定あり)" : ""} ${flow.label ?? ""} 返事=${flow.lastReply ?? "-"} 今回=${flow.currentReply ?? "-"} 聞いた日=${flow.askedDay ?? "-"} 候補=${flow.slots.join(",") || "-"} 次=${viewingFlowNextAix(flow) ?? "-"} [${flow.reason}]`);
      }
    }
    return;
  }

  // ── A. 押した瞬間 ──
  type Row = { cid: string; at: string; pressed: string; flow: ViewingFlow; after: string | null; before: string | null; lastCust: string; stale: boolean; body: string };
  const rows: Row[] = [];
  for (const [cid, ax] of aixByConv) {
    const ms = byConv.get(cid) ?? [];
    for (const r of ax) {
      if (r.aix_type !== "viewing_invite" && r.aix_type !== "meeting_place") continue;
      const at = r.sent_at ?? r.created_at;
      // AIX の本文は記録の時刻より数分前に messages に入る事があるので、「押す直前のお客様の最後の発言の直後」で切る
      const prevCust = [...ms].reverse().find((m) => m.sender === "customer" && Date.parse(m.created_at) < Date.parse(at));
      const t = prevCust ? Date.parse(prevCust.created_at) + 1000 : Date.parse(at) - 10 * 60_000;
      const { flow, lastCust, msgs: lm } = flowAt(ms, ax, t);
      // お客様の最後の発言より後にこちらがもう何か送っている（＝お客様の発言への一手ではない・こちらからの追い打ち）は別に数える
      const lastStaffAfter = ms.some((m) => m.sender === "staff" && Date.parse(m.created_at) > t && Date.parse(m.created_at) < Date.parse(at) - 10 * 60_000);
      const hasImage = /\[画像\]/.test(lastCust);
      const sentCount = lm.filter((m) => m.sender === "staff" && /🌟|https?:\/\//.test(m.text)).length;
      let before: string | null = null;
      try { before = detectAixSceneEvidence({ latestCustomerTurn: lastCust.replace(/\[画像\][^\n]*/g, "").trim(), hasCustomerImage: hasImage, sentPropertyCount: sentCount, recentMessages: lm.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt })), propertyStatus: "unknown" } as Parameters<typeof detectAixSceneEvidence>[0])?.candidateAction ?? null; } catch { before = null; }
      rows.push({ cid, at, pressed: r.aix_type, flow, after: viewingFlowNextAix(flow), before, lastCust, stale: lastStaffAfter, body: r.generated_text ?? "" });
    }
  }
  const live = rows.filter((r) => !r.stale);
  console.log(`=== A. スタッフが AIX【内覧調整】【待ち合わせ場所】を押した ${rows.length}回（うちお客様の発言への一手 ${live.length}・こちらの連投の途中 ${rows.length - live.length}） ===`);
  for (const p of ["viewing_invite", "meeting_place"]) {
    const s = live.filter((r) => r.pressed === p);
    const b = s.filter((r) => r.before === p).length; const a = s.filter((r) => r.after === p).length;
    const bWrong = s.filter((r) => r.before && r.before !== p && (r.before === "viewing_invite" || r.before === "meeting_place")).length;
    const aWrong = s.filter((r) => r.after && r.after !== p).length;
    console.log(`  ${p} ${s.length}回: 前（場面の証拠）一致 ${b}（${pct(b, s.length)}）・逆の内覧 AIX ${bWrong}／後（段階の関数）一致 ${a}（${pct(a, s.length)}）・逆 ${aWrong}・候補なし ${s.length - a - aWrong}`);
  }
  const both = live.filter((r) => r.after === r.pressed || r.before === r.pressed).length;
  console.log(`  どちらかが一致 ${both}/${live.length}（${pct(both, live.length)}）＝ブレインには両方を材料として渡す`);

  console.log(`\n=== C. 押した時の段階の内訳 ===`);
  for (const p of ["viewing_invite", "meeting_place"]) {
    const s = live.filter((r) => r.pressed === p); const n = new Map<string, number>();
    for (const r of s) { const k = `${r.flow.stage}${r.flow.confirmed && r.flow.stage !== "confirmed" ? "+確定あり" : ""}／今回=${r.flow.currentReply ?? (r.flow.currentWish ? "wish" : "-")}`; n.set(k, (n.get(k) ?? 0) + 1); }
    console.log(`  ${p}: ${[...n].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join("｜")}`);
  }

  console.log(`\n=== A'. 後（段階の関数）が逆を言った回（全部読む）===`);
  for (const r of live.filter((x) => x.after && x.after !== x.pressed)) {
    console.log(`  [${r.cid.slice(0, 8)} ${jst(r.at)}] 押した=${r.pressed} 段階=${r.flow.stage} ${r.flow.label ?? ""} 今回=${r.flow.currentReply} 候補=${r.flow.slots.join(",") || "-"} [${r.flow.reason}]\n      客: ${one(r.lastCust, 130)}\n      AIX: ${one(r.body, 130)}`);
  }
  console.log(`\n=== A''. 後が候補なしだった回（${DUMP ? "全部" : "先頭40"}）===`);
  for (const r of live.filter((x) => !x.after).slice(0, DUMP ? 500 : 40)) {
    console.log(`  [${r.cid.slice(0, 8)} ${jst(r.at)}] 押した=${r.pressed} 前=${r.before ?? "-"} 段階=${r.flow.stage}${r.flow.confirmed ? "(確定あり)" : ""} ${r.flow.label ?? ""} 返事=${r.flow.lastReply ?? "-"} 今回=${r.flow.currentReply ?? "-"} [${r.flow.reason}]\n      客: ${one(r.lastCust, 130)}\n      AIX: ${one(r.body, 110)}`);
  }

  // ── B. 候補日のやり取り中・日にち決定後（待ち合わせ前）のお客様の発言で、スタッフが AIX 内覧系を押さなかった回 ──
  console.log(`\n=== B. 未確定の間（proposing / date_agreed）のお客様の連投と、段階の関数の候補・スタッフの次の一手 ===`);
  type Turn = { cid: string; at: string; text: string; flow: ViewingFlow; next: string | null; staffNext: string; staffText: string };
  const turns: Turn[] = [];
  for (const [cid, ms] of byConv) {
    const ax = aixByConv.get(cid) ?? [];
    if (!ax.some((r) => r.aix_type === "viewing_invite")) continue;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || (ms[i + 1] && ms[i + 1].sender === "customer")) continue;
      const t = Date.parse(ms[i].created_at) + 1000;
      const { flow, lastCust } = flowAt(ms, ax, t);
      if (flow.stage !== "proposing" && flow.stage !== "date_agreed") continue;
      const nextStaff = ms.slice(i + 1).find((m) => m.sender === "staff");
      if (!nextStaff) continue;
      const a = ax.find((r) => Math.abs(Date.parse(r.sent_at ?? r.created_at) - Date.parse(nextStaff.created_at)) < 3 * 60_000);
      turns.push({ cid, at: ms[i].created_at, text: lastCust, flow, next: viewingFlowNextAix(flow), staffNext: a ? a.aix_type : "手書き", staffText: nextStaff.text ?? "" });
    }
  }
  const tab = new Map<string, number>();
  for (const x of turns) { const k = `今回=${x.flow.currentReply}｜候補=${x.next ?? "なし"}｜実際=${x.staffNext === "viewing_invite" || x.staffNext === "meeting_place" || x.staffNext === "手書き" ? x.staffNext : "他のAIX"}`; tab.set(k, (tab.get(k) ?? 0) + 1); }
  for (const [k, c] of [...tab].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${k}: ${c}`);
  const other = turns.filter((x) => x.flow.currentReply === "none");
  const otherView = other.filter((x) => x.staffNext === "viewing_invite" || x.staffNext === "meeting_place");
  console.log(`  別の話（今回=none）${other.length}回: スタッフが内覧の AIX を押した ${otherView.length}／押さなかった ${other.length - otherView.length}（＝段階を進めないで合っている ${pct(other.length - otherView.length, other.length)}）`);
  console.log(`  -- 今回=none なのにスタッフが内覧の AIX を押した回（読み落としの候補・全部）--`);
  for (const x of otherView) console.log(`    [${x.cid.slice(0, 8)} ${jst(x.at)}] 段階=${x.flow.stage} ${x.flow.label ?? ""} → ${x.staffNext}\n        客: ${one(x.text, 140)}\n        ス: ${one(x.staffText, 110)}`);
  console.log(`  -- 候補あり（日にちの返事）なのにスタッフが手書きで返した回（${DUMP ? "全部" : "先頭25"}）--`);
  for (const x of turns.filter((y) => y.next && y.staffNext === "手書き").slice(0, DUMP ? 300 : 25)) console.log(`    [${x.cid.slice(0, 8)} ${jst(x.at)}] 今回=${x.flow.currentReply} 候補=${x.next}\n        客: ${one(x.text, 130)}\n        ス: ${one(x.staffText, 130)}`);
  console.log(`\n段階の名前: ${Object.entries(VIEWING_FLOW_STAGE_JA).map(([k, v]) => `${k}=${v}`).join("／")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
