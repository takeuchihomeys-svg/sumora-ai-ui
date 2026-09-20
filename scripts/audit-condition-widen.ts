// 「条件を広げた」を文生成に渡すと、文は良くなるのか（読み取りのみ）
//
// 2026-09-20 竹内「物件ピックアップで送った物件に対して DeepSeek が読みとれば
//   **条件広げてるのとかも理解できる**から、ちゃんとお客さんに対して適切な文を生成できる可能性が高い」
//
// 設計知見「分類を増やす前に『増やすと質が上がるのか』を測る」。
//   渡す材料（property_condition_history 127件）は既にある。渡す価値があるかは
//   **スタッフが実際に「広げたこと」に触れて送っているか**で決まる。触れていないなら渡しても文は変わらない。
//
// 測り方:
//   ① 条件が変わった直後（24時間以内）のスタッフ送信を集める
//   ② その文に「広げた」ことに触れる言い回しがあるか数える
//   ③ 触れている実文を目で読む（言い回しの型を取る）
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 「条件を広げた／変えた」ことに触れる言い回し（実送信から型を取るための入口。広めに取る） */
const WIDEN_RE = /(?:まで|も)(?:広げ|拡[げ大])|範囲[^\n。！!]{0,6}(?:広げ|拡[げ大])|エリア[^\n。！!]{0,8}(?:広げ|拡[げ大])|条件[^\n。！!]{0,8}(?:広げ|変更|緩和)|(?:も|まで)含めて[^\n。！!]{0,12}(?:ピックアップ|お探し|探[しさ])|少ない状況/;

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // 条件変更（property_customer_id 単位）
  const hist: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 6; p++) {
    const { data, error } = await sb.from("property_condition_history")
      .select("property_customer_id, changed_field, old_value, new_value, created_at")
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    hist.push(...r);
    if (r.length < 1000) break;
  }
  console.log(`=== 条件変更 ${hist.length}件（直近${days}日）===`);

  // property_customer_id → conversation_id
  const pcIds = [...new Set(hist.map((h) => String(h.property_customer_id ?? "")).filter(Boolean))];
  const convOf = new Map<string, string>();
  for (let i = 0; i < pcIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, property_customer_id").in("property_customer_id", pcIds.slice(i, i + 200));
    for (const c of ((data ?? []) as Array<{ id: string; property_customer_id: string | null }>)) {
      if (c.property_customer_id) convOf.set(c.property_customer_id, c.id);
    }
  }
  console.log(`   会話に辿れた: ${[...new Set(hist.map((h) => convOf.get(String(h.property_customer_id ?? ""))).filter(Boolean))].length}会話`);

  // その会話のスタッフ送信
  const convIds = [...new Set([...convOf.values()])];
  const msgs: Array<{ conversation_id: string; text: string | null; created_at: string; sender: string }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    // ⚠ Supabase の既定上限（1000件）で静かに切れるのでページングする（設計知見「1000件で切れる」）
    const chunk = convIds.slice(i, i + 20);
    for (let p = 0; p < 10; p++) {
      const { data, error } = await sb.from("messages").select("conversation_id, text, created_at, sender")
        .in("conversation_id", chunk).eq("sender", "staff").gte("created_at", since)
        .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      if (error) { console.log(`   ⚠ messages: ${error.message}`); break; }
      const r = (data ?? []) as typeof msgs;
      if (r.length === 0) break;
      msgs.push(...r);
      if (r.length < 1000) break;
    }
  }
  console.log(`   その会話のスタッフ送信: ${msgs.length}通`);
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }

  // ① 条件変更の直後（24時間以内）のスタッフ送信
  let windows = 0, touched = 0;
  const samples: Array<{ field: string; oldV: string; newV: string; text: string }> = [];
  const widenedOnly: Array<{ field: string; oldV: string; newV: string }> = [];
  for (const h of hist) {
    const cid = convOf.get(String(h.property_customer_id ?? ""));
    if (!cid) continue;
    const t = Date.parse(String(h.created_at));
    const after = (byConv.get(cid) ?? []).filter((m) => {
      const mt = Date.parse(m.created_at);
      return mt >= t && mt <= t + 24 * 3600_000 && (m.text ?? "").length > 10;
    });
    if (after.length === 0) continue;
    windows++;
    const hit = after.find((m) => WIDEN_RE.test(m.text ?? ""));
    const oldV = String(h.old_value ?? ""), newV = String(h.new_value ?? "");
    // 「広がった」と言えるもの（新しい値が古い値を含む／数値が大きくなった）だけ別に数える
    const grew = (newV.length > oldV.length && oldV.length > 0 && newV.includes(oldV.slice(0, Math.min(8, oldV.length))))
      || (/^\d+$/.test(oldV) && /^\d+$/.test(newV) && Number(newV) > Number(oldV));
    if (grew) widenedOnly.push({ field: String(h.changed_field ?? ""), oldV, newV });
    if (hit) {
      touched++;
      if (samples.length < 12) samples.push({ field: String(h.changed_field ?? ""), oldV, newV, text: (hit.text ?? "").replace(/\n/g, " ／ ").slice(0, 150) });
    }
  }
  console.log(`\n=== ① 条件変更の直後24時間にスタッフ送信がある: ${windows}件 ===`);
  console.log(`   そのうち「広げた／変えた」ことに触れている: ${touched}件 (${windows ? ((touched / windows) * 100).toFixed(1) : "-"}%)`);
  console.log(`   → この率が低ければ、材料を渡しても文は変わらない（渡す価値が無い）\n`);
  console.log(`   --- 触れている実文（目で読む・言い回しの型を取る）---`);
  for (const s of samples) console.log(`     [${s.field}] ${s.oldV.slice(0, 20)} → ${s.newV.slice(0, 20)}\n        ${s.text}\n`);

  console.log(`=== ② 実際に「広がった」変更（新しい値が古い値を含む／数値が増えた）: ${widenedOnly.length}件 ===`);
  const wf = new Map<string, number>();
  for (const w of widenedOnly) wf.set(w.field, (wf.get(w.field) ?? 0) + 1);
  for (const [k, n] of [...wf.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}件  ${k}`);
  for (const w of widenedOnly.slice(0, 8)) console.log(`     例: ${w.field}: ${w.oldV.slice(0, 30)} → ${w.newV.slice(0, 30)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
