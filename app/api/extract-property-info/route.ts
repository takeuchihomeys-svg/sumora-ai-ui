import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { readPropertyImage } from "@/app/lib/property-image-read";

// 2026-09-22 竹内「画像から物件名などを読み取る処理 deepseek に置き換える」:
//   旧は Claude Haiku Vision。送信時の読み取り（send-line-message）と同じ DeepSeek-V4.1-Flash・同じ聞き方
//   （PROPERTY_IMAGE_PROMPT）に揃えた。推論モデルなので数秒〜20秒かかる → 上限を延ばす。
//   呼び出し元（画面の送信・AIX 物件オススメ）はどちらも結果を待たない（裏で動く）ので、送信は遅くならない
export const maxDuration = 90;

// ─── Levenshtein distance ────────────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = edit distance between a[0..i-1] and b[0..j-1]
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function stringSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.trim().toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ─── POST handler ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      image_url?: string;
      conversation_id?: string;
      property_customer_id?: string;
    };

    const { image_url, conversation_id, property_customer_id: bodyPcId } = body;

    if (!image_url) {
      return NextResponse.json({ error: "image_url は必須です" }, { status: 400 });
    }
    if (!conversation_id) {
      return NextResponse.json({ error: "conversation_id は必須です" }, { status: 400 });
    }

    // ── 1. Resolve property_customer_id ──────────────────────────────────────
    let propertyCustomerId: string | null = bodyPcId ?? null;
    if (!propertyCustomerId) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("property_customer_id")
        .eq("id", conversation_id)
        .single();
      propertyCustomerId = conv?.property_customer_id ?? null;
    }

    // ── 2. 画像の読み取り（DeepSeek・送信時の読み取りと同じ関数） ─────────────────
    //   見積書・本人確認書類など物件資料でない画像は is_property=false で返る → 物件として記録しない
    //   （旧 Haiku は見積書からも物件名を拾って sent_properties に入れていた）
    const read = await readPropertyImage(image_url, { timeoutMs: 80_000 });
    const top = read.isProperty ? read.items[0] : undefined;
    // 2026-09-22 実測: カタカナの物件名はモデルを問わず読み違える（DeepSeek「ワールドアイ」→「ワールドワイド」／
    //   旧 Haiku「グランエクラ今宮戎 601」→「グランエクラ合成 001」）。送信時の読み取りと同じく、
    //   **この会話に出ている物件名と照合して**寄せる。照合できなければ読んだ名前のまま（今までどおり記録はする）
    let matched = false;
    let named = top;
    if (top) {
      const [{ resolveReadProperty }, { extractPropertyLabels }] = await Promise.all([
        import("@/app/lib/property-name-match"),
        import("@/app/lib/action-ledger"),
      ]);
      const known = new Set<string>();
      const { data: sp } = await supabase.from("sent_properties").select("property_name").eq("conversation_id", conversation_id).limit(50);
      for (const r of (sp ?? []) as Array<{ property_name: string | null }>) if (r.property_name) known.add(r.property_name.trim());
      const { data: ms } = await supabase.from("messages").select("text").eq("conversation_id", conversation_id).order("created_at", { ascending: false }).limit(80);
      for (const lbl of extractPropertyLabels(((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n"))) {
        known.add(lbl.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim());
      }
      const fixed = resolveReadProperty(top, [...known].filter((s) => s.length >= 2));
      if (fixed) { named = fixed; matched = true; }
    }
    const propertyName: string | null = named?.propertyName?.trim() || null;
    const roomNo: string | null = named?.roomNumber?.trim() || null;
    console.log(JSON.stringify({
      tag: "extract-property-info:read", model: "deepseek", conversationId: conversation_id,
      isProperty: read.isProperty, items: read.items.length, found: !!propertyName, matched, tokens: read.usage ?? null,
      raw: propertyName ? undefined : read.raw.slice(0, 80),
    }));

    // ── 3. Duplicate check ───────────────────────────────────────────────────
    let isDuplicate = false;
    let duplicateInfo: { sent_at: string; property_name: string; room_no: string } | null =
      null;

    if (propertyCustomerId && propertyName && roomNo) {
      const { data: existing } = await supabase
        .from("sent_properties")
        .select("property_name, room_no, sent_at")
        .eq("property_customer_id", propertyCustomerId)
        .order("sent_at", { ascending: false });

      if (existing && existing.length > 0) {
        for (const row of existing as Array<{ property_name: string; room_no: string; sent_at: string }>) {
          const roomMatch =
            row.room_no.trim().toLowerCase() === roomNo.toLowerCase();
          const nameSim = stringSimilarity(row.property_name, propertyName);
          // Duplicate: exact room_no match AND property_name similarity > 80%
          if (roomMatch && nameSim > 0.8) {
            isDuplicate = true;
            duplicateInfo = {
              sent_at: row.sent_at,
              property_name: row.property_name,
              room_no: row.room_no,
            };
            break;
          }
        }
      }
    }

    // ── 3.5 画像 → 物件の対応は重複でも必ず残す（2026-09-15 竹内・みく事例）──────────
    //   お客様が引用返信で「こちら３階は空きありますか？」と聞いた時に、引用先の画像がどの物件かを直すため（quoted-context）。
    //   sent_properties は同じ物件の2回目以降の画像（御見積書・送り直し）を重複として書かないので、画像ごとの対応はこちら
    // 2026-09-22: 送信時の読み取り（send-line-message）は会話に出ている物件名と**照合してから**書く。
    //   こちらは照合しないので、既に記録がある時は上書きしない（旧は後から書いた方が残り、照合済みの名前が消える事があった）
    if (propertyName) {
      const { error: mapErr } = await supabase.from("sent_image_properties").upsert(
        { image_url, conversation_id, property_name: propertyName, room_no: roomNo, source: "vision" },
        { onConflict: "image_url", ignoreDuplicates: true },
      );
      if (mapErr) console.warn("[extract-property-info] sent_image_properties upsert failed:", mapErr.message);
    }

    // ── 4. Save to sent_properties ───────────────────────────────────────────
    let insertErrorMessage: string | null = null;
    if (propertyName && roomNo && !isDuplicate) {
      const { error: insertError } = await supabase
        .from("sent_properties")
        .insert({
          property_customer_id: propertyCustomerId ?? null,
          conversation_id,
          property_name: propertyName,
          room_no: roomNo,
          image_url,
          source: "vision",
        });
      if (insertError) {
        console.error("[extract-property-info] insert error:", insertError.message);
        insertErrorMessage = insertError.message;
      }
    }

    return NextResponse.json({
      ok: true,
      property_name: propertyName,
      room_no: roomNo,
      is_duplicate: isDuplicate,
      insert_error: insertErrorMessage,
      ...(duplicateInfo ? { duplicate_info: duplicateInfo } : {}),
    });
  } catch (err) {
    console.error("[extract-property-info]", err);
    return NextResponse.json(
      { error: "物件情報の抽出に失敗しました" },
      { status: 500 }
    );
  }
}
