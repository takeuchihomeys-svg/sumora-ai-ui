// app/lib/sent-facts.ts
// こちらが送ったこと・約束したことの「送信時の記録」（sent_facts）と、内覧の記録（viewing_history）を書く・読む。
// 2026-09-14 竹内「自分が送った内容を記憶して次の解析に引き継げるように。送った内容や AIX ボタンのどこ送ったか等は鮮度の高い部分」:
//   根本原因（設計知見「【根本原因】送った内容は送った時に記録せず、毎回本文から推測し直していた」）:
//   ・手打ちの送信（30日で47%）は何をしたかの記録が無く、毎回本文を正規表現で読み直していた（1通1分類・1通単位の時制で誤る）
//   ・AIX 待ち合わせ場所は画面で入力した日付・時刻が記録に渡らず、内覧の記録（viewing_history）も作られなかった（29回中7回）。
//     既存の最新の未完了行に物件名を上書きし「9/10 15:00 メゾン加美北 予定」のような誤った記録を作っていた
//   → 送った時（一番よく知っている所）に構造化して1回書く。行動台帳（action-ledger）は記録を一次証拠にし、本文の読み直しは記録前の古いメッセージだけ
import { supabase } from "@/app/lib/supabase";
import { classifyStaffTextFacts, aixLedgerKind, aixTextPromises, extractViewingAppointment, appointmentFromMeetingInput, appointmentYmd, type RecordedFact, type ViewingAppointment } from "@/app/lib/action-ledger";

type FactRow = RecordedFact & { conversation_id: string };

async function upsertFacts(rows: FactRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from("sent_facts").upsert(
    rows.map((r) => ({ ...r, detail: r.detail ?? {}, evidence: (r.evidence ?? "").slice(0, 80) })),
    { onConflict: "conversation_id,sent_at,origin,kind", ignoreDuplicates: true },
  );
  if (error) console.warn("[sent-facts] upsert failed:", error.message);
}

/** 手打ちの送信を1回分類して記録する（send-line-message・送信成功後）。待ち合わせの案内なら内覧の記録も書く */
export async function recordStaffTextFacts(o: { conversationId: string; text: string; sentAt: string; lineMessageId?: string | null; viewingOnlyFrom?: string }): Promise<number> {
  const entries = classifyStaffTextFacts(o.text, o.sentAt).filter((e) => e.kind !== "media_sent");
  // 1通に複数の行為がある時は主な行為を先頭に保つ（読む時は送信時刻の昇順＝主な行為が「直前スタッフ発言」になる）ため 1ms ずつずらす
  const base = Date.parse(o.sentAt);
  await upsertFacts(entries.map((e, i) => ({
    conversation_id: o.conversationId, sent_at: Number.isFinite(base) ? new Date(base + i).toISOString() : o.sentAt, origin: "staff_text", aix_type: null, kind: e.kind, status: e.status,
    line_message_id: o.lineMessageId ?? null, detail: e.detail, evidence: e.evidence,
  })));
  const meeting = entries.find((e) => e.kind === "meeting_place_sent")?.detail.appointment;
  if (meeting) await recordViewingFromAppointment({ conversationId: o.conversationId, appointment: meeting, sentAt: o.sentAt, source: "staff_text", onlyFrom: o.viewingOnlyFrom });
  return entries.length;
}

