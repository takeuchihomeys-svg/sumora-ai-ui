// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

// 熱い（is_hot）客が返信 → @鈴木メンション + リスト即時通知
// ※is_flaggedは全客自動セットになったためis_hotのみで通知判定する
export async function notifySuzukiReply(db: DbClient, convId: string, msgText: string) {
  const { data: conv } = await db
    .from("conversations")
    .select("customer_name, is_flagged, is_hot")
    .eq("id", convId)
    .maybeSingle();
  if (!conv?.is_hot) return; // is_hot客のみ通知（is_flaggedは全客自動セットのため除外）

  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? process.env.LINE_GROUP_ID ?? null;
  if (!groupId) {
    const { data: grpRow } = await db.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (grpRow?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) return;

  const { data: suzukiRow } = await db.from("hanbancyo_settings").select("value").eq("key", "suzuki_line_user_id").maybeSingle();
  const suzukiUserId = suzukiRow?.value as string | undefined;

  // ターゲット全リスト取得（申込以降は除外）
  const { data: flagged } = await db
    .from("conversations")
    .select("id, customer_name, updated_at")
    .eq("is_flagged", true)
    .not("status", "in", "(applying,screening,contract,closed_won,closed_lost,lost)")
    .order("updated_at", { ascending: false })
    .limit(35);

  // 今日のスタッフメッセージ（✅/☑判定）
  const jstMidnight = new Date(Date.now() + 9 * 3600000);
  jstMidnight.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(jstMidnight.getTime() - 9 * 3600000);
  const flaggedIds = (flagged ?? []).map((c: any) => c.id as string);
  const staffMsgMap = new Map<string, { hasAix: boolean }>();
  if (flaggedIds.length > 0) {
    const { data: todayMsgs } = await db
      .from("messages")
      .select("conversation_id, is_aix_generated")
      .eq("sender", "staff")
      .gte("created_at", todayStart.toISOString())
      .in("conversation_id", flaggedIds);
    for (const m of todayMsgs ?? []) {
      const prev = staffMsgMap.get(m.conversation_id) ?? { hasAix: false };
      staffMsgMap.set(m.conversation_id, { hasAix: prev.hasAix || !!m.is_aix_generated });
    }
  }

  // 今日「物件確認した」顧客セット（property_customers.property_viewed_at が今日）
  const flaggedNames = (flagged ?? []).map((c: any) => c.customer_name as string).filter(Boolean);
  const { data: viewedRows2 } = flaggedNames.length > 0
    ? await db.from("property_customers").select("customer_name")
        .in("customer_name", flaggedNames).gte("property_viewed_at", todayStart.toISOString())
    : { data: [] };
  const viewedNames2 = new Set((viewedRows2 ?? []).map((r: any) => r.customer_name as string));

  // ☑(AIX未送信 or 物件確認済み) → ・(未対応) → ✅(AIX済み) の優先ソート
  const getMarkPrio = (id: string, nm: string) => { const i = staffMsgMap.get(id); if (!i && !viewedNames2.has(nm)) return 1; if (i?.hasAix) return 2; return 0; };
  const getMark     = (id: string, nm: string) => { const i = staffMsgMap.get(id); if (!i && !viewedNames2.has(nm)) return "・"; if (i?.hasAix) return "✅"; return "☑"; };
  const sorted = [...(flagged ?? [])].sort((a, b) => getMarkPrio(a.id as string, a.customer_name as string) - getMarkPrio(b.id as string, b.customer_name as string));

  const name = (conv.customer_name as string) || "名称未設定";
  const preview = msgText.slice(0, 25) + (msgText.length > 25 ? "…" : "");

  const bodyLines: string[] = [
    `【熱い客】${name}から返信きた！！`,
    `「${preview}」`,
    "今が熱い！！今すぐ詰めて！！",
    "",
    "【しょーへいの今日のターゲット全リスト】",
  ];

  if (sorted.length > 0) {
    bodyLines.push("", "► 決まる（最優先）");
    sorted.forEach((c) => bodyLines.push(`${getMark(c.id as string, c.customer_name as string)}${c.customer_name || "名称未設定"}`));
  }

  const bodyText = bodyLines.join("\n");
  const message = suzukiUserId
    ? { type: "textV2", text: `{0} ${bodyText}`, substitution: { "0": { type: "mention", mentionee: { type: "user", userId: suzukiUserId } } } }
    : { type: "text", text: bodyText };

  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.warn("[notifySuzukiReply] push failed:", e);
  }
}
