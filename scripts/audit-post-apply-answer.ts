// 申込後の場面で、スタッフは実際にどう返しているか（セルの中身を作る材料・読み取りのみ）
//
// 2026-09-20 竹内「直す」
// audit-rule-effect.ts で「セルがあると採用率 44.4% 対 24.6%（直前=other なら 56.8% 対 8.3%）」＝足す価値あり。
// ここでは PAIR_MATRIX のセルの direction / mustInclude / example を**実データの正解文から**決める。
// 重複を避けるため (直前スタッフ発言, 顧客発言, 次のスタッフ返信) のユニークな組だけを見る。
import { createClient } from "@supabase/supabase-js";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const SCENE: Array<{ id: string; re: RegExp }> = [
  { id: "docs_request（書類の依頼）", re: /(?:身分証明書|本人確認書類|免許証|保険証|マイナンバー|在職証明|収入証明|源泉徴収)[^\n]{0,24}(?:お写真|お送り|ご提出|ご準備|頂け)|(?:お写真|ご情報)[^\n]{0,12}お送り(?:ください|頂け|いただけ)|(?:フォーマット|申込書|お申込みフォーム)[^\n]{0,20}(?:ご入力|ご記入|お送り|ご返送)|連帯保証人[^\n]{0,10}(?:ご情報|情報|様の)/ },
  { id: "apply_done（申込の完了報告）", re: /(?:お|ご)?申込(?:み)?[^\n]{0,10}完了(?:し|いたし|させて)|[０-９0-9一二]番手(?:にて|で)[^\n]{0,10}(?:お申込|申込)|申込み?番手[^\n]{0,8}確認/ },
  { id: "screening_wait（審査の進捗待ち）", re: /審査[^\n]{0,12}(?:進捗|結果|状況)[^\n]{0,12}(?:あり次第|出次第|分かり次第|ご連絡)|保証会社[^\n]{0,16}(?:審査|お電話|ご連絡)/ },
];

async function main() {
  const days = Number(process.env.DAYS ?? 180);
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
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }

  type Row = { scene: string; custKind: string; cust: string; next: string };
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const [, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text) continue;
      let k = i - 1;
      while (k >= 0 && list[k].sender === "customer") k--;
      if (k < 0) continue;
      const staffText = list[k].text ?? "";
      const scene = SCENE.find((s) => s.re.test(staffText))?.id;
      if (!scene) continue;
      // お客様の連投は最後の1通だけ扱う（同じスタッフ返信を何度も正解にしない）
      if (i + 1 < list.length && list[i + 1].sender === "customer") continue;
      let j = i + 1;
      if (j >= list.length || list[j].sender !== "staff" || !list[j].text) continue;
      const next = list[j].text ?? "";
      const key = `${staffText.slice(0, 40)}|${m.text.slice(0, 30)}|${next.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const st = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: list[k].created_at });
      const sub = analyzeSubstance(m.text, undefined, { staffAskedQuestion: st.kind === "question_to_customer" });
      const cust = classifyCustomerResponse(sub, st, {});
      rows.push({ scene, custKind: cust.kind, cust: m.text, next });
    }
  }

  console.log(`=== 申込後の場面（ユニークな組）${rows.length}件・直近${days}日 ===\n`);
  for (const s of SCENE) {
    const list = rows.filter((r) => r.scene === s.id);
    if (list.length === 0) continue;
    console.log(`${"=".repeat(74)}\n=== 【${s.id}】${list.length}件 ===`);
    const kinds = new Map<string, Row[]>();
    for (const r of list) {
      if (!kinds.has(r.custKind)) kinds.set(r.custKind, []);
      kinds.get(r.custKind)!.push(r);
    }
    for (const [k, ls] of [...kinds.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ── お客様=${k}（${ls.length}件）のスタッフの正解 ──`);
      for (const r of ls.slice(0, 6)) {
        console.log(`    客「${r.cust.replace(/\n/g, " ").slice(0, 40)}」`);
        console.log(`    店「${r.next.replace(/\n/g, " ").slice(0, 100)}」`);
      }
    }
    // その場面の正解文によく出る言い回し
    const forms = new Map<string, number>();
    for (const r of list) {
      for (const ln of r.next.split("\n").map((x) => x.trim()).filter((x) => x.length >= 6)) {
        const key = ln.replace(/[0-9０-９,，:：]+/g, "#").replace(/[ぁ-んァ-ヶー一-龥]{1,6}さん/g, "〇さん").replace(/【[^】]*】/g, "【】").replace(/\s+/g, "");
        forms.set(key, (forms.get(key) ?? 0) + 1);
      }
    }
    console.log(`\n  ── この場面の正解によく出る行（2回以上）──`);
    for (const [k, n] of [...forms.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${String(n).padStart(3)}回  ${k.slice(0, 80)}`);
    }
    console.log("");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
