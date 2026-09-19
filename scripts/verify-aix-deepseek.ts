// scripts/verify-aix-deepseek.ts
// 本番の AIX を**画面と同じ形**で叩き、DeepSeek に切り替わっているか・漏れが無いかを確かめる。
//
// 2026-09-19 竹内「テストお願い / 設計知見と協力して漏れがないか」
//
// 設計知見に従った作り:
//  ・「本番検証は**画面が渡すのと同じ形**で渡す — 形が違うと直す必要のない物を直してしまう」
//    → body は AixModal.tsx の組み立て（action/account/conversation_id/customer_name/recent_messages）、
//      recent_messages は page.tsx の aixRecentMessages（sender/text/rawCreatedAt/isAix/imageUrl）と同じ形
//  ・「書き込みを伴う本番の確認はテスト用の会話 YUMA で行う」→ 既定は YUMA（生成のみ・送信はしない）
//  ・「線を引いたら外れた側の中身を必ず読む」→ 生成文を全文出す
//
// 実行: npx tsx --env-file=.env.local scripts/verify-aix-deepseek.ts [--action=property_recommendation]
export {};
import { createClient } from "@supabase/supabase-js";
import { createMasker } from "../app/lib/pii-pseudonym";
import { extractPhraseShapes } from "../app/lib/phrase-shape";

const BASE = process.env.VERIFY_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA（竹内さん本人のテスト会話）
// --action=a,b,c で複数を順に叩ける（竹内「AIXの全部切り替える形で」）
const ACTIONS = (process.argv.find((a) => a.startsWith("--action="))?.slice(9) ?? "property_recommendation")
  .split(",").map((s) => s.trim()).filter(Boolean);

/**
 * 実送信365日の言い回し（述部 → 件数）。
 * 設計知見「生成文と実送信を同じ整形で突き合わせる」= 0件なら**こちらが一度も使ったことのない言い方**。
 * 竹内「元々の文通りできてるか注意して」を数字で見るための物差し。
 */
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) { console.error("Supabase の設定が未設定"); process.exit(2); }
const sb = createClient(url, key);

type Msg = { sender: string; text: string; rawCreatedAt: string; isAix: boolean; imageUrl: string | null };

async function main() {
  const sentPhrases = await loadSentPhrases();
  console.log(`── 実送信365日の言い回し ${sentPhrases.size} 種類を物差しにする`);
  const summary: Array<{ action: string; ok: boolean; model: string; note: string; unseen: number; phrases: number; len: number; ms: number; hit: number; miss: number }> = [];
  for (const ACTION of ACTIONS) {
    try { await runOne(ACTION, sentPhrases, summary); }
    catch (e) { console.error(`  ⚠ ${ACTION} 失敗: ${e instanceof Error ? e.message : e}\n`); summary.push({ action: ACTION, ok: false, model: "-", note: String(e instanceof Error ? e.message : e).slice(0, 60), unseen: 0, phrases: 0, len: 0, ms: 0, hit: 0, miss: 0 }); }
  }
  console.log("\n━━━━━━━━━━ まとめ ━━━━━━━━━━");
  console.log("AIX                       モデル        文字  言回 0件 キャッシュ  速度");
  for (const s of summary) {
    const mark = s.ok ? (s.model.includes("deepseek") ? "✅" : "－") : "⚠";
    const cache = s.hit + s.miss > 0 ? `${Math.round((100 * s.hit) / (s.hit + s.miss))}%`.padStart(4) : "   -";
    console.log(`${mark} ${s.action.padEnd(22)} ${(s.model || "-").replace("claude-", "C-").replace("deepseek-", "DS-").padEnd(12)} ${String(s.len).padStart(4)}  ${String(s.phrases).padStart(3)} ${String(s.unseen).padStart(3)} ${cache}  ${String(s.ms).padStart(6)}ms${s.note ? "  " + s.note : ""}`);
  }
  const ds = summary.filter((s) => s.model.includes("deepseek"));
  const ng = summary.filter((s) => !s.ok);
  const unseen = ds.reduce((a, s) => a + s.unseen, 0);
  console.log(`\n  DeepSeek で作られた: ${ds.length}/${summary.length}　エラー: ${ng.length}　実送信0件の言い回し（創作）: ${unseen}`);
}

