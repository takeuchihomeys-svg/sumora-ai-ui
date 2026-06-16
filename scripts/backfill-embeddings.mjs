/**
 * embeddingが未生成の実例にembeddingを生成してバックフィルする
 * Usage: node scripts/backfill-embeddings.mjs [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/^([^=]+)=["']?(.+?)["']?\s*$/);
      if (m) process.env[m[1].trim()] = m[2].trim();
    }
  } catch { /* 既存の環境変数を使う */ }
}
loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const DRY_RUN      = process.argv.includes("--dry-run");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_KEY が未設定です");
  process.exit(1);
}
if (!OPENAI_KEY) {
  console.error("❌ OPENAI_API_KEY が未設定です（embedding生成に必要）");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getEmbedding(text) {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`  embedding APIエラー: ${res.status} ${err.slice(0, 100)}`);
      return null;
    }
    const data = await res.json();
    return data.data[0]?.embedding ?? null;
  } catch (e) {
    console.error(`  embedding例外: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`🔍 モード: ${DRY_RUN ? "DRY RUN（実際には変更しない）" : "本番実行"}`);
  console.log("─────────────────────────────────────");

  // embedding が null のレコードを全件取得
  let allRecords = [];
  let from = 0;
  const PAGE = 500;
  while (true) {
    const { data, error } = await sb
      .from("ai_reply_examples")
      .select("id, conversation_state, customer_message")
      .is("embedding", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("取得エラー:", error.message); break; }
    if (!data || data.length === 0) break;
    allRecords = allRecords.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`📦 embedding未生成レコード: ${allRecords.length}件`);
  if (allRecords.length === 0) {
    console.log("✅ 全件embedding済み。完了。");
    return;
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < allRecords.length; i++) {
    const rec = allRecords[i];
    const input = `${rec.conversation_state}: ${rec.customer_message}`;
    process.stdout.write(`[${i + 1}/${allRecords.length}] ${rec.id.slice(0, 8)}... `);

    if (DRY_RUN) {
      console.log("(dry-run skip)");
      continue;
    }

    const embedding = await getEmbedding(input);
    if (!embedding) {
      console.log("❌ embedding取得失敗");
      failed++;
      continue;
    }

    const { error } = await sb
      .from("ai_reply_examples")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", rec.id);

    if (error) {
      console.log(`❌ 更新エラー: ${error.message}`);
      failed++;
    } else {
      console.log("✅");
      success++;
    }

    // OpenAI APIのレート制限回避（300ms間隔）
    await new Promise(r => setTimeout(r, 300));
  }

  console.log("\n─────────────────────────────────────");
  if (DRY_RUN) {
    console.log(`🔍 DRY RUN完了: ${allRecords.length}件がバックフィル対象`);
    console.log("  実際に実行: node scripts/backfill-embeddings.mjs");
  } else {
    console.log(`✅ 完了: ${success}件成功、${failed}件失敗`);
  }
}

main().catch(console.error);
