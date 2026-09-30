// 手続きの質問（審査の期間・入居までの期間と流れ・必要書類・本人確認書類）の線の監査（読み取りのみ）
//
// 2026-09-30 竹内（みこと「本人確認書類がマイナンバー、パスポート両方あるのですが審査通るまでどのくらいの期間見といたらいいですか？」
//   → 画面は AIX【物件確認した】。「この場合は AIX の確認したではない…申込から審査、入居までの期間と流れを説明する部分、返信すれば大丈夫」）
//   ① お客様の発言（365日）の広い候補（審査|入居まで|流れ|書類|身分証|マイナンバー|パスポート|免許）に detectProcedureQuestion を当て、
//      当たり（返信に倒す）・当たりだが混ざり（通りやすさ・保証会社・進み具合）・外れ を並べて読む
//   ② 当たりの次のスタッフの実送信と、24時間以内に押した AIX を並べる（返信で答えたか・AIX を押したか）
//   ③ その回のブレインの判断（brain_decision_logs）が 物件確認した／確認します／保証会社について だった回＝直しで返信に変わる回
//   --all で申込以降の会話も含める（既定は申込前だけ＝直しが効く範囲）
// 実行: npx tsx --env-file=.env.local scripts/audit-procedure-question.ts [--all] [DAYS=365]
import { createClient } from "@supabase/supabase-js";
import { detectProcedureQuestion, isProcedureReplyQuestion, type ProcedureQuestion } from "../app/lib/procedure-question";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const one = (s: string) => s.replace(/\s+/g, " ").trim();
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const WIDE = /審査|入居まで|流れ|書類|身分証|マイナンバー|パスポート|免許/;

async function pageAll<T>(table: string, cols: string, since: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(table, error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
  type Aix = { conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string };
  type Dec = { conversation_id: string; suggested_action: string | null; suggested_check_pattern: string | null; decision_source: string | null; analyzed_msg_ts: string | null; created_at: string };
  const [msgs, aix, decs] = await Promise.all([
    pageAll<Msg>("messages", "conversation_id, sender, text, created_at", since),
    pageAll<Aix>("aix_usage_logs", "conversation_id, aix_type, check_pattern, created_at", since),
    pageAll<Dec>("brain_decision_logs", "conversation_id, suggested_action, suggested_check_pattern, decision_source, analyzed_msg_ts, created_at", since),
  ]);
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (m.conversation_id === YUMA) continue; const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const cust = msgs.filter((m) => m.conversation_id !== YUMA && m.sender === "customer" && (m.text ?? "").trim() && !/^\s*\[(?:画像|動画|スタンプ|ファイル)\]/.test(m.text ?? ""));
  console.log(`直近${days}日 全${msgs.length}通・お客様の発言 ${cust.length}通\n`);
  const nextStaff = (m: Msg) => {
    const a = byConv.get(m.conversation_id) ?? []; const i = a.indexOf(m);
    for (let j = i + 1; j < a.length && j < i + 8; j++) if (a[j].sender === "staff" && (a[j].text ?? "").trim() && !/^\[/.test(a[j].text ?? "")) return one(a[j].text ?? "").slice(0, 170);
    return "（なし）";
  };
  const aixAfter = (m: Msg) => aix.filter((a) => a.conversation_id === m.conversation_id && a.created_at > m.created_at && Date.parse(a.created_at) - Date.parse(m.created_at) < 86400_000)
    .map((a) => `${a.aix_type}${a.check_pattern ? `(${a.check_pattern})` : ""}`).slice(0, 4).join(",") || "なし";
  const brainAt = (m: Msg) => {
    const d = decs.filter((x) => x.conversation_id === m.conversation_id && x.created_at > m.created_at && Date.parse(x.created_at) - Date.parse(m.created_at) < 10 * 60_000)[0];
    return d ? `${d.suggested_action ?? "なし"}${d.suggested_check_pattern ? `(${d.suggested_check_pattern})` : ""}[${d.decision_source ?? "-"}]` : "記録なし";
  };
  const cand = cust.filter((m) => WIDE.test(m.text ?? ""));
  let hit = 0, mixed = 0, miss = 0; const kinds: Record<string, number> = {}; let brainAixOnHit = 0, staffAixOnHit = 0;
  const lines: string[] = [];
  for (const m of cand) {
    const q = detectProcedureQuestion(m.text);
    if (!q) { miss++; if (/審査[^。\n]{0,12}(?:日|期間|くらい|ぐらい)|入居まで|流れ|必要.{0,3}書類/.test(m.text ?? "")) lines.push(`  [外れ] ${m.created_at.slice(0, 10)} ${one(m.text ?? "").slice(0, 110)}`); continue; }
    const qq: ProcedureQuestion = q; const ok: boolean = isProcedureReplyQuestion(qq);
    if (ok) { hit++; for (const k of qq.kinds) kinds[k] = (kinds[k] ?? 0) + 1; } else mixed++;
    const b = brainAt(m), a = aixAfter(m);
    if (ok && /^(property_check_result|acknowledge_check|guarantor_info)/.test(b)) brainAixOnHit++;
    if (ok && /property_check_result|acknowledge_check|guarantor_info/.test(a)) staffAixOnHit++;
    lines.push(`  [${ok ? "当たり" : `混ざり(${[qq.passability && "通りやすさ", qq.guarantorIdentity && "保証会社", qq.progress && "進み具合"].filter(Boolean).join("・")})`}:${qq.kinds.join("+")}] ${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} ${one(m.text ?? "").slice(0, 130)}\n        → スタッフ: ${nextStaff(m)}\n        → 24h の AIX: ${a} ／ その回のブレイン: ${b}`);
  }
  console.log(`① 広い候補 ${cand.length}通 → 当たり ${hit}・混ざり ${mixed}・外れ ${miss}`);
  console.log(lines.join("\n"));
  console.log(`\n種類: ${JSON.stringify(kinds)}`);
  console.log(`当たり ${hit}通のうち: ブレインが 物件確認した／確認します／保証会社について を出していた ${brainAixOnHit}・スタッフが24h 以内にその AIX を押した ${staffAixOnHit}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
