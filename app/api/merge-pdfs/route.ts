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

export async function POST(req: NextRequest) {
  try {
    const { pdf_data, file_name, send_to_line } = await req.json() as {
      pdf_data: string[];   // base64エンコードされたPDF配列
      file_name?: string;
      send_to_line?: boolean;
    };

    if (!pdf_data?.length) {
      return NextResponse.json({ error: "pdf_dataが空です" }, { status: 400 });
    }

    // PDFを結合
    const merged = await PDFDocument.create();
    for (const b64 of pdf_data) {
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

    const mergedBytes = await merged.save();
    const base64Result = Buffer.from(mergedBytes).toString("base64");
    const today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "-");
    const name = file_name || `物件まとめ_${today}.pdf`;

    // LINE送信が要求された場合
    if (send_to_line && HANBANCYO_TOKEN) {
      const groupId = await getGroupId();
      if (groupId) {
        // Vercel Blobに一時保存してURL生成
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
          // Blob失敗時はPDFだけ返す
        }
      }
    }

    return NextResponse.json({ ok: true, pdf: base64Result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
