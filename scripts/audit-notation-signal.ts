// 漢字/ひらがなの選び方に「読める signal」があるか（読み取りのみ）
//
// 2026-09-21 YUMA 検証で、buildNotationNote を userPrompt の最後に置いても
// 「させて頂く」のひらがな率は **0%**（実送信 32.5%）のままだった。
//
// ⚠ そもそも率を材料に渡す形が成立しない可能性がある:
//   1通の中に「させて頂きます」は**1回しか出ない**ことが多い。
//   1回しか出ない物に「32.5% でひらがなを混ぜろ」と言っても、0% か 100% にしかならない
//   （設計知見「プロンプトの微調整は振り子になる — 中間を言葉で指定しても中間には落ちない」）。
//
// なので測るのは「率」ではなく **1通ごとにどちらを選ぶかを決められる材料があるか**:
//   ① 同じ会話の中でスタッフの表記は揃っているか（揃っているなら「その会話に合わせる」で決まる）
//   ② 場面（AIX の種類）で分かれるか
//   ③ 1通の中で混在しているか（混在するなら「通ごとに決める」自体が誤り）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-notation-signal.ts
import { createClient } from "@supabase/supabase-js";
import { NOTATION_PAIRS } from "../app/lib/notation-mix";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 120);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

async function page(table: string, select: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
      .order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const msgs = (await page("messages", "conversation_id, sender, text, created_at", DAYS))
    .filter((m) => String(m.sender) === "staff" && String(m.text ?? "").trim());
  console.log(`=== 材料: 直近${DAYS}日のスタッフ送信 ${msgs.length}件 ===\n`);

  for (const p of NOTATION_PAIRS) {
    const hits = msgs.map((m) => {
      const t = String(m.text);
      return { conv: String(m.conversation_id ?? ""), k: (t.match(p.kanji) ?? []).length, h: (t.match(p.kana) ?? []).length };
    }).filter((x) => x.k + x.h > 0);
    if (hits.length < 50) { console.log(`■ ${p.name}: 母数 ${hits.length}件（少ないので飛ばす）\n`); continue; }

    const totalK = hits.reduce((a, x) => a + x.k, 0), totalH = hits.reduce((a, x) => a + x.h, 0);
    console.log(`■ ${p.name}`);
    console.log(`   出た通 ${hits.length}件 ／ 漢字 ${totalK}回・かな ${totalH}回（ひらがな率 ${pct(totalH, totalK + totalH)}）`);

    // ③ 1通の中で混ざるか
    const mixed = hits.filter((x) => x.k > 0 && x.h > 0).length;
    const multi = hits.filter((x) => x.k + x.h >= 2).length;
    console.log(`   1通に2回以上出る ${multi}件（${pct(multi, hits.length)}）／ うち1通の中で混在 ${mixed}件（${pct(mixed, multi)}）`);

    // ① 会話ごとに揃っているか
    const byConv = new Map<string, { k: number; h: number; msgs: number }>();
    for (const x of hits) {
      const c = byConv.get(x.conv) ?? { k: 0, h: 0, msgs: 0 };
      c.k += x.k; c.h += x.h; c.msgs++;
      byConv.set(x.conv, c);
    }
    const convs = [...byConv.values()].filter((c) => c.msgs >= 3);
    const pure = convs.filter((c) => c.k === 0 || c.h === 0).length;
    // 「その会話の過去の表記に合わせる」と決めたら何%当たるか（多数派で当てる）
    let follow = 0, followTot = 0;
    for (const x of hits) {
      const c = byConv.get(x.conv)!;
      const restK = c.k - x.k, restH = c.h - x.h;
      if (restK + restH === 0) continue;             // その会話に他の実績が無ければ決められない
      const guessKana = restH > restK;
      const actualKana = x.h > x.k;
      followTot++;
      if (guessKana === actualKana) follow++;
    }
    console.log(`   3通以上ある会話 ${convs.length}件 ／ 全部どちらか一方に揃っている ${pure}件（${pct(pure, convs.length)}）`);
    console.log(`   「その会話の過去の表記に合わせる」で当たる率: ${pct(follow, followTot)}（判定できた ${followTot}件）`);
    console.log(`   （何も見ずに多い方に倒すと ${pct(Math.max(totalK, totalH), totalK + totalH)}）\n`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
