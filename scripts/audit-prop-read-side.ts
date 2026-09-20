// 送った物件は「書けているか」だけでなく「**読めているか**」（読み取りのみ）
//
// 2026-09-21 竹内「物件ピックアップで送った物件の情報ちゃんと読みとれるようになっているのか？」
//
// 2026-09-20 に直した経路:
//   ① send-line-message: 画像から読めた物件を sent_properties にも入れる（source=aix:* / staff_image）
//   ② log-aix-usage: AIX の property_names / prop_statuses を sent_properties に残す
//   ③ chrome-extension/background.js: merge-pdfs に property_customer_id を渡す（**拡張の再読み込みが必要**）
//   ④ check-property-duplicate: 判定を sent-property-record に一本化＋conversation_id でも引ける
//
// ここでは ①書き込みが増えたか（時系列）②**読み取り側が実際に物件を知れているか** を見る。
// 設計知見「ブレインが物件を知る経路は3つあり、画像だけで送ると全部すり抜ける」
//   （conversation_id で引けば86%取れるのに property_customer_id だけで引いていた）。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const days = Number(process.env.DAYS ?? 14);

  // ── ① 書き込みの時系列（直した経路が動き始めたか）──
  const sp = await page("sent_properties", "conversation_id, property_customer_id, property_name, room_no, source, recruitment_status, sent_at", "sent_at", days);
  console.log(`=== ① sent_properties の書き込み（直近${days}日 ${sp.length}件）===`);
  const days_ = [...new Set(sp.map((r) => jstDay(String(r.sent_at))))].sort();
  console.log(`   ${"日付".padEnd(12)} 合計   line_group(紐付き)   vision   aix:*`);
  for (const d of days_.slice(-10)) {
    const rows = sp.filter((r) => jstDay(String(r.sent_at)) === d);
    const lg = rows.filter((r) => r.source === "line_group");
    const lgLinked = lg.filter((r) => r.property_customer_id || r.conversation_id).length;
    const vi = rows.filter((r) => r.source === "vision").length;
    const aix = rows.filter((r) => String(r.source ?? "").startsWith("aix:")).length;
    const si = rows.filter((r) => r.source === "staff_image").length;
    console.log(`   ${d.padEnd(12)} ${String(rows.length).padStart(4)}   ${String(lg.length).padStart(4)}(${String(lgLinked).padStart(3)})        ${String(vi).padStart(4)}   ${String(aix + si).padStart(4)}`);
  }
  const aixRows = sp.filter((r) => String(r.source ?? "").startsWith("aix:") || r.source === "staff_image");
  console.log(`\n   2026-09-20 に入れた経路（aix:* / staff_image）: ${aixRows.length}件`);
  for (const r of aixRows.slice(0, 8)) {
    console.log(`     ${jstDay(String(r.sent_at))} [${r.source}] ${r.property_name} ${r.room_no ?? ""} / 会話${r.conversation_id ? "✓" : "✗"} 顧客${r.property_customer_id ? "✓" : "✗"} 募集${r.recruitment_status ?? "-"}`);
  }
  const lgAll = sp.filter((r) => r.source === "line_group");
  const lgLinkedAll = lgAll.filter((r) => r.property_customer_id || r.conversation_id);
  console.log(`\n   line_group（物件出しツール）: ${lgAll.length}件 中 紐付き ${lgLinkedAll.length}件 (${pct(lgLinkedAll.length, lgAll.length)})`);
  if (lgLinkedAll.length > 0) {
    const firstLinked = [...lgLinkedAll].sort((a, b) => Date.parse(String(a.sent_at)) - Date.parse(String(b.sent_at)))[0];
    console.log(`   紐付いた最初の1件: ${String(firstLinked.sent_at).slice(0, 16)} 「${firstLinked.property_name}」`);
    console.log(`   → この時刻以降に送った分が紐付いていれば**拡張の再読み込みが効いている**`);
    // 拡張が直った時刻以降だけで率を出す（それ以前は古い拡張が送った分なので混ぜない）
    const cut = Date.parse(String(firstLinked.sent_at));
    const after = lgAll.filter((r) => Date.parse(String(r.sent_at)) >= cut);
    const afterLinked = after.filter((r) => r.property_customer_id || r.conversation_id).length;
    console.log(`   **その時刻以降の line_group: ${after.length}件 中 紐付き ${afterLinked}件 (${pct(afterLinked, after.length)})**`);
    const beforeN = lgAll.length - after.length;
    console.log(`   （それ以前 ${beforeN}件 は古い拡張が送った分＝紐付かないのは想定どおり）`);
  } else {
    console.log(`   → まだ0件。**Chrome 拡張の再読み込みがまだ**の可能性（background.js の変更は再読み込みが要る）`);
  }

  // ── ② 読み取り側: 物件を送った会話で、ブレイン・文生成が物件を知れるか ──
  //   設計知見どおり conversation_id と property_customer_id の**両方**で引いた時の到達率
  console.log(`\n=== ② 読み取り側（物件を送った会話のうち、物件を引ける会話）===`);
  const convIds = [...new Set(sp.map((r) => String(r.conversation_id ?? "")).filter(Boolean))];
  const pcIds = [...new Set(sp.map((r) => String(r.property_customer_id ?? "")).filter(Boolean))];
  // 物件顧客 → 会話
  const pcToConv = new Map<string, string>();
  for (let i = 0; i < pcIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, property_customer_id").in("property_customer_id", pcIds.slice(i, i + 200));
    for (const c of ((data ?? []) as Array<{ id: string; property_customer_id: string | null }>)) {
      if (c.property_customer_id) pcToConv.set(c.property_customer_id, c.id);
    }
  }
  const reachable = new Set<string>(convIds);
  for (const [pc, conv] of pcToConv) { void pc; reachable.add(conv); }
  console.log(`   物件が紐付いている会話: ${reachable.size}件`);
  console.log(`     conversation_id が直接ある: ${convIds.length}件`);
  console.log(`     物件顧客ID から辿れる    : ${[...pcToConv.values()].filter((c) => !convIds.includes(c)).length}件（両方で引くと増える分）`);

  // その会話で実際にスタッフが物件を送っているか（messages の 🌟 や号室）をざっくり照合
  const msgs: Array<{ conversation_id: string; text: string | null; created_at: string }> = [];
  const targets = [...reachable].slice(0, 300);
  for (let i = 0; i < targets.length; i += 20) {
    const { data } = await sb.from("messages").select("conversation_id, text, created_at")
      .in("conversation_id", targets.slice(i, i + 20)).eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString()).limit(2000);
    msgs.push(...((data ?? []) as typeof msgs));
  }
  const sentPropText = new Set(msgs.filter((m) => /🌟|[0-9０-９]{2,4}号室/.test(m.text ?? "")).map((m) => m.conversation_id));
  console.log(`\n   本文に物件（🌟・号室）が出ている会話: ${sentPropText.size}件`);
  const bothOk = [...sentPropText].filter((c) => reachable.has(c)).length;
  console.log(`     そのうち sent_properties からも引ける: ${bothOk}件 (${pct(bothOk, sentPropText.size)})`);

  // ── ③ 2026-09-20 に足した列（退去予定・家賃）は埋まり始めたか ──
  console.log(`\n=== ③ 追加した列の埋まり具合（直近${days}日）===`);
  for (const k of ["room_no", "recruitment_status"]) {
    const n = sp.filter((r) => r[k] !== null && r[k] !== undefined && r[k] !== "").length;
    console.log(`   ${k.padEnd(20)} ${String(n).padStart(5)}件 (${pct(n, sp.length)})`);
  }
  const aixRoom = aixRows.filter((r) => String(r.room_no ?? "").trim()).length;
  const aixStatus = aixRows.filter((r) => r.recruitment_status).length;
  console.log(`   ※ 新しい経路（aix:* / staff_image）だけで見ると 号室 ${aixRoom}/${aixRows.length}・募集状況 ${aixStatus}/${aixRows.length}`);

  // ── ④ 重複チェックが効く範囲 ──
  console.log(`\n=== ④ 重複チェック（check-property-duplicate）が効く範囲 ===`);
  const dupUsable = sp.filter((r) => (r.property_customer_id || r.conversation_id) && String(r.property_name ?? "").trim()).length;
  console.log(`   紐付きがあって照合できる行: ${dupUsable}件 / ${sp.length}件 (${pct(dupUsable, sp.length)})`);
  console.log(`   → 紐付きが無い行は「誰に送ったか」不明なので重複判定に使えない`);
}
main().catch((e) => { console.error(e); process.exit(1); });
