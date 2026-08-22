import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 120;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 30_000 });

const GITHUB_REPO = "takeuchihomeys-svg/sumora-ai-ui";

// アーキテクチャ・設計変更を示すキーワード（コミットメッセージで判定）
const ARCH_KEYWORDS = ["refactor", "feat:", "redesign", "layer", "cache", "rag", "aix", "brain", "prompt", "architecture", "廃止", "統合", "刷新", "設計"];

async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY.replace(/\s/g, ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = { embedded: 0, extracted: 0, skipped: 0, errors: [] as string[] };

  // ── Phase 1: NULL embedding の補完 ──────────────────────────────────────────
  // system_design_thinking で embedding が未生成の行にOpenAI embeddingを付与する。
  // RAG検索（match_design_thinking）が効くようになる。
  {
    const { data: nullRows } = await supabase
      .from("system_design_thinking")
      .select("id, title, insight, rationale")
      .is("embedding", null)
      .limit(20);

    for (const row of nullRows ?? []) {
      const input = [row.title as string, row.insight as string, row.rationale as string]
        .filter(Boolean)
        .join("\n");
      const emb = await generateEmbedding(input);
      if (emb) {
        const { error } = await supabase
          .from("system_design_thinking")
          .update({ embedding: emb })
          .eq("id", row.id as string);
        if (error) results.errors.push(`embed ${row.id}: ${error.message}`);
        else results.embedded++;
      }
    }
  }

  // ── Phase 2: GitHub コミット分析 → 設計思考の自動抽出 ────────────────────
  // 直近25時間のコミットを読み、アーキテクチャ・設計変更に見えるものを
  // Haikuで分析してsystem_design_thinkingにINSERTする。
  if (!process.env.GITHUB_TOKEN) {
    console.log("[learn-design-thinking] GITHUB_TOKEN未設定 → Phase2スキップ");
    return NextResponse.json({ ...results, phase2: "skipped: no GITHUB_TOKEN" });
  }

  const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  let commits: Array<{ sha: string; commit: { message: string } }> = [];
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/commits?since=${since}&per_page=20`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );
    if (res.ok) commits = await res.json() as typeof commits;
  } catch (e) {
    results.errors.push(`GitHub commits fetch: ${String(e)}`);
  }

  for (const commit of commits) {
    const msg = commit.commit.message;
    const msgLower = msg.toLowerCase();

    // アーキテクチャ変更キーワードが含まれるコミットのみ対象
    if (!ARCH_KEYWORDS.some((kw) => msgLower.includes(kw))) {
      results.skipped++;
      continue;
    }

    // コミット詳細（diff）を取得
    let changedFiles = "";
    let diffSample = "";
    try {
      const detailRes = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/commits/${commit.sha}`,
        {
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );
      if (detailRes.ok) {
        const detail = await detailRes.json() as {
          files?: Array<{ filename: string; additions: number; deletions: number; patch?: string }>;
        };
        const files = detail.files ?? [];
        changedFiles = files.map((f) => f.filename).join(", ");
        // 変更量最大のファイルのdiffを代表サンプルとして使う
        const biggestFile = files.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))[0];
        diffSample = (biggestFile?.patch ?? "").slice(0, 800);
      }
    } catch {
      results.skipped++;
      continue;
    }

    // 同一 applied_to で直近2日以内に既存エントリがあればスキップ（重複防止）
    const { count } = await supabase
      .from("system_design_thinking")
      .select("id", { count: "exact", head: true })
      .ilike("applied_to", `%${changedFiles.slice(0, 80)}%`)
      .gte("created_at", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
    if ((count ?? 0) > 0) {
      results.skipped++;
      continue;
    }

    // Haikuで設計思考を抽出
    type ExtractionResult = {
      is_design_insight: boolean;
      title: string;
      category: "architecture" | "prompt_engineering" | "data_model" | "ux" | "performance" | "ai_design";
      insight: string;
      rationale: string;
    };

    let extracted: ExtractionResult | null = null;
    try {
      const resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content:
              `以下のgitコミットから設計思考・アーキテクチャ知識を抽出してください。\n\n` +
              `コミットメッセージ:\n${msg.slice(0, 500)}\n\n` +
              `変更ファイル: ${changedFiles.slice(0, 200)}\n\n` +
              `diff（代表）:\n${diffSample}\n\n` +
              `設計上の判断・パターン・知見が読み取れる場合のみis_design_insight:trueにしてください。\n` +
              `単純なバグ修正・テキスト変更・設定変更はfalseです。\n\n` +
              `出力形式（JSONのみ）:\n` +
              `{"is_design_insight":true,"title":"30字以内のタイトル","category":"architecture","insight":"何をどう変えたか（100字以内）","rationale":"なぜそうしたか（80字以内）"}`,
          },
        ],
      });
      const text = ((resp.content[0] as { text: string }).text ?? "").trim();
      const match = text.match(/\{[\s\S]+\}/);
      if (match) extracted = JSON.parse(match[0]) as ExtractionResult;
    } catch {
      results.errors.push(`haiku extract ${commit.sha.slice(0, 7)}: failed`);
      continue;
    }

    if (!extracted?.is_design_insight) {
      results.skipped++;
      continue;
    }

    // embedding生成 → INSERT
    const embInput = [extracted.title, extracted.insight, extracted.rationale].filter(Boolean).join("\n");
    const emb = await generateEmbedding(embInput);

    const { error } = await supabase.from("system_design_thinking").insert({
      title: extracted.title,
      category: extracted.category ?? "architecture",
      insight: extracted.insight,
      rationale: extracted.rationale,
      context: `GitHubコミット ${commit.sha.slice(0, 7)} から自動抽出。${new Date().toISOString().slice(0, 10)}`,
      applied_to: changedFiles.slice(0, 300),
      tags: ["auto-extracted", "git-commit"],
      embedding: emb ?? null,
    });

    if (error) results.errors.push(`insert ${commit.sha.slice(0, 7)}: ${error.message}`);
    else results.extracted++;
  }

  return NextResponse.json(results);
}
