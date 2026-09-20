// 「自分が送った文」を踏まえずに書いた返信を探す（読み取りのみ）
//
// 2026-09-20 竹内「自分が送った文のことも踏まえたうえでズレは起きていないかな？
//   **自分で送った文を理解していないことがたまにある**から」
//
// 設計知見（行動台帳）:
//   「送付済み物件を『これからお送りします』と未来形で再宣言しない」
//   「御見積書は送付済み。『御見積書を作成しお送りします』の再宣言は禁止」
//   「この内覧は決まっている。新しい日程の打診は書かない」
//   「募集状況の確認は実行・報告済み。『確認します』の再宣言は禁止」
//
// つまり**台帳が「もうやった」と知っている事を、もう一度これからやると書く**のが
// 「自分が送った文を理解していない」の正体。台帳を組んで下書き・実送信と突き合わせる。
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, type LedgerAixRow, type LedgerMessage, type LedgerTask } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 台帳の事実 × それと矛盾する言い回し */
const CONTRADICTIONS: Array<{
  id: string;
  when: (f: ReturnType<typeof buildActionLedger>["facts"]) => boolean;
  re: RegExp;
  note: string;
}> = [
  {
    id: "見積を送ったのに「これから作ってお送りします」",
    when: (f) => f.estimateSent,
    re: /(?:御|お)?見積(?:書|り|もり)[^\n。！!]{0,20}(?:作成|お作り)[^\n。！!]{0,12}(?:お送り|ご連絡)(?:させて(?:頂|いただ)きます|いたします|致します|します)|(?:御|お)?見積(?:書|り|もり)[^\n。！!]{0,12}(?:お送り|ご用意)(?:させて(?:頂|いただ)きます|いたします|致します)/,
    note: "台帳: 御見積書は送付済み。「作成しお送りします」の再宣言は禁止",
  },
  {
    id: "物件を送ったのに「これからピックアップしてお送りします」",
    when: (f) => f.propertiesSentCount > 0 && !f.pickupPromisedUnfulfilled,
    re: /(?:これから|今から)[^\n。！!]{0,16}ピックアップ|ピックアップ(?:して|し)(?:お送り|ご連絡)(?:させて(?:頂|いただ)きます|いたします|致します)(?![^\n]{0,20}次第)/,
    note: "台帳: 送付済み物件を「これからお送りします」と未来形で再宣言しない",
  },
  {
    id: "内覧が決まっているのに新しい日程を打診",
    when: (f) => !!f.viewingAppointment,
    re: /ご都合(?:の)?よろしい(?:お日にち|日)/,
    note: "台帳: この内覧は決まっている。新しい日程の打診は書かない",
  },
  {
    id: "確認を報告済みなのに「確認させて頂きます」",
    when: (f) => f.confirmationReported && !f.confirmationPromisedUnfulfilled,
    re: /(?:募集状況|空室状況|空き状況)[^\n。！!]{0,10}(?:を)?確認(?:させて(?:頂|いただ)きます|いたします|致します)/,
    note: "台帳: 募集状況の確認は実行・報告済み。「確認します」の再宣言は禁止",
  },
  {
    id: "物件0件なのに「再度」「改めて」",
    when: (f) => !f.redoAllowed,
    re: /再度|改めて|もう一度|追加で|別の物件|先ほどお送りした/,
    note: "台帳: 1件も送っていないので二度目は存在しない",
  },
];

