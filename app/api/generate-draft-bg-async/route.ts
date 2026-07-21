import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 300;

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

const SKIP_STATUSES = new Set(["applying", "application", "screening", "contract", "closed_won", "closed_lost"]);

const STATUS_ALIAS: Record<string, string> = {
  first_reply:             "hearing",
  condition_hearing:       "hearing",
  property_search:         "hearing",
  property_recommendation: "proposing",
  viewing:                 "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  application:             "applying",
  screening:               "applying",
  contract:                "applying",
};

function getBaseUrl(): string {
  // 優先順位: 手動設定 > 本番URL > デプロイURL > ローカル
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { conversation_id?: string; memo?: string };
  const convId = body.conversation_id;
  const memo = body.memo || "";
  if (!convId) return NextResponse.json({ ok: false }, { status: 400 });

  // 即200返却 → after()でバックグラウンド生成（Realtimeで通知）
  after(async () => {
    const db = getDb();
    try {
      const { data: conv, error: convErr } = await db
        .from("conversations")
        .select("status, property_customer_id, ai_draft, last_sender, customer_name, draft_fail_count")
        .eq("id", convId)
        .single();

      if (convErr) { console.error("[bg-async] conv fetch error:", convErr.message, "convId:", convId); return; }
      if (!conv) { console.error("[bg-async] conv not found:", convId); return; }
      if (conv.last_sender !== "customer") return;
      if (conv.ai_draft) return;
      if (SKIP_STATUSES.has(conv.status as string)) return;

      // Atomic claim: 並列bg-asyncが同じ会話を重複生成するのを防ぐ
      // draft_attempted_atが5分以内に設定済みの場合はスキップ
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: claimed } = await db.from("conversations")
        .update({ draft_attempted_at: new Date().toISOString() })
        .eq("id", convId)
        .is("ai_draft", null)
        .or(`draft_attempted_at.is.null,draft_attempted_at.lt.${fiveMinAgo}`)
        .select("id");
      if (!claimed?.length) {
        console.log("[bg-async] 同時生成をスキップ（atomic claim失敗）, convId:", convId);
        return;
      }

      const [{ data: msgs, error: msgsErr }, { data: pc }] = await Promise.all([
        db.from("messages").select("sender, text, created_at").eq("conversation_id", convId)
          .order("created_at", { ascending: false }).limit(20),
        conv.property_customer_id
          ? db.from("property_customers")
            .select("customer_name, desired_area, floor_plan, rent_min, rent_max, ai_summary, preferences, ng_points, walk_minutes, move_in_time, building_age, other_requests, additional_conditions")
            .eq("id", conv.property_customer_id).single()
          : Promise.resolve({ data: null }),
      ]);

      if (msgsErr) { console.error("[bg-async] msgs fetch error:", msgsErr.message); return; }

      const recentMsgs = ((msgs || []) as Array<{ sender: string; text: string; created_at?: string }>)
        .reverse()
        .map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));

      // 直近20件にスタッフ返信があるか確認
      const hasStaffInLast20 = recentMsgs.some((m) => m.sender === "staff");

      // 直近20件にスタッフ返信がない場合: 全履歴から最新スタッフ返信を取得してコンテキストに注入
      // - hasAnyStaffMsg: 過去に返信済みか（effectiveState=first_reply 判定精度向上）
      // - 見つかれば先頭追加（generateReplyの inject last staff ロジックと統一）
      let hasAnyStaffMsg = hasStaffInLast20;
      let recentMsgsForGen = recentMsgs;
      if (!hasStaffInLast20) {
        const { data: lastStaffData } = await db.from("messages")
          .select("sender, text, created_at")
          .eq("conversation_id", convId)
          .eq("sender", "staff")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastStaffData) {
          hasAnyStaffMsg = true;
          recentMsgsForGen = [
            { sender: "staff", text: (lastStaffData.text as string) || "", createdAt: lastStaffData.created_at as string | undefined },
            ...recentMsgs,
          ];
        }
      }

      const normalizedStatus = STATUS_ALIAS[conv.status as string] ?? conv.status;
      const effectiveState = !hasAnyStaffMsg && normalizedStatus === "hearing" ? "first_reply" : (conv.status as string);

      // targetMessage は元のrecentMsgs（注入なし）から計算
      const lastStaffIdx = recentMsgs.map((m, i) => m.sender === "staff" ? i : -1).filter((i) => i >= 0).at(-1);
      const msgsAfterStaff = lastStaffIdx !== undefined ? recentMsgs.slice(lastStaffIdx + 1) : recentMsgs;
      const unreplied = msgsAfterStaff
        .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
        .slice(-3);
      const targetMessage = unreplied.map((m) => m.text).join("\n");

      if (!targetMessage.trim()) return;

      type PC = { customer_name?: string; desired_area?: string; floor_plan?: string; rent_min?: number; rent_max?: number; ai_summary?: string; preferences?: string; ng_points?: string; walk_minutes?: number; move_in_time?: string; building_age?: number; other_requests?: string; additional_conditions?: string } | null;
      const pcData = pc as PC;
      // formatConditions と同じロジックで全フィールドを統一フォーマット
      const dbConditions = [
        pcData?.desired_area && `エリア: ${pcData.desired_area}`,
        pcData?.floor_plan && `間取り: ${pcData.floor_plan}`,
        (pcData?.rent_min || pcData?.rent_max) && `家賃: ${[pcData.rent_min ? Math.floor(pcData.rent_min / 10000) + "万円〜" : "", pcData.rent_max ? Math.floor(pcData.rent_max / 10000) + "万円以内" : ""].join("")}`,
        pcData?.walk_minutes && `駅徒歩: ${pcData.walk_minutes}分以内`,
        pcData?.move_in_time && `入居: ${pcData.move_in_time}`,
        pcData?.building_age && `築年数: ${pcData.building_age}年以内`,
        pcData?.preferences && `希望: ${pcData.preferences}`,
        pcData?.ng_points && `NG: ${pcData.ng_points}`,
        pcData?.other_requests && `その他: ${pcData.other_requests}`,
        pcData?.additional_conditions && (() => {
          const clean = pcData.additional_conditions!.split("\n").map((l) => l.replace(/^【[^】]*】/, "").trim()).filter(Boolean).join("、");
          return clean ? `追加条件: ${clean}` : null;
        })(),
      ].filter(Boolean).join("\n");
      const customerConditions = dbConditions || memo;

      // お客様メッセージから返信ヒントを自動抽出
      const msgLines = targetMessage.split("\n").map((l) => l.trim()).filter(Boolean);

      // ① 箇条書き条件（3行以上の短い行）
      const shortLines = msgLines.filter((l) => l.length <= 25);
      const isBulletConditions = shortLines.length >= 3;

      // ② 条件変更・緩和キーワード（1〜2行でも発火）
      const COND_RE = /[0-9０-９]+万|[0-9０-９]+LDK|[0-9０-９]+[KDk]|エリア|区|駅|間取り|家賃|広さ|㎡|ペット|駐車場|築/;
      const ACT_RE = /含めて|を外|に変え|以上|以下|でも可|気にしな|上げて|下げて|緩め|広げ|に絞|でお願い|から探|も探/;
      const PICKUP_RE = /ありませんか|ありますか|送って|ピックアップ|おすすめ|オススメ|出てます|教えて/;
      const hasConditionChange = msgLines.some((l) => COND_RE.test(l) && ACT_RE.test(l));
      const hasPickupRequest = msgLines.some((l) => PICKUP_RE.test(l));

      let replyHint = "";
      // first_reply は phase_guide の パターンA が最適対応（挨拶+条件復唱+ピックアップ宣言）
      // replyHint を渡すと指定生成モード「2〜3行制限」が発動してパターンAが潰されるため除外
      if (effectiveState !== "first_reply") {
        if (isBulletConditions) {
          replyHint = `【お客様が列挙した条件・要望（返信で具体的に言及すること）】${shortLines.slice(0, 8).join("・")}`;
        } else if (hasConditionChange || hasPickupRequest) {
          replyHint = `【条件変更/ピックアップ依頼（追加質問禁止・変更内容を具体的に言葉にして即行動宣言）】${msgLines.join("・")}`;
        }
      }

      const baseUrl = getBaseUrl();
      console.log("[bg-async] calling generate-reply at:", baseUrl, "convId:", convId, "state:", effectiveState);

      // 150秒タイムアウト: generate-replyはStep1(最大45s)+Step2(最大45s)+余裕=最大90s超。
      // 40秒では重い会話で構造的に常にタイムアウトするため150秒に引き上げ（after()maxDuration=300s内）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 150000);

      let draftRes: Response;
      try {
        draftRes = await fetch(`${baseUrl}/api/generate-reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            message: targetMessage,
            state: effectiveState,
            // 紐付き顧客名 → なければ conversationsの表示名（LINEの名前）をフォールバック
            customerName: pcData?.customer_name || (conv.customer_name as string) || "",
            recentMessages: recentMsgsForGen,
            customerConditions,
            customerSummary: pcData?.ai_summary || "",
            replyHint,
            // RLHF断絶修正: conversationId を渡して generate-reply 側の logKnowledgeApply を発火させる
            // （knowledge_apply_log 記録 → text_retention / deal_outcome フィードバック対象化）
            // ※ generate-reply 側も ai_draft を保存するが同一内容の冪等上書きのため二重化の実害なし
            conversationId: convId,
          }),
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const isTimeout = fetchErr instanceof Error && fetchErr.name === "AbortError";
        const errMsg = isTimeout ? "timeout (150s)" : String(fetchErr);
        console.error("[bg-async] fetch error:", errMsg, "baseUrl:", baseUrl, "convId:", convId);
        // draft_attempted_at は上書きしない（クレーム時のタイムスタンプを維持 → 10分バックオフ有効）
        await db.from("conversations").update({
          draft_fail_count: (conv.draft_fail_count ?? 0) + 1,
          draft_last_error: errMsg.slice(0, 500),
        }).eq("id", convId);
        return;
      }

      if (!draftRes.ok || !draftRes.body) {
        const errMsg = `generate-reply non-ok: ${draftRes.status} ${draftRes.statusText}`;
        console.error("[bg-async]", errMsg, "convId:", convId);
        // draft_attempted_at は上書きしない（10分バックオフ有効）
        await db.from("conversations").update({
          draft_fail_count: (conv.draft_fail_count ?? 0) + 1,
          draft_last_error: errMsg,
        }).eq("id", convId);
        return;
      }

      const reader = draftRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", metaDone = false, fullText = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (!metaDone) {
            buffer += chunk;
            const nl = buffer.indexOf("\n");
            if (nl >= 0) {
              try {
                const meta = JSON.parse(buffer.slice(0, nl)) as { ok: boolean };
                if (!meta.ok) { console.error("[bg-async] generate-reply meta.ok=false, convId:", convId); return; }
              } catch (parseErr) {
                console.error("[bg-async] meta parse error:", String(parseErr), "buffer:", buffer.slice(0, 100), "convId:", convId);
                return;
              }
              metaDone = true;
              fullText = buffer.slice(nl + 1);
            }
          } else {
            fullText += chunk;
          }
        }
      } catch (streamErr) {
        console.error("[bg-async] stream read error:", String(streamErr), "convId:", convId, "partial text length:", fullText.length);
        // 部分テキストがあれば保存を試みる（内部タグは除去）
        const partialDraft = fullText
          .replace(/\n?<<<SUGGESTED_AIX:[\s\S]*?>>>/g, "")
          .replace(/\n?<<<STOP_REASON:[\w-]*>>>/g, "")
          .trim();
        if (partialDraft.length > 20) {
          await db.from("conversations").update({ ai_draft: partialDraft, draft_pending_at: null }).eq("id", convId);
          console.log("[bg-async] saved partial draft:", partialDraft.length, "chars, convId:", convId);
        }
        return;
      }

      // 内部タグ（<<<SUGGESTED_AIX:{...}>>> / <<<STOP_REASON:xxx>>>）を本文から除去してから保存
      // （generate-reply はストリーム末尾にトレーラーを付加するため、未除去のまま保存すると内部指示が顧客に届く事故になる）
      const finalDraft = fullText
        .replace(/\n?<<<SUGGESTED_AIX:[\s\S]*?>>>/g, "")
        .replace(/\n?<<<STOP_REASON:[\w-]*>>>/g, "")
        .trim();
      if (finalDraft) {
        // ai_draft IS NULL ガード: 人間が編集中の場合は上書きしない
        const { error: saveErr } = await db.from("conversations")
          .update({ ai_draft: finalDraft, draft_pending_at: null, draft_fail_count: 0 })
          .eq("id", convId)
          .is("ai_draft", null);
        if (saveErr) {
          console.error("[bg-async] save error:", saveErr.message, "convId:", convId);
        } else {
          console.log("[bg-async] draft saved OK, length:", finalDraft.length, "convId:", convId);
        }
      } else {
        console.error("[bg-async] empty draft, convId:", convId, "targetMessage:", targetMessage.slice(0, 50));
      }
    } catch (err) {
      console.error("[bg-async] unhandled error:", String(err), "convId:", convId);
    }
  });

  return NextResponse.json({ ok: true });
}
