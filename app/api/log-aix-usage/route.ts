import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";
import type { SummaryJson } from "@/app/api/customer-summary/route";

// POST /api/log-aix-usage
// AIX送信時にどのAIX+テンプレートを使ったか記録する（analyze-aix-flowで分析に使用）
// HIGH-01: fire-and-forget は waitUntil で包む（Vercelはレスポンス返却後に処理凍結されるため）
export const maxDuration = 30;

const AIX_TYPE_LABELS: Record<string, string> = {
  property_send:            "物件紹介を送った",
  viewing_invite:           "内覧に誘った",
  property_recommendation:  "物件おすすめ文を送った",
  hearing:                  "ヒアリングした",
  follow_up:                "フォローアップした",
  application:              "申込み案内をした",
  document_request:         "書類案内をした",
  contract:                 "契約手続きを案内した",
  greeting:                 "初回挨拶を送った",
  // ⑨-2: 現行AIXボタンの aix_type（欠落していたため追加）
  estimate_sheet:           "見積書を送った",
  property_check_result:    "物件の確認結果を報告した",
  meeting_place:            "待ち合わせ場所を案内した",
  acknowledge_check:        "確認しますと返信した",
  followup_revive:          "追客メッセージを送った",
  application_push:         "申込みを後押しした",
  condition_hearing:        "条件ヒアリングをした",
  greeting_viewing:         "内覧挨拶を送った",
  cost_explain:             "初期費用の安さの仕組みと還元額を説明した",
  cost_breakdown:           "御見積書の内訳で初期費用の中身（含まれる項目・家賃だけで入居できるか）を説明した",
  phone_call:               "「電話をかける」ボタン（LINEコール）と案内文を送った（お客様からの電話待ち）",
  phone_followup:           "電話でお話しした内容のまとめを送った",
  guarantor_info:           "物件ごとの保証会社名と種類（独立系・LICC系・信販系）を案内した（並行審査の勧めを含むことがある）",
};

// 一致判定（簡易ベースライン）
// 中2: 未定義の aix_type は wasAccurate=false 固定になり、Haiku パース失敗時に
// 不要な learning_rule 保存を誘発するため全 aix_type を網羅する
const MATCH_KEYWORDS: Record<string, string[]> = {
  viewing_invite:          ["内覧", "見学", "日程", "お部屋"],
  property_send:           ["物件", "ご紹介", "新着", "おすすめ"],
  property_recommendation: ["物件", "おすすめ", "おすすめ物件"],
  follow_up:               ["いかがでし", "確認", "どうでし", "感想"],
  application:             ["申込", "お申し込み", "申し込み"],
  document_request:        ["書類", "身分証", "連帯保証"],
  estimate_sheet:          ["見積", "費用", "初期費用", "家賃"],
  meeting_place:           ["待ち合わせ", "案内", "現地", "集合"],
  property_check_result:   ["空室", "確認", "空き", "退去"],
  greeting:                ["はじめまして", "よろしく", "担当"],
  hearing:                 ["条件", "ご希望", "予算", "エリア"],
  condition_hearing:       ["条件", "ご希望", "予算", "エリア", "ヒアリング"],
  contract:                ["契約", "手続き", "書類", "入居日"],
  acknowledge_check:       ["確認", "承知", "了解"],
  followup_revive:         ["いかが", "その後", "近況"],
  application_push:        ["申込", "お申し込み"],
  greeting_viewing:        ["内覧", "挨拶", "案内", "当日"],
  cost_explain:            ["仲介手数料", "還元", "広告料", "安い", "理由"],
  cost_breakdown:          ["初期費用", "敷金", "礼金", "内訳", "家賃だけ", "日割"],
  phone_call:              ["電話", "通話", "相談"],
  phone_followup:          ["電話", "お話し", "まとめ"],
  guarantor_info:          ["保証会社", "独立系", "LICC", "信販", "並行"],
};

// キーワード簡易判定（予測テキストに実アクションのキーワードが含まれるか）
// runGapAnalysis と POST 側の暫定書き込み（⑨-1）の両方から使う
function keywordAccuracy(actualAixType: string, predictedAction: string): boolean {
  const kw = MATCH_KEYWORDS[actualAixType] ?? [];
  return kw.length > 0 && kw.some(k => predictedAction.includes(k));
}