/** AIX の送信を記録する（log-aix-usage）。待ち合わせ場所は画面で入力した日付・時刻・物件で内覧の記録も書く */
export async function recordAixFacts(o: {
  conversationId: string; aixType: string; sentAt: string; lineMessageId?: string | null; generatedText?: string | null;
  checkPattern?: string | null; propertyNames?: string[] | null; estimateSent?: boolean | null;
  meeting?: { date?: string | null; time?: string | null; propertyName?: string | null; address?: string | null } | null;
  /** 遡って記録する時だけ: この日（YYYY-MM-DD）より前の内覧の記録は作らない */
  viewingOnlyFrom?: string;
}): Promise<void> {
  const map = aixLedgerKind(o.aixType);
  if (!map) return;
  const detail: Record<string, unknown> = {};
  if (o.checkPattern) detail.checkPattern = o.checkPattern;
  if (o.propertyNames?.length) { detail.propertyNames = o.propertyNames; detail.propertyCount = o.propertyNames.length; }
  if (map.kind === "estimate_sent" && o.propertyNames?.length) detail.estimateFor = o.propertyNames;
  let appointment: ViewingAppointment | null = null;
  if (map.kind === "meeting_place_sent") {
    appointment = appointmentFromMeetingInput(o.meeting) ?? extractViewingAppointment(o.generatedText, o.sentAt);
    // 本文から読んだ時も、物件は画面で選んだ名前を正にする
    if (appointment && o.meeting?.propertyName?.trim()) appointment = { ...appointment, place: o.meeting.propertyName.trim() };
    if (appointment) detail.appointment = appointment;
  }
  const rows: FactRow[] = [{
    conversation_id: o.conversationId, sent_at: o.sentAt, origin: "aix", aix_type: o.aixType, kind: map.kind, status: map.status,
    line_message_id: o.lineMessageId ?? null, detail: detail as RecordedFact["detail"], evidence: `${o.aixType}${o.checkPattern ? "/" + o.checkPattern : ""}`,
  }];
  // 物件確認した 等に御見積書を同封した → 見積書の送付も記録（台帳 ① と同じ）
  if (map.kind !== "estimate_sent" && o.estimateSent === true) {
    rows.push({ conversation_id: o.conversationId, sent_at: o.sentAt, origin: "aix", aix_type: o.aixType, kind: "estimate_sent", status: "done",
      line_message_id: o.lineMessageId ?? null, detail: o.propertyNames?.length ? { estimateFor: o.propertyNames } : {}, evidence: `estimate_sent@${o.aixType}` });
  }
  // 2026-09-15 竹内（ゆうこ事例）: AIX の本文に書き足した約束（「改めてオススメできるお部屋ピックアップさせて頂きます」等）も記録する。
  //   AIX の行より後（+1ms〜）に置き、台帳の「直前スタッフ発言」を約束にする → ブレインが約束の履行の AIX（promise:）と判定・一覧にも AIX が出る
  const base = Date.parse(o.sentAt);
  aixTextPromises(o.aixType, o.generatedText, o.sentAt, { estimateEnclosed: o.estimateSent === true }).forEach((p, i) => {
    rows.push({
      conversation_id: o.conversationId, sent_at: Number.isFinite(base) ? new Date(base + 1 + i).toISOString() : o.sentAt, origin: "aix", aix_type: o.aixType,
      kind: p.kind, status: p.status, line_message_id: o.lineMessageId ?? null, detail: p.detail ?? {}, evidence: p.evidence,
    });
  });
  await upsertFacts(rows);
  if (appointment) await recordViewingFromAppointment({ conversationId: o.conversationId, appointment, address: o.meeting?.address ?? null, sentAt: o.sentAt, source: "aix", onlyFrom: o.viewingOnlyFrom });
}

/** 行動台帳に渡す送信時の記録（古→新）。取得範囲より古い送信も忘れないよう、メッセージの取得件数より多めに読む */
export async function loadRecordedFacts(conversationId: string, limit = 120): Promise<RecordedFact[]> {
  try {
    const { data, error } = await supabase.from("sent_facts")
      .select("sent_at, origin, aix_type, kind, status, line_message_id, detail, evidence")
      .eq("conversation_id", conversationId).order("sent_at", { ascending: false }).limit(limit);
    if (error) { console.warn("[sent-facts] load failed:", error.message); return []; }
    return ((data ?? []) as RecordedFact[]).reverse();
  } catch { return []; }
}

// ─── 内覧の記録（viewing_history）───

/**
 * 案内した待ち合わせで内覧の記録を作る／同じ日の記録を更新する（最新の案内をその会話の主な内覧＝is_primary にする）。
 * 旧（log-aix-usage M3）: 既存の最新の未完了行に物件名だけを上書きしていた＝日付が違う古い行に新しい物件が載った
 */
export async function recordViewingFromAppointment(o: { conversationId: string; appointment: ViewingAppointment; address?: string | null; sentAt: string; source: "aix" | "staff_text"; onlyFrom?: string }): Promise<void> {
  const a = o.appointment;
  if (!a.dateMD) return;
  const ymd = appointmentYmd(a.dateMD, o.sentAt);
  if (!ymd || (o.onlyFrom && ymd < o.onlyFrom)) return;
  try {
    const { data: same } = await supabase.from("viewing_history").select("id, property_name, scheduled_time")
      .eq("conversation_id", o.conversationId).eq("scheduled_date", ymd).limit(1).maybeSingle();
    let id = same?.id as string | undefined;
    const fields = {
      scheduled_time: a.time ?? (same?.scheduled_time as string | null) ?? null,
      property_name: a.place ?? (same?.property_name as string | null) ?? null,
      ...(o.address ? { property_address: o.address } : {}),
      status: "scheduled",
      notes: `待ち合わせの案内（${o.source === "aix" ? "AIX 待ち合わせ場所" : "手打ち"}・${o.sentAt}）`,
      updated_at: new Date().toISOString(),
    };
    if (id) {
      await supabase.from("viewing_history").update(fields).eq("id", id);
    } else {
      const { data: ins, error } = await supabase.from("viewing_history")
        .insert({ conversation_id: o.conversationId, scheduled_date: ymd, is_primary: false, ...fields }).select("id").single();
      if (error) { console.warn("[sent-facts] viewing_history insert failed:", error.message); return; }
      id = ins?.id as string | undefined;
    }
    if (!id) return;
    await supabase.from("viewing_history").update({ is_primary: false }).eq("conversation_id", o.conversationId).neq("id", id);
    await supabase.from("viewing_history").update({ is_primary: true }).eq("id", id);
    console.log(JSON.stringify({ tag: "viewing:recorded", conversationId: o.conversationId, date: ymd, time: a.time, source: o.source }));
  } catch (e) {
    console.warn("[sent-facts] recordViewingFromAppointment failed:", e instanceof Error ? e.message : e);
  }
}
