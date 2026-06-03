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

async function pushLineFile(groupId: string, fileUrl: string, fileName: string, pageCount: number) {
  const text = `📎 物件まとめPDF（${pageCount}枚）\n${fileName}\n\n↓ダウンロードリンク↓\n${fileUrl}\n\n※リンクをタップしてPDFを開いてください`;
  await fetch("https://api.line.me/v2/bot/message/push", {
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
}

// サーバー側でPDFを代理取得（クッキーを使って認証済みリクエスト）
async function fetchPdfAsBase64(url: string, cookieStr: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Cookie: cookieStr,
      // リアプロが通常のブラウザリクエストと見なすようにヘッダーを付加
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
    throw new Error(`PDFではなくHTMLが返されました。リアプロのセッションが切れている可能性があります。再ログインしてください。`);
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      pdf_data?: string[];        // 既存: base64済みPDF配列
      pdf_urls?: string[];        // 新方式: URLリスト（cookie_strと一緒に使う）
      cookie_str?: string;        // 新方式: リアプロのセッションクッキー文字列
      file_name?: string;
      send_to_line?: boolean;
    };

    const { pdf_data, pdf_urls, cookie_str, file_name, send_to_line } = body;

    // PDF データを収集（URL方式 or base64方式）
    let pdfBase64List: string[] = [];

    if (pdf_urls && pdf_urls.length > 0 && cookie_str) {
      // 新方式: サーバー側でPDFを代理取得
      pdfBase64List = await Promise.all(
        pdf_urls.map((url) => fetchPdfAsBase64(url, cookie_str))
      );
    } else if (pdf_data && pdf_data.length > 0) {
      // 旧方式: 拡張機能側で取得済みのbase64
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
        continue; // 読み込めないPDFはスキップ
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

    // LINE送信が要求された場合
    if (send_to_line && HANBANCYO_TOKEN) {
      const groupId = await getGroupId();
      if (groupId) {
        try {
          const { put } = await import("@vercel/blob");
          const blob = await put(name, Buffer.from(mergedBytes), {
            access: "public",
            contentType: "application/pdf",
          });
          await pushLineFile(groupId, blob.url, name, merged.getPageCount());
          return NextResponse.json({
            ok: true,
            pdf: base64Result,
            line_sent: true,
            url: blob.url,
          });
        } catch {
          // Blob/LINE失敗時はPDFだけ返す
        }
      }
    }

    return NextResponse.json({ ok: true, pdf: base64Result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
