// 主のお部屋（こちらが送って気に入って頂いたお部屋）への見積もりの依頼に、スタッフが次に何を押したか（読み取りのみ・LLM は呼ばない・本文はマスク）
// 2026-09-27 竹内（YUMA の返信テスト）「この場面は見積書を正解にする」→ app/lib/focused-estimate-request.ts の線を実送信で確かめる
//
// 場面: お客様の連投（前のこちらの発言より後の連続した発言）が見積もりの依頼（FOCUSED_ESTIMATE_ASK_RE・条件フォームを除く）
// お部屋の分け方（customer-state の主のお部屋の近似）:
//   ours_pointed   … 21日以内にこちらが AIX で送ったお部屋を、今回か直前の連投で名指し・引用・「この物件／いいですね」等で指している
//   ours_unnamed   … こちらの送付はあるが、どれかは言っていない（主のお部屋は customer-state が決める＝ここでは分からない）
//   customer_brought … お客様が URL・画像を送ってきた（こちらの最後の送付より後）＝持ち込み
//   none           … 物件なし
// 次の一手: 連投から72時間以内に最初に送った AIX（物件確認した＋御見積書同封／物件確認した／見積書送る／確認します／他）・無し
//   あわせて最初のこちらの文（AIX でない）が「募集状況…確認」を言ったか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-focused-estimate-request.ts   （DAYS=180・SHOW=30）
import { createClient } from "@supabase/supabase-js";
import { FOCUSED_ESTIMATE_ASK_RE, VACANCY_ASK_RE, resolveFocusedEstimateRequest } from "../app/lib/focused-estimate-request";
import { isConditionFormMessage } from "../app/lib/line-reply-prompts";
import { normalizeBuildingName } from "../app/lib/property-brain";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const SHOW = Number(process.env.SHOW ?? 30);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page(table: string, cols: string, s: string | null, tcol = "created_at"): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (let p = 0; p < 400; p++) {
    let q = sb.from(table).select(cols).order(tcol).range(p * 1000, p * 1000 + 999);
    if (s) q = q.gte(tcol, s);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");
const SEND_TYPES = new Set(["property_send", "property_recommendation", "property_pickup", "pickup"]);
const POINT_RE = /この(物件|お?部屋|マンション)|こちらの(物件|お?部屋)|ここ(の|が|に|で|いい)|号室|いいですね|良いですね|いいな|気に入|気になり|気になる|素敵|よさそう|良さそう|[1-9１-９一二三①②③](枚目|件目|番目|つ目)|最初の|一番(上|目)/;

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; quoted_message_id: string | null; line_message_id: string | null; t: number };

