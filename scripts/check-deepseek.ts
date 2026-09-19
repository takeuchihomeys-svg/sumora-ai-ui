// scripts/check-deepseek.ts
// DeepSeek 本家 API の疎通・モデル名・プロンプトキャッシュを**実際に呼んで**確かめる。
//
// 2026-09-19 竹内「deepsheekのAPIとりいれる／プロンプトキャッシュも使う／モデルはV4.1を使う」
//   ドキュメントの記述だけで「効くはず」と書かない（設計知見「実データで線を引く」）。
//   同じ前置きで2回呼び、2回目に prompt_cache_hit_tokens が付くかを見る。
//
// 実行: npx tsx --env-file=.env.local scripts/check-deepseek.ts
export {};
import { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL, toOpenAIBody, fromOpenAIResponse } from "../app/lib/llm-alt-provider";

const key = process.env.DEEPSEEK_API_KEY;
if (!key) { console.error("DEEPSEEK_API_KEY が未設定（--env-file=.env.local）"); process.exit(2); }

const model = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? DEEPSEEK_DEFAULT_MODEL;

// キャッシュは「前置きの一致」で効くので、長めの固定の前置きを作る（1024トークン以上ないと効かないことがある）
const FIXED_PREFIX = Array.from({ length: 120 }, (_, i) =>
  `${i + 1}. 賃貸仲介のLINE接客で守ること: お客様への返信は簡潔に、事実だけを書き、決まっていないことは断定しない。`
).join("\n");

async function call(userText: string) {
  // 本番と同じ変換を通す（ここで形がズレていると本番だけ落ちる）
  const body = toOpenAIBody({
    system: [{ type: "text", text: `あなたは賃貸仲介のアシスタントです。\n${FIXED_PREFIX}` }],
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    max_tokens: 64,
  } as Parameters<typeof toOpenAIBody>[0], model);
  if (!body) throw new Error("toOpenAIBody が null（変換の対象外）");

  const t0 = Date.now();
  const res = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as Parameters<typeof fromOpenAIResponse>[0] & { model?: string };
  const conv = fromOpenAIResponse(json, model) as { content: Array<{ text: string }>; usage: Record<string, number> };
  return { json, conv, ms };
}

async function main() {
  console.log(`── DeepSeek 疎通確認  model=${model}`);
  try {
    const a = await call("内覧希望のお客様に返す一文を作ってください。");
    console.log(`\n① 1回目  ${a.ms}ms`);
    console.log(`  返ってきたモデル名: ${a.json.model ?? "(なし)"}`);
    console.log(`  本文: ${a.conv.content[0]?.text?.slice(0, 60)}`);
    console.log(`  usage: 一致=${a.json.usage?.prompt_cache_hit_tokens ?? "-"} 不一致=${a.json.usage?.prompt_cache_miss_tokens ?? "-"} 出力=${a.json.usage?.completion_tokens ?? "-"}`);

    const b = await call("内覧希望のお客様に返す一文を、別の言い方で作ってください。");
    console.log(`\n② 2回目（前置きは同じ）  ${b.ms}ms`);
    console.log(`  usage: 一致=${b.json.usage?.prompt_cache_hit_tokens ?? "-"} 不一致=${b.json.usage?.prompt_cache_miss_tokens ?? "-"} 出力=${b.json.usage?.completion_tokens ?? "-"}`);

    const hit = b.json.usage?.prompt_cache_hit_tokens ?? 0;
    console.log(`\n── プロンプトキャッシュ`);
    console.log(hit > 0
      ? `  ✅ 効いています（2回目で ${hit} トークンが一致）`
      : `  ⚠ 2回目も一致 0。前置きが短い・キャッシュがまだ作られていない等の可能性（数分後に再実行して確認）`);

    console.log(`\n── llm_usage_logs にどう記録されるか（変換後）`);
    console.log(`  input_tokens=${b.conv.usage.input_tokens} cache_read=${b.conv.usage.cache_read_input_tokens} output=${b.conv.usage.output_tokens}`);
    console.log(`\n結果: ✅ 疎通 OK`);
  } catch (e) {
    console.error(`\n結果: ⚠ 失敗 — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

main();
