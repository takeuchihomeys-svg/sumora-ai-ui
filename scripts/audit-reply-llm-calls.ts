// 返信生成でどのモデルが何回呼ばれているか（読み取りのみ）
//
// 2026-09-21 竹内:
//   「返信の部分でクロード紛れ込んでて２重で生成されていないか」
//   「返信の部分はdeepsheek一択になっているか」
//   「ファイナルチェックしたあとでの生成される文のところはdeepsheekとなっているのか」
//   「今回の改善でAPI費用がおおきくなったなら、そこも問題となる」
//
// 設計知見:
//   ・「切り替えの名前が1つの受け皿に潰れている（classify 問題）」
//     resolveRouteName は ①x-sumora-llm-action ヘッダー ②system 先頭の目印 だけで決まり、
//     どれにも当たらない物は全部 classify に落ちる。final-check.ts は素の fetch なので classify。
//   ・「fail-open の検査を別クラウドに回すと守りが黙って外れる」
//     → final-check は Claude のままが正しい（JSON スキーマ強制が変換で落ちるため）。
//   ・「見ていない数字は存在しない事にしてしまう」→ sys_head でどの呼び出しかを見分ける。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-reply-llm-calls.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const INPUT_PRICE: Record<string, number> = { "claude-sonnet-5": 3, "claude-haiku-4-5-20251001": 1, "claude-opus-5": 15, "claude-sonnet-4-6": 3 };
const cost = (r: Record<string, unknown>) => {
  const p = INPUT_PRICE[String(r.model)];
  if (!p) return 0;   // DeepSeek は Anthropic の請求ではない
  return (n(r.input_uncached) + n(r.cache_write_5m) * 1.25 + n(r.cache_write_1h) * 2 + n(r.cache_read) * 0.1 + n(r.output_tokens) * 5) * p / 1e6;
};