async function main() {
  const convs = await page("conversations", "id, line_source_type", null);
  const ok = new Set<string>(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  const msgs: Msg[] = (await page("messages", "id, conversation_id, sender, text, created_at, is_aix_generated, quoted_message_id, line_message_id", since))
    .filter((m) => ok.has(m.conversation_id)).map((m) => ({ ...m, t: Date.parse(m.created_at) }));
  const aix = (await page("aix_usage_logs", "conversation_id, aix_type, sent_at, estimate_sent, prop_cost_notes, property_names", since))
    .filter((a) => a.sent_at && ok.has(a.conversation_id)).map((a) => ({ ...a, t: Date.parse(a.sent_at) }));
  const byConv = new Map<string, Msg[]>(); for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aixByConv = new Map<string, any[]>(); for (const a of aix) { const x = aixByConv.get(a.conversation_id) ?? []; x.push(a); aixByConv.set(a.conversation_id, x); }
  for (const x of aixByConv.values()) x.sort((a, b) => a.t - b.t);

  type Row = { cat: string; vac: boolean; next: string; declared: string; text: string; prev: string; fn: string; conv: string };
  const rows: Row[] = [];
  for (const [conv, ms0] of byConv) {
    const ms = ms0.sort((a, b) => a.t - b.t);
    const ax = aixByConv.get(conv) ?? [];
    // 連投に分ける
    const turns: Array<{ s: number; e: number }> = [];
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer") continue;
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      turns.push({ s: i, e: j }); i = j;
    }
    for (let k = 0; k < turns.length; k++) {
      const { s, e } = turns[k];
      const tt = ms.slice(s, e + 1);
      const text = tt.map((m) => m.text ?? "").filter((x) => x && !/^\[(画像|動画|スタンプ)/.test(x)).join("\n");
      if (!text || isConditionFormMessage(text) || !FOCUSED_ESTIMATE_ASK_RE.test(text)) continue;
      const t0 = tt[0].t, t1 = tt[tt.length - 1].t;
      // こちらの送付（21日以内・連投より前）
      const sends = ax.filter((a) => SEND_TYPES.has(a.aix_type) && a.t < t0 && a.t > t0 - 21 * 86400e3);
      const lastSendT = sends.length ? sends[sends.length - 1].t : 0;
      const names = [...new Set(sends.flatMap((a) => (a.property_names ?? []) as string[]).map((n) => normalizeBuildingName(n)).filter((n) => n.length >= 3))];
      // お客様の持ち込み（こちらの最後の送付より後・21日以内・今回を含む）
      const brought = ms.some((m) => m.sender === "customer" && m.t <= t1 && m.t > Math.max(lastSendT, t0 - 21 * 86400e3) && /https?:\/\/|^\[画像\]/.test(m.text ?? ""));
      // 今回＋直前の連投（こちらの最後の送付より後）で指しているか
      const prevTurn = k > 0 && ms[turns[k - 1].s].t > lastSendT ? ms.slice(turns[k - 1].s, turns[k - 1].e + 1) : [];
      const around = [...prevTurn, ...tt];
      const aroundText = around.map((m) => m.text ?? "").join("\n");
      const normAround = normalizeBuildingName(aroundText);
      const namesHit = names.some((n) => normAround.includes(n) || aroundText.includes(n));
      const staffLineIds = new Set(ms.filter((m) => m.sender !== "customer" && m.line_message_id).map((m) => m.line_message_id));
      const quoted = around.some((m) => m.quoted_message_id && staffLineIds.has(m.quoted_message_id));
      const pointed = namesHit || quoted || POINT_RE.test(aroundText);
      const cat = brought ? "customer_brought" : sends.length ? (pointed ? "ours_pointed" : "ours_unnamed") : "none";
      const vac = VACANCY_ASK_RE.test(text);
      // 次の一手
      const nxt = ax.find((a) => a.t > t1 && a.t < t1 + 72 * 3600e3);
      const nextCust = turns[k + 1] ? ms[turns[k + 1].s].t : Infinity;
      let next = "none";
      if (nxt) {
        if (nxt.aix_type === "property_check_result") next = (nxt.estimate_sent || (nxt.prop_cost_notes && String(nxt.prop_cost_notes).trim())) ? "check+estimate" : "check_only";
        else next = nxt.aix_type;
        if (nxt.t > nextCust) next += "(after_next_cust)";
      }
      const firstStaffText = ms.find((m) => m.t > t1 && m.sender !== "customer" && !m.is_aix_generated && m.t < t1 + 72 * 3600e3);
      const ft = firstStaffText?.text ?? "";
      const declared = /(募集状況|空室|空き状況|空き).{0,12}確認/.test(ft) ? "check" : /見積/.test(ft) ? "estimate" : ft ? "other" : "-";
      const fn = resolveFocusedEstimateRequest(text, cat === "ours_pointed" || cat === "ours_unnamed" ? { name: "x", sentByUs: true, ended: false } : cat === "customer_brought" ? { name: "x", sentByUs: false, ended: false } : null).reason;
      rows.push({ cat, vac, next, declared, text: mask(text).slice(0, 110), prev: mask(prevTurn.map((m) => m.text ?? "").join(" / ")).slice(0, 70), fn, conv: conv.slice(0, 8) });
    }
  }
  console.log(`見積もりの依頼の連投 ${rows.length}件（直近${DAYS}日・グループと YUMA を除く）`);
  const cats = ["ours_pointed", "ours_unnamed", "customer_brought", "none"];
  for (const c of cats) for (const v of [false, true]) {
    const rs = rows.filter((r) => r.cat === c && r.vac === v); if (!rs.length) continue;
    const cnt: Record<string, number> = {}; for (const r of rs) { const k = r.next.replace("(after_next_cust)", "*"); cnt[k] = (cnt[k] ?? 0) + 1; }
    const dec: Record<string, number> = {}; for (const r of rs) dec[r.declared] = (dec[r.declared] ?? 0) + 1;
    console.log(`\n■ ${c}${v ? "＋空きも質問" : ""}  n=${rs.length}`);
    console.log("  次の AIX: " + Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}(${pct(n, rs.length)})`).join(" / "));
    console.log("  最初の文: " + Object.entries(dec).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" / "));
    const fnc: Record<string, number> = {}; for (const r of rs) fnc[r.fn] = (fnc[r.fn] ?? 0) + 1;
    console.log("  関数の判定: " + Object.entries(fnc).map(([k, n]) => `${k} ${n}`).join(" / "));
  }
  const show = (c: string, v: boolean) => {
    const rs = rows.filter((r) => r.cat === c && r.vac === v).slice(-SHOW);
    console.log(`\n── 目で読む: ${c}${v ? "＋空き" : ""}（新しい${rs.length}件）`);
    for (const r of rs) console.log(`  [${r.next} / 文=${r.declared} / fn=${r.fn}] ${r.conv} 前:「${r.prev}」 今:「${r.text}」`);
  };
  show("ours_pointed", false); show("ours_pointed", true); show("ours_unnamed", false);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
