import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 90;

const HANBANCYO_TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";

// SSRF対策: pdf_urls のドメイン allowlist
// - realnetpro.com（リアプロ）
// - vercel-storage.com / blob.vercel-storage.com（Vercel Blob の一時アップロード先）
const ALLOWED_PDF_HOST_SUFFIXES = ["realnetpro.com", "vercel-storage.com"];

// Cookie（リアプロ認証情報）を送信してよいホスト（リアプロのみ）
const COOKIE_ALLOWED_HOST_SUFFIXES = ["realnetpro.com"];

function hostMatchesSuffix(hostname: string, suffixes: string[]): boolean {
  const host = hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isAllowedPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return hostMatchesSuffix(parsed.hostname, ALLOWED_PDF_HOST_SUFFIXES);
  } catch {
    return false;
  }
}

function isCookieAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return hostMatchesSuffix(parsed.hostname, COOKIE_ALLOWED_HOST_SUFFIXES);
  } catch {
    return false;
  }
}

async function getGroupId(): Promise<string | null> {
  const { data } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .single();
  return data?.value ?? null;
}

async function rankAndAnnotateSummaries(summaries: string[], customerConditions?: string | null): Promise<string[]> {
  if (summaries.length <= 1) return summaries;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "") });
    const conditionsBlock = customerConditions
      ? `【お客様の希望条件（最優先で照らし合わせること）】\n${customerConditions}\n\n`
      : "";
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `以下の物件一覧を見て、お客様に最もオススメの物件番号（1始まり）を選んでください。上位1〜3件をJSONで返してください。JSONのみ返すこと。

${conditionsBlock}判断基準（優先順位が高い順）:
1. お客様希望条件への合致度（最優先）:
   - 家賃が希望予算以内か
   - 間取りが希望と一致するか
   - 徒歩分数が希望以内か
   - 専有面積が希望以上か
   - 敷・礼が0ヶ月に近いほど良い（なし > 1ヶ月 > 2ヶ月以上）
   ※ 予算を大幅に超える・希望外間取りの物件は絶対に選ばないこと
2. AD（仲介手数料の追加報酬・重要）:
   - 「AD 2ヶ月」= 家賃×2ヶ月分の追加報酬（非常に優先）
   - 「AD 1ヶ月」= 家賃×1ヶ月分の追加報酬（優先）
   - AD記載なし = 追加報酬ゼロ
3. ㎡あたりの家賃（安いほど良い）
4. 間取りと面積の広さ（2LDK>1LDK>1DK>1K>1R、かつ㎡数が大きいほど良い）
5. 駅からの徒歩分数（近いほど良い）

${summaries.join('\n\n')}

例: {"recommended":[2,5]}`
      }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const match = text.match(/"recommended"\s*:\s*\[([^\]]*)\]/);
    if (!match) return summaries;
    const recommendedArr = match[1].split(",").map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    const topPickNum = recommendedArr[0]; // AIの真の1位（配列の先頭が最高スコア）
    const recommended = new Set(recommendedArr);
    return summaries.map((summary, i) => {
      if (!recommended.has(i + 1)) return summary;
      const lines = summary.split("\n");
      // 真の1位は🌟★、それ以外の推薦は🌟のみ（buildLineMessageで区別するため）
      const marker = (i + 1) === topPickNum ? "【$1🌟★】" : "【$1🌟】";
      lines[0] = lines[0].replace(/^【(\d+)】/, marker);
      return lines.join("\n");
    });
  } catch (e) {
    console.warn("[merge-pdfs] AI ranking skipped:", e);
    return summaries;
  }
}

function buildLineMessage(
  fileUrl: string,
  fileName: string,
  pageCount: number,
  customerName: string | null | undefined,
  propertySummaries: string[] | null | undefined,
  sourceLabel?: string,
): string {
  const lines: string[] = [];
  const src = sourceLabel || "リアプロ";

  // ヘッダー
  if (customerName) {
    const nameWithSan = customerName.endsWith("さん") ? customerName : `${customerName}さん`;
    lines.push(`${nameWithSan} 物件（${src}）`);
  } else {
    lines.push(`物件（${src}）`);
  }

  // 🌟一番オススメ（🌟付き物件の先頭に単独表示）
  if (propertySummaries && propertySummaries.length > 0) {
    // 🌟★ = AIの真の1位を優先、なければ最初の🌟（後方互換フォールバック）
    const topPick = propertySummaries.find(s => s.split("\n")[0].includes("🌟★"))
      ?? propertySummaries.find(s => s.split("\n")[0].includes("🌟"));
    if (topPick) {
      lines.push("━━━━━━━━━━━━━━");
      lines.push("🌟 一番オススメ");
      const topLines = topPick.split("\n");
      const topName = topLines[0].replace(/^【\d+🌟★?】\s*/, "").trim();
      if (topName) lines.push(topName);
      topLines.slice(1).forEach(l => { if (l.trim()) lines.push(l); });
    }
  }

  lines.push("━━━━━━━━━━━━━━");

  // 物件一覧
  if (propertySummaries && propertySummaries.length > 0) {
    propertySummaries.forEach((summary) => {
      lines.push(summary);
      lines.push("");
    });
    lines.push("━━━━━━━━━━━━━━");
  }

  // PDFリンク
  lines.push("📄 物件PDF");
  lines.push(fileUrl);

  return lines.join("\n");
}

