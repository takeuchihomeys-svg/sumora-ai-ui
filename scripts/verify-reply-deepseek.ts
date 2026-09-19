// scripts/verify-reply-deepseek.ts
// 本番の**返信文の生成**を画面と同じ形で叩き、DeepSeek に切り替わっているか・漏れが無いかを確かめる。
//
// 2026-09-19 竹内「これ文の質問題なさそうなら返信の部分も deepseek に切り替えよかな」
//            「設計知見と協力してテストしてみればよいのでは」
//
// 設計知見に従った作り:
//  ・「本番検証は**画面が渡すのと同じ形**で渡す — 形が違うと直す必要のない物を直してしまう」
//    → body は page.tsx の fetch("/api/generate-reply") と同じ（message / customerMessages / state /
//      conversationId / customerName / recentMessages（sender/text/imageUrl/createdAt/isAix））
//  ・「生成文と実送信を同じ整形で突き合わせる」→ phrase-shape で実送信0件の言い回しを数える
//  ・「線を引いたら外れた側の中身を必ず読む」→ 生成文を全文出す
//  ・AIX と違い返信文には**最終チェック**がある。通ったか（block されなかったか）も見る
//
// 実行: npx tsx --env-file=.env.local scripts/verify-reply-deepseek.ts [--times=3]
export {};
import { createClient } from "@supabase/supabase-js";
import { extractPhraseShapes } from "../app/lib/phrase-shape";
import { createMasker } from "../app/lib/pii-pseudonym";

const BASE = process.env.VERIFY_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA（竹内さん本人のテスト会話）
const TIMES = Number(process.argv.find((a) => a.startsWith("--times="))?.slice(8) ?? 3);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) { console.error("Supabase の設定が未設定"); process.exit(2); }
const sb = createClient(url, key);

async function loadSentPhrases(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let page = 0; ; page++) {
    const { data } = await sb.from("messages").select("text")
      .eq("sender", "staff").gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    const rows = (data ?? []) as Array<{ text: string | null }>;
    if (rows.length === 0) break;
    for (const m of rows) for (const p of extractPhraseShapes(m.text ?? "")) counts.set(p.predicate, (counts.get(p.predicate) ?? 0) + 1);
    if (rows.length < 1000) break;
  }
  return counts;
}

