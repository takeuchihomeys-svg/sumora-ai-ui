/**
 * 分割送信マージバッチ
 * 90秒以内に同じcustomer_message + conversation_stateで送られたレコードを1件に結合する
 * Usage: node scripts/merge-split-replies.mjs [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";

// .env.local から読み込む（または環境変数で直接渡す）
import { readFileSync } from "fs";
import { resolve } from "path";
function loadEnv() {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/^([^=]+)=["']?(.+?)["']?\s*$/);
      if (m) process.env[m[1].trim()] = m[2].trim();
    }
  } catch { /* .env.localがなければ既存の環境変数を使う */ }
}
loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_KEY が未設定です");
  process.exit(1);
}
const DRY_RUN       = process.argv.includes("--dry-run");
const WINDOW_MS     = 90 * 1000; // 90秒

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getEmbedding(text) {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data[0]?.embedding ?? null;
  } catch { return null; }
}

async function main() {
  console.log(`🔍 モード: ${DRY_RUN ? "DRY RUN（実際には変更しない）" : "本番実行"}`);
  console.log("─────────────────────────────────────");

  // 全レコードを古い順で取得（ページネーション対応）
  let allRecords = [];
  let from = 0;
  const PAGE = 500;
  while (true) {
    const { data, error } = await sb
      .from("ai_reply_examples")
      .select("id, customer_message, conversation_state, sent_reply, is_starred, created_at")
      .not("customer_message", "in", '("[画像]","[動画]")')  // 画像・動画は除外
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("取得エラー:", error.message); break; }
    if (!data || data.length === 0) break;
    allRecords = allRecords.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`📦 対象レコード: ${allRecords.length}件`);

  // グループ化: (customer_message, conversation_state) + 90秒以内
  const groups = []; // [{base: record, extras: [record, ...]}]
  const processed = new Set();

  for (let i = 0; i < allRecords.length; i++) {
    if (processed.has(allRecords[i].id)) continue;
    const base = allRecords[i];
    const baseTime = new Date(base.created_at).getTime();
    const group = { base, extras: [] };

    for (let j = i + 1; j < allRecords.length; j++) {
      if (processed.has(allRecords[j].id)) continue;
      const cand = allRecords[j];
      const candTime = new Date(cand.created_at).getTime();
      // 90秒超えたら以降は対象外（時系列順なので）
      if (candTime - baseTime > WINDOW_MS) break;
      if (
        cand.customer_message === base.customer_message &&
        cand.conversation_state === base.conversation_state
      ) {
        group.extras.push(cand);
        processed.add(cand.id);
      }
    }

    if (group.extras.length > 0) {
      groups.push(group);
    }
    processed.add(base.id);
  }

  console.log(`🔗 マージ対象グループ: ${groups.length}件`);
  if (groups.length === 0) {
    console.log("✅ マージ対象なし。完了。");
    return;
  }

  let merged = 0;
  let deleted = 0;
  let errors = 0;

  for (const { base, extras } of groups) {
    const mergedReply = [base.sent_reply, ...extras.map(e => e.sent_reply)].join("\n");
    const isStarred = base.is_starred || extras.some(e => e.is_starred);

    const preview = mergedReply.replace(/\n/g, " ↵ ").slice(0, 80);
    console.log(`\n[マージ] ${base.id.slice(0, 8)}... + ${extras.length}件`);
    console.log(`  状態: ${base.conversation_state}`);
    console.log(`  結合後: "${preview}..."`);
    console.log(`  削除するID: ${extras.map(e => e.id.slice(0, 8)).join(", ")}`);

    if (!DRY_RUN) {
      // embeddingを再生成
      const embeddingInput = `${base.conversation_state}: ${base.customer_message}`;
      const embedding = await getEmbedding(embeddingInput);

      const updatePayload = {
        sent_reply: mergedReply,
        is_starred: isStarred,
      };
      if (embedding) updatePayload.embedding = JSON.stringify(embedding);

      const { error: updateErr } = await sb
        .from("ai_reply_examples")
        .update(updatePayload)
        .eq("id", base.id);

      if (updateErr) {
        console.error(`  ❌ 更新エラー: ${updateErr.message}`);
        errors++;
        continue;
      }

      // 余分なレコードを削除
      for (const extra of extras) {
        const { error: delErr } = await sb
          .from("ai_reply_examples")
          .delete()
          .eq("id", extra.id);
        if (delErr) {
          console.error(`  ❌ 削除エラー (${extra.id}): ${delErr.message}`);
          errors++;
        } else {
          deleted++;
        }
      }
      merged++;
      console.log(`  ✅ 完了`);

      // レート制限回避
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log("\n─────────────────────────────────────");
  if (DRY_RUN) {
    console.log(`🔍 DRY RUN完了: ${groups.length}グループがマージ対象（実際には変更なし）`);
    console.log("  実際に実行する場合: node scripts/merge-split-replies.mjs");
  } else {
    console.log(`✅ 完了: ${merged}グループをマージ、${deleted}件を削除、エラー: ${errors}件`);
  }
}

main().catch(console.error);
