// 戦略（普段の整理）と毎回の分析のずれを数える監査（読み取りのみ）
//
// 2026-09-23 竹内「なんでこの場面 AIX の物件ピックアップがセットされていないのか。この状況は物件を次送る状況なのに。ここにずれがある」
//
// 実物（あっぴさん）: conversations.brain_strategy は
//   「Step1: …新着物件を Chrome拡張で再検索する／Step2: 見つかり次第 AIXボタン『物件ピックアップした』を押す」
// と正しく書けているのに、毎回の分析は aix:null（ルール⑧）で要対応が1件も立っていなかった。
//
// この監査が数える物:
//   ① 戦略が物件を送れと言っているのに、その後の毎回の分析が aix:null の会話（ずれの件数）
//   ② そのうち台帳に未履行のピックアップ宣言が残っている会話（＝今回入れた決定論 signal:pending_pickup が立て直す分）
//   ③ 逆に、未履行の宣言が無いのに立ってしまう会話（＝誤って立つ分。0であることを目で読む）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-strategy-aix-gap.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger } from "../app/lib/action-ledger";
import { resolvePendingPickup } from "../app/lib/pending-pickup";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 30);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
/** 申込以降（次の一手は物件ではない） */
const POST_APPLY_STATUS = new Set(["applying", "application", "screening", "contract", "closed_won", "申込", "審査中", "契約"]);
/** 戦略が「次は物件を送る」と言っている印 */
const STRATEGY_PICKUP_RE = /物件ピックアップ|ピックアップした|property_send|物件をピックアップ|再検索|新着物件/;

type Conv = { id: string; customer_name: string | null; status: string | null; brain_strategy: unknown; updated_at: string | null };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
type Log = { conversation_id: string; suggested_action: string | null; decision_source: string | null; created_at: string };

async function pageAll<T>(run: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await run(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${error.message}`); break; }
    const r = (data ?? []) as T[];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 戦略と毎回の分析のずれ（直近${DAYS}日）===\n`);

  const convs = await pageAll<Conv>((a, b) =>
    sb.from("conversations").select("id, customer_name, status, brain_strategy, updated_at")
      .gte("updated_at", since).not("brain_strategy", "is", null).range(a, b));
  console.log(`戦略が書かれている会話: ${convs.length}件`);

  const logs = await pageAll<Log>((a, b) =>
    sb.from("brain_decision_logs").select("conversation_id, suggested_action, decision_source, created_at")
      .gte("created_at", since).order("created_at", { ascending: false }).range(a, b));
  const lastLog = new Map<string, Log>();
  for (const l of logs) if (!lastLog.has(l.conversation_id)) lastLog.set(l.conversation_id, l);

  // 戦略が物件を指していて、最後の分析が AIX なしの会話
  const gap: Conv[] = [];
  for (const c of convs) {
    if (POST_APPLY_STATUS.has((c.status ?? "").trim())) continue;
    const st = JSON.stringify(c.brain_strategy ?? "");
    if (!STRATEGY_PICKUP_RE.test(st)) continue;
    const l = lastLog.get(c.id);
    if (!l) continue;
    if (l.suggested_action) continue; // AIX が立っている＝ずれていない
    gap.push(c);
  }
  console.log(`① 戦略は物件を送れと言っているのに毎回の分析が AIX なし: ${gap.length}件\n`);

  // それぞれの台帳を作って、新しい決定論が立て直す分・誤って立つ分を分ける
  let willFire = 0; let wontFire = 0;
  const fired: string[] = []; const notFired: string[] = [];
  for (const c of gap) {
    const msgs = await pageAll<Msg>((a, b) =>
      sb.from("messages").select("conversation_id, sender, text, created_at")
        .eq("conversation_id", c.id).order("created_at", { ascending: false }).range(a, Math.min(b, a + 59)));
    const oldestFirst = [...msgs].reverse().map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at }));
    if (oldestFirst.length === 0) continue;
    const ledger = buildActionLedger({ messages: oldestFirst });
    const r = resolvePendingPickup(ledger.facts, { postApply: POST_APPLY_STATUS.has((c.status ?? "").trim()) });
    const name = (c.customer_name ?? "（名無し）").slice(0, 8);
    const lastStaff = [...oldestFirst].reverse().find((m) => m.sender === "staff")?.text ?? "";
    const lastCust = [...oldestFirst].reverse().find((m) => m.sender === "customer")?.text ?? "";
    const line = `   ${name}｜宣言:${ledger.facts.pickupPromisedAt?.slice(0, 16) ?? "なし"}｜送付:${ledger.facts.lastPropertiesSentAt?.slice(0, 16) ?? "なし"}｜理由:${r.reason}\n      直近スタッフ: ${lastStaff.replace(/\n/g, " ").slice(0, 70)}\n      直近お客様  : ${lastCust.replace(/\n/g, " ").slice(0, 70)}`;
    if (r.pending) { willFire++; fired.push(line); } else { wontFire++; notFired.push(line); }
  }

  console.log(`② 新しい決定論（signal:pending_pickup）が立て直す: ${willFire}件（1件ずつ目で読む）`);
  for (const l of fired) console.log(l);
  console.log(`\n③ 立て直さない（未履行の宣言なし・申込以降・古い宣言）: ${wontFire}件`);
  for (const l of notFired) console.log(l);

  // ④ 誤って立つ会話が0か（戦略の有無に関係なく、動いている会話に当てて pending になる物を全部目で読む）
  const active = await pageAll<Conv>((a, b) =>
    sb.from("conversations").select("id, customer_name, status, brain_strategy, updated_at")
      .gte("updated_at", new Date(Date.now() - 14 * 86400_000).toISOString())
      .order("updated_at", { ascending: false }).range(a, b));
  const targets = active.filter((c) => !POST_APPLY_STATUS.has((c.status ?? "").trim())).slice(0, 150);
  console.log(`\n④ 動いている会話 ${targets.length}件（直近14日・申込前）に当てて pending になる物を全部読む`);
  let pendingAll = 0;
  for (const c of targets) {
    const msgs = await pageAll<Msg>((a, b) =>
      sb.from("messages").select("conversation_id, sender, text, created_at")
        .eq("conversation_id", c.id).order("created_at", { ascending: false }).range(a, Math.min(b, a + 59)));
    const oldestFirst = [...msgs].reverse().map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at }));
    if (oldestFirst.length === 0) continue;
    const ledger = buildActionLedger({ messages: oldestFirst });
    const r = resolvePendingPickup(ledger.facts, {});
    if (!r.pending) continue;
    pendingAll++;
    const decl = ledger.entries.filter((e) => e.kind === "pickup_declared" && e.status === "promised").at(-1);
    console.log(`   ${(c.customer_name ?? "（名無し）").slice(0, 8)}｜${Math.round(r.hours ?? 0)}時間前の宣言｜根拠: ${(decl?.evidence ?? "").replace(/\n/g, " ").slice(0, 60)}`);
  }

  console.log(`\n=== まとめ ===`);
  console.log(`ずれ ${gap.length}件 → 立て直す ${willFire}件／残るずれ ${wontFire}件`);
  console.log(`動いている会話で pending になる: ${pendingAll}件（根拠がピックアップの宣言でない物が1件でもあれば誤爆）`);
  console.log(`※ ②の「直近スタッフ」がピックアップの宣言でない会話が1件でもあれば誤爆。入れる前に判定を狭めること`);
}

main().catch((e) => { console.error(e); process.exit(1); });
