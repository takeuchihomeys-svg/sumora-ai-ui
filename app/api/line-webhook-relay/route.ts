import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { inboxPut } from "@/app/lib/line-webhook-inbox";

export const maxDuration = 30;

// LINE webhook を受け取り、2つの宛先に並行転送する
const SCREENING_URL = "https://sumora-screening-admin.vercel.app/api/line-webhook";
const AI_UI_URL     = "https://sumora-ai-ui.vercel.app/api/line-webhook";

// タイムアウト付き fetch + 失敗時に1回だけリトライ（500ms 待機後）
async function fetchWithRetry(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const attempt = async () => {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res;
  };
  try {
    return await attempt();
  } catch (e) {
    // 1回リトライ
    await new Promise((r) => setTimeout(r, 500));
    return attempt();
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  const headers = {
    "Content-Type": "application/json",
    "x-line-signature": signature,
  };

  // 2026-11-21 作業員M（竹内さん「返信が来ているのにツールに反映されない」）:
  //   旧: screening-admin への転送（15秒×2回＋0.5秒）を待ってから LINE に返していた＝最大 30.5秒で maxDuration（30秒）を超え、
  //   関数が切られると LINE には何も返らなかった。screening-admin は waitUntil で応答の後も続け、LINE への応答は sumora-ai-ui の結果だけで決める。
  //   screening-admin の転送は 12秒×2回（24.5秒）に縮めて maxDuration の中に収める。
  const screening = fetchWithRetry(SCREENING_URL, { method: "POST", headers, body: rawBody }, 12_000)
    .then((r) => { if (!r.ok) console.error("[line-relay] screening-admin がエラー応答:", r.status); })
    .catch((e) => console.error("[line-relay] screening-admin 転送エラー:", e));
  waitUntil(screening);

  const aiUiResult = await fetch(AI_UI_URL, { method: "POST", headers, body: rawBody, signal: AbortSignal.timeout(8_000) })
    .then((r) => ({ ok: true as const, res: r }))
    .catch((e: unknown) => ({ ok: false as const, error: e }));

  // sumora-ai-ui が失敗した場合は 500 を返して LINE にリトライさせる（LINE の管理画面の「Webhook の再送」が on の時だけ再送される）
  // （line_message_id UNIQUE制約により重複保存は防止済み）
  // 2026-11-21 作業員M: 再送が off でも本文を失わないよう、届かなかった・時間切れ（8秒）・5xx の時は生の本文を Blob に貯める（line-webhook-inbox.ts）。
  //   受け口が自分でも貯める（保存の失敗）ので二重に貯まる事があるが、入れ直しは line_message_id で重ならない
  if (!aiUiResult.ok) {
    console.error("[line-relay] sumora-ai-ui 転送エラー:", aiUiResult.error);
    await inboxPut(rawBody, signature, `relay_forward_failed:${aiUiResult.error instanceof Error ? aiUiResult.error.name : "error"}`, "relay");
    return NextResponse.json({ error: "forward failed" }, { status: 500 });
  }
  if (!aiUiResult.res.ok) {
    const status = aiUiResult.res.status;
    // 400 = 署名不正など正常な拒否 → LINE に 200 を返して終了（リトライ不要・宛先の誤りは受け口が貯める）
    // 500 = 保存失敗 → LINE に 500 を返してリトライさせる（受け口が本文を貯めている）
    if (status >= 500) {
      console.error("[line-relay] sumora-ai-ui がエラー応答:", status);
      return NextResponse.json({ error: "message save failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
