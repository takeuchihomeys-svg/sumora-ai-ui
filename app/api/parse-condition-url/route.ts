import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

const KNOWN_PROPERTY_SITES = [
  "suumo.jp",
  "homes.co.jp",
  "chintai.net",
  "athome.co.jp",
  "lifull.com",
];

// メッセージテキストから物件サイトURLを検出（line-webhook からも呼ばれる）
export function isPropertySiteUrl(text: string): string | null {
  try {
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return null;
    const url = new URL(urlMatch[0]);
    return KNOWN_PROPERTY_SITES.some((site) => url.hostname.includes(site))
      ? urlMatch[0]
      : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let url: string;
  let customerId: string;
  try {
    const body = await req.json() as { url?: string; customerId?: string };
    if (!body.url || !body.customerId) {
      return NextResponse.json({ ok: false, error: "missing params" }, { status: 400 });
    }
    url = body.url;
    customerId = body.customerId;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // ページHTMLを取得（タイムアウト8秒）
  let pageText = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
      signal: AbortSignal.timeout(8_000),
    });
    const html = await res.text();
    // HTMLからテキストを粗く抽出（スクリプト・スタイル除去）
    pageText = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 4000); // Claude入力コスト削減
  } catch {
    return NextResponse.json({ ok: false, error: "fetch failed" }, { status: 502 });
  }

  if (!pageText.trim()) {
    return NextResponse.json({ ok: false, error: "no content extracted" }, { status: 422 });
  }

  // Claude Haikuで条件抽出
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    timeout: 20_000,
  });

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `以下は不動産検索サイトの検索結果ページのテキストです。
お客さんが設定した検索条件（エリア・間取り・家賃上限・徒歩分数等）を抽出してJSONで返してください。
検索条件が見つからない場合は全フィールドをnullにしてください。
返すJSONのみ（説明不要）:
{"desired_area":null,"floor_plan":null,"rent_max":null,"walk_minutes":null,"building_age":null,"floor_area_min":null}

ページテキスト:
${pageText}`,
        },
      ],
    });
    const raw =
      (msg.content?.[0] as { type: string; text?: string })?.text ?? "";
    const match = raw
      .replace(/```json?\s*/gi, "")
      .trim()
      .match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json({ ok: false, error: "parse error" }, { status: 500 });
    }
    const extracted = JSON.parse(match[0]) as Record<string, unknown>;
    return NextResponse.json({ ok: true, extracted, source_url: url, customerId });
  } catch {
    return NextResponse.json({ ok: false, error: "ai error" }, { status: 500 });
  }
}
