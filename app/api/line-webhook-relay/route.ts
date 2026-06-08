import { NextRequest, NextResponse } from "next/server";

// LINE webhook を受け取り、2つの宛先に並行転送する
const SCREENING_URL = "https://sumora-screening-admin.vercel.app/api/line-webhook";
const AI_UI_URL     = "https://sumora-ai-ui.vercel.app/api/line-webhook";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  const headers = {
    "Content-Type": "application/json",
    "x-line-signature": signature,
  };

  // 両方に並行転送
  const [screeningResult, aiUiResult] = await Promise.allSettled([
    fetch(SCREENING_URL, { method: "POST", headers, body: rawBody }),
    fetch(AI_UI_URL,     { method: "POST", headers, body: rawBody }),
  ]);

  // screening-admin のエラーはログだけ（sumora-ai-ui が主管轄）
  if (screeningResult.status === "rejected") {
    console.error("[line-relay] screening-admin 転送エラー:", screeningResult.reason);
  }

  // sumora-ai-ui が失敗した場合は 500 を返して LINE にリトライさせる
  // （line_message_id UNIQUE制約により重複保存は防止済み）
  if (aiUiResult.status === "rejected") {
    console.error("[line-relay] sumora-ai-ui 転送エラー:", aiUiResult.reason);
    return NextResponse.json({ error: "forward failed" }, { status: 500 });
  }
  if (!aiUiResult.value.ok) {
    const status = aiUiResult.value.status;
    // 400 = 署名不正など正常な拒否 → LINE に 200 を返して終了（リトライ不要）
    // 500 = 保存失敗 → LINE に 500 を返してリトライさせる
    if (status >= 500) {
      console.error("[line-relay] sumora-ai-ui がエラー応答:", status);
      return NextResponse.json({ error: "message save failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
