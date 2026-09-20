// 往復文脈のセルが要求する物を、スタッフは実際に書いているか（読み取りのみ）
//
// 2026-09-20 竹内「返信が実際送ったのと比べてまちがったのが出る可能性ないか**一連のやりとりで**
//   テストを設計知見と協力して問題ないか調査する」
//
// 設計知見「足す決定論は『実送信に何通あるか』を根拠にする」:
//   必須にしていた締めが実際には1通（0.008%）しか使われておらず、
//   結果「49%でスタッフが削り、そのまま送られたのは3.9%」になっていた。
//   → **必須にしてよいのは過半数が守っている形だけ**。
//
// ここでは会話を古い順にたどり、**本番と同じ条件（行動台帳あり）**で各ターンの pair を組み、
// 選ばれたセルの mustInclude / mustNot を「スタッフが実際に送った次の1通」に当てる。
//   ・mustInclude を満たす率が低い ＝ スタッフが書かない物を AI に要求している（間違いの元）
//   ・mustNot に当たる率が高い ＝ スタッフがやっている事を禁止している（間違いの元）
import { createClient } from "@supabase/supabase-js";
import {
  classifyLastStaffTurn, analyzeSubstance, classifyCustomerResponse, resolveTurnPair,
  mustIncludeSatisfied, selectPairExample, fillPairPlaceholders,
} from "../app/lib/reply-context";
import { buildActionLedger, type LedgerAixRow, type LedgerMessage, type LedgerTask } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Cell = { n: number; satisfied: number; byLabel: Map<string, { n: number; ok: number; fix: string }> };

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let p = 0; p < 30; p++) {
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
  const { data: convData } = await sb.from("conversations").select("id, customer_name").limit(6000);
  const nameOf = new Map<string, string>();
  for (const c of ((convData ?? []) as Array<{ id: string; customer_name: string | null }>)) {
    nameOf.set(c.id, (c.customer_name ?? "").replace(/[\s　]/g, ""));
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

  const cells = new Map<string, Cell>();
  const mk = (): Cell => ({ n: 0, satisfied: 0, byLabel: new Map() });
  let turns = 0, withRule = 0;
  const misses = new Map<string, string[]>();   // ラベル別に「満たしていないスタッフの実送信」を溜める

  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text) continue;
      // お客様の連投は最後の1通だけ（同じスタッフ返信を何度も正解にしない）
      if (i + 1 < list.length && list[i + 1].sender === "customer") continue;
      let k = i - 1;
      while (k >= 0 && list[k].sender === "customer") k--;
      if (k < 0) continue;
      const staffText = list[k].text ?? "";
      if (!staffText) continue;
      // ★ スタッフが実際に送った「次の1通」＝正解
      const j = i + 1;
      if (j >= list.length || list[j].sender !== "staff" || !list[j].text) continue;
      const answer = list[j].text ?? "";
      if (/^\[(画像|動画|スタンプ|通話)/.test(answer)) continue;
      // 2026-09-20: 時間が空いた返信は「その発言への返答」ではなく別件（確認結果の報告など）なので外す。
      //   最初に測った時、PD_ACK の「正解」に「あ」（誤送信）や数日後の募集状況の報告が混ざっていた。
      const gapMin = (Date.parse(list[j].created_at) - Date.parse(m.created_at)) / 60000;
      if (!Number.isFinite(gapMin) || gapMin > Number(process.env.GAP_MIN ?? 30)) continue;
      if (answer.trim().length < 6) continue;   // 「あ」等の誤送信
      turns++;

      const ledger = buildActionLedger({
        recentAixRows: aixByConv.get(cid) ?? [],
        messages: list.slice(0, i).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at } as LedgerMessage)),
        lineTasks: [] as LedgerTask[], lastCustomerAt: m.created_at, now: Date.parse(m.created_at),
      });
      const st = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: list[k].created_at, ledger });
      const sub = analyzeSubstance(m.text, undefined, { staffAskedQuestion: st.kind === "question_to_customer" });
      const cust = classifyCustomerResponse(sub, st, { ledger });
      const pair = resolveTurnPair(st, cust, sub, staffText, { ledger, customerName: nameOf.get(cid) ?? "" });
      if (!pair.rule) continue;
      withRule++;

      const id = pair.ruleId ?? "(なし)";
      if (!cells.has(id)) cells.set(id, mk());
      const c = cells.get(id)!;
      c.n++;
      const actives = pair.rule.mustInclude.filter((x) => !x.when || x.when(pair));
      let allOk = true;
      for (const mi of actives) {
        const key = `${id}|${mi.label}`;
        if (!c.byLabel.has(mi.label)) c.byLabel.set(mi.label, { n: 0, ok: 0, fix: mi.fix });
        const s = c.byLabel.get(mi.label)!;
        s.n++;
        const ok = mustIncludeSatisfied(mi, answer, pair);
        if (ok) s.ok++;
        else {
          allOk = false;
          if (!misses.has(key)) misses.set(key, []);
          const arr = misses.get(key)!;
          if (arr.length < 4) arr.push(answer.replace(/\n/g, " ／ ").slice(0, 86));
        }
      }
      if (allOk) c.satisfied++;
    }
  }

  console.log(`=== 直近${days}日 お客様が返信 → スタッフが返した場面 ${turns}件（セルが選ばれた ${withRule}件）===\n`);
  console.log(`スタッフの実送信が、そのセルの**必須要素を全部満たす**割合`);
  console.log(`（低い＝スタッフが書かない物を AI に要求している＝間違った返信の元）\n`);
  console.log(`${"セル".padEnd(26)} 件数   全部満たす`);
  console.log("─".repeat(58));
  const rows = [...cells.entries()].filter(([, c]) => c.n >= 5).sort((a, b) => (a[1].satisfied / a[1].n) - (b[1].satisfied / b[1].n));
  for (const [id, c] of rows) {
    const pct = ((c.satisfied / c.n) * 100).toFixed(0);
    const mark = c.satisfied / c.n < 0.5 ? " 🔴" : c.satisfied / c.n < 0.7 ? " 🟡" : "";
    console.log(`${id.padEnd(26)} ${String(c.n).padStart(4)}   ${pct.padStart(3)}%${mark}`);
  }

  console.log(`\n\n=== ★ 必須要素ごと（満たす率が低い順・20件）===`);
  const labels: Array<{ id: string; label: string; n: number; ok: number; fix: string }> = [];
  for (const [id, c] of cells) {
    if (c.n < 5) continue;
    for (const [label, s] of c.byLabel) labels.push({ id, label, n: s.n, ok: s.ok, fix: s.fix });
  }
  for (const l of labels.sort((a, b) => (a.ok / a.n) - (b.ok / b.n)).slice(0, 20)) {
    const pct = ((l.ok / l.n) * 100).toFixed(0);
    const mark = l.ok / l.n < 0.5 ? "🔴" : l.ok / l.n < 0.7 ? "🟡" : "🟢";
    console.log(`\n${mark} ${pct.padStart(3)}% (${l.ok}/${l.n})  ${l.id} — ${l.label}`);
    console.log(`      fix: ${l.fix.slice(0, 92)}`);
    for (const s of (misses.get(`${l.id}|${l.label}`) ?? []).slice(0, 3)) {
      console.log(`      スタッフの実送信: ${s}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