async function main() {
  const days = Number(process.env.DAYS ?? 90);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let p = 0; p < 28; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }
  const aix: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, generated_text")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    aix.push(...r);
    if (r.length < 1000) break;
  }
  // AI の下書きと、その会話・時刻
  const drafts: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 12; p++) {
    const { data } = await sb.from("ai_reply_examples")
      .select("conversation_id, ai_draft, sent_reply, was_ai_used, created_at, customer_message")
      .gte("created_at", since).not("ai_draft", "is", null)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    drafts.push(...r);
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

  console.log(`=== 直近${days}日 会話 ${byConv.size}件／AI 下書き ${drafts.length}件 ===\n`);

  type Hit = { id: string; text: string; who: "下書き" | "実送信"; at: string; note: string };
  const hits: Hit[] = [];
  let checkedDraft = 0, checkedSent = 0;

  for (const d of drafts) {
    const cid = String(d.conversation_id ?? "");
    const list = byConv.get(cid);
    if (!list) continue;
    const at = Date.parse(String(d.created_at));
    if (!Number.isFinite(at)) continue;
    // その下書きが作られた時点までの会話で台帳を組む
    const upto = list.filter((m) => Date.parse(m.created_at) <= at);
    if (upto.length === 0) continue;
    const lastCust = [...upto].reverse().find((m) => m.sender === "customer");
    if (!lastCust) continue;
    const ledger = buildActionLedger({
      recentAixRows: (aixByConv.get(cid) ?? []).filter((r) => Date.parse(String(r.created_at)) <= at),
      messages: upto.map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at } as LedgerMessage)),
      lineTasks: [] as LedgerTask[], lastCustomerAt: lastCust.created_at, now: at,
    });
    const f = ledger.facts;
    for (const [col, who] of [["ai_draft", "下書き"], ["sent_reply", "実送信"]] as Array<[string, "下書き" | "実送信"]>) {
      const t = String(d[col] ?? "");
      if (!t || t === "__SHOWN__" || /^\[/.test(t)) continue;
      if (who === "下書き") checkedDraft++; else checkedSent++;
      for (const c of CONTRADICTIONS) {
        if (!c.when(f) || !c.re.test(t)) continue;
        hits.push({ id: c.id, text: t.replace(/\n/g, " ／ ").slice(0, 96), who, at: String(d.created_at), note: c.note });
      }
    }
  }

  console.log(`当てた回数: 下書き ${checkedDraft}件 ／ 実送信 ${checkedSent}件\n`);
  console.log(`${"台帳と矛盾する言い回し".padEnd(44)} 下書き / 実送信`);
  console.log("─".repeat(72));
  for (const c of CONTRADICTIONS) {
    const d = hits.filter((h) => h.id === c.id && h.who === "下書き");
    const s = hits.filter((h) => h.id === c.id && h.who === "実送信");
    const mark = d.length > s.length ? " 🔴 AI だけが間違える" : s.length > 0 ? " 🟡 スタッフも書く" : "";
    console.log(`${c.id.padEnd(44)} ${String(d.length).padStart(5)} / ${String(s.length).padStart(5)}${mark}`);
    console.log(`    （${c.note}）`);
    for (const h of d.slice(0, 3)) console.log(`      [下書き ${h.at.slice(5, 16)}] ${h.text}`);
    for (const h of s.slice(0, 2)) console.log(`      [実送信 ${h.at.slice(5, 16)}] ${h.text}`);
    console.log("");
  }

  const dTotal = hits.filter((h) => h.who === "下書き").length;
  const sTotal = hits.filter((h) => h.who === "実送信").length;
  console.log(`=== 合計: 下書き ${dTotal}件（${checkedDraft ? ((dTotal / checkedDraft) * 100).toFixed(1) : "-"}%）／ 実送信 ${sTotal}件（${checkedSent ? ((sTotal / checkedSent) * 100).toFixed(1) : "-"}%）===`);
  console.log(`  下書きの方が多い型 ＝ AI が「自分が送った文」を踏まえていない`);
  console.log(`  実送信にも同じだけ出る型 ＝ スタッフもそう書く（台帳の禁止の方が厳しすぎる）`);
  // ── 2026-09-20 実行して目で読んだ結果（この監査の限界を残す）──────────────────────
  //  下書き 6.2% / 実送信 4.9% と出たが、**中身を読むとほとんどが偽陽性**だった:
  //   ・「見積を送ったのに作成しお送りします」54/68 … 実送信の方が多い。**新しく送られた物件の見積**で正当
  //   ・「内覧が決まっているのに日程を打診」16/13 …「来週の内覧に変更可能でございます」＝**変更の場面**で正当
  //   ・「確認を報告済みなのに確認します」17/10 … **新しく送られた物件**の確認で正当
  //   ・「物件0件なのに再度・改めて」10/4 …「9月末に改めてご連絡させて頂きます」＝連絡の話で物件ではない
  //  台帳の事実は「過去に1度でもやったか」なので、**対象が違う新しい依頼**と区別できない。
  //  regex で矛盾を探すこの方法は**当てにならない**。
  //  → より確実なのは scripts/audit-deleted-lines.ts（**スタッフが下書きから削った行**を集める）。
  //    スタッフの判断そのものなので偽陽性が無く、実際に削られているのは「次の一手」の宣言だった
  //    （内覧提案 44回・見積の同封/作成 33回・ピックアップ/探索の継続 23回）。
  //  この監査は「台帳の禁止と実送信の食い違い」を見る道具として残すが、**件数だけで判断しない**。
}
main().catch((e) => { console.error(e); process.exit(1); });