// next_action 予測 vs 実際の行動 のギャップを Haiku で分析し ai_reply_knowledge に保存
async function runGapAnalysis(opts: {
  predId: string;
  predictedAction: string;
  predictedAt: string;
  actualAixType: string;
  conversationId: string;
  customerId: string;
}): Promise<void> {
  const { predId, predictedAction, predictedAt, actualAixType, conversationId, customerId } = opts;

  // 予測後〜AIX送信までの間のメッセージ（文脈変化の把握）
  const { data: msgs } = await supabase
    .from("messages")
    .select("sender, text, created_at")
    .eq("conversation_id", conversationId)
    .gt("created_at", predictedAt)
    .neq("text", "[画像]")
    .not("text", "is", null)
    .order("created_at", { ascending: true })
    .limit(15);

  const actualLabel = AIX_TYPE_LABELS[actualAixType] ?? actualAixType;
  const msgContext = (msgs ?? []).length > 0
    ? (msgs as Array<{ sender: string; text: string }>)
        .map(m => `${m.sender === "customer" ? "お客さん" : "スタッフ"}: ${(m.text || "").slice(0, 100)}`)
        .join("\n")
    : "（やりとりなし）";

  // 一致判定（簡易ベースライン）: モジュールスコープの keywordAccuracy を使用（⑨-1で共通化）
  const wasAccurate = keywordAccuracy(actualAixType, predictedAction);

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
  });

  const prompt = `賃貸仲介AIの「次のアクション予測」の精度改善分析をしてください。

【AIが予測した次のアクション】
${predictedAction}

【スタッフが実際に取ったアクション】
${actualLabel}（AIXボタン: ${actualAixType}）

【予測後〜実際のAIX送信までの会話】
${msgContext}

参考: キーワード簡易判定では「${wasAccurate ? "一致" : "不一致"}」でしたが、会話の文脈を踏まえてあなた自身が判断してください。

以下の形式で分析してください（JSONのみ・説明不要）：
{
  "was_accurate": true または false（予測と実際のアクションが実質的に一致していたか）,
  "gap_summary": "予測と実際の差を1文で",
  "reason": "なぜスタッフが予測と違う行動を取ったかの原因（会話から読み取れる文脈変化など）",
  "learning_rule": "【状況】〜の場合 【正しいアクション】〜 【誤りやすい予測】〜 【理由】〜"
}`;

  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: "あなたは不動産営業AIの学習システムです。JSONのみで回答してください。",
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = res.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "{}";

  let parsed: { was_accurate?: boolean; gap_summary?: string; reason?: string; learning_rule?: string } = {};
  try {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch { /* ignore */ }

  const gapAnalysis = [
    parsed.gap_summary && `差分: ${parsed.gap_summary}`,
    parsed.reason && `原因: ${parsed.reason}`,
  ].filter(Boolean).join(" / ");

  // next_action_logs を更新
  await supabase.from("next_action_logs").update({
    validated: true,
    actual_aix_type: actualAixType,
    was_accurate: parsed.was_accurate ?? wasAccurate,
    gap_analysis: gapAnalysis || null,
    validated_at: new Date().toISOString(),
  }).eq("id", predId);

  // 学習ルールを ai_reply_knowledge に保存（ずれがある場合のみ）
  // 中2: Haiku パース失敗時（parsed.learning_rule が undefined）は保存をスキップ
  //      （キーワード簡易判定だけを根拠にした低品質ルールの蓄積を防ぐ）
  if (parsed.learning_rule && !(parsed.was_accurate ?? wasAccurate)) {
    const title = `next_action_rule_${customerId.slice(0, 8)}_${Date.now()}`;
    // 断線修正①: state → conversation_state（正しいカラム名）、
    // category は CHECK制約 IN ('pattern','style','phrase','principle') に合わせて 'pattern' を使用
    const { error: insertError } = await supabase.from("ai_reply_knowledge").insert({
      title,
      category: "pattern",
      content: parsed.learning_rule,
      conversation_state: null,
      importance: 7, // HIGH-06修正: importance=3 は min_importance=7 フィルタで除外されるため 7 に引き上げ
      hypothesis_status: "hypothesis",
      apply_count: 0,
      correct_count: 0,
      wrong_count: 0,
    });
    // 断線修正①: insert失敗の握りつぶし防止（カラム名・制約違反等を検知できるようにする）
    if (insertError) console.error("[log-aix-usage] ai_reply_knowledge insert failed:", insertError);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      conversation_id: string;
      aix_type: string;
      template_id?: string | null;
      template_name?: string | null;
      template_category?: string | null;
      conversation_status?: string | null;
      suggested_action?: string | null;
      line_message_id?: string | null;
      sent_at?: string | null;
      previous_action_type?: string | null;
      check_pattern?: string | null;
      app_sub_mode?: string | null;
      send_mode?: string | null;
      generated_text?: string | null;
      was_edited?: boolean | null;
      conversation_match?: boolean | null;
      // M1: 「物件確認した」で確認した物件名と各物件の状態（同一index対応）
      property_names?: string[] | null;
      prop_statuses?: string[] | null;
      // M2: 御見積書を同封したか / 見積書OCRで読み取った物件別の費用メモ
      estimate_sent?: boolean | null;
      prop_cost_notes?: string[] | null;
      // 改善3-c: スタッフ入力キーワード
      send_keyword?: string | null;
      // M3: 待ち合わせ場所（meeting_place AIX）の物件名・住所
      meeting_property_name?: string | null;
      meeting_property_address?: string | null;
      /** 2026-09-14: 画面で入力した待ち合わせの日付（「9/14（月）」）・時刻（「12:00」） */
      meeting_date?: string | null;
      meeting_time?: string | null;
      /** 2026-09-15 竹内（YUYA 事例）: 保証会社について の物件×保証会社×種類・並行審査ON（sent_facts の台帳でブレインが読む） */
      guarantor_properties?: Array<{ name?: string | null; company?: string | null; type?: string | null }> | null;
      parallel_screening?: boolean | null;
      /** 予約送信の予約時点（まだ送っていない）。約束のカレンダーは実送信で同期する */
      scheduled?: boolean;
    };

    const { conversation_id, aix_type, template_id, template_name, template_category, conversation_status, suggested_action, line_message_id, sent_at, previous_action_type, check_pattern, app_sub_mode, send_mode, generated_text, was_edited, conversation_match, property_names, prop_statuses, estimate_sent, prop_cost_notes, send_keyword, meeting_property_name, meeting_property_address, meeting_date, meeting_time, guarantor_properties, parallel_screening, scheduled } = body;
    if (!conversation_id || !aix_type) {
      return NextResponse.json({ ok: false, error: "conversation_id and aix_type required" }, { status: 400 });
    }

    // PA-1: 前回AIXの確実な記録
    let previousAction: string | null = previous_action_type ?? null;
    if (!previousAction) {
      const { data: prevRow } = await supabase
        .from("aix_usage_logs")
        .select("aix_type")
        .eq("conversation_id", conversation_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      previousAction = (prevRow?.aix_type as string) ?? null;
    }

    const { error } = await supabase.from("aix_usage_logs").insert({
      conversation_id,
      aix_type,
      template_id: template_id ?? null,
      template_name: template_name ?? null,
      template_category: template_category ?? null,
      conversation_status: conversation_status ?? null,
      suggested_action: suggested_action ?? null,
      line_message_id: line_message_id ?? null,
      sent_at: sent_at ?? null,
      previous_action_type: previousAction,
      check_pattern: check_pattern ?? null,
      app_sub_mode: app_sub_mode ?? null,
      send_mode: send_mode ?? null,
      generated_text: generated_text ? generated_text.slice(0, 2000) : null,
      was_edited: was_edited ?? null,
      // 「会話を合わせる」で生成された文か（analyze-aix-adapt cron の学習対象抽出に使用）
      conversation_match: conversation_match ?? null,
      // M1: 物件確認結果の永続化。property_names[i] と prop_statuses[i] が対応する。
      // brain-core.ts が select して【物件別空き状況（確定事実）】ブロックに変換する。
      // 空配列は NULL に落とす（brain 側の length>0 判定を簡潔に保つため）
      property_names: Array.isArray(property_names) && property_names.length > 0
        ? property_names.map((n) => String(n ?? "").slice(0, 100))
        : null,
      prop_statuses: Array.isArray(prop_statuses) && prop_statuses.length > 0
        ? prop_statuses.map((s) => String(s ?? "").slice(0, 40))
        : null,
      // M2: 御見積書を同封したか（estimate_sheet 以外のAIX＝物件確認したの見積書同封も「送付済み」として残す）。
      // generate-reply の estimatePromised 判定が aix_type='estimate_sheet' しか見ておらず、
      // 「物件確認した＋見積書同封」で送った直後に「御見積書を作成しお送りします」と再宣言していた。
      estimate_sent: estimate_sent === true ? true : null,
      // 見積書OCRの費用メモ（"物件名 / 初期費用合計: 〇〇円 / 割引額: 〇〇円 / クリーニング費用: 〇〇円"）。
      // brain-core が【同封済み御見積書の費用情報】としてプロンプトへ注入する
      prop_cost_notes: Array.isArray(prop_cost_notes) && prop_cost_notes.length > 0
        ? prop_cost_notes.map((n) => String(n ?? "").slice(0, 300))
        : null,
      // 改善3-c: スタッフが入力したフリーワードキーワード（aix-template-generate の続き文ragQuery に注入する）
      send_keyword: typeof send_keyword === "string" && send_keyword.trim() ? send_keyword.trim().slice(0, 200) : null,
    });

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    // 売上番長グループの「AIX要対応」: この会話の未完了を完了（一覧で✅）にする（2026-09-12 竹内方針）
    try {
      const { completeAixActionItem } = await import("@/app/lib/aix-action-items");
      await completeAixActionItem(conversation_id, aix_type);
    } catch (e) {
      console.warn("[log-aix-usage] completeAixActionItem failed:", conversation_id, e instanceof Error ? e.message : e);
    }

    // ステージ変化AIX送信 → 軽量メタパッチ更新（fire-and-forget）
    // 旧実装は last_brain_meta / brain_full_analyzed_at をクリアして次回強制フル分析を誘発していたが、
    // 前回の分析結論にAIXイベントを Haiku で差分反映し、次の顧客メッセージを cached で処理できるようにする。
    // brain_full_analyzed_at はそのまま維持（10メッセージサイクルを崩さない）。
    // 2026-09-14 竹内「自分が送った内容を記憶して次の解析に引き継ぐ」: AIX の送信を送信時の記録（sent_facts）に書く。
    //   待ち合わせ場所は画面で入力した日付・時刻・物件で内覧の記録（viewing_history）を作る／同じ日の記録を更新する。
    //   旧 M3: 既存の最新の未完了行に物件名だけを上書き（日付が違う古い行に新しい物件が載り「9/10 15:00 メゾン加美北 予定」になった。
    //   記録が無ければ何も作らず、30日の待ち合わせ場所29回中 内覧の記録ができたのは7回）
    waitUntil((async () => {
      try {
        const { recordAixFacts } = await import("@/app/lib/sent-facts");
        await recordAixFacts({
          // 2026-09-16（Fable5 批評）: 予約送信は予約時点で呼ばれる＝まだ送っていない。約束のカレンダーは実送信（send-scheduled-messages）で同期する
          skipCalendar: scheduled === true,
          conversationId: conversation_id, aixType: aix_type, sentAt: sent_at ?? new Date().toISOString(), lineMessageId: line_message_id ?? null,
          generatedText: generated_text ?? null, checkPattern: check_pattern ?? null,
          propertyNames: Array.isArray(property_names) ? property_names.map((n) => String(n ?? "")).filter(Boolean) : null,
          estimateSent: estimate_sent === true,
          meeting: aix_type === "meeting_place" ? { date: meeting_date ?? null, time: meeting_time ?? null, propertyName: meeting_property_name ?? null, address: meeting_property_address ?? null } : null,
          guarantors: aix_type === "guarantor_info" && Array.isArray(guarantor_properties)
            ? {
              properties: guarantor_properties
                .map((g) => ({ name: String(g?.name ?? "").slice(0, 100), company: String(g?.company ?? "").slice(0, 60), type: String(g?.type ?? "unknown") }))
                .filter((g) => g.name && g.company),
              parallel: parallel_screening === true,
            }
            : null,
        });
      } catch (e) { console.error("[log-aix-usage] sent_facts record failed:", e); }
    })());

    // ── 2026-09-20 竹内「物件ピックアップから送る物件もテーブルかクエリで保管したら…
    //   文生成される部分毎回直さなくて済む（退去予定物件の部分等）」────────────────────
    //   AIX が持っている property_names / prop_statuses を sent_properties にも残す。
    //   ・prop_statuses の "vacating"（退去予定あり）→ recruitment_status="move_out_planned"。
    //     この列のコメントは元から「MOVE_OUT_PATTERN regex推測の代替」で、**退去予定をデータで持つ設計**だった。
    //     実測（scripts/audit-sent-properties.ts・180日）では recruitment_status は **0%** で、
    //     退去予定の判断は今も本文の regex 推測に頼っていた。
    //   ・同じ物件の2回目は書かない（送った物件の数え方を守る）。判定は sent-property-record の純関数に一本化。
    //   ・失敗しても AIX の記録には影響させない（waitUntil の中で握る）。
    if (Array.isArray(property_names) && property_names.length > 0) {
      waitUntil((async () => {
        try {
          const { buildSentPropertyRows, isSameProperty } = await import("@/app/lib/sent-property-record");
          const { data: convRow } = await supabase.from("conversations")
            .select("property_customer_id").eq("id", conversation_id).maybeSingle();
          const rows = buildSentPropertyRows({
            conversationId: conversation_id,
            propertyCustomerId: (convRow as { property_customer_id?: string | null } | null)?.property_customer_id ?? null,
            names: property_names,
            statuses: Array.isArray(prop_statuses) ? prop_statuses : undefined,
            source: `aix:${aix_type}`,
          });
          if (rows.length === 0) return;
          const { data: already } = await supabase.from("sent_properties")
            .select("property_name, room_no").eq("conversation_id", conversation_id).limit(200);
          const existing = ((already ?? []) as Array<{ property_name: string | null; room_no: string | null }>)
            .map((r) => ({ property_name: r.property_name ?? "", room_no: r.room_no }));
          const fresh = rows.filter((r) =>
            !existing.some((e) => isSameProperty(e, { property_name: r.property_name, room_no: r.room_no })));
          if (fresh.length === 0) {
            console.log(JSON.stringify({ tag: "log-aix-usage:sent-properties", conversation_id, aix_type, inserted: 0, skipped: rows.length }));
            return;
          }
          const { error: spErr } = await supabase.from("sent_properties").insert(fresh);
          console.log(JSON.stringify({
            tag: "log-aix-usage:sent-properties", conversation_id, aix_type,
            inserted: spErr ? 0 : fresh.length, skipped: rows.length - fresh.length,
            moveOutPlanned: fresh.filter((r) => r.recruitment_status === "move_out_planned").length,
            error: spErr?.message ?? null,
          }));
        } catch (e) { console.error("[log-aix-usage] sent_properties record failed:", e); }
      })());
    }

    const STAGE_TRANSITION_AIX_TYPES = [
      "application",
      "application_push",
      "contract",
      "document_request",
      "estimate_sheet",
      "viewing_invite",
      "greeting_viewing",
      "meeting_place",
    ];
    if (STAGE_TRANSITION_AIX_TYPES.includes(aix_type)) {
      waitUntil(
        (async () => {
          try {
            // 1. 現在の last_brain_meta を取得
            const { data: convForPatch } = await supabase
              .from("conversations")
              .select("last_brain_meta")
              .eq("id", conversation_id)
              .single();

            const prevMeta = convForPatch?.last_brain_meta as Record<string, unknown> | null;
            if (!prevMeta) return; // meta がなければスキップ（通常サイクルに委譲）

            // 2. AIXタイプの意味マップ
            const AIX_STAGE_LABEL: Record<string, string> = {
              application: "申込案内AIXを送信した。次は申込書類のサポートと進捗確認が主タスク",
              application_push: "申込プッシュAIXを送信した。申込を後押しする段階",
              contract: "契約AIXを送信した。契約手続きのサポートが主タスク",
              document_request: "書類依頼AIXを送信した。書類の受取確認と案内が主タスク",
              estimate_sheet: "見積書AIXを送信した。費用について顧客が検討している段階",
              viewing_invite: "内見招待AIXを送信した。内見日程の確認・当日案内が主タスク",
              greeting_viewing: "内見挨拶AIXを送信した。内見後のフォローが主タスク",
            };
            // meeting_place は物件名・住所を動的に含める
            let stageNote = AIX_STAGE_LABEL[aix_type] ?? `${aix_type}AIXを送信した`;
            if (aix_type === "meeting_place") {
              stageNote = meeting_property_name
                ? `待ち合わせ場所AIXを送信した。案内物件: ${meeting_property_name}${meeting_property_address ? `（住所: ${meeting_property_address}）` : ""}。内見当日の現地集合案内が完了している`
                : "待ち合わせ場所AIXを送信した。内見当日の現地集合案内が完了している";
            }

            // 3. Haiku でメタを差分パッチ（既存のトップレベル import を再利用）
            const patchClient = new Anthropic({
              apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
            });

            const patchRes = await patchClient.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 600,
              messages: [{
                role: "user",
                content: `あなたはLINE返信AIの分析更新担当です。
前回の分析結論にAIX送信の事実を差分反映し、更新後のJSONを返してください。

【前回の分析結論】
${JSON.stringify(prevMeta, null, 2)}

【新たな事実】
${stageNote}

以下の2つのフィールドだけを新事実に合わせて更新し、この2つだけを JSON で返してください。変更不要なら前回の値をそのまま返してください。
- next_steps: 次のステップの配列（string[]）
- closing_strategy: クロージング戦略

JSONのみ返してください。説明文不要。`,
              }],
            }).catch(() => null);

            if (!patchRes) return;

            // 4. レスポンスをパース
            const raw = patchRes.content[0]?.type === "text" ? patchRes.content[0].text : null;
            if (!raw) return;
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return;
            const rawPatch = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
            // 2026-09-13 監査 抜け5: 旧はパッチの全キーをそのままマージしていた。action が「日本語・簡潔に」の自由文になり
            //   （ブレインの AIX キーではなくなる → 分析モード判定の prevAction が壊れる）、template_hint は許可ラベルの検査を通らず、
            //   分析の省略（cached）で {...last_brain_meta} として返信生成に流れていた。更新してよいのは次の手順と成約戦略だけ
            const patch: Record<string, unknown> = {};
            if (Array.isArray(rawPatch.next_steps) && rawPatch.next_steps.every((s) => typeof s === "string")) patch.next_steps = rawPatch.next_steps;
            if (typeof rawPatch.closing_strategy === "string" && rawPatch.closing_strategy.trim()) patch.closing_strategy = rawPatch.closing_strategy.trim();
            if (Object.keys(patch).length === 0) return;

            // 5. 前回 meta にパッチをマージして保存
            const patchedMeta = { ...prevMeta, ...patch, source: "aix_patch" };
            // 2026-09-13 2層ブレイン: 会話全体の戦略の層（brain_strategy）の次の手順・成約戦略も同じく更新する。
            //   旧: last_brain_meta だけ更新 → 毎回の分析が前提にする戦略の Step1（例: 見積書を送る）が送付後も残り、同じ AIX を再提案していた
            const { data: bsRow } = await supabase.from("conversations").select("brain_strategy").eq("id", conversation_id).maybeSingle();
            const bs = (bsRow?.brain_strategy ?? null) as Record<string, unknown> | null;
            await supabase
              .from("conversations")
              .update({
                last_brain_meta: patchedMeta,
                ...(bs ? { brain_strategy: { ...bs, ...patch, aix_patched_at: new Date().toISOString() } } : {}),
                brain_analyzed_at: new Date().toISOString(),
                // brain_full_analyzed_at はそのまま（10サイクル管理を崩さない）
              })
              .eq("id", conversation_id);
          } catch { /* fail-open: エラー時は何もせず通常サイクルに委譲 */ }
        })().catch(() => {})
      );
    }

    // ③ AIX送信後: property_customer_id を取得（要約再生成 + ギャップ分析に使う）
    const { data: convRow } = await supabase
      .from("conversations")
      .select("property_customer_id")
      .eq("id", conversation_id)
      .maybeSingle();
    const pcId = convRow?.property_customer_id as string | null;

    if (pcId) {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

      // AIX送信後に要約を再生成（状況最新化 / fire-and-forget → waitUntilで確実実行）
      waitUntil(fetch(`${baseUrl}/api/customer-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: pcId, conversation_id, fetch_from_db: true }),
      }).catch(() => {}));

      // next_action ギャップ分析（直近の未検証予測を取得して比較 / fire-and-forget）
      // 改善10: まず会話スコープ（conversation_id）で検索し、同一顧客の別会話の予測を誤検証しないようにする
      const { data: convScopedPred } = await supabase
        .from("next_action_logs")
        .select("id, predicted_action, predicted_at, conversation_id")
        .eq("conversation_id", conversation_id)
        .eq("validated", false)
        .order("predicted_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      let predRow = convScopedPred;
      if (!predRow) {
        // ヒットしない場合のみ customer_id にフォールバック（既存の挙動を維持）
        const { data: customerScopedPred } = await supabase
          .from("next_action_logs")
          .select("id, predicted_action, predicted_at, conversation_id")
          .eq("customer_id", pcId)
          .eq("validated", false)
          .order("predicted_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        predRow = customerScopedPred;
      }

      if (predRow) {
        // 二重処理防止のため先に validated=true にしてから非同期で分析
        // ⑨-1: Haiku 分析が失敗すると was_accurate が NULL のまま残るため、
        //      キーワード簡易判定の結果を暫定書き込みしておく（Haiku 成功時に runGapAnalysis が上書き）
        await supabase.from("next_action_logs")
          .update({
            validated: true,
            actual_aix_type: aix_type,
            was_accurate: keywordAccuracy(aix_type, (predRow.predicted_action as string) ?? ""),
            validated_at: new Date().toISOString(),
          })
          .eq("id", predRow.id as string);

        waitUntil(runGapAnalysis({
          predId:          predRow.id as string,
          predictedAction: predRow.predicted_action as string,
          predictedAt:     predRow.predicted_at as string,
          actualAixType:   aix_type,
          conversationId:  (predRow.conversation_id as string) ?? conversation_id,
          customerId:      pcId,
        }).catch(() => {}));
      }

      // AIX送信内容を ai_summary_json.our_actions に直接記録（fire-and-forget → waitUntilで確実実行）
      // ai_summary_at は更新しない（customer-summary のスロットリングに影響させない）
      waitUntil((async (_pcId: string) => {
        try {
          const OUR_ACTION_LABELS: Record<string, string> = {
            property_send:            "物件送付",
            viewing_invite:           "内覧誘導",
            property_recommendation:  "物件おすすめ",
            condition_hearing:        "条件ヒアリング",
            application_push:         "申込促進",
            estimate_sheet:           "見積書送付",
            property_check_result:    "物件確認",
            meeting_place:            "待ち合わせ案内",
            acknowledge_check:        "確認フォロー",
            followup_revive:          "追客フォロー",
            cost_explain:             "初期費用の説明",
            cost_breakdown:           "初期費用について",
            phone_call:               "電話をかける",
            phone_followup:           "電話終了後",
            guarantor_info:           "保証会社について",
            application:              "申込案内",
            document_request:         "書類案内",
            contract:                 "契約手続き",
            greeting:                 "初回挨拶",
            hearing:                  "ヒアリング",
            follow_up:                "フォローアップ",
          };
          const PROPERTY_RELATED = new Set(["property_send", "viewing_invite", "property_recommendation"]);

          const baseLabel = OUR_ACTION_LABELS[aix_type] ?? "AIX送信";
          let actionText: string;
          if (PROPERTY_RELATED.has(aix_type) && template_name) {
            // 物件名を付与（全体20文字以内）
            const maxPropLen = 20 - baseLabel.length - 1;
            const propName = maxPropLen > 0 ? template_name.slice(0, maxPropLen) : "";
            actionText = propName ? `${baseLabel} ${propName}` : baseLabel;
          } else {
            actionText = baseLabel;
          }

          const { data: pcRow } = await supabase
            .from("property_customers")
            .select("ai_summary_json")
            .eq("id", _pcId)
            .maybeSingle();

          if (!pcRow) return;

          const existing = ((pcRow as Record<string, unknown>).ai_summary_json ?? {}) as SummaryJson;
          const newActions = [actionText, ...(existing.our_actions ?? [])].slice(0, 3);

          await supabase
            .from("property_customers")
            .update({ ai_summary_json: { ...existing, our_actions: newActions } })
            .eq("id", _pcId);
        } catch { /* ignore - AIX本体に影響させない */ }
      })(pcId).catch(() => {}));

      // P3(削除済み): ai_reply_examples への直接INSERTは AixModal / page.tsx の
      // /api/save-reply-example 呼び出し（entry_source: "aix_action"）と二重保存になるため削除。
      // save-reply-example 側が正（実際の下書き・サブキー state・embedding・dedup・auto-star を持つ）。
    }

    return NextResponse.json({ ok: true, previous_action_type: previousAction });
  } catch (e) {
    console.error("[log-aix-usage]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
