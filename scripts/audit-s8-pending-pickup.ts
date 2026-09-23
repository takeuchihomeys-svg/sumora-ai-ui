// 場面 S8「未履行のピックアップ宣言後の短い了承」の純関数の今月全件当て（読み取りのみ・DB は書かない）
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
//
// 【測る物】今日入れた pending-pickup.resolvePendingPickup と action-ledger.droppedKindDigest を、
//   今月のお客様発言の各時点（ブレインが回る時点）に**ブレインと同じ入力**（messages 直近15通・aix_usage_logs 30件・line_tasks 8件・sent_facts）で当て、
//   (1) pending=true の件数・reason 内訳、(2) pending=true の後 14日以内に物件を送った率（線 79.8%）、
//   (3) S8（直前スタッフ＝ピックアップ宣言・お客様＝短い了承）の実物: スタッフが実際にしたこと（返信なし／短い受け／再宣言／物件送付）と AIX（3時間以内）、
//   (4) droppedKindDigest が「もう言った」（pickup_declared / estimate_declared）を窓 8件の外から拾った件数。
//   出力の実物は YUMA 再現（scripts/yuma-scene-gap-s8.ts）の候補にする。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-s8-pending-pickup.ts [MONTH=2026-09] [SHOW=15]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { buildActionLedger, droppedKindDigest, classifyStaffTextFacts, STAFF_PICKUP_DECL_RE, STAFF_PROPERTIES_DONE_RE, type RecordedFact, type LedgerEntry } from "../app/lib/action-ledger";
import { resolvePendingPickup } from "../app/lib/pending-pickup";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";
import { classifySentKind } from "../app/lib/sent-shape";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const MONTH = process.env.MONTH ?? "2026-09";
const SHOW = Number(process.env.SHOW ?? 15);
const since = `${MONTH}-01T00:00:00+09:00`;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const WON_STATUSES = new Set(["closed_won", "applying", "screening", "application", "contract", "approved"]);
const DAY = 86_400_000;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "  —  ");

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null };
type Aix = { aix_type: string; check_pattern: string | null; created_at: string; sent_at: string | null; line_message_id: string | null; property_names: string[] | null; estimate_sent: boolean | null; template_name: string | null; generated_text: string | null };
type Task = { task_type: string; status: string; created_at: string; resolved_at: string | null; result: string | null };
type Conv = { id: string; customer_name: string; status: string; is_post_apply: boolean | null };
type Ex = { id: string; customer_message: string | null; sent_reply: string | null; ai_draft: string | null; was_ai_used: boolean | null; aix_action: string | null; created_at: string };

function maskWith(names: string[]) {
  return (s: string) => {
    let t = s;
    for (const n of names) if (n && n.length >= 2) t = t.split(n).join("〈お客様〉");
    return t.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,8}(?:さん|様|さま)/g, "〈お客様〉").replace(/\d{2,4}-\d{2,4}-\d{3,4}/g, "〈電話〉").replace(/https?:\/\/\S+/g, "〈URL〉");
  };
}
async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const ms = (s: string | null | undefined) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? t : NaN; };
const isPickupDecl = (t: string) => STAFF_PICKUP_DECL_RE.test(t) && !STAFF_PROPERTIES_DONE_RE.test(t);

type Point = {
  convId: string; name: string; status: string; won: boolean; msgId: string; at: string; custText: string;
  prevStaff: Msg | null; prevStaffKind: string | null; prevStaffIsPickupDecl: boolean; s8: boolean;
  pending: boolean; reason: string; hours: number | null; postApply: boolean;
  ledgerSummary: string; digestKinds: string[]; digestHasSaid: boolean;
  sentWithin14d: boolean; sentAt: string | null; nextStaff: Msg | null; nextStaffKind: string | null; nextStaffRedeclare: boolean; nextStaffMinutes: number | null;
  aix3h: string[]; example: Ex | null;
};