async function page(sinceIso: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, route, model, status, env, action, conversation_id, sys_key, sys_head, input_uncached, cache_read, cache_write_5m, cache_write_1h, output_tokens, duration_ms")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

/** その呼び出しが何をしている物か（system 先頭の目印で見分ける） */
function callKindOf(r: Record<string, unknown>): string {
  const h = String(r.sys_head ?? "");
  if (/ハードゲート|指示の優先順位/.test(h)) return "返信の本文を作る";
  if (/敵対的|検査|指摘|issues|ADVERSARIAL/i.test(h)) return "最終チェック（検査）";
  if (/スモラAI|会話全体の戦略/.test(h)) return "ブレイン";
  if (/ハルシネーション絶対禁止/.test(h)) return "AIXテンプレート";
  if (!h) return "（system なし）";
  return `その他: ${h.slice(0, 28)}`;
}

async function main() {
  const days = Number(process.env.DAYS ?? 7);
  const rows = await page(new Date(Date.now() - days * 86400_000).toISOString());
  const reply = rows.filter((r) => String(r.route) === "/api/generate-reply");
  console.log(`=== 材料: 全 ${rows.length}件 / うち /api/generate-reply ${reply.length}件（直近${days}日）===\n`);

  // ① generate-reply の中身をモデル × 呼び出しの種類で割る
  console.log(`=== ① /api/generate-reply の中で何が何回呼ばれているか ===`);
  const m = new Map<string, { c: number; usd: number; out: number }>();
  for (const r of reply) {
    const k = `${callKindOf(r)} ｜ ${r.model}`;
    const b = m.get(k) ?? { c: 0, usd: 0, out: 0 };
    b.c++; b.usd += cost(r); b.out += n(r.output_tokens); m.set(k, b);
  }
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1].c - a[1].c)) {
    console.log(`   ${String(v.c).padStart(5)}回  $${v.usd.toFixed(2).padStart(7)}  出力${String(Math.round(v.out / 1000)).padStart(4)}k  ${k}`);
  }

  // ② 「返信の本文を作る」だけを取り出して、Claude が混ざっていないか
  console.log(`\n=== ② 本文を作る呼び出しは DeepSeek 一択になっているか ===`);
  const gen = reply.filter((r) => callKindOf(r) === "返信の本文を作る");
  const byModel = new Map<string, number>();
  for (const r of gen) byModel.set(String(r.model), (byModel.get(String(r.model)) ?? 0) + 1);
  const total = gen.length;
  for (const [k, c] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) {
    const ds = k.startsWith("deepseek");
    console.log(`   ${String(c).padStart(5)}回 (${(c / total * 100).toFixed(1).padStart(5)}%)  ${k}  ${ds ? "✅ DeepSeek" : "⚠ Claude（切り替わっていない）"}`);
  }

  // ③ 二重生成: 同じ会話・同じ分で本文を作る呼び出しが2回以上ないか
  console.log(`\n=== ③ 二重生成（同じ会話で本文を作る呼び出しが続けて起きていないか）===`);
  const byConv = new Map<string, Array<{ at: number; model: string }>>();
  for (const r of gen) {
    const cid = String(r.conversation_id ?? "(なし)");
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ at: new Date(String(r.created_at)).getTime(), model: String(r.model) });
  }
  let pairs = 0, mixed = 0, sameModel = 0;
  const samples: string[] = [];
  for (const [cid, arr] of byConv) {
    arr.sort((a, b) => a.at - b.at);
    for (let i = 1; i < arr.length; i++) {
      const gap = arr[i].at - arr[i - 1].at;
      if (gap > 120_000) continue;             // 2分以内＝同じ1回の生成の中
      pairs++;
      if (arr[i].model !== arr[i - 1].model) {
        mixed++;
        if (samples.length < 8) samples.push(`     ${cid.slice(0, 8)}  ${Math.round(gap / 1000)}秒差  ${arr[i - 1].model} → ${arr[i].model}`);
      } else {
        sameModel++;
        if (samples.length < 8) samples.push(`     ${cid.slice(0, 8)}  ${Math.round(gap / 1000)}秒差  ${arr[i - 1].model} → ${arr[i].model}（同じモデルで2回）`);
      }
    }
  }
  console.log(`   2分以内に本文を2回作った組: ${pairs}組（同じモデル ${sameModel} / 違うモデル ${mixed}）`);
  console.log(`   ※ 最終チェックの指摘後の作り直しは正常。違うモデルが混ざっていたら切り替えの漏れ`);
  for (const s of samples) console.log(s);

  // ④ 最終チェック（検査）はどのモデルか（Claude のままが正しい）
  console.log(`\n=== ④ 最終チェック（検査）のモデル ===`);
  const fc = reply.filter((r) => callKindOf(r) === "最終チェック（検査）" || /その他/.test(callKindOf(r)));
  const fm = new Map<string, { c: number; usd: number; head: string }>();
  for (const r of fc) {
    const k = String(r.model);
    const b = fm.get(k) ?? { c: 0, usd: 0, head: String(r.sys_head ?? "").slice(0, 40) };
    b.c++; b.usd += cost(r); fm.set(k, b);
  }
  for (const [k, v] of [...fm.entries()].sort((a, b) => b[1].c - a[1].c)) {
    console.log(`   ${String(v.c).padStart(5)}回  $${v.usd.toFixed(2).padStart(7)}  ${k}  ${k.startsWith("claude") ? "✅ Claude（JSON強制が要るので正しい）" : "⚠ DeepSeek（JSONスキーマ強制が落ちる）"}`);
  }

  // ⑤ 日別の費用（今回の改善で増えていないか）
  console.log(`\n=== ⑤ /api/generate-reply の日別（JST）— 今回の改善で増えていないか ===`);
  const byDay = new Map<string, { c: number; usd: number; genC: number; genDs: number; inTok: number }>();
  for (const r of reply) {
    const d = new Date(new Date(String(r.created_at)).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    const b = byDay.get(d) ?? { c: 0, usd: 0, genC: 0, genDs: 0, inTok: 0 };
    b.c++; b.usd += cost(r);
    b.inTok += n(r.input_uncached) + n(r.cache_read) + n(r.cache_write_5m) + n(r.cache_write_1h);
    if (callKindOf(r) === "返信の本文を作る") { b.genC++; if (String(r.model).startsWith("deepseek")) b.genDs++; }
    byDay.set(d, b);
  }
  console.log(`   日付        回数   Claude費用   入力トークン   本文生成(うちDeepSeek)`);
  for (const [d, v] of [...byDay.entries()].sort()) {
    console.log(`   ${d}  ${String(v.c).padStart(5)}  $${v.usd.toFixed(2).padStart(8)}  ${(v.inTok / 1e6).toFixed(2).padStart(8)}M  ${String(v.genC).padStart(5)}(${v.genDs})`);
  }

  // ⑤-2 切り替え後だけを見る（切り替えは 2026-09-19）
  console.log(`\n=== ⑤-2 切り替え後（9/19〜）に Claude で本文を作った回の中身 ===`);
  const after = gen.filter((r) => String(r.created_at) >= "2026-09-19");
  const stillClaude = after.filter((r) => String(r.model).startsWith("claude"));
  console.log(`   切り替え後の本文生成 ${after.length}回 / うち Claude ${stillClaude.length}回 (${(stillClaude.length / (after.length || 1) * 100).toFixed(1)}%)`);
  const why = new Map<string, number>();
  for (const r of stillClaude) {
    const k = `env=${r.env} status=${r.status} action=${r.action ?? "(なし)"} conv=${r.conversation_id ? "あり" : "なし"}`;
    why.set(k, (why.get(k) ?? 0) + 1);
  }
  for (const [k, c] of [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`     ${String(c).padStart(4)}回  ${k}`);
  console.log(`   時刻順（最新8件）:`);
  for (const r of stillClaude.slice(0, 8)) {
    console.log(`     ${String(r.created_at).slice(0, 19)}  ${r.model}  ${String(r.conversation_id ?? "").slice(0, 8)}  action=${r.action ?? "-"}  ${n(r.duration_ms)}ms`);
  }

  // ⑤-3 「system なし」の塊は何か（費用の大半を占めている）
  console.log(`\n=== ⑤-3 「system なし」の呼び出しの正体（費用の大半）===`);
  const noSys = reply.filter((r) => !String(r.sys_head ?? ""));
  const ns = new Map<string, { c: number; usd: number; dur: number }>();
  for (const r of noSys) {
    const k = `${r.model} / sys_key=${r.sys_key ?? "なし"}`;
    const b = ns.get(k) ?? { c: 0, usd: 0, dur: 0 };
    b.c++; b.usd += cost(r); b.dur += n(r.duration_ms); ns.set(k, b);
  }
  for (const [k, v] of [...ns.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 10)) {
    console.log(`   ${String(v.c).padStart(5)}回  $${v.usd.toFixed(2).padStart(7)}  平均${Math.round(v.dur / v.c)}ms  ${k}`);
  }
  console.log(`   ※ 最終チェックは system をブロック配列で渡すので sys_head が空になる。`);
  console.log(`     つまりこの塊＝**最終チェックの検査パス**。/api/generate-reply の費用の大半を占めている。`);

  // ⑥ 自動返信の経路（generate-draft-bg-async 経由）も同じか
  console.log(`\n=== ⑥ 自動返信の経路（/api/cron/auto-reply-dispatch・generate-draft-bg-async）===`);
  for (const rt of ["/api/generate-draft-bg-async", "/api/cron/auto-reply-dispatch", "/api/cron/generate-pending-drafts"]) {
    const rr = rows.filter((r) => String(r.route) === rt);
    if (rr.length === 0) { console.log(`   ${rt}: 0件`); continue; }
    const mm = new Map<string, number>();
    for (const r of rr) mm.set(`${callKindOf(r)} ｜ ${r.model}`, (mm.get(`${callKindOf(r)} ｜ ${r.model}`) ?? 0) + 1);
    console.log(`   ${rt}: ${rr.length}件`);
    for (const [k, c] of [...mm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`     ${String(c).padStart(5)}回  ${k}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