async function runOne(
  ACTION: string,
  sentPhrases: Map<string, number>,
  summary: Array<{ action: string; ok: boolean; model: string; note: string; unseen: number; phrases: number; len: number; ms: number; hit: number; miss: number }>,
) {
  console.log(`\n═══════ ${ACTION} ═══════`);

  const { data: conv } = await sb.from("conversations")
    .select("customer_name, status, account, auto_send_enabled").eq("id", CONV).maybeSingle();
  const c = conv as { customer_name: string | null; status: string | null; account: string | null; auto_send_enabled: boolean | null } | null;
  console.log(`  状態=${c?.status} 自動返信=${c?.auto_send_enabled} アカウント=${c?.account} 名前=${c?.customer_name}`);

  // 画面（page.tsx aixRecentMessages）と同じ形・同じ件数（直近20件）
  const { data: msgs } = await sb.from("messages")
    .select("sender, text, created_at, is_aix_generated, image_url")
    .eq("conversation_id", CONV).order("created_at", { ascending: true }).limit(400);
  const all = (msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null }>;
  const recent: Msg[] = all.slice(-20).map((m) => ({
    sender: m.sender, text: m.text || "", rawCreatedAt: m.created_at,
    isAix: !!m.is_aix_generated, imageUrl: m.image_url,
  }));
  console.log(`  直近の会話 ${recent.length} 通（一番新しい: ${JSON.stringify((recent.at(-1)?.text ?? "").slice(0, 40))}）`);

  const before = new Date(Date.now() - 5_000).toISOString();

  // AixModal.tsx と同じ body
  const body: Record<string, unknown> = {
    action: ACTION,
    account: c?.account ?? "sumora",
    conversation_id: CONV,
    customer_name: c?.customer_name,
    recent_messages: recent,
  };

  // 物件オススメ・入居日確認は物件資料の画像が必須（route.ts「物件資料画像が必要です」）。
  // 画面ではスタッフが貼るので、検証では実データの間取り図を1枚借りる（--image= で指定も可）
  if (["property_recommendation", "property_check_result"].includes(ACTION)) {
    const given = process.argv.find((a) => a.startsWith("--image="))?.slice(8);
    if (given) body.image_url = given;
    else {
      const { data: img } = await sb.from("messages")
        .select("image_url").eq("image_type", "floor_plan").not("image_url", "is", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const u = (img as { image_url?: string } | null)?.image_url;
      if (!u) { console.error("⚠ 物件資料の画像が見つからない（--image=URL で指定してください）"); process.exit(1); }
      body.image_url = u;
      console.log(`  物件資料の画像: ${u.slice(-28)}（実データから借用）`);
    }
  }

  console.log(`\n── 生成中…（${BASE}/api/aix/action）`);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/aix/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },   // ndjson を付けない＝1本の JSON で返る
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - t0;
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
  let out: { ok?: boolean; message_text?: string; error?: string } = {};
  try { out = JSON.parse(raw); } catch { throw new Error(`JSON ではない応答: ${raw.slice(0, 150)}`); }
  if (out.error) throw new Error(out.error);

  const text = out.message_text ?? "";
  console.log(`  ${ms}ms / ${text.length}字\n`);
  console.log("━━━━━━ 生成された文（全文）━━━━━━");
  console.log(text);
  console.log("━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── 漏れの点検 ────────────────────────────────────────────
  console.log("── 漏れの点検");
  const name = (c?.customer_name ?? "").trim();
  const m = createMasker({ conversationId: CONV, customerName: name });
  m.mask(`${name}さん`);                       // この会話でどの仮名が割り当たるかを再現
  const fakes = m.table().map((e) => e.fake);
  const leftFakes = fakes.filter((f) => text.includes(f) || text.includes(f.slice(0, 2)));
  console.log(`  ${leftFakes.length === 0 ? "✅" : "⚠"} 仮名の残り: ${leftFakes.length === 0 ? "なし" : leftFakes.join(", ")}`);
  console.log(`  ${name && text.includes(name) ? "✅" : "－"} お客様の名前（${name}）が本文にある: ${text.includes(name)}`);
  console.log(`  ${/(山田太郎|佐藤花子|鈴木一郎|高橋直美|田中健太|伊藤美咲|渡辺大輔|中村七海|小林拓也|加藤陽子|吉田翔太|山本結衣|松本和也|井上彩香|木村涼介)/.test(text) ? "⚠" : "✅"} 仮名の名前が混ざっていない`);
  console.log(`  ${/090-0000-|sample\d+@example\.com|1990年\d+月1日生/.test(text) ? "⚠" : "✅"} 仮の電話・メール・生年月日が混ざっていない`);
  console.log(`  ${text.includes("[お申込み情報を受け取りました") ? "⚠" : "✅"} 申込の置き換え文が混ざっていない`);
  console.log(`  ${/^\s*[-*#]|⚠|確認事項：/m.test(text) ? "⚠" : "✅"} 作業メモ・箇条書きが混ざっていない`);

  // ── 元々の文体どおりか（竹内「元々の文通りできてるか注意して」）──────────
  // 設計知見「その言い回しがスタッフ実送信に何件あるか。0件なら創作」
  const shapes = extractPhraseShapes(text);
  const unseen = shapes.filter((s) => (sentPhrases.get(s.predicate) ?? 0) === 0);
  console.log(`\n── 元々の文体どおりか（実送信365日と突き合わせ）`);
  console.log(`  ${unseen.length === 0 ? "✅" : "⚠"} 実送信0件の言い回し: ${unseen.length}件 / 全${shapes.length}件`);
  for (const u of unseen.slice(0, 4)) console.log(`     0件: ${JSON.stringify(u.clause)}`);
  const top = shapes.filter((s) => (sentPhrases.get(s.predicate) ?? 0) > 0)
    .sort((a, b) => (sentPhrases.get(b.predicate) ?? 0) - (sentPhrases.get(a.predicate) ?? 0)).slice(0, 3);
  for (const s of top) console.log(`     実送信${sentPhrases.get(s.predicate)}件: 「${s.predicate}」`);
  console.log(`  ${/！！/.test(text) ? "✅" : "⚠"} スモラの「！！」がある`);
  console.log(`  ${/(お待たせ致しました|お待たせしました)/.test(text) ? "⚠" : "✅"} 禁止語「お待たせ致しました」が無い`);

  // ── どのモデルで作られたか ───────────────────────────────
  await new Promise((r) => setTimeout(r, 4000)); // 使用量の記録は応答後に書かれる
  const { data: logs } = await sb.from("llm_usage_logs")
    .select("created_at, action, model, status, input_uncached, cache_read, cache_write, output_tokens, duration_ms")
    .gte("created_at", before).order("created_at", { ascending: true }).limit(20);
  const rows = (logs ?? []) as Array<Record<string, unknown>>;
  console.log(`\n── この生成で走った LLM 呼び出し（${rows.length}件）`);
  for (const r of rows) {
    const t = new Date(String(r.created_at)).toLocaleTimeString("ja-JP");
    console.log(`  ${t} ${String(r.action ?? "(なし)").padEnd(24)} ${String(r.model).padEnd(26)} 新規=${r.input_uncached} 一致=${r.cache_read} 出力=${r.output_tokens} ${r.duration_ms}ms`);
  }
  const target = rows.filter((r) => r.action === ACTION);
  const ds = target.filter((r) => String(r.model).includes("deepseek"));
  const pick = ds[0] ?? target[0];
  const hit = Number(pick?.cache_read ?? 0), miss = Number(pick?.input_uncached ?? 0);
  console.log(`\n── 切り替えの結果`);
  if (target.length === 0) console.log(`  ⚠ ${ACTION} の呼び出しが記録されていない`);
  else if (ds.length > 0) {
    console.log(`  ✅ DeepSeek に切り替わっている（model=${ds[0].model}）`);
    console.log(`  プロンプトキャッシュ: 一致 ${hit} / 新規 ${miss} = ${hit + miss > 0 ? Math.round((100 * hit) / (hit + miss)) : 0}%`);
  } else {
    console.log(`  － まだ Claude（model=${target[0].model}）＝画像を使う経路は対象外なので正常`);
  }
  summary.push({
    action: ACTION, ok: true, model: String(pick?.model ?? "-"), note: "",
    unseen: unseen.length, phrases: shapes.length, len: text.length, ms, hit, miss,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