async function main() {
  const custMsgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated, line_message_id")
    .eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: true }).range(a, b));
  const convIds = [...new Set(custMsgs.map((m) => m.conversation_id))].filter((id) => id !== YUMA);
  const convOf = new Map<string, Conv>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name, status, is_post_apply").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Conv[]) convOf.set(c.id, c);
  }
  console.log(`=== ${MONTH} お客様発言あり ${convIds.length}会話（お客様発言 ${custMsgs.length}通・YUMA 除く）===`);
  const points: Point[] = [];
  for (const conv of convIds) {
    const c = convOf.get(conv); if (!c) continue;
    const msgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated, line_message_id").eq("conversation_id", conv).order("created_at", { ascending: true }).range(a, b));
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, property_names, estimate_sent, template_name, generated_text").eq("conversation_id", conv).order("created_at", { ascending: true }).limit(500);
    const aix = ((ax ?? []) as Aix[]).filter((r) => !!r.aix_type);
    const { data: tk } = await sb.from("line_tasks").select("task_type, status, created_at, resolved_at, result").eq("conversation_id", conv).order("created_at", { ascending: true }).limit(500);
    const tasks = (tk ?? []) as Task[];
    const { data: sf } = await sb.from("sent_facts").select("sent_at, origin, aix_type, kind, status, line_message_id, detail, evidence").eq("conversation_id", conv).order("sent_at", { ascending: true }).limit(1000);
    const facts = (sf ?? []) as RecordedFact[];
    const { data: exs } = await sb.from("ai_reply_examples").select("id, customer_message, sent_reply, ai_draft, was_ai_used, aix_action, created_at").eq("conversation_id", conv).gte("created_at", since);
    const examples = (exs ?? []) as Ex[];
    const won = WON_STATUSES.has(c.status) || c.is_post_apply === true;
    const applyPushAt = aix.filter((r) => r.aix_type === "application_push").map((r) => ms(r.sent_at ?? r.created_at));
    // 全期間の台帳（その後の履行を見る用）
    const fullLedger = buildActionLedger({
      recentAixRows: aix, messages: msgs.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated, lineMessageId: m.line_message_id })),
      lineTasks: tasks.map((t) => ({ task_type: t.task_type, status: t.status, created_at: t.created_at, completed_at: t.resolved_at, result: t.result })), recordedFacts: facts, now: Date.now(),
    });
    const sentDone = fullLedger.entries.filter((e) => e.kind === "properties_sent" && e.status === "done" && Number.isFinite(ms(e.at)));

    // お客様発言の連投（15分以内）は最後の1通を「ブレインが回る時点」にする
    const idxs = msgs.map((m, i) => ({ m, i })).filter(({ m }) => m.sender === "customer" && m.created_at >= since);
    for (const { m, i } of idxs) {
      const next = msgs[i + 1];
      if (next && next.sender === "customer" && ms(next.created_at) - ms(m.created_at) < 15 * 60_000) continue; // 連投の途中
      const T = ms(m.created_at);
      let s = i; while (s > 0 && msgs[s - 1].sender === "customer" && ms(msgs[s].created_at) - ms(msgs[s - 1].created_at) < 15 * 60_000) s--;
      const burstText = msgs.slice(s, i + 1).map((x) => x.text || (x.image_url ? "[画像]" : "")).join("\n");
      // ブレインと同じ入力（直近15通・AIX 30件・タスク 8件・送信時の記録）を T 時点で切る
      const winMsgs = msgs.slice(0, i + 1).slice(-15);
      const winAix = aix.filter((r) => ms(r.sent_at ?? r.created_at) <= T).slice(-30);
      const winTasks = tasks.filter((t) => ms(t.created_at) <= T).slice(-8).map((t) => ({ task_type: t.task_type, status: ms(t.resolved_at) > T ? "pending" : t.status, created_at: t.created_at, completed_at: ms(t.resolved_at) > T ? null : t.resolved_at, result: ms(t.resolved_at) > T ? null : t.result }));
      const winFacts = facts.filter((f) => ms(f.sent_at) <= T).slice(-120);
      const ledger = buildActionLedger({
        recentAixRows: winAix, messages: winMsgs.map((x) => ({ sender: x.sender, text: x.text ?? "", createdAt: x.created_at, isAix: !!x.is_aix_generated, lineMessageId: x.line_message_id })),
        lineTasks: winTasks, lastCustomerAt: m.created_at, recordedFacts: winFacts, now: T,
      });
      const postApply = isPostApplyStatus(c.status) && applyPushAt.some((t) => t <= T);
      const pp = resolvePendingPickup({ pickupPromisedUnfulfilled: ledger.facts.pickupPromisedUnfulfilled, pickupPromisedAt: ledger.facts.pickupPromisedAt, lastPropertiesSentAt: ledger.facts.lastPropertiesSentAt }, { now: T, postApply });
      const nonMedia = ledger.entries.filter((e) => e.kind !== "media_sent");
      const digest = droppedKindDigest(nonMedia, nonMedia.slice(-8));
      const prevStaff = msgs.slice(0, s).reverse().find((x) => x.sender === "staff" && (x.text ?? "").trim() && !/^\s*\[(?:画像|動画)\]\s*$/.test(x.text ?? "")) ?? null;
      const prevKinds = prevStaff ? classifyStaffTextFacts(prevStaff.text ?? "", prevStaff.created_at).map((e) => e.kind) : [];
      const prevIsPickup = !!prevStaff && (prevKinds.includes("pickup_declared") || isPickupDecl(prevStaff.text ?? ""));
      const s8 = prevIsPickup && isShortAckOnly(burstText);
      const after = msgs.slice(i + 1);
      const nextStaff = after.find((x) => x.sender === "staff" && (x.text ?? "").trim() && !/^\s*\[(?:画像|動画)\]\s*$/.test(x.text ?? "") && ms(x.created_at) - T <= 14 * DAY) ?? null;
      const nextCustBefore = after.find((x) => x.sender === "customer");
      const nextStaffBeforeCust = nextStaff && (!nextCustBefore || ms(nextStaff.created_at) < ms(nextCustBefore.created_at)) ? nextStaff : null;
      const sentAfter = sentDone.find((e) => ms(e.at) > T && ms(e.at) - T <= 14 * DAY);
      const aix3h = aix.filter((r) => { const t = ms(r.sent_at ?? r.created_at); return t > T && t - T <= 3 * 3_600_000; }).map((r) => r.aix_type + (r.check_pattern ? `/${r.check_pattern}` : ""));
      // 下書きの対応づけは時刻で（短い了承は本文が同じ物が多いので本文一致だけでは別の回を拾う）: 発言の後〜次のお客様発言（無ければ3日）まで
      const exEnd = nextCustBefore ? ms(nextCustBefore.created_at) : T + 3 * DAY;
      const ex = examples.filter((e) => ms(e.created_at) >= T - 60_000 && ms(e.created_at) <= exEnd).sort((a, b) => ms(a.created_at) - ms(b.created_at))[0] ?? null;
      points.push({
        convId: conv, name: c.customer_name, status: c.status, won, msgId: m.id, at: m.created_at, custText: burstText,
        prevStaff, prevStaffKind: prevKinds[0] ?? null, prevStaffIsPickupDecl: prevIsPickup, s8,
        pending: pp.pending, reason: pp.reason, hours: pp.hours, postApply,
        ledgerSummary: ledger.summary, digestKinds: digest.map((d: LedgerEntry) => `${d.kind}/${d.status}`), digestHasSaid: digest.some((d: LedgerEntry) => d.kind === "pickup_declared" || d.kind === "estimate_declared"),
        sentWithin14d: !!sentAfter, sentAt: sentAfter?.at ?? null, nextStaff: nextStaffBeforeCust, nextStaffKind: nextStaffBeforeCust ? classifySentKind(nextStaffBeforeCust.text) : null,
        nextStaffRedeclare: !!nextStaffBeforeCust && isPickupDecl(nextStaffBeforeCust.text ?? ""), nextStaffMinutes: nextStaffBeforeCust ? Math.round((ms(nextStaffBeforeCust.created_at) - T) / 60_000) : null,
        aix3h, example: ex,
      });
    }
  }

  // ── (1)(2) pending の内訳と履行率 ──
  const n = points.length;
  console.log(`\n■ (1) ブレインが回る時点 ${n}件（連投は最後の1通）／ 会話 ${convIds.length}`);
  const byReason = new Map<string, number>();
  for (const p of points) byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1);
  for (const [r, k] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`   reason=${r.padEnd(18)} ${String(k).padStart(4)}  ${pct(k, n)}`);
  const pend = points.filter((p) => p.pending);
  const pendConv = new Set(pend.map((p) => p.convId)).size;
  console.log(`\n■ (2) pending=true ${pend.length}件（${pendConv}会話）→ 14日以内に物件送付 ${pend.filter((p) => p.sentWithin14d).length}件 = ${pct(pend.filter((p) => p.sentWithin14d).length, pend.length)}（線 79.8%）`);
  const recentCut = Date.now() - 14 * DAY;
  const pendMature = pend.filter((p) => ms(p.at) <= recentCut);
  console.log(`   14日経った物だけ: ${pendMature.length}件 → 送付 ${pendMature.filter((p) => p.sentWithin14d).length}件 = ${pct(pendMature.filter((p) => p.sentWithin14d).length, pendMature.length)}`);
  const pendWon = pend.filter((p) => p.won);
  console.log(`   成約側: ${pendWon.length}件 → 送付 ${pendWon.filter((p) => p.sentWithin14d).length}件 = ${pct(pendWon.filter((p) => p.sentWithin14d).length, pendWon.length)}`);
  // 宣言からの経過時間の分布
  const hs = pend.map((p) => p.hours ?? 0).sort((a, b) => a - b);
  console.log(`   宣言からの経過: 中央値 ${hs.length ? hs[Math.floor(hs.length / 2)].toFixed(1) : "-"}h ／ 24h以内 ${pend.filter((p) => (p.hours ?? 0) <= 24).length} ／ 3日以内 ${pend.filter((p) => (p.hours ?? 0) <= 72).length} ／ 3日超 ${pend.filter((p) => (p.hours ?? 0) > 72).length}`);
  // pending=false（stale/fulfilled）でその後送った物（逆方向の誤り）
  const stale = points.filter((p) => p.reason === "stale");
  console.log(`   逆方向: stale ${stale.length}件のうち 14日以内に送付 ${stale.filter((p) => p.sentWithin14d).length}件 ／ no_promise ${points.filter((p) => p.reason === "no_promise").length}件のうち送付 ${points.filter((p) => p.reason === "no_promise" && p.sentWithin14d).length}件`);

  // ── (4) digest ──
  const withDigest = points.filter((p) => p.digestKinds.length);
  console.log(`\n■ (4) droppedKindDigest: 窓8件から落ちた種類がある時点 ${withDigest.length}/${n} = ${pct(withDigest.length, n)} ／ 「もう言った」（pickup_declared・estimate_declared）が拾えた ${points.filter((p) => p.digestHasSaid).length}件`);
  const dk = new Map<string, number>();
  for (const p of points) for (const k of p.digestKinds) dk.set(k, (dk.get(k) ?? 0) + 1);
  console.log(`   種類別: ${[...dk.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" / ")}`);

  // ── (3) S8 の実物 ──
  const s8 = points.filter((p) => p.s8);
  const s8won = s8.filter((p) => p.won);
  console.log(`\n■ (3) S8「直前スタッフ＝ピックアップ宣言・お客様＝短い了承」 ${s8.length}件（${new Set(s8.map((p) => p.convId)).size}会話・成約側 ${s8won.length}）`);
  const rate = (name: string, xs: Point[]) => {
    if (!xs.length) { console.log(`   ${name}: 0件`); return; }
    const noReply = xs.filter((p) => !p.nextStaff).length;
    const redecl = xs.filter((p) => p.nextStaffRedeclare).length;
    const shortR = xs.filter((p) => p.nextStaff && p.nextStaffKind === "短い返し" && !p.nextStaffRedeclare).length;
    const card = xs.filter((p) => p.nextStaff && (p.nextStaffKind === "物件カード" || p.nextStaffKind === "画像・URLのみ" || p.nextStaffKind === "物件・書類の送付（ご査収）")).length;
    console.log(`   ${name}: ${xs.length}件 ／ pending=true ${pct(xs.filter((p) => p.pending).length, xs.length)}（reason: ${[...new Set(xs.map((p) => p.reason))].join("・")}）`);
    console.log(`      次のスタッフ送信（お客様の次発言より前・14日）: 返信なし ${pct(noReply, xs.length)} ／ 短い受け ${pct(shortR, xs.length)} ／ 再宣言（3通目） ${pct(redecl, xs.length)} ／ 物件カード・画像 ${pct(card, xs.length)} ／ その他 ${pct(xs.length - noReply - shortR - redecl - card, xs.length)}`);
    console.log(`      14日以内に物件送付 ${pct(xs.filter((p) => p.sentWithin14d).length, xs.length)} ／ 3時間以内の AIX あり ${pct(xs.filter((p) => p.aix3h.length).length, xs.length)}（${[...new Set(xs.flatMap((p) => p.aix3h))].join("・") || "なし"}）／ AI 下書きあり ${pct(xs.filter((p) => p.example?.ai_draft && !/^\s*(\[AIX誘導中\]|__SHOWN__|\[返信不要\])/.test(p.example.ai_draft)).length, xs.length)} ／ そのまま送信 ${pct(xs.filter((p) => p.example?.was_ai_used).length, xs.filter((p) => p.example).length)}（下書きのある ${xs.filter((p) => p.example).length}件中）`);
    console.log(`      digest に「もう言った」 ${pct(xs.filter((p) => p.digestHasSaid).length, xs.length)}`);
  };
  rate("全体", s8); rate("成約側", s8won); rate("未成約", s8.filter((p) => !p.won));

  // 実物（成約側→pending=true→下書きあり を優先）
  const ranked = [...s8].sort((a, b) => Number(b.won) - Number(a.won) || Number(b.pending) - Number(a.pending) || Number(!!b.example?.ai_draft) - Number(!!a.example?.ai_draft) || ms(b.at) - ms(a.at));
  console.log(`\n■ S8 の実物（${Math.min(SHOW, ranked.length)}件・本名は伏せる）`);
  for (const p of ranked.slice(0, SHOW)) {
    const mask = maskWith([p.name]);
    console.log(`\n── ${p.won ? "★成約側" : "　"} conv=${p.convId.slice(0, 8)} msg=${p.msgId} status=${p.status} at=${p.at.slice(0, 16)} pending=${p.pending}(${p.reason}${p.hours != null ? `・${p.hours.toFixed(1)}h` : ""})`);
    console.log(`   直前スタッフ[${p.prevStaff?.created_at.slice(5, 16)}] ${mask((p.prevStaff?.text ?? "").replace(/\n/g, " / ")).slice(0, 160)}`);
    console.log(`   お客様: ${mask(p.custText.replace(/\n/g, " / ")).slice(0, 80)}`);
    console.log(`   台帳: ${p.ledgerSummary.slice(0, 120)} ／ digest=[${p.digestKinds.join("・") || "なし"}]`);
    console.log(`   次のスタッフ: ${p.nextStaff ? `[+${p.nextStaffMinutes}分・${p.nextStaffKind}${p.nextStaffRedeclare ? "・再宣言" : ""}] ${mask((p.nextStaff.text ?? "").replace(/\n/g, " / ")).slice(0, 160)}` : "（お客様の次発言まで返信なし）"} ／ 14日以内送付=${p.sentWithin14d ? `○ ${p.sentAt?.slice(5, 16)}` : "✗"} ／ AIX3h=[${p.aix3h.join("・") || "なし"}]`);
    if (p.example) console.log(`   AI下書き(${p.example.was_ai_used ? "そのまま送信" : "編集/未使用"}・aix=${p.example.aix_action ?? "-"}): ${mask((p.example.ai_draft ?? "").replace(/\n/g, " / ")).slice(0, 200)}`);
  }
  writeFileSync(`scripts/.s8-audit-${MONTH}.json`, JSON.stringify({ n, points: points.map((p) => ({ ...p, prevStaff: p.prevStaff ? { id: p.prevStaff.id, at: p.prevStaff.created_at, text: p.prevStaff.text } : null, nextStaff: p.nextStaff ? { id: p.nextStaff.id, at: p.nextStaff.created_at, text: p.nextStaff.text } : null })) }, null, 2), "utf8");
  console.log(`\n記録: scripts/.s8-audit-${MONTH}.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
