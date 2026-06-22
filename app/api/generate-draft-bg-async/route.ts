import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

const SKIP_STATUSES = new Set(["applying", "screening", "contract", "closed_won"]);

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
        .select("status, property_customer_id, ai_draft, last_sender, customer_name")
        .eq("id", convId)
        .single();

      if (convErr) { console.error("[bg-async] conv fetch error:", convErr.message, "convId:", convId); return; }
      if (!conv) { console.error("[bg-async] conv not found:", convId); return; }
      if (conv.last_sender !== "customer") return;
      if (conv.ai_draft) return;
      if (SKIP_STATUSES.has(conv.status as string)) return;

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

      const hasStaffMsg = recentMsgs.some((m) => m.sender === "staff");
      const normalizedStatus = STATUS_ALIAS[conv.status as string] ?? conv.status;
      const effectiveState = !hasStaffMsg && normalizedStatus === "hearing" ? "first_reply" : (conv.status as string);

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
      if (isBulletConditions) {
        replyHint = `【お客様が列挙した条件・要望（返信で具体的に言及すること）】${shortLines.slice(0, 8).join("・")}`;
      } else if (hasConditionChange || hasPickupRequest) {
        replyHint = `【条件変更/ピックアップ依頼（追加質問禁止・変更内容を具体的に言葉にして即行動宣言）】${msgLines.join("・")}`;
      }

      const baseUrl = getBaseUrl();
      console.log("[bg-async] calling generate-reply at:", baseUrl, "convId:", convId, "state:", effectiveState);

      // 50秒タイムアウト（Vercel after()のウォームアップ込みで安全マージン）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 50000);

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
            recentMessages: recentMsgs,
            customerConditions,
            customerSummary: pcData?.ai_summary || "",
            replyHint,
          }),
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const isTimeout = fetchErr instanceof Error && fetchErr.name === "AbortError";
        console.error("[bg-async] fetch error:", isTimeout ? "timeout (50s)" : String(fetchErr), "baseUrl:", baseUrl, "convId:", convId);
        return;
      }

      if (!draftRes.ok || !draftRes.body) {
        console.error("[bg-async] generate-reply non-ok:", draftRes.status, draftRes.statusText, "convId:", convId);
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
        // 部分テキストがあれば保存を試みる
        if (fullText.trim().length > 20) {
          await db.from("conversations").update({ ai_draft: fullText.trim() }).eq("id", convId);
          console.log("[bg-async] saved partial draft:", fullText.length, "chars, convId:", convId);
        }
        return;
      }

      const finalDraft = fullText.trim();
      if (finalDraft) {
        const { error: saveErr } = await db.from("conversations").update({ ai_draft: finalDraft }).eq("id", convId);
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
