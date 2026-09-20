// ブレインの customer_intent="decision" は信用できるか（読み取りのみ）
//
// 2026-09-20 竹内「ブレインで足りていない部分はあるかな？」
// reply-context.ts:350 のコメント:
//   「お客様の今回の問い合わせ意図。**定義が広い（negative=懸念・不安）ため単独で kind を立てない**。
//    corroboration（補助証拠）専用」
// → negative が広いという理由で、decision（決断）という明確な値まで捨てている。
//
// 申込を実行した場面ではブレインは customer_intent=decision を 27% 返していた。
// ここでは逆から測る: **decision が出た時、スタッフは実際に何をしたか**（精度）。
// 「単独で kind を立ててよい」と言えるのは、decision の後にスタッフが申込・決定の行動を
// 取っている割合が十分高い時だけ。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** スタッフが申込・決定の行動を取った形 */
const STAFF_APPLY_DO_RE =
  /お?申込?(?:み)?(?:さ|し)せ(?:て)?(?:頂|いただ)き|お申し?込み(?:させて)?(?:頂|いただ)き|お申込み完了|申込み?番手|1番手[^\n]{0,6}(?:にて)?お申|お部屋(?:を)?(?:抑え|押さえ)させて(?:頂|いただ)き|審査(?:を)?(?:進め|開始)/;
/** 申込の案内・打診（まだ実行していない） */
const STAFF_APPLY_GUIDE_RE = /お気に召されましたら[^\n]{0,20}お申込|お申込(?:み)?(?:に必要|フォーム|書類)|申込書/;

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const logs: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 12; p++) {
    const { data } = await sb.from("brain_decision_logs")
      .select("conversation_id, created_at, suggested_action, conversation_status, digest")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    logs.push(...r);
    if (r.length < 1000) break;
  }
  const intentOf = (l: Record<string, unknown>) => {
    const d = (l.digest ?? {}) as Record<string, unknown>;
    return String(d.intent ?? d.customer_intent ?? "");
  };
  const byIntent = new Map<string, number>();
  for (const l of logs) byIntent.set(intentOf(l) || "(なし)", (byIntent.get(intentOf(l) || "(なし)") ?? 0) + 1);
  console.log(`=== 直近${days}日 ブレインの判断ログ ${logs.length}件 ===`);
  console.log(`--- customer_intent の分布 ---`);
  for (const [k, n] of [...byIntent.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}件 (${((n / logs.length) * 100).toFixed(1)}%)  ${k}`);
  }

  // decision が出た判断の「直後のスタッフ発言」を見る
  const convIds = [...new Set(logs.map((l) => String(l.conversation_id)))];
  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let p = 0; p < 24; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }
  const staffByConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (m.sender !== "staff" || !m.text) continue;
    if (!staffByConv.has(m.conversation_id)) staffByConv.set(m.conversation_id, []);
    staffByConv.get(m.conversation_id)!.push(m);
  }
  void convIds;

  // ── ブレインが出した AIX（suggested_action）の方が申込を言い当てているか ──
  console.log(`\n\n${"=".repeat(70)}\n=== ブレインの AIX 判断 別 ===`);
  const actions = [...new Set(logs.map((l) => String(l.suggested_action ?? "")))].filter(Boolean);
  const rows: Array<{ a: string; n: number; did: number; rate: number }> = [];
  for (const a of actions) {
    const hit = logs.filter((l) => String(l.suggested_action ?? "") === a);
    let did = 0, withReply = 0;
    for (const l of hit) {
      const list = staffByConv.get(String(l.conversation_id)) ?? [];
      const at = Date.parse(String(l.created_at));
      const next = list.find((m) => Date.parse(m.created_at) >= at && Date.parse(m.created_at) <= at + 12 * 3600_000);
      if (!next) continue;
      withReply++;
      if (STAFF_APPLY_DO_RE.test(next.text ?? "")) did++;
    }
    if (withReply >= 5) rows.push({ a, n: withReply, did, rate: did / withReply });
  }
  console.log(`（直後12時間のスタッフ発言が「申込・審査を実行」だった割合。5件以上のものだけ）`);
  for (const r of rows.sort((x, y) => y.rate - x.rate)) {
    console.log(`  ${(r.rate * 100).toFixed(0).padStart(3)}%  ${String(r.did).padStart(3)}/${String(r.n).padStart(3)}  ${r.a}`);
  }

  for (const target of ["decision", "desire", "negative", "question", "chat"]) {
    const hit = logs.filter((l) => intentOf(l) === target);
    let did = 0, guided = 0, other = 0, none = 0;
    const samples: string[] = [];
    for (const l of hit) {
      const list = staffByConv.get(String(l.conversation_id)) ?? [];
      const at = Date.parse(String(l.created_at));
      const next = list.find((m) => Date.parse(m.created_at) >= at && Date.parse(m.created_at) <= at + 12 * 3600_000);
      if (!next) { none++; continue; }
      const t = next.text ?? "";
      if (STAFF_APPLY_DO_RE.test(t)) { did++; if (samples.length < 4) samples.push(`  ✅ 申込実行: 「${t.replace(/\n/g, " ").slice(0, 72)}」`); }
      else if (STAFF_APPLY_GUIDE_RE.test(t)) { guided++; if (samples.length < 7) samples.push(`  ◽ 申込の案内: 「${t.replace(/\n/g, " ").slice(0, 72)}」`); }
      else { other++; if (samples.length < 12) samples.push(`  ❌ それ以外: 「${t.replace(/\n/g, " ").slice(0, 72)}」`); }
    }
    const withReply = did + guided + other;
    const p = (n: number) => withReply ? `${((n / withReply) * 100).toFixed(0)}%` : "-";
    console.log(`\n=== customer_intent="${target}" : ${hit.length}件（直後のスタッフ発言あり ${withReply}件）===`);
    console.log(`  申込・審査を実行 : ${String(did).padStart(3)}件 ${p(did)}`);
    console.log(`  申込の案内・打診 : ${String(guided).padStart(3)}件 ${p(guided)}`);
    console.log(`  それ以外         : ${String(other).padStart(3)}件 ${p(other)}`);
    for (const s of samples) console.log(s);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