async function main() {
  const sentPhrases = await loadSentPhrases();
  console.log(`── 実送信365日の言い回し ${sentPhrases.size} 種類を物差しにする`);

  const { data: conv } = await sb.from("conversations")
    .select("customer_name, status, account, auto_send_enabled").eq("id", CONV).maybeSingle();
  const c = conv as { customer_name: string | null; status: string | null; auto_send_enabled: boolean | null } | null;
  console.log(`   YUMA: 状態=${c?.status} 自動返信=${c?.auto_send_enabled}`);
  if (c?.auto_send_enabled) console.log("   ⚠ 自動返信オン → 歯止めで Claude のままになる（テストにならない）");

  const { data: msgs } = await sb.from("messages")
    .select("sender, text, created_at, is_aix_generated, image_url")
    .eq("conversation_id", CONV).order("created_at", { ascending: true }).limit(400);
  const all = (msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null }>;
  // page.tsx と同じ: 直近25件＋（直近にスタッフ返信が無ければ）最後のスタッフ返信を先頭に
  const last25 = all.slice(-25);
  const hasStaff = last25.some((m) => m.sender === "staff");
  const lastStaff = !hasStaff ? [...all].reverse().find((m) => m.sender === "staff") : undefined;
  const finalMsgs = lastStaff ? [lastStaff, ...last25] : last25;
  const recentMessages = finalMsgs.map((m) => ({
    sender: m.sender, text: m.text || "", imageUrl: m.image_url || undefined,
    createdAt: m.created_at || undefined, isAix: !!m.is_aix_generated,
  }));
  const lastCustomer = [...all].reverse().find((m) => m.sender === "customer");
  const targetMessage = lastCustomer?.text || "ありがとうございます！";
  console.log(`   直近 ${recentMessages.length} 通 / お客様の最新: ${JSON.stringify(targetMessage.slice(0, 44))}\n`);

  const summary: Array<{ n: number; model: string; len: number; phrases: number; unseen: number; ms: number; hit: number; miss: number; blocked: boolean }> = [];

  for (let i = 1; i <= TIMES; i++) {
    console.log(`═══════ ${i} 回目 ═══════`);
    const before = new Date(Date.now() - 5_000).toISOString();
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/generate-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: targetMessage,
        state: c?.status ?? "proposing",
        conversationId: CONV,
        customerName: c?.customer_name,
        hasViewed: false,
        activeTaskTypes: [],
        recentMessages,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Date.now() - t0;
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (!res.ok) { console.error(`  ⚠ HTTP ${res.status}: ${raw.slice(0, 300)}\n`); continue; }
    if (ct.includes("application/json")) {
      const j = JSON.parse(raw) as { skipped?: boolean; reason?: string; error?: string };
      console.log(`  ${j.skipped ? `－ スキップ（${j.reason}）` : `⚠ ${j.error}`}\n`);
      continue;
    }
    // SSE（本文は data: の行に少しずつ届く）
    let text = "";
    let blocked = false;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try {
        const j = JSON.parse(d) as { text?: string; delta?: string; content?: string; finalCheck?: { blocked?: boolean } };
        text += j.text ?? j.delta ?? j.content ?? "";
        if (j.finalCheck?.blocked) blocked = true;
      } catch { /* 本文以外のイベント */ }
    }
    if (!text) text = raw.replace(/^data:\s*/gm, "").trim();   // 形が違っても中身は見る

    console.log(`  ${ms}ms / ${text.length}字`);
    console.log("━━━━━━ 生成された文 ━━━━━━");
    console.log(text.slice(0, 600));
    console.log("━━━━━━━━━━━━━━━━━━━\n");

    // ── 漏れの点検 ──
    const name = (c?.customer_name ?? "").trim();
    const m = createMasker({ conversationId: CONV, customerName: name });
    m.mask(`${name}さん`);
    const fakes = m.table().map((e) => e.fake);
    const left = fakes.filter((f) => text.includes(f) || text.includes(f.slice(0, 2)));
    console.log(`  ${left.length === 0 ? "✅" : "⚠"} 仮名の残り: ${left.length === 0 ? "なし" : left.join(", ")}`);
    console.log(`  ${name && text.includes(name) ? "✅" : "－"} お客様の名前（${name}）が本文にある`);
    console.log(`  ${/090-0000-|sample\d+@example\.com/.test(text) ? "⚠" : "✅"} 仮の電話・メールが混ざっていない`);
    console.log(`  ${/^\s*[-*#]|⚠|確認事項：/m.test(text) ? "⚠" : "✅"} 作業メモ・箇条書きが混ざっていない`);
    console.log(`  ${/(お待たせ致しました|お待たせしました)/.test(text) ? "⚠" : "✅"} 禁止語「お待たせ致しました」が無い`);

    const shapes = extractPhraseShapes(text);
    const unseen = shapes.filter((s) => (sentPhrases.get(s.predicate) ?? 0) === 0);
    console.log(`  ${unseen.length === 0 ? "✅" : "⚠"} 実送信0件の言い回し: ${unseen.length}件 / 全${shapes.length}件`);
    for (const u of unseen.slice(0, 4)) console.log(`     0件: ${JSON.stringify(u.clause)}`);

    // ── どのモデルで作られたか ──
    await new Promise((r) => setTimeout(r, 4000));
    const { data: logs } = await sb.from("llm_usage_logs")
      .select("created_at, action, model, status, input_uncached, cache_read, output_tokens, duration_ms, sys_head")
      .gte("created_at", before).order("created_at", { ascending: true }).limit(20);
    const rows = (logs ?? []) as Array<Record<string, unknown>>;
    const gen = rows.filter((r) => String(r.sys_head ?? "").includes("ハードゲート") || r.action === "reply_generate");
    console.log(`\n  この生成で走った LLM 呼び出し ${rows.length} 件:`);
    for (const r of rows) console.log(`    ${String(r.action ?? "-").padEnd(18)} ${String(r.model).padEnd(26)} 新規=${r.input_uncached} 一致=${r.cache_read} 出力=${r.output_tokens}`);
    const ds = gen.filter((r) => String(r.model).includes("deepseek"));
    const pick = ds[0] ?? gen[0];
    const hit = Number(pick?.cache_read ?? 0), miss = Number(pick?.input_uncached ?? 0);
    if (gen.length === 0) console.log("  ⚠ 返信生成の呼び出しが記録されていない");
    else if (ds.length > 0) console.log(`  ✅ DeepSeek で作られている（${ds[0].model}）キャッシュ ${hit + miss > 0 ? Math.round((100 * hit) / (hit + miss)) : 0}%`);
    else console.log(`  － まだ Claude（${gen[0].model}）`);
    console.log("");
    summary.push({ n: i, model: String(pick?.model ?? "-"), len: text.length, phrases: shapes.length, unseen: unseen.length, ms, hit, miss, blocked });
  }

  console.log("━━━━━━━━━━ まとめ ━━━━━━━━━━");
  console.log("回  モデル           文字  言回 0件 キャッシュ  速度");
  for (const s of summary) {
    const mark = s.model.includes("deepseek") ? "✅" : "－";
    const cache = s.hit + s.miss > 0 ? `${Math.round((100 * s.hit) / (s.hit + s.miss))}%`.padStart(4) : "   -";
    console.log(`${mark}${s.n}  ${s.model.replace("claude-", "C-").replace("deepseek-", "DS-").padEnd(14)} ${String(s.len).padStart(4)}  ${String(s.phrases).padStart(3)} ${String(s.unseen).padStart(3)} ${cache}  ${String(s.ms).padStart(6)}ms`);
  }
  const ds = summary.filter((s) => s.model.includes("deepseek"));
  console.log(`\n  DeepSeek で作られた: ${ds.length}/${summary.length}　実送信0件の言い回し（創作）合計: ${summary.reduce((a, s) => a + s.unseen, 0)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
