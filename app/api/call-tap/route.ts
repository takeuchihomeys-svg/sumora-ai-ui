// app/api/call-tap/route.ts
// 「電話をかける」ボタン（AIX【電話する】→電話をかける）の行き先。押された事を記録して、LINEコールの通話URL へ転送する。
// 2026-10-02 竹内「AIXの電話をかけるが、こっちが電話でれなくて不在だった場合 不在の通知がはいるようにする。今出ないのでわかりにくい」
//   LINEコールは webhook に着信・不在着信が来ない（LINE の仕様）ので、押した瞬間を拾って知らせる（判断・文は app/lib/call-tap.ts）:
//   ・conversations.call_tapped_at を今にする（トーク画面の「📞 電話ボタンが押されました」の印・call-tap-view.ts）
//   ・売上番長グループへ「〇〇さんが電話ボタンを押しました」（同じ会話で3分以内の押し直しは重ねない）
//   お客様の端末から開かれるので認証は付けない。代わりにリンクの署名が合う物だけ扱う
import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { callUrlSettingKey, isValidLineCallUrl } from "@/app/lib/phone-call";
import { verifyCallTap, callTapSecret, buildCallTapNotice, CALL_TAP_NOTIFY_GAP_MS } from "@/app/lib/call-tap";
import { pushToHanbancyoGroup } from "@/app/lib/aix-action-items";
import { normalizeLineAccountKey } from "@/app/lib/line-accounts";
import { isTestConversation } from "@/app/lib/test-conversations";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const conversationId = sp.get("c") ?? "";
  const accountKey = normalizeLineAccountKey(sp.get("a"));
  const sig = sp.get("s") ?? "";
  const secret = callTapSecret(process.env);
  if (!secret || !accountKey || !verifyCallTap(conversationId, accountKey, sig, secret)) {
    console.warn(JSON.stringify({ tag: "call-tap:bad-link", hasSecret: !!secret, account: accountKey ?? null }));
    return new NextResponse("リンクが正しくありません", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const { data: urlRow } = await supabase.from("aix_settings").select("value").eq("key", callUrlSettingKey(accountKey)).maybeSingle();
  const callUrl = (urlRow?.value as string | undefined) ?? "";

  const now = new Date();
  after(async () => {
    try {
      const { data: conv } = await supabase.from("conversations").select("customer_name, call_tapped_at").eq("id", conversationId).maybeSingle();
      if (!conv) return;
      const prev = conv.call_tapped_at ? Date.parse(conv.call_tapped_at as string) : NaN;
      const { error: upErr } = await supabase.from("conversations").update({ call_tapped_at: now.toISOString() }).eq("id", conversationId);
      if (upErr) console.warn(JSON.stringify({ tag: "call-tap:update-failed", error: upErr.message }));
      if (Number.isFinite(prev) && now.getTime() - prev < CALL_TAP_NOTIFY_GAP_MS) {
        console.log(JSON.stringify({ tag: "call-tap:repeat", conversationId }));
        return;
      }
      const notice = buildCallTapNotice(conv.customer_name as string | null, now) + (isTestConversation(conversationId) ? "\n（テスト用の会話）" : "");
      const ok = await pushToHanbancyoGroup(notice);
      console.log(JSON.stringify({ tag: "call-tap:notified", conversationId, account: accountKey, ok }));
    } catch (e) {
      console.error(JSON.stringify({ tag: "call-tap:error", error: e instanceof Error ? e.message : String(e) }));
    }
  });

  if (!isValidLineCallUrl(callUrl)) {
    return new NextResponse("ただいま電話をおつなぎできません。お手数ですがトークでご連絡ください。", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return NextResponse.redirect(callUrl, 302);
}
