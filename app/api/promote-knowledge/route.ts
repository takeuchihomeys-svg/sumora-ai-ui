import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const PROMPTS_PATH = path.join(process.cwd(), "app/lib/line-reply-prompts.ts");
const MIN_USED_COUNT = 10;

async function callHaiku(prompt: string): Promise<string> {
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content[0].type === "text" ? res.content[0].text.trim() : "";
}

export async function POST() {
  const phases: Array<"first_reply" | "hearing" | "proposing" | "applying"> = [
    "first_reply", "hearing", "proposing", "applying",
  ];

  let fileContent = await fs.readFile(PROMPTS_PATH, "utf-8");
  const backup = fileContent;

  let totalAdded = 0;
  const report: { phase: string; rules: string[] }[] = [];

  for (const phase of phases) {
    // 上位ルールを取得（used_count >= MIN_USED_COUNT）
    const { data: topRules } = await supabase
      .from("ai_reply_knowledge")
      .select("title, content, used_count")
      .eq("conversation_state", phase)
      .gte("used_count", MIN_USED_COUNT)
      .order("used_count", { ascending: false })
      .limit(8);

    if (!topRules || topRules.length === 0) continue;

    // 現在のフェーズセクションを抽出（カバー済み判定用）
    const phaseStart = fileContent.indexOf(`  ${phase}: \``);
    if (phaseStart === -1) continue;
    const forbiddenMarker = `【🚫 ${phase} フェーズ 絶対禁止ルール】`;
    const forbiddenIdx = fileContent.indexOf(forbiddenMarker, phaseStart);
    if (forbiddenIdx === -1) continue;

    const currentPhaseContent = fileContent.slice(phaseStart, forbiddenIdx);

    // Claudeでカバー済みフィルタリング＋PHASE_GUIDE形式にフォーマット
    const response = await callHaiku(`あなたは賃貸仲介LINEのAIプロンプト管理者です。

【現在のPHASE_GUIDE（${phase}フェーズ）】
${currentPhaseContent.slice(0, 3000)}

【学習済みルール候補（used_count順）】
${topRules.map((r, i) => `${i + 1}. [${r.used_count}回] ${r.title}\n${r.content}`).join("\n\n---\n")}

タスク：
① 現在のPHASE_GUIDEにまだ明示されていないルールを最大2件選ぶ（already covered → スキップ）
② PHASE_GUIDEの書き方でフォーマットする

PHASE_GUIDEの形式例：
【パターン〇〇】〜の場合（★重要）
→ 具体的な行動指示
→ 例: 「かしこまりました！！〇〇さん...！！」

既にカバー済み・ニュアンスが重複するものはスキップ。追加候補がなければadditions=[]でOK。

JSONのみ返す：{"additions":[{"title":"ルール名","formatted":"フォーマット済みテキスト（改行含む）"}]}`);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;

    let additions: { title: string; formatted: string }[] = [];
    try {
      additions = (JSON.parse(jsonMatch[0]) as { additions: { title: string; formatted: string }[] }).additions ?? [];
    } catch { continue; }

    if (additions.length === 0) continue;

    // 禁止ルールの直前に挿入
    const insertText = "\n" + additions.map((a) => a.formatted).join("\n\n") + "\n";
    fileContent =
      fileContent.slice(0, forbiddenIdx) +
      insertText +
      "\n" +
      fileContent.slice(forbiddenIdx);

    totalAdded += additions.length;
    report.push({ phase, rules: additions.map((a) => a.title) });
  }

  if (totalAdded === 0) {
    return NextResponse.json({ ok: true, added: 0, message: "追加候補なし（全ルール既にカバー済み）" });
  }

  // 型チェック（失敗時はロールバック）
  await fs.writeFile(PROMPTS_PATH, fileContent, "utf-8");
  try {
    await execAsync("npx tsc --noEmit", { cwd: process.cwd() });
  } catch (e) {
    await fs.writeFile(PROMPTS_PATH, backup, "utf-8");
    return NextResponse.json({ ok: false, error: "型チェック失敗・ロールバック済み", details: String(e) }, { status: 500 });
  }

  // git commit & push
  const ruleNames = report.flatMap((r) => r.rules).join("・");
  try {
    await execAsync(
      `git add app/lib/line-reply-prompts.ts && git commit -m "auto: PHASE_GUIDE自動昇格（${totalAdded}件）${ruleNames ? " - " + ruleNames : ""}" && git push`,
      { cwd: process.cwd() }
    );
  } catch {
    // commit失敗は無視（ファイルは保存済み）
  }

  return NextResponse.json({ ok: true, added: totalAdded, report });
}
