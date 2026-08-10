import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

export interface ExtractedEstimate {
  propertyName: string;
  roomNumber: string;
  customerName: string;
  assignee: string;
  moveInDate: string;       // YYYY-MM-DD
  moveInMonth: number;      // 入居月
  moveInDay: number;        // 入居日
  moveInMonthDays: number;  // 入居月の日数
  rent: number;
  managementFee: number;
  waterFee: number;
  shikikin: number;
  reikin: number;
  hoshokikin: number;       // 保証金
  commission: number;
  commissionTax: number;
  parkingCommission: number;
  parkingCommissionTax: number;
  guarantee: number;
  monthlyGuaranteeFee: number; // 月額保証料（毎月支払い分）
  insurance: number;
  keyExchange: number;
  cleaning: number;
  guaranteeRate?: number;
  cleaningAtDeparture?: boolean;
  parkingDeposit: number;
  parkingMonthly: number;
  otherItems: Array<{ item: string; amount: number }>;
  discountAmount: number;
  discountNote: string;
  supplementaryNotes: string;
}

const EMPTY: ExtractedEstimate = {
  propertyName: "",
  roomNumber: "",
  customerName: "",
  assignee: "",
  moveInDate: "",
  moveInMonth: 0,
  moveInDay: 1,
  moveInMonthDays: 30,
  rent: 0,
  managementFee: 0,
  waterFee: 0,
  shikikin: 0,
  reikin: 0,
  hoshokikin: 0,
  commission: 0,
  commissionTax: 0,
  parkingCommission: 0,
  parkingCommissionTax: 0,
  guarantee: 0,
  monthlyGuaranteeFee: 0,
  insurance: 0,
  keyExchange: 0,
  cleaning: 0,
  guaranteeRate: 50,
  cleaningAtDeparture: false,
  parkingDeposit: 0,
  parkingMonthly: 0,
  otherItems: [],
  discountAmount: 0,
  discountNote: "",
  supplementaryNotes: "",
};

