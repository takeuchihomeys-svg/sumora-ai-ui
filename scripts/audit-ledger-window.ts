// 行動台帳がブレインに見せている「直近6件」で、こちらが伝えたことがどれだけ落ちているかを測る（読み取りのみ）
// 2026-09-23 竹内「①から着手する／AIXで何を押して送っているかも記憶にかけあわせたら更に質が上がる」
//
// 設計知見「繰り返しは禁止にできない — 既に言った締めと、まだ言っていない具体を材料として渡す」に従い、
//   禁止を増やすのではなく「既に伝えたこと」を**事実として**渡す方向で、今どれだけ落ちているかを先に測る。
//
// 測ること:
//   ① 会話ごとの台帳エントリ数の分布（6件で何%の会話が切られているか・何件落ちているか）
//   ② 切られて落ちる中身は何か（種類ごとの最後の1回が落ちていないか＝「もう言った」が消える）
//   ③ AIX の押下が台帳に何件入っているか（手打ちとの比）と、同じ AIX を何回押しているか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-ledger-window.ts [DAYS=60] [SHOW=6]
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger } from "../app/lib/action-ledger";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null };
type Aix = { conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string; sent_at: string | null; line_message_id: string | null; property_names: string[] | null; estimate_sent: boolean | null; template_name: string | null };
const pct = (a: number, b: number) => `${((a / Math.max(b, 1)) * 100).toFixed(1)}%`;

async function page<T>(table: string, cols: string, since: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(`${table}: ${error.message}`); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const SHOW = Number(process.env.SHOW ?? 6);          // 今ブレインに見せている件数
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs = await page<Msg>("messages", "conversation_id, sender, text, created_at, is_aix_generated, line_message_id", since);
  const aix = await page<Aix>("aix_usage_logs", "conversation_id, aix_type, check_pattern, created_at, sent_at, line_message_id, property_names, estimate_sent, template_name", since);
  const convs = [...new Set(msgs.map((m) => m.conversation_id))];
  console.log(`直近${days}日: メッセージ ${msgs.length}通 ／ AIX 押下 ${aix.length}件 ／ 会話 ${convs.length}件\n`);

  const byConvM = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConvM.has(m.conversation_id)) byConvM.set(m.conversation_id, []); byConvM.get(m.conversation_id)!.push(m); }
  const byConvA = new Map<string, Aix[]>();
  for (const a of aix) { if (!byConvA.has(a.conversation_id)) byConvA.set(a.conversation_id, []); byConvA.get(a.conversation_id)!.push(a); }

  let convOver = 0, entriesTotal = 0, entriesDropped = 0;
  const droppedKinds = new Map<string, number>();
  const shownKinds = new Map<string, number>();
  /** 種類ごとの「最後の1回」が窓から落ちた回数（＝「もう言った」がブレインに届かない） */
  const lastOfKindDropped = new Map<string, number>();
  const sizes: number[] = [];

  for (const cid of convs) {
    const list = (byConvM.get(cid) ?? []);
    const ledger = buildActionLedger({
      recentAixRows: (byConvA.get(cid) ?? []).map((l) => ({
        aix_type: l.aix_type, check_pattern: l.check_pattern, created_at: l.created_at, sent_at: l.sent_at,
        line_message_id: l.line_message_id, property_names: l.property_names, estimate_sent: l.estimate_sent,
        template_name: l.template_name, generated_text: null,
      })),
      messages: list.map((m) => ({ sender: m.sender ?? "customer", text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated, lineMessageId: m.line_message_id })),
      lineTasks: [],
      lastCustomerAt: [...list].reverse().find((m) => m.sender === "customer")?.created_at ?? null,
    });
    const shownList = ledger.entries.filter((e) => e.kind !== "media_sent");
    sizes.push(shownList.length);
    entriesTotal += shownList.length;
    if (shownList.length > SHOW) {
      convOver++;
      const dropped = shownList.slice(0, shownList.length - SHOW);
      const kept = shownList.slice(-SHOW);
      entriesDropped += dropped.length;
      for (const e of dropped) droppedKinds.set(e.kind, (droppedKinds.get(e.kind) ?? 0) + 1);
      for (const e of kept) shownKinds.set(e.kind, (shownKinds.get(e.kind) ?? 0) + 1);
      // 種類ごとの最後の1回が落ちたか（窓に同じ種類が1つも残っていない）
      const keptKinds = new Set(kept.map((e) => e.kind));
      for (const k of new Set(dropped.map((e) => e.kind))) {
        if (!keptKinds.has(k)) lastOfKindDropped.set(k, (lastOfKindDropped.get(k) ?? 0) + 1);
      }
    } else {
      for (const e of shownList) shownKinds.set(e.kind, (shownKinds.get(e.kind) ?? 0) + 1);
    }
  }
  sizes.sort((a, b) => a - b);
  console.log(`① 台帳のエントリ数（会話ごと）: 中央値 ${sizes[Math.floor(sizes.length / 2)]} ／ 最大 ${sizes[sizes.length - 1]} ／ 合計 ${entriesTotal}`);
  console.log(`   ${SHOW}件を超える会話: ${convOver}件（${pct(convOver, convs.length)}）／ 窓から落ちるエントリ ${entriesDropped}件（${pct(entriesDropped, entriesTotal)}）`);

  console.log(`\n② 落ちている中身（上位）— 「その種類の最後の1回」まで落ちた会話数が重要`);
  const rows = [...new Set([...droppedKinds.keys(), ...lastOfKindDropped.keys()])]
    .map((k) => ({ k, dropped: droppedKinds.get(k) ?? 0, last: lastOfKindDropped.get(k) ?? 0, shown: shownKinds.get(k) ?? 0 }))
    .sort((a, b) => b.last - a.last || b.dropped - a.dropped);
  console.log(`   ${"種類".padEnd(24)} 落ちた ／ うち最後の1回まで落ちた会話 ／ 窓に残っている`);
  for (const r of rows.slice(0, 14)) {
    console.log(`   ${r.k.padEnd(24)} ${String(r.dropped).padStart(5)} ／ ${String(r.last).padStart(5)} ／ ${String(r.shown).padStart(5)}`);
  }

  console.log(`\n③ AIX の押下`);
  const byType = new Map<string, number>();
  for (const a of aix) byType.set(a.aix_type ?? "?", (byType.get(a.aix_type ?? "?") ?? 0) + 1);
  console.log(`   押下 ${aix.length}件 ／ 種類 ${byType.size}`);
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   - ${String(t).padEnd(26)} ${n}`);
  // 同じ AIX を同じ会話で何回押しているか（「使用済み一覧」は種類だけで回数・時刻が無い）
  const repeat = new Map<string, number>();
  for (const [cid, list] of byConvA) {
    const c = new Map<string, number>();
    for (const a of list) c.set(a.aix_type ?? "?", (c.get(a.aix_type ?? "?") ?? 0) + 1);
    for (const [t, n] of c) if (n >= 2) repeat.set(t, (repeat.get(t) ?? 0) + 1);
    void cid;
  }
  console.log(`\n   同じ AIX を同じ会話で2回以上押した（種類ごとの会話数）:`);
  for (const [t, n] of [...repeat].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   - ${String(t).padEnd(26)} ${n}会話`);
}
main().catch((e) => { console.error(e); process.exit(1); });
