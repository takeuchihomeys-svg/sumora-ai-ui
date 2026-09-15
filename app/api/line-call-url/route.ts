// app/api/line-call-url/route.ts
// LINE 公式アカウントの LINEコール「通話URL」（アカウントごと）の読み書き。AIX【電話をかける】の「電話をかける」ボタンの行き先。
// 2026-09-15 竹内（H 事例）: 通話URL は管理画面（設定 → チャット → 通話 → LINEコールを告知）でアカウントごとに発行される。
//   Messaging API からは取得できないので、AIX の画面で1回貼り付けて aix_settings に保存する（静的な設定・認証情報ではない）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { normalizeLineAccountKey, LINE_ACCOUNT_LABELS } from "@/app/lib/line-accounts";
import { callUrlSettingKey, isValidLineCallUrl } from "@/app/lib/phone-call";

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const accountKey = normalizeLineAccountKey(req.nextUrl.searchParams.get("account")) ?? "sumora";
  const { data, error } = await supabase.from("aix_settings").select("value, updated_at").eq("key", callUrlSettingKey(accountKey)).maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, account: accountKey, accountLabel: LINE_ACCOUNT_LABELS[accountKey], url: (data?.value as string | undefined) ?? null, updatedAt: data?.updated_at ?? null });
}

export async function PUT(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const { account, url } = await req.json() as { account?: string; url?: string };
  const accountKey = normalizeLineAccountKey(account) ?? "sumora";
  const u = (url ?? "").trim();
  if (!isValidLineCallUrl(u)) {
    return NextResponse.json({ ok: false, error: "LINE の通話URL（https://line.me/… または https://lin.ee/…）を貼り付けてください" }, { status: 400 });
  }
  const { error } = await supabase.from("aix_settings").upsert(
    { key: callUrlSettingKey(accountKey), label: `📞 LINEコールの通話URL（${LINE_ACCOUNT_LABELS[accountKey]}）`, value: u, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  console.log(JSON.stringify({ tag: "line-call-url:saved", account: accountKey }));
  return NextResponse.json({ ok: true, account: accountKey, url: u });
}
