// 申込後の場面を、実データから「型」として取り出す（読み取りのみ）
//
// 2026-09-20 竹内「直す」
// audit-staff-other2.ts で分かったこと: 返信生成が起きる場面 2,459件のうち
// **台帳ありでも直前スタッフ発言が other なのが 674件（27.4%）**で、中身は申込後の手続きに集中していた。
//
// 設計知見「分類体系を増やす時は必ず『出口』を定義する。下流のどの列に落ちるかが無いラベルは
//   検出できない故障を作る」→ StaffTurnKind に足すなら PAIR_MATRIX のセルも同時に作る。
// そのセルの direction / mustInclude / example を**実データのスタッフの正解文**から決めるために、
// ここで「直前スタッフ発言の型 × お客様の返答 × 次のスタッフ返信（＝正解）」を数える。
import { createClient } from "@supabase/supabase-js";
import { classifyLastStaffTurn, analyzeSubstance, classifyCustomerResponse } from "../app/lib/reply-context";
import { buildActionLedger, type LedgerAixRow, type LedgerMessage, type LedgerTask } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 申込後の場面の候補（直前スタッフ発言に当てる）。ここが StaffTurnKind に足す候補 */
const SCENE: Array<{ id: string; re: RegExp }> = [
  { id: "書類の依頼", re: /(?:身分証明書|本人確認書類|免許証|保険証|マイナンバー|在職証明|収入証明|源泉徴収)[^\n]{0,24}(?:お写真|お送り|ご提出|ご準備|頂け)|(?:お写真|ご情報)[^\n]{0,12}お送り(?:ください|頂け|いただけ)|(?:フォーマット|申込書|お申込みフォーム)[^\n]{0,20}(?:ご入力|ご記入|お送り|ご返送)|連帯保証人[^\n]{0,10}(?:ご情報|情報|様の)/ },
  { id: "申込の完了報告", re: /(?:お|ご)?申込(?:み)?[^\n]{0,10}完了(?:し|いたし|させて)|[０-９0-9一二]番手(?:にて|で)[^\n]{0,10}(?:お申込|申込)|申込み?番手[^\n]{0,8}確認/ },
  { id: "審査の進捗待ち", re: /審査[^\n]{0,12}(?:進捗|結果|状況)[^\n]{0,12}(?:あり次第|出次第|分かり次第|ご連絡)|審査[^\n]{0,8}(?:открыт|進め|移り|開始)|保証会社[^\n]{0,16}(?:審査|お電話|ご連絡)/ },
  { id: "契約・入居の手続き", re: /(?:契約書|重要事項説明|レターパック|鍵の(?:お)?受け渡し|初期費用[^\n]{0,8}お振込)/ },
];

async function main() {
  const days = Number(process.env.DAYS ?? 60);
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

  type Row = { scene: string; staff: string; cust: string; custKind: string; next: string };
  const rows: Row[] = [];
  let totalOther = 0;
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text) continue;
      let k = i - 1;
      while (k >= 0 && list[k].sender === "customer") k--;
      if (k < 0) continue;
      const staffText = list[k].text ?? "";
      if (!staffText) continue;
      const ledger = buildActionLedger({
        recentAixRows: aixByConv.get(cid) ?? [],
        messages: list.slice(0, i).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at } as LedgerMessage)),
        lineTasks: [] as LedgerTask[], lastCustomerAt: m.created_at, now: Date.parse(m.created_at),
      });
      const st = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: list[k].created_at, ledger });
      if (st.kind !== "other") continue;
      totalOther++;
      const scene = SCENE.find((s) => s.re.test(staffText))?.id ?? "（どれでもない）";
      // お客様の返答の分類 + 次のスタッフ返信（＝正解）
      const sub = analyzeSubstance(m.text, undefined, { staffAskedQuestion: false });
      const cust = classifyCustomerResponse(sub, st, { ledger });
      let j = i + 1;
      while (j < list.length && list[j].sender === "customer") j++;
      const next = j < list.length && list[j].sender === "staff" ? (list[j].text ?? "") : "";
      rows.push({ scene, staff: staffText, cust: m.text, custKind: cust.kind, next });
    }
  }

  console.log(`=== 直近${days}日「台帳ありでも直前スタッフ発言が other」: ${totalOther}件 ===\n`);
  const byScene = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byScene.has(r.scene)) byScene.set(r.scene, []);
    byScene.get(r.scene)!.push(r);
  }
  console.log(`--- 場面の内訳 ---`);
  for (const [s, list] of [...byScene.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(list.length).padStart(4)}件 (${((list.length / totalOther) * 100).toFixed(1)}%)  ${s}`);
  }

  for (const [s, list] of [...byScene.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (s === "（どれでもない）") continue;
    console.log(`\n${"=".repeat(74)}\n=== 【${s}】${list.length}件 ===`);
    const kinds = new Map<string, number>();
    for (const r of list) kinds.set(r.custKind, (kinds.get(r.custKind) ?? 0) + 1);
    console.log(`  お客様の返答の分類: ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" / ")}`);
    console.log(`\n  --- お客様の返答 → スタッフの正解（上位8組）---`);
    for (const r of list.slice(0, 8)) {
      if (!r.next) continue;
      console.log(`   客[${r.custKind}]「${r.cust.replace(/\n/g, " ").slice(0, 44)}」`);
      console.log(`      正解「${r.next.replace(/\n/g, " ").slice(0, 90)}」`);
    }
  }

  // どれでもない分の上位（次に足す候補）
  const none = byScene.get("（どれでもない）") ?? [];
  console.log(`\n${"=".repeat(74)}\n=== 【どれでもない】${none.length}件 の直前スタッフ発言（頻度順・上位20）===`);
  const forms = new Map<string, { n: number; s: string }>();
  for (const r of none) {
    const line = r.staff.split("\n").map((l) => l.trim()).filter((l) => l.length >= 6)
      .find((l) => !/お世話になっております|はじめまして/.test(l)) ?? "";
    if (line.length < 6) continue;
    const key = line.replace(/[0-9０-９,，:：]+/g, "#").replace(/[ぁ-んァ-ヶー一-龥]{1,6}さん/g, "〇さん").replace(/\s+/g, "");
    const cur = forms.get(key) ?? { n: 0, s: line };
    cur.n++; forms.set(key, cur);
  }
  for (const [, v] of [...forms.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
    console.log(`  ${String(v.n).padStart(3)}回  ${v.s.slice(0, 84)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