async function pushLineMessage(groupId: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HANBANCYO_TOKEN}`,
    },
    body: JSON.stringify({
      to: groupId,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LINE API エラー HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function fetchPdfAsBase64(url: string, cookieStr: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: "https://www.realnetpro.com/",
    Accept: "application/pdf,*/*",
  };
  // Cookie（リアプロ認証情報）は許可ドメイン（リアプロ）にのみ送信する
  if (cookieStr && isCookieAllowedUrl(url)) {
    headers.Cookie = cookieStr;
  }
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`PDF取得失敗: HTTP ${res.status} (${url})`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) {
    throw new Error("PDFではなくHTMLが返されました。リアプロのセッションが切れています。再ログインしてください。");
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      pdf_data?: string[];
      pdf_urls?: string[];
      cookie_str?: string;
      file_name?: string;
      send_to_line?: boolean;
      customer_name?: string | null;
      property_summaries?: string[] | null;
      customer_conditions?: string | null;
      site?: string | null;
      property_customer_id?: string | null;
      conversation_id?: string | null;
    };

    const { pdf_data, pdf_urls, cookie_str, file_name, send_to_line, customer_name, property_summaries, customer_conditions, site, property_customer_id, conversation_id } = body;

    // PDF データを収集
    let pdfBase64List: string[] = [];

    if (pdf_urls && pdf_urls.length > 0) {
      // SSRF対策: 許可ドメイン以外のURLは拒否
      const invalidUrl = pdf_urls.find((url) => !isAllowedPdfUrl(url));
      if (invalidUrl) {
        return NextResponse.json(
          { error: `許可されていないURLです: ${invalidUrl}（realnetpro.com / Vercel Blob のみ許可）` },
          { status: 400 }
        );
      }
      // cookie_str なしでも公開URL（Vercel Blob等）は取得可能
      pdfBase64List = await Promise.all(
        pdf_urls.map((url) => fetchPdfAsBase64(url, cookie_str ?? ""))
      );
    } else if (pdf_data && pdf_data.length > 0) {
      pdfBase64List = pdf_data;
    } else {
      return NextResponse.json({ error: "pdf_urls または pdf_data が必要です" }, { status: 400 });
    }

    // PDFを結合
    const merged = await PDFDocument.create();
    for (const b64 of pdfBase64List) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      let srcDoc: PDFDocument;
      try {
        srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      } catch {
        continue;
      }
      const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    if (merged.getPageCount() === 0) {
      return NextResponse.json({ error: "有効なPDFページがありませんでした" }, { status: 400 });
    }

    const mergedBytes = await merged.save();
    const base64Result = Buffer.from(mergedBytes).toString("base64");
    const today = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }).replace(/\//g, "-");
    // タイムスタンプで一意なファイル名にしてCDNキャッシュの古いPDF誤返却を防ぐ
    // allowOverwrite:true でも Vercel Blob CDN は同じURLをキャッシュし続けるため
    const baseName = (file_name || `物件まとめ_${today}`).replace(/\.pdf$/i, "");
    const name = `${baseName}_${Date.now()}.pdf`;

    // LINE送信
    if (send_to_line) {
      if (!HANBANCYO_TOKEN) {
        return NextResponse.json({ ok: false, error: "LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN が未設定です（Vercel環境変数を確認してください）" }, { status: 500 });
      }
      const groupId = await getGroupId();
      if (!groupId) {
        return NextResponse.json({ ok: false, error: "hanbancyo_settings に group_id が登録されていません" }, { status: 500 });
      }
      try {
        const { put, del } = await import("@vercel/blob");

        // 結合済みPDFをBlobに保存（一意なファイル名なので allowOverwrite 不要）
        const blob = await put(name, Buffer.from(mergedBytes), {
          access: "public",
          contentType: "application/pdf",
        });

        // 一時ファイル(itandiアップ分)を削除してBlobストレージを掃除
        // pdf_urlsが提供されていた場合（=itandi方式）、アップロードした一時ファイルを削除
        if (pdf_urls && pdf_urls.length > 0) {
          del(pdf_urls).catch((e) =>
            console.warn("[merge-pdfs] 一時Blob削除失敗（無視して続行）:", e)
          );
        }

        const rankedSummaries = property_summaries && property_summaries.length > 0
          ? await rankAndAnnotateSummaries(property_summaries, customer_conditions)
          : property_summaries;
        const lineText = buildLineMessage(
          blob.url,
          name,
          merged.getPageCount(),
          customer_name,
          rankedSummaries,
          site === "itandi" ? "itandi" : site === "realpro" ? "リアプロ" :
            (pdf_urls && pdf_urls.some(u => !u.includes("realnetpro"))) ? "itandi" : "リアプロ",
        );
        await pushLineMessage(groupId, lineText);

        // 送付物件を sent_properties に記録（source: "line_group" でVision OCR経由と区別）
        // insert失敗してもLINE送信自体は成功として扱う（レスポンスは変えない）
        try {
          // property_customer_id はbody優先。無ければ conversation_id から lookup
          let propertyCustomerId: string | null = property_customer_id ?? null;
          if (!propertyCustomerId && conversation_id) {
            const { data: conv } = await supabase
              .from("conversations")
              .select("property_customer_id")
              .eq("id", conversation_id)
              .single();
            propertyCustomerId = conv?.property_customer_id ?? null;
          }

          const summariesToRecord =
            rankedSummaries && rankedSummaries.length > 0
              ? rankedSummaries
              : property_summaries ?? [];

          // 物件名・号室を全件抽出
          type PropInfo = { propertyName: string; roomNo: string };
          const propInfoList: PropInfo[] = summariesToRecord.flatMap((summary) => {
            const firstLine = (summary.split("\n")[0] ?? "")
              .replace(/^【\d+🌟?★?】\s*/, "")
              .trim();
            if (!firstLine) return [];
            const roomMatch = firstLine.match(/[\s　]+(\d{1,4})(?:号室?)?$/);
            const roomNo = roomMatch ? roomMatch[1] : "";
            const propertyName = roomMatch
              ? firstLine.slice(0, (roomMatch.index ?? 0)).trim()
              : firstLine;
            if (!propertyName) return [];
            return [{ propertyName, roomNo }];
          });

          if (propInfoList.length > 0) {
            // 1回の SELECT で全物件の重複チェック（N+1 → 1クエリに削減）
            const propertyNames = propInfoList.map((p) => p.propertyName);
            let dupQuery = supabase
              .from("sent_properties")
              .select("property_name, room_no")
              .in("property_name", propertyNames);
            if (propertyCustomerId) {
              dupQuery = dupQuery.eq("property_customer_id", propertyCustomerId);
            } else if (conversation_id) {
              dupQuery = dupQuery.eq("conversation_id", conversation_id);
            }
            const { data: existingRows } = await dupQuery;
            const existingSet = new Set(
              (existingRows ?? []).map((r) => `${r.property_name}__${r.room_no}`)
            );

            // 未登録の物件を一括 INSERT（N回 → 1クエリに削減）
            const toInsert = propInfoList
              .filter((p) => !existingSet.has(`${p.propertyName}__${p.roomNo}`))
              .map((p) => ({
                property_customer_id: propertyCustomerId,
                conversation_id: conversation_id ?? null,
                property_name: p.propertyName,
                room_no: p.roomNo,
                source: "line_group",
              }));
            if (toInsert.length > 0) {
              const { error: insertError } = await supabase
                .from("sent_properties")
                .insert(toInsert);
              if (insertError) {
                console.error("[merge-pdfs] sent_properties 一括insert失敗（続行）:", insertError.message);
              }
            }
          }
        } catch (histErr) {
          console.error("[merge-pdfs] sent_properties 記録処理失敗（LINE送信は成功扱い）:", histErr);
        }

        return NextResponse.json({ ok: true, line_sent: true, url: blob.url });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[merge-pdfs] LINE送信失敗:", msg);
        return NextResponse.json({ ok: false, error: "LINE送信失敗: " + msg }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, pdf: base64Result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