export async function POST(req: NextRequest) {
  // ビルド時の環境変数未定義を避けるため、クライアントはここで初期化する
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });

  try {
    const body = await req.json() as {
      images?: Array<{ base64: string; mimeType: string }>;
      supplementaryText?: string;
    };

    const { images = [], supplementaryText = "" } = body;
    if (images.length === 0 && !supplementaryText) {
      return NextResponse.json({ error: "画像またはテキストを入力してください" }, { status: 400 });
    }

    const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);
    const unsupported = images.find((img) => !SUPPORTED_MIME.has(img.mimeType));
    if (unsupported) {
      return NextResponse.json(
        { error: `非対応の画像形式です（${unsupported.mimeType}）。JPEG / PNG / PDF に変換して再度お試しください。` },
        { status: 400 }
      );
    }

    const systemPrompt = `あなたは不動産賃貸の費用明細・見積書を読み取るAIです。
提供された画像や文章から賃貸初期費用の情報を正確に抽出し、以下のJSON形式のみで返してください。他のテキストは不要です。

{
  "propertyName": "物件名",
  "roomNumber": "号室（数字のみ、例: 202）",
  "customerName": "入居者名（あれば）",
  "assignee": "担当者名（あれば）",
  "moveInDate": "入居日 YYYY-MM-DD形式（不明なら空文字）",
  "moveInMonth": 入居月（数値、不明なら0）,
  "moveInDay": 入居日（数値、不明なら1）,
  "moveInMonthDays": 入居月の日数（不明なら30）,
  "rent": 月額家賃（数値、共益費別。不明なら0）,
  "managementFee": 共益費・管理費（数値。不明なら0）,
  "waterFee": 水道代（数値。不明なら0）,
  "shikikin": 敷金（数値。不明なら0）,
  "reikin": 礼金（数値。不明なら0）,
  "hoshokikin": 保証金（数値。敷金とは別。不明なら0）,
  "commission": 仲介手数料（税抜。数値。不明なら0）,
  "commissionTax": 仲介手数料の消費税（数値。不明なら0）,
  "parkingCommission": 駐車場手数料（税抜。数値。不明なら0）,
  "parkingCommissionTax": 駐車場手数料消費税（数値。不明なら0）,
  "guarantee": 賃貸保証料（数値。不明なら0）,
  "guaranteeRate": 賃貸保証料率（%の数値のみ。例: 30。複数ある場合は最低率。記載がなければ50）,
  "monthlyGuaranteeFee": 月額保証料（毎月支払う保証料。数値。不明なら0）,
  "insurance": 住宅保険・火災保険（数値。不明なら0）,
  "keyExchange": 鍵交換代（数値。不明なら0）,
  "cleaning": クリーニング代（数値。不明なら0）,
  "cleaningAtDeparture": クリーニング代が「退去時清算」「退去時精算」「退去時」の場合はtrue（入居時に支払わず退去時に精算するため初期費用から除外）、入居時支払いの場合はfalse（不明はfalse）,
  "parkingDeposit": 駐車場保証金（数値。不明なら0）,
  "parkingMonthly": 翌月駐車場代（数値。不明なら0）,
  "otherItems": [{"item": "項目名", "amount": 税込金額数値}],
  "discountAmount": 割引額（数値、正数で。不明なら0）,
  "discountNote": "割引の説明（あれば）",
  "supplementaryNotes": "その他特記事項"
}

重要なルール:
- 金額は数値のみ（カンマ・円記号なし）
- 家賃と共益費・管理費は必ず分ける
- 仲介手数料のみ税抜と消費税を分けて抽出（まとめて書いてあれば: 合計÷1.1=税抜、端数切捨て）
- otherItemsの金額は【必ず税込金額のまま】記入すること。÷1.1の計算は絶対にしない。書いてある数字をそのまま使う
- guarantee・insurance・keyExchange・cleaning等も税込のまま書いてある数字を使う（÷1.1しない）
- guaranteeRate: 「エポス30%→」「JRAG50%/70%」等から保証料率を抽出。複数ある場合は最低率（例: 30）。記載がなければ50
- cleaningAtDeparture: 「退去時清算」「退去時精算」「退去時 ¥○○」「退去時」等の記載があればtrue。入居時に支払う場合はfalse
- 【退去時費用の除外】退去時・退去時清算・退去時精算・退去時支払い・退去時 ¥〇〇 等の文言が付いた費用は一切初期費用に含めない。室内清掃費用・ルームクリーニング・ハウスクリーニング代が退去時扱いの場合はcleaning: 0、cleaningAtDeparture: true。退去時と分かる費用はotherItemsにも絶対に入れない
- monthlyGuaranteeFee: 「月額保証料」「保証料(月額)」等の毎月支払う保証料。otherItemsには入れずこのフィールドに入れる（初回保証料guaranteeとは別）
- 日割賃料は抽出不要（入居日から自動計算するため）
- 不明な項目は0または空文字
- otherItemsには上記フィールドに当てはまらない【入居時のみ】の費用を入れる。退去時費用は絶対に含めない`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = images.map((img) =>
      img.mimeType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: img.base64 } }
        : { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.base64 } }
    );

    const userText = `${images.length > 0 ? "添付の画像・書類" : ""}${supplementaryText ? `\n\n【補足情報】\n${supplementaryText}` : ""}\n\nから賃貸初期費用の全項目をJSONで抽出してください。`;
    contentParts.push({ type: "text", text: userText });

    // claude-sonnet-5 の制約:
    //   - temperature / top_p / top_k は送ると 400 エラーになるため省略
    //   - thinking: { type: "disabled" } で adaptive thinking を明示的に無効化する
    //     （aix/action/route.ts の callClaudeVision でも同じ設定で本番稼働中）
    //   - thinking 無効化により全トークンが JSON 出力に使われるため max_tokens を余裕持たせる
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 6000,
      thinking: { type: "disabled" },
      system: systemPrompt,
      messages: [{ role: "user", content: contentParts }],
    });

    console.log("[extract-estimate-info] content blocks:", res.content.map((b) => b.type));
    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock) {
      console.error("[extract-estimate-info] text block not found. content:", JSON.stringify(res.content));
      return NextResponse.json({ error: "テキストブロックが見つかりませんでした" }, { status: 500 });
    }
    const raw = textBlock.type === "text" ? textBlock.text.trim() : "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error("[extract-estimate-info] JSON not found in response:", raw.slice(0, 500));
      return NextResponse.json({ error: "JSONを抽出できませんでした" }, { status: 500 });
    }
    let extracted: ExtractedEstimate;
    try {
      extracted = { ...EMPTY, ...(JSON.parse(match[0]) as Partial<ExtractedEstimate>) };
    } catch (parseErr) {
      console.error("[extract-estimate-info] JSON parse failed:", parseErr, "raw:", match[0].slice(0, 500));
      return NextResponse.json({ error: "JSON解析に失敗しました" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, extracted });
  } catch (err) {
    console.error("[extract-estimate-info] unexpected error:", err);
    return NextResponse.json({ error: "読み取りに失敗しました" }, { status: 500 });
  }
}
