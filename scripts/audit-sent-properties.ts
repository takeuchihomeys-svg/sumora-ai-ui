// 物件ピックアップの材料は今どこまで届いているか（読み取りのみ）
//
// 2026-09-20 竹内「AIX の物件ピックアップで文送る際に文生成される部分、ここ物件ピックアップで送った物件に対して
//   DeepSeek が読みとれば条件広げてるのとかも理解できるから、ちゃんとお客さんに対して適切な文を生成できる可能性が高い。
//   物件ピックアップから送る物件もテーブルかクエリで保管したら、どれが物件ピックアップで送った物件かも理解できるし、
//   文生成される部分毎回直さなくて済む（退去予定物件の部分等）。そして一度送った物件が間違えって入ってしまうこと防げる」
//
// 設計知見「分析強化の原則」: **材料やルールを足す前に、その材料が今どう届いているかを測って構造を直す**。
//   竹内さんの構想に必要な入れ物は**既にある**:
//     sent_properties（property_name / room_no / rent / property_url / recruitment_status / applicant_rank /
//                      customer_reaction / source / conversation_id / property_customer_id）
//       ※ recruitment_status のコメントは「MOVE_OUT_PATTERN regex推測の代替」＝退去予定をデータで持つ設計
//     property_condition_history（changed_field / old_value / new_value）＝条件を広げた履歴
//   なので最初に測るのは「入れ物があるか」ではなく **どれだけ埋まっているか・誰が書いているか**。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type SP = Record<string, unknown>;
async function page(table: string, select: string, days: number | null, order: string): Promise<SP[]> {
  const out: SP[] = [];
  for (let p = 0; p < 20; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as SP[];
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 180);

  // ── ① sent_properties はどれだけ埋まっているか ──
  const sp = await page("sent_properties",
    "id, conversation_id, property_customer_id, property_name, room_no, rent, property_url, recruitment_status, applicant_rank, customer_reaction, source, sent_at",
    days, "sent_at");
  console.log(`=== ① sent_properties（直近${days}日 ${sp.length}件）===`);
  const filled = (k: string) => sp.filter((r) => r[k] !== null && r[k] !== undefined && r[k] !== "").length;
  const pc = (n: number) => sp.length ? `${((n / sp.length) * 100).toFixed(1)}%` : "-";
  for (const k of ["property_name", "room_no", "rent", "property_url", "recruitment_status", "applicant_rank", "customer_reaction", "conversation_id", "property_customer_id", "image_url"]) {
    if (k === "image_url") continue;
    console.log(`   ${k.padEnd(22)} ${String(filled(k)).padStart(5)}件 (${pc(filled(k))})`);
  }
  const bySource = new Map<string, number>();
  for (const r of sp) bySource.set(String(r.source ?? "(null)"), (bySource.get(String(r.source ?? "(null)")) ?? 0) + 1);
  console.log(`   --- source 別（誰が書いたか）---`);
  for (const [k, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(5)}件  ${k}`);
  const rs = new Map<string, number>();
  for (const r of sp) if (r.recruitment_status) rs.set(String(r.recruitment_status), (rs.get(String(r.recruitment_status)) ?? 0) + 1);
  console.log(`   --- recruitment_status（退去予定をデータで持つ設計）---`);
  if (rs.size === 0) console.log(`     （1件も入っていない）`);
  for (const [k, n] of rs) console.log(`     ${String(n).padStart(5)}件  ${k}`);

  // ── ② AIX の物件送付と sent_properties は対応しているか ──
  const logs = await page("aix_usage_logs", "id, conversation_id, aix_type, created_at", days, "created_at");
  const PICK = new Set(["property_send", "property_search", "property_recommendation"]);
  const picks = logs.filter((l) => PICK.has(String(l.aix_type ?? "")));
  console.log(`\n=== ② AIX の物件ピックアップ ${picks.length}件（直近${days}日）===`);
  const byAction = new Map<string, number>();
  for (const l of picks) byAction.set(String(l.aix_type), (byAction.get(String(l.aix_type)) ?? 0) + 1);
  for (const [k, n] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(5)}件  ${k}`);
  // その会話に、AIX の前後30分で sent_properties が書かれたか
  const spByConv = new Map<string, Array<{ at: number; name: string }>>();
  for (const r of sp) {
    const c = String(r.conversation_id ?? "");
    if (!c) continue;
    if (!spByConv.has(c)) spByConv.set(c, []);
    spByConv.get(c)!.push({ at: Date.parse(String(r.sent_at)), name: `${r.property_name}__${r.room_no}` });
  }
  let withSp = 0, withoutSp = 0;
  for (const l of picks) {
    const c = String(l.conversation_id ?? "");
    const t = Date.parse(String(l.created_at));
    const near = (spByConv.get(c) ?? []).filter((x) => Math.abs(x.at - t) <= 30 * 60_000);
    if (near.length) withSp++; else withoutSp++;
  }
  console.log(`   AIX の前後30分に sent_properties がある: ${withSp}件 (${picks.length ? ((withSp / picks.length) * 100).toFixed(1) : "-"}%)`);
  console.log(`   無い                                  : ${withoutSp}件`);
  console.log(`   → 「どれが物件ピックアップで送った物件か」が今どれだけ分かるか`);

  // ── ③ 同じ物件を2回以上送っているか（重複送付の実績）──
  console.log(`\n=== ③ 同じ会話で同じ物件を2回以上送った実績 ===`);
  let dupConv = 0, dupPairs = 0;
  const dupSamples: string[] = [];
  for (const [c, list] of spByConv) {
    const seen = new Map<string, number>();
    for (const x of list) seen.set(x.name, (seen.get(x.name) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, n]) => n >= 2);
    if (dups.length) {
      dupConv++;
      dupPairs += dups.length;
      if (dupSamples.length < 8) dupSamples.push(`${c.slice(0, 8)}… ${dups.map(([k, n]) => `${k}×${n}`).join(" / ")}`);
    }
  }
  console.log(`   会話 ${spByConv.size}件のうち 同じ物件を2回以上送った会話: ${dupConv}件 (${spByConv.size ? ((dupConv / spByConv.size) * 100).toFixed(1) : "-"}%)`);
  console.log(`   重複した物件の組: ${dupPairs}件`);
  for (const s of dupSamples) console.log(`     ${s}`);
  console.log(`   ※ sent_properties は「同じ物件の2回目は書かない」設計なので、ここに出る＝**記録をすり抜けて2回送った**`);

  // ── ④ 条件を広げた履歴は取れているか ──
  const hist = await page("property_condition_history", "id, property_customer_id, changed_field, old_value, new_value, created_at", days, "created_at");
  console.log(`\n=== ④ property_condition_history（条件を広げた履歴・直近${days}日 ${hist.length}件）===`);
  const byField = new Map<string, number>();
  for (const h of hist) byField.set(String(h.changed_field ?? "?"), (byField.get(String(h.changed_field ?? "?")) ?? 0) + 1);
  if (hist.length === 0) console.log(`   （1件も入っていない＝「条件を広げた」を履歴からは判断できない）`);
  for (const [k, n] of [...byField.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`     ${String(n).padStart(5)}件  ${k}`);
  for (const h of hist.slice(0, 6)) console.log(`     例: ${h.changed_field}: ${String(h.old_value).slice(0, 24)} → ${String(h.new_value).slice(0, 24)}`);

  // ── ④-2 aix_usage_logs には物件データが既に入っているか ──
  //   page.tsx:10595 が log-aix-usage に property_names / prop_statuses を渡しており、
  //   コメントは「brain-core が【物件別空き状況（確定事実）】としてプロンプトへ注入する」。
  //   ＝ 竹内さんの言う「テーブルかクエリで保管」は**ここに既にある可能性**がある。埋まり具合を見る。
  const aixFull = await page("aix_usage_logs",
    "id, conversation_id, aix_type, property_names, prop_statuses, estimate_sent, prop_cost_notes, line_message_id, sent_at, created_at",
    days, "created_at");
  console.log(`\n=== ④-2 aix_usage_logs の物件データ（直近${days}日 ${aixFull.length}件）===`);
  const aFilled = (k: string) => aixFull.filter((r) => {
    const v = r[k];
    return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
  }).length;
  const apc = (n: number) => aixFull.length ? `${((n / aixFull.length) * 100).toFixed(1)}%` : "-";
  for (const k of ["property_names", "prop_statuses", "estimate_sent", "prop_cost_notes", "line_message_id", "sent_at"]) {
    console.log(`   ${k.padEnd(18)} ${String(aFilled(k)).padStart(5)}件 (${apc(aFilled(k))})`);
  }
  // 物件ピックアップ系だけに絞る
  const pickFull = aixFull.filter((r) => PICK.has(String(r.aix_type ?? "")));
  const pickWithNames = pickFull.filter((r) => Array.isArray(r.property_names) && (r.property_names as unknown[]).length > 0);
  console.log(`   --- 物件ピックアップ系 ${pickFull.length}件のうち property_names がある: ${pickWithNames.length}件 (${pickFull.length ? ((pickWithNames.length / pickFull.length) * 100).toFixed(1) : "-"}%)`);
  // AIX 種類別に「物件名が残っている率」
  const byType = new Map<string, { n: number; withNames: number; withStatus: number }>();
  for (const r of aixFull) {
    const t = String(r.aix_type ?? "?");
    if (!byType.has(t)) byType.set(t, { n: 0, withNames: 0, withStatus: 0 });
    const b = byType.get(t)!;
    b.n++;
    if (Array.isArray(r.property_names) && (r.property_names as unknown[]).length) b.withNames++;
    if (Array.isArray(r.prop_statuses) && (r.prop_statuses as unknown[]).length) b.withStatus++;
  }
  console.log(`   --- AIX 種類別（物件名が残っている率）上位12 ---`);
  for (const [t, b] of [...byType.entries()].sort((a, b2) => b2[1].n - a[1].n).slice(0, 12)) {
    console.log(`     ${t.padEnd(24)} ${String(b.n).padStart(4)}件  物件名 ${String(b.withNames).padStart(4)}件 (${((b.withNames / b.n) * 100).toFixed(0)}%)  状態 ${String(b.withStatus).padStart(4)}件 (${((b.withStatus / b.n) * 100).toFixed(0)}%)`);
  }
  // prop_statuses の中身（退去予定がどれだけあるか）
  const stat = new Map<string, number>();
  for (const r of aixFull) for (const s of (Array.isArray(r.prop_statuses) ? r.prop_statuses as unknown[] : [])) stat.set(String(s), (stat.get(String(s)) ?? 0) + 1);
  console.log(`   --- prop_statuses の中身（vacating＝退去予定あり）---`);
  if (stat.size === 0) console.log(`     （1件も入っていない）`);
  for (const [k, n] of [...stat.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(5)}件  ${k}`);
  // 実物
  console.log(`   --- 実物（物件名＋状態が両方ある物・5件）---`);
  let shown = 0;
  for (const r of aixFull) {
    if (shown >= 5) break;
    const ns = Array.isArray(r.property_names) ? (r.property_names as unknown[]).map(String) : [];
    const ss = Array.isArray(r.prop_statuses) ? (r.prop_statuses as unknown[]).map(String) : [];
    if (!ns.length || !ss.length) continue;
    shown++;
    console.log(`     [${r.aix_type}] ${ns.map((n, i) => `${n}（${ss[i] ?? "?"}）`).join(" / ").slice(0, 130)}`);
  }

  // ── ④-3 sent_image_properties（送信時に DeepSeek で画像を読んだ結果）はどこまで埋まっているか ──
  //   2026-09-20 に入った経路。source="aix:<種類>" で「どの AIX で送ったか」が分かる設計。
  //   ここに物件名があるなら、**sent_properties（重複チェック・ブレインが見る方）へ繋ぐだけ**で済む。
  const sip = await page("sent_image_properties", "image_url, conversation_id, property_name, room_no, source, created_at", days, "created_at");
  console.log(`\n=== ④-3 sent_image_properties（直近${days}日 ${sip.length}件）===`);
  const sipSrc = new Map<string, number>();
  for (const r of sip) sipSrc.set(String(r.source ?? "(null)"), (sipSrc.get(String(r.source ?? "(null)")) ?? 0) + 1);
  for (const [k, n] of [...sipSrc.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(5)}件  ${k}`);
  const aixSip = sip.filter((r) => String(r.source ?? "").startsWith("aix:"));
  console.log(`   AIX 由来（source が aix:*）: ${aixSip.length}件`);
  console.log(`   → ここが埋まれば「どの物件をどの AIX で送ったか」が分かる（2026-09-20 に入ったばかりの経路）`);
  // sent_properties に同じ物件があるか（＝重複チェックに効くか）
  const spKey = new Set(sp.map((r) => `${String(r.conversation_id ?? "")}|${String(r.property_name ?? "").trim()}`));
  const notInSp = aixSip.filter((r) => !spKey.has(`${String(r.conversation_id ?? "")}|${String(r.property_name ?? "").trim()}`));
  console.log(`   そのうち sent_properties に無い（＝重複チェックに効かない）: ${notInSp.length}件`);
  for (const r of aixSip.slice(0, 6)) console.log(`     [${r.source}] ${r.property_name} ${r.room_no ?? ""}`);

  // ── ⑤ 「退去予定」は今どこから来ているか（regex 推測かデータか）──
  console.log(`\n=== ⑤ 「退去予定」の今の出所 ===`);
  console.log(`   sent_properties.recruitment_status が入っている: ${filled("recruitment_status")}件 (${pc(filled("recruitment_status"))})`);
  console.log(`   → 0% なら、退去予定の判断は今も本文の regex 推測（MOVE_OUT_PATTERN）だけに頼っている`);
}
main().catch((e) => { console.error(e); process.exit(1); });
