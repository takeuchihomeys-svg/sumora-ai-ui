import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type Account = "sumora" | "ieyasu" | "giga";

const ACCOUNT_LABELS: Record<Account, string> = {
  sumora: "スモラ",
  ieyasu: "イエヤス",
  giga: "ギガ賃貸",
};

export interface EstimateItem {
  item: string;
  amount: number;
  category: string;
  notes: string;
}

function calcProratedDays(moveInDate: string) {
  const d = new Date(moveInDate);
  const year = d.getFullYear();
  const month = d.getMonth();
  const day = d.getDate();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const days = totalDays - day + 1;
  const nextMonth = month === 11 ? 1 : month + 2;
  const nextYear = month === 11 ? year + 1 : year;
  return { days, totalDays, month: month + 1, year, nextMonth, nextYear };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      account: Account;
      customerName?: string;
      propertyName?: string;
      moveInDate?: string;
      rent: number;
      managementFee?: number;
      shikikinMonths?: number;
      reikinMonths?: number;
      commissionRate?: number;
      customCommission?: number | null;
      guarantee?: number;
      insurance?: number;
      keyExchange?: number;
      cleaning?: number;
      otherItems?: Array<{ item: string; amount: number; notes?: string }>;
      discountAmount?: number;
      discountNote?: string;
      supplementaryNotes?: string;
    };

    const {
      account = "sumora",
      customerName = "",
      propertyName = "",
      moveInDate = "",
      rent,
      managementFee = 0,
      shikikinMonths = 0,
      reikinMonths = 0,
      commissionRate = 1.1,
      customCommission = null,
      guarantee = 0,
      insurance = 0,
      keyExchange = 0,
      cleaning = 0,
      otherItems = [],
      discountAmount = 0,
      discountNote = "",
      supplementaryNotes = "",
    } = body;

    if (!rent || rent <= 0) {
      return NextResponse.json({ error: "賃料を入力してください" }, { status: 400 });
    }

    const items: EstimateItem[] = [];

    // 敷金
    if (shikikinMonths > 0) {
      items.push({
        item: "敷金",
        amount: Math.round(rent * shikikinMonths),
        category: "shikikin",
        notes: `${shikikinMonths}ヶ月分`,
      });
    }

    // 礼金
    if (reikinMonths > 0) {
      items.push({
        item: "礼金",
        amount: Math.round(rent * reikinMonths),
        category: "reikin",
        notes: `${reikinMonths}ヶ月分`,
      });
    }

    // 日割り賃料・翌月賃料
    if (moveInDate) {
      const { days, totalDays, month, year, nextMonth, nextYear } = calcProratedDays(moveInDate);
      const moveDay = new Date(moveInDate).getDate();
      const proratedRent = Math.round((rent / totalDays) * days);
      const proratedFee = managementFee > 0 ? Math.round((managementFee / totalDays) * days) : 0;

      items.push({
        item: `${month}月分 日割賃料`,
        amount: proratedRent,
        category: "prorated_rent",
        notes: `${month}月${moveDay}日〜${month}月${totalDays}日（${days}日分）`,
      });

      if (proratedFee > 0) {
        items.push({
          item: `${month}月分 日割管理費`,
          amount: proratedFee,
          category: "prorated_fee",
          notes: `${days}日分`,
        });
      }

      items.push({
        item: `${nextMonth}月分 賃料`,
        amount: rent,
        category: "next_rent",
        notes: `${nextYear}年${nextMonth}月`,
      });

      if (managementFee > 0) {
        items.push({
          item: `${nextMonth}月分 管理費`,
          amount: managementFee,
          category: "next_fee",
          notes: "",
        });
      }
    }

    // 仲介手数料
    const commission = customCommission !== null && customCommission !== undefined
      ? customCommission
      : Math.round(rent * commissionRate);
    if (commission > 0) {
      items.push({
        item: "仲介手数料",
        amount: commission,
        category: "commission",
        notes: customCommission !== null && customCommission !== undefined
          ? ""
          : `賃料×${commissionRate}`,
      });
    }

    // 保証料
    if (guarantee > 0) {
      items.push({ item: "保証料（初回）", amount: guarantee, category: "guarantee", notes: "" });
    }

    // 火災保険
    if (insurance > 0) {
      items.push({ item: "火災保険", amount: insurance, category: "insurance", notes: "" });
    }

    // 鍵交換費用
    if (keyExchange > 0) {
      items.push({ item: "鍵交換費用", amount: keyExchange, category: "key", notes: "" });
    }

    // ハウスクリーニング
    if (cleaning > 0) {
      items.push({ item: "ハウスクリーニング", amount: cleaning, category: "cleaning", notes: "" });
    }

    // その他
    for (const o of otherItems) {
      if (o.amount > 0) {
        items.push({ item: o.item, amount: o.amount, category: "other", notes: o.notes || "" });
      }
    }

    const subtotal = items.reduce((s, i) => s + i.amount, 0);
    const accountLabel = ACCOUNT_LABELS[account] || "スモラ";

    // AIで割引適用戦略 + LINE テキスト生成
    const moveInStr = moveInDate
      ? new Date(moveInDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
      : "未定";

    const itemLines = items
      .map((i) => `・${i.item}：¥${i.amount.toLocaleString()}${i.notes ? `（${i.notes}）` : ""}`)
      .join("\n");

    const aiPrompt = `あなたは不動産仲介「${accountLabel}」の見積書作成AIです。
以下の情報をもとに、割引の適用方法を決定し、LINE送付用の見積書テキストを生成してください。

【基本情報】
アカウント: ${accountLabel}
お客様: ${customerName || "お客様"}様
物件: ${propertyName || "（物件名未入力）"}
入居予定: ${moveInStr}

【費用項目】
${itemLines}

小計: ¥${subtotal.toLocaleString()}
割引額: ¥${discountAmount.toLocaleString()}${discountNote ? `（${discountNote}）` : ""}
合計（目安）: ¥${(subtotal - discountAmount).toLocaleString()}
${supplementaryNotes ? `\n【補足情報】\n${supplementaryNotes}` : ""}

【指示】
1. 割引¥${discountAmount.toLocaleString()}をどの項目から引くか決定してください（通常は仲介手数料が自然）
2. LINE送付用の見積書テキストを作成してください

見積書テキストのフォーマット：
- 見やすく整形された日本語
- 各費用を箇条書きで列挙
- 割引は明確に「▲¥XX,XXX（割引）」と表記
- 合計金額を強調
- 末尾に「※この金額は概算です」を記載
- 送る会社名「${accountLabel}」を末尾に記載

以下のJSON形式のみで返してください：
{
  "discountAppliedTo": "割引を適用した項目名",
  "discountBreakdown": "割引の説明文（例: 仲介手数料より¥30,000割引）",
  "total": 合計金額（数値）,
  "lineText": "LINE送付用テキスト"
}`;

    const aiRes = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: aiPrompt }],
    });

    const raw = aiRes.content[0].type === "text" ? aiRes.content[0].text.trim() : "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    const ai = match
      ? (JSON.parse(match[0]) as { discountAppliedTo: string; discountBreakdown: string; total: number; lineText: string })
      : { discountAppliedTo: "仲介手数料", discountBreakdown: `仲介手数料より¥${discountAmount.toLocaleString()}割引`, total: subtotal - discountAmount, lineText: "" };

    // 割引行を追加
    const finalItems: EstimateItem[] = [...items];
    if (discountAmount > 0) {
      finalItems.push({
        item: "割引",
        amount: -discountAmount,
        category: "discount",
        notes: ai.discountBreakdown || discountNote || "",
      });
    }

    const total = ai.total ?? subtotal - discountAmount;

    // DB保存
    const { data: saved, error: insertError } = await supabase
      .from("estimates")
      .insert({
        account,
        customer_name: customerName,
        property_name: propertyName,
        move_in_date: moveInDate || null,
        rent,
        management_fee: managementFee,
        shikikin_months: shikikinMonths,
        reikin_months: reikinMonths,
        commission_rate: commissionRate,
        custom_commission: customCommission,
        guarantee,
        insurance,
        key_exchange: keyExchange,
        cleaning,
        other_items: otherItems,
        discount: discountAmount,
        discount_note: discountNote,
        supplementary_notes: supplementaryNotes,
        items: finalItems,
        total,
        line_text: ai.lineText,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[generate-estimate] DB保存エラー:", insertError);
      return NextResponse.json(
        { error: `見積書の保存に失敗しました: ${insertError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      id: saved?.id,
      items: finalItems,
      subtotal,
      discountAmount,
      discountBreakdown: ai.discountBreakdown,
      discountAppliedTo: ai.discountAppliedTo,
      total,
      lineText: ai.lineText,
    });
  } catch (err) {
    console.error("[generate-estimate]", err);
    return NextResponse.json({ error: "見積書の生成に失敗しました" }, { status: 500 });
  }
}

// 過去の見積書一覧
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account");
  const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 50);

  let query = supabase
    .from("estimates")
    .select("id, account, customer_name, property_name, move_in_date, total, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (account) query = query.eq("account", account);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, estimates: data ?? [] });
}
