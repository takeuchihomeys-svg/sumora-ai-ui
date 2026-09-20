// お客様の「申込の意思表示」は分類されているか（読み取りのみ）
//
// 2026-09-20 竹内「ブレインで足りていない部分はあるかな？実際スタッフが送る返信を生成する為にも」
// find-brain-gaps（30日）の G1 分類の穴 325件（34.5%）の実例を読むと、`other` に落ちている中に
// **申込の意思表示**が固まっていた:
//   「申し込みお願いします」→ スタッフ「お部屋お申込みさせていただきます😊！！」
//   「お部屋抑えてて頂きたいです💦」→「クレール元町203号室お申込みさせていただきます」
//   「やはり江坂の物件にしようかなと思うのですが」→「RIDGE江坂102号室お申込みさせていただきます」
// CustomerResponseKind に申込は無く（concern/positive/thinking/…/other の11種）、
// PositiveVerdict も viewing_explicit / appraisal の2つだけ。
//
// ここでは**正解ラベルをスタッフの返信から作る**: 顧客発言の直後にスタッフが
// 「お申込みさせていただきます」型を返していれば、その顧客発言は申込の意思表示だった。
import { createClient } from "@supabase/supabase-js";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** スタッフが「この物件で申し込みます」と実行を宣言した形（＝直前の顧客発言は申込の意思表示） */
const STAFF_APPLY_DO_RE =
  /お?申込?(?:み)?(?:さ|し)せ(?:て)?(?:頂|いただ)き|お申し?込み(?:させて)?(?:頂|いただ)き|お申込み完了|申込み?番手|1番手[^\n]{0,6}(?:にて)?お申|お部屋(?:を)?(?:抑え|押さえ)させて(?:頂|いただ)き/;
/** 申込の話題を含む顧客発言（ここから正解・不正解を分ける） */
const CUST_APPLY_WORD_RE = /申込|申し込|申込み|抑え|押さえ|契約(?:し|させ|したい)|決め(?:たい|ます|ました)|これにし(?:たい|ます)|このお?部屋に(?:し|決)/;

const jst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // 会話ごとにメッセージを古い順で取る
  const { data: convs } = await sb.from("conversations").select("id, customer_name, status").limit(4000);
  const convRows = (convs ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>;

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null }> = [];
  for (let p = 0; p < 20; p++) {
    const { data } = await sb.from("messages")
      .select("conversation_id, sender, text, created_at, is_aix_generated")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }
  console.log(`=== 直近${days}日 メッセージ ${msgs.length}通 ===\n`);

  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }

  type Case = { conv: string; at: string; cust: string; staff: string; kind: string; secondary: string; positive: string; staffKind: string };
  const applied: Case[] = [];   // スタッフが実際に申込を実行した＝顧客は申込の意思表示をしていた
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text) continue;
      // 直後のスタッフ発言（お客様の連投は最後の1通を使う）
      let j = i + 1;
      while (j < list.length && list[j].sender === "customer") j++;
      if (j >= list.length) continue;
      const reply = list[j];
      if (reply.sender !== "staff" || !reply.text) continue;
      if (!STAFF_APPLY_DO_RE.test(reply.text)) continue;
      // 直前のスタッフ発言
      let k = i - 1;
      while (k >= 0 && list[k].sender === "customer") k--;
      const lastStaff = k >= 0 ? (list[k].text ?? "") : "";

      const staff = classifyLastStaffTurn(lastStaff, { recentAixRows: [], lastStaffAt: k >= 0 ? list[k].created_at : null });
      const sub = analyzeSubstance(m.text, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
      const cust = classifyCustomerResponse(sub, staff, {});
      applied.push({
        conv: cid, at: m.created_at, cust: m.text, staff: reply.text,
        kind: cust.kind, secondary: cust.secondary.join(","), positive: cust.positive?.kind ?? "-", staffKind: staff.kind,
      });
    }
  }

  console.log(`=== スタッフが「お申込みさせていただきます」型で応じた顧客発言: ${applied.length}件 ===`);
  const byKind = new Map<string, Case[]>();
  for (const c of applied) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind)!.push(c);
  }
  console.log(`\n--- その顧客発言が今どう分類されているか ---`);
  for (const [k, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(list.length).padStart(3)}件 (${((list.length / applied.length) * 100).toFixed(0)}%)  kind=${k}`);
    for (const c of list.slice(0, 4)) {
      console.log(`       [${jst(c.at)} 直前=${c.staffKind}] 客「${c.cust.replace(/\n/g, " ").slice(0, 52)}」`);
      console.log(`           → 店「${c.staff.replace(/\n/g, " ").slice(0, 60)}」`);
    }
  }

  // 申込の語を含むかどうかで分ける（語が無いのに申込に至った＝文脈でしか分からない）
  const withWord = applied.filter((c) => CUST_APPLY_WORD_RE.test(c.cust));
  console.log(`\n--- 顧客発言に申込の語があるか ---`);
  console.log(`  語あり: ${withWord.length}件（${((withWord.length / applied.length) * 100).toFixed(0)}%）＝ regex で拾える`);
  console.log(`  語なし: ${applied.length - withWord.length}件 ＝ 文脈でしか分からない`);
  for (const c of applied.filter((x) => !CUST_APPLY_WORD_RE.test(x.cust)).slice(0, 8)) {
    console.log(`       客「${c.cust.replace(/\n/g, " ").slice(0, 56)}」 → 店「${c.staff.replace(/\n/g, " ").slice(0, 52)}」`);
  }

  // ── 誤検出の確認: 申込の語を含むが、スタッフは申込を実行しなかった顧客発言 ──
  const notApplied: Case[] = [];
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text || !CUST_APPLY_WORD_RE.test(m.text)) continue;
      let j = i + 1;
      while (j < list.length && list[j].sender === "customer") j++;
      if (j >= list.length) continue;
      const reply = list[j];
      if (reply.sender !== "staff" || !reply.text) continue;
      if (STAFF_APPLY_DO_RE.test(reply.text)) continue;
      notApplied.push({ conv: cid, at: m.created_at, cust: m.text, staff: reply.text, kind: "", secondary: "", positive: "", staffKind: "" });
    }
  }
  console.log(`\n=== 申込の語を含むが、スタッフは申込を実行しなかった: ${notApplied.length}件（誤検出の元）===`);
  for (const c of notApplied.slice(0, 14)) {
    console.log(`  客「${c.cust.replace(/\n/g, " ").slice(0, 56)}」`);
    console.log(`      → 店「${c.staff.replace(/\n/g, " ").slice(0, 64)}」`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
