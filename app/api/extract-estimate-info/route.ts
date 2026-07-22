import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });

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
  insurance: number;
  keyExchange: number;
  cleaning: number;
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
  insurance: 0,
  keyExchange: 0,
  cleaning: 0,
  cleaningAtDeparture: false,
  parkingDeposit: 0,
  parkingMonthly: 0,
  otherItems: [],
  discountAmount: 0,
  discountNote: "",
  supplementaryNotes: "",
};

export async function POST(req: NextRequest) {
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
- cleaningAtDeparture: 「退去時清算」「退去時精算」「退去時 ¥○○」等の記載があればtrue。入居時に支払う場合はfalse
- 日割賃料は抽出不要（入居日から自動計算するため）
- 不明な項目は0または空文字
- otherItemsには上記フィールドに当てはまらない費用のみ入れる`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = images.map((img) =>
      img.mimeType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: img.base64 } }
        : { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.base64 } }
    );

    const userText = `${images.length > 0 ? "添付の画像・書類" : ""}${supplementaryText ? `\n\n【補足情報】\n${supplementaryText}` : ""}\n\nから賃貸初期費用の全項目をJSONで抽出してください。`;
    contentParts.push({ type: "text", text: userText });

    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: contentParts }],
    });

    const raw = res.content[0].type === "text" ? res.content[0].text.trim() : "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    const extracted: ExtractedEstimate = match
      ? { ...EMPTY, ...(JSON.parse(match[0]) as Partial<ExtractedEstimate>) }
      : EMPTY;

    return NextResponse.json({ ok: true, extracted });
  } catch (err) {
    console.error("[extract-estimate-info]", err);
    return NextResponse.json({ error: "読み取りに失敗しました" }, { status: 500 });
  }
}
