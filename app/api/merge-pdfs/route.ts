import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { supabase } from "@/app/lib/supabase";

const HANBANCYO_TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";

async function getGroupId(): Promise<string | null> {
  const { data } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .single();
  return data?.value ?? null;
}

function buildLineMessage(
  fileUrl: string,
  fileName: string,
  pageCount: number,
  customerName: string | null | undefined,
  propertySummaries: string[] | null | undefined,
): string {
  const lines: string[] = [];

  // お客さん名を最初に・物件情報を続ける
  if (customerName) {
    lines.push(`👤 ${customerName}様`);
    lines.push(`🏠 物件（${pageCount}件）`);
  } else {
    lines.push(`🏠 物件（${pageCount}件）`);
  }
  lines.push("━━━━━━━━━━━━━━");

  // 物件サマリー（1件ずつ）
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
  const res = await fetch(url, {
    headers: {
      Cookie: cookieStr,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.realnetpro.com/",
      Accept: "application/pdf,*/*",
    },
    redirect: "follow",
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
    };

    const { pdf_data, pdf_urls, cookie_str, file_name, send_to_line, customer_name, property_summaries } = body;

    // PDF データを収集
    let pdfBase64List: string[] = [];

    if (pdf_urls && pdf_urls.length > 0) {
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
    const today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
    const name = file_name || `物件まとめ_${today}.pdf`;

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

        // 結合済みPDFをBlobに保存
        const blob = await put(name, Buffer.from(mergedBytes), {
          access: "public",
          contentType: "application/pdf",
          allowOverwrite: true,
        });

        // 一時ファイル(itandiアップ分)を削除してBlobストレージを掃除
        // pdf_urlsが提供されていた場合（=itandi方式）、アップロードした一時ファイルを削除
        if (pdf_urls && pdf_urls.length > 0) {
          del(pdf_urls).catch((e) =>
            console.warn("[merge-pdfs] 一時Blob削除失敗（無視して続行）:", e)
          );
        }

        const lineText = buildLineMessage(
          blob.url,
          name,
          merged.getPageCount(),
          customer_name,
          property_summaries,
        );
        await pushLineMessage(groupId, lineText);
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
