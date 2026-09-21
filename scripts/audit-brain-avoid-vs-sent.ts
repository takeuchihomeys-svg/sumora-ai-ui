// ブレインが「避ける」と言った話題を、スタッフは実際に書いているか（読み取りのみ）
//
// 2026-09-21 竹内「ブレインが勝つようにする」
//
// 今は衝突した時、`avoidConflictsWithCell` が **ブレインの avoid を削って**セルの必須要素を通している
// （＝セルが勝つ）。逆にするなら、まず「ブレインの avoid が正しいのか」を実送信で確かめる必要がある。
//   設計知見「必須にしてよいのは過半数が守っている形だけ」「足す決定論は実送信に何通あるかを根拠にする」
//
// 【測り方】
//   conversations.suggested_aix_meta.avoid_topics（今の値）と analyzed_msg_ts（その判断が見たお客様発言の時刻）を使い、
//   **その直後にスタッフが実際に送った1通**に、避けろと言われた話題が入っているかを見る。
//   ⚠ avoid_topics は会話ごとに1つしか残らない（上書き）ので、これは「最新の判断1回分」の標本。
//     過去の全ターンは測れない（brain_decision_logs に avoid_topics の列が無い）。正直にそう書く。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-avoid-vs-sent.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number | null) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");

/**
 * 避ける話題 → 本文でそれに当たる言い回し。
 * ⚠ reply-context.ts の CONFLICT_CLASSES と同じ意味クラスで作る（四者同名）。
 */
const TOPIC_RE: Array<{ id: string; avoid: RegExp; inBody: RegExp }> = [
  { id: "estimate", avoid: /見積/, inBody: /御?見積(?:書|り|もり)?/ },
  { id: "initial_cost", avoid: /初期費用/, inBody: /初期費用/ },
  { id: "new_pickup", avoid: /新規.{0,6}ピックアップ|再ピックアップ|別物件|他物件|物件提案|別のお部屋/, inBody: /ピックアップ|お探し|探させて|オススメ(?:出来る|できる)お部屋/ },
  { id: "viewing", avoid: /内見|内覧|ご案内/, inBody: /内覧|ご案内させて(?:頂|いただ)き/ },
  { id: "apply", avoid: /申込/, inBody: /お申込|申込/ },
  { id: "vacancy", avoid: /募集状況|空室/, inBody: /募集状況|空室/ },
];

async function main() {
  const convs = await page("conversations", "id, suggested_aix_meta, status, updated_at", "updated_at", Number(process.env.DAYS ?? 60));
  const msgs = await page("messages", "conversation_id, sender, text, created_at", "created_at", Number(process.env.DAYS ?? 60));
  console.log(`=== 材料: conversations ${convs.length} / messages ${msgs.length} ===\n`);

  const byConv = new Map<string, Array<{ sender: string; text: string; at: number }>>();
  for (const m of msgs) {
    const cid = String(m.conversation_id ?? ""); const t = String(m.text ?? "").trim();
    if (!cid || !t) continue;
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ sender: String(m.sender ?? ""), text: t, at: new Date(String(m.created_at)).getTime() });
  }
  for (const a of byConv.values()) a.sort((x, y) => x.at - y.at);

  type Row = { topic: string; cls: string; wrote: boolean; body: string; cid: string };
  const rows: Row[] = [];
  let convWithAvoid = 0, convMatched = 0;

  for (const c of convs) {
    const meta = (c.suggested_aix_meta ?? null) as Record<string, unknown> | null;
    const avoid = (meta?.avoid_topics as string[] | undefined) ?? [];
    if (avoid.length === 0) continue;
    convWithAvoid++;
    const analyzedAt = meta?.analyzed_msg_ts ? new Date(String(meta.analyzed_msg_ts)).getTime() : NaN;
    const arr = byConv.get(String(c.id));
    if (!arr || !Number.isFinite(analyzedAt)) continue;
    // その判断が見たお客様発言の**直後**にスタッフが送った1通
    const next = arr.find((m) => m.sender === "staff" && m.at > analyzedAt);
    if (!next) continue;
    if (/^\[画像\]|^https?:\/\//.test(next.text.trim())) continue;   // 画像だけは本文が無い
    convMatched++;
    for (const t of avoid) {
      const cls = TOPIC_RE.find((x) => x.avoid.test(t));
      if (!cls) continue;
      rows.push({ topic: t, cls: cls.id, wrote: cls.inBody.test(next.text), body: next.text, cid: String(c.id).slice(0, 8) });
    }
  }

  console.log(`=== ① ブレインが「避ける」と言った話題を、スタッフは実際に書いたか ===`);
  console.log(`   avoid_topics がある会話 ${convWithAvoid}件 / 直後のスタッフ送信が取れた ${convMatched}件`);
  console.log(`   突き合わせできた（意味クラスに当たる）話題 ${rows.length}件\n`);
  const byCls = new Map<string, { n: number; wrote: number }>();
  for (const r of rows) {
    const b = byCls.get(r.cls) ?? { n: 0, wrote: 0 };
    b.n++; if (r.wrote) b.wrote++; byCls.set(r.cls, b);
  }
  console.log(`   意味クラス        件数   スタッフが書いた   判定`);
  for (const [k, v] of [...byCls.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const rate = v.wrote / v.n;
    const verdict = rate < 0.3 ? "✅ ブレインが正しい（書いていない）" : rate > 0.5 ? "⚠ セルが正しい（書いている）" : "△ 半々";
    console.log(`   ${k.padEnd(16)} ${String(v.n).padStart(4)}件  ${String(v.wrote).padStart(4)}件 (${pct(v.wrote, v.n).padStart(6)})  ${verdict}`);
  }
  const allWrote = rows.filter((r) => r.wrote).length;
  console.log(`\n   全体: ${allWrote}/${rows.length} = ${pct(allWrote, rows.length)} がブレインの「避ける」に反して書かれていた`);
  console.log(`   → この率が低いほど「ブレインを勝たせてよい」`);

  console.log(`\n=== ② ブレインの言う通りだった実物（避けろと言われ、実際に書いていない）===`);
  for (const r of rows.filter((x) => !x.wrote).slice(0, 5)) {
    console.log(`${"─".repeat(74)}`);
    console.log(`   ${r.cid}  避ける「${r.topic}」（${r.cls}）`);
    console.log(`   実送信: ${mask(r.body).slice(0, 140)}`);
  }

  console.log(`\n=== ③ ブレインに反して書いていた実物（ここはセルが正しい可能性）===`);
  for (const r of rows.filter((x) => x.wrote).slice(0, 8)) {
    console.log(`${"─".repeat(74)}`);
    console.log(`   ${r.cid}  避ける「${r.topic}」（${r.cls}）なのに書いている`);
    console.log(`   実送信: ${mask(r.body).slice(0, 140)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
