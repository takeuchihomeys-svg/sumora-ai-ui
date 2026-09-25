import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";
// 2026-09-21 竹内「一度共有した物件を除いてLINEに送ることが出来ればかなり質高くなる」
import {
  filterOutAlreadySent, renumberSummaries, parseSummaryHead, buildExcludedNotice,
  normalizePropertyUrl, urlKeysAreDistinct, type OutgoingProperty, type SentProperty,
} from "@/app/lib/sent-property-filter";
// 2026-09-21 竹内「ちゃんと物件を読み取ることできてるんかな？」: 家賃は説明文から読み直す
import { parseRentFromSummary } from "@/app/lib/property-summary-parse";
import { waitUntil } from "@vercel/functions";
// 2026-09-24: 送った時の AD を送付記録に残す（見積書の割引と結び付けて利益を出す材料）
import { parsePropertyFacts } from "@/app/lib/property-brain";
import { enrichSummariesFromPdf, rankAndAnnotateSummaries, buildRankMaterials, loadRankConditions } from "@/app/lib/pickup-rank";
import { isPlaceholderName } from "@/app/lib/listing-text";

// 2026-09-24: 応答は今まで通り早く返し、売上サポへの記録（waitUntil）で DeepSeek が資料を読む時間（1枚 27〜40秒・並列）を確保するため 300 に
export const maxDuration = 300;

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
  // 物件ピックアップ専用グループ優先（pickup_group_id）
  const { data: pickupRow } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "pickup_group_id")
    .maybeSingle();
  if (pickupRow?.value) return pickupRow.value as string;

  // fallback: 旧グループ
  const { data } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .maybeSingle();
  return data?.value ?? null;
}

/**
 * お客様の名前から物件顧客を引く（拡張が property_customer_id を渡してこない時の回復）。
 *
 * 2026-09-21 竹内「一度共有した物件を除いてLINEに送る」:
 *   除外するには「この人に何を送ったか」が引けないといけないが、実測（scripts/audit-sent-prop-recent.ts）で
 *   line_group の紐付きは 9/20 に 79.2% まで直った翌日 **9/21 は 0.1%** に戻っていた。
 *   ＝ background.js の修正が**再読み込みされていない端末**で動いている。
 *   customer_name は LINE の見出しに使うため**必ず届いている**ので、ここで引き直せば拡張を待たずに紐付く。
 *
 * ⚠ 同姓同名は引かない。実測（scripts/audit-name-to-customer.ts・293人）で
 *   **1人に決まる名前は 91.4%**、残り 23種類・50人（17.1%）は同名が複数いる。
 *   別人の履歴で物件を外すと「送るべき物件が送られない」＝いちばん重い失敗なので、
 *   曖昧な時は**何もしない**（設計知見「入口は厳しく」）。
 */
async function lookupCustomerByName(customerName: string | null | undefined): Promise<string | null> {
  const name = (customerName ?? "").replace(/さん\s*$/, "").replace(/[\s　]+/g, "").trim();
  if (!name) return null;
  const { data, error } = await supabase
    .from("property_customers")
    .select("id, customer_name")
    .limit(1000);
  if (error || !data) return null;
  const norm = (s: string | null) => (s ?? "").replace(/さん\s*$/, "").replace(/[\s　]+/g, "").trim();
  const hits = (data as Array<{ id: string; customer_name: string | null }>).filter((c) => norm(c.customer_name) === name);
  if (hits.length !== 1) {
    console.log(JSON.stringify({
      tag: "merge-pdfs:name-lookup", matched: hits.length,
      note: hits.length === 0 ? "名前が一致する物件顧客が無い" : "同じ名前が複数いるので引かない",
    }));
    return null;
  }
  return hits[0].id;
}

// 2026-09-24: AD の補完・🌟 の順位付け（DeepSeek）は app/lib/pickup-rank.ts へ移した（YUMA のテストから本番と同じ関数を呼ぶため）

function buildLineMessage(
  fileUrl: string,
  fileName: string,
  pageCount: number,
  customerName: string | null | undefined,
  propertySummaries: string[] | null | undefined,
  sourceLabel?: string,
  /** 2026-09-21: 送付済みで外した物の知らせ（無ければ空文字） */
  excludedNotice?: string,
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

  // 送付済みで外した物（スタッフが「候補より少ない」と気づけるように最後に1行）
  if (excludedNotice) {
    lines.push("");
    lines.push(excludedNotice);
  }

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
      /** 2026-09-21 竹内「スタッフモードで送るときはちゃんとLINEに共有できるように。これを省く（スタッフモード）の時」 */
      staff_mode?: boolean | null;
      /** 2026-09-23 拡張のブレインモード（記録用・判定は拡張側で済んでいる） */
      brain_mode?: boolean | null;
    };

    const { pdf_data, cookie_str, file_name, send_to_line, customer_name, customer_conditions, site, property_customer_id, conversation_id, staff_mode, brain_mode } = body;
    let { pdf_urls, property_summaries } = body;

    // PDF データを収集（pdf_urls[i]・pdf_data[i] は property_summaries[i] と同じ組）
    let pdfBase64List: string[] = [];
    let pdfsLoaded = false;
    /** 送付済みを外した後に残した元の並びの番号（PDF を後で取る時に同じ組で落とす） */
    let keptIndexes: number[] | null = null;
    const loadPdfs = async (): Promise<NextResponse | null> => {
      pdfsLoaded = true;
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
      return null;
    };

    // 2026-09-24 竹内「賃料と間取りも㎡数取り入れるようにする」: itandi の説明文は拡張が物件名を取れず「【1】物件」だけで届く。
    //   名前が無いと送付済みの除外（建物ごと）が1件も当たらないので、その時だけ PDF を先に取って文字層で説明文を補ってから除外する。
    //   名前のある説明文（リアプロ）は今まで通り除外を先にする（送付済みの PDF を取りに行かない）。
    if (send_to_line && property_summaries && property_summaries.length > 0
        && property_summaries.some((s) => isPlaceholderName(parseSummaryHead(s)?.propertyName))) {
      const err = await loadPdfs();
      if (err) return err;
      property_summaries = await enrichSummariesFromPdf(property_summaries, pdfBase64List);
    }

    // ─── 2026-09-21 竹内「一度共有した物件を除いてLINEに送る」──────────────────
    //   ここで外すのは **PDF を取りに行く前**。外した物の PDF をダウンロードしても捨てるだけなので。
    //   ⚠ pdf_urls[i] と property_summaries[i] は拡張側の send-pairing.js が**同じ組から**作っていて、
    //     構造的に対応が保証されている（2026-09-18 の修正）。だから index を揃えて両方から落とせる。
    //   戻す時は環境変数 SKIP_SENT_PROPERTIES=off。
    let excludedNotice = "";
    let resolvedCustomerId: string | null = property_customer_id ?? null;
    if (!resolvedCustomerId && conversation_id) {
      const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", conversation_id).maybeSingle();
      resolvedCustomerId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    }
    // 拡張が古くて property_customer_id を渡してこない時は名前から引き直す（同名が複数なら引かない）
    if (!resolvedCustomerId && !conversation_id) resolvedCustomerId = await lookupCustomerByName(customer_name);

    // 2026-09-21 竹内「スタッフモードで送るときはちゃんとLINEに共有できるように。これを省く（スタッフモード）の時」
    //   スタッフが自分で選んで送る時は、意図して選んだ物なので1件も減らさない。
    //   ⚠ 記録（sent_properties への書き込み）は**止めない**。次に自動で送る時に外すための材料なので。
    const skipSent = process.env.SKIP_SENT_PROPERTIES !== "off" && staff_mode !== true;
    if (staff_mode === true) {
      console.log(JSON.stringify({ tag: "merge-pdfs:staff-mode", note: "スタッフモードなので送付済みの除外をしない" }));
    }

    if (skipSent
        && send_to_line
        && property_summaries && property_summaries.length > 0
        && (resolvedCustomerId || conversation_id)) {
      try {
        const outgoing: OutgoingProperty[] = property_summaries.map((s, i) => {
          const head = parseSummaryHead(s);
          return {
            url: pdf_urls?.[i] ?? null,
            propertyName: head?.propertyName ?? "",
            roomNo: head?.roomNo ?? "",
          };
        });
        let q = supabase.from("sent_properties").select("property_name, room_no, property_url");
        q = resolvedCustomerId ? q.eq("property_customer_id", resolvedCustomerId) : q.eq("conversation_id", conversation_id as string);
        const { data: sentRows } = await q.limit(2000);
        const sent = ((sentRows ?? []) as SentProperty[]);
        // 2026-09-21 竹内「一度グループに送った物件（マンションごと）は送られんように」＝ 既定は建物ごと。
        //   部屋ごとに戻す時は SKIP_SENT_LEVEL=room
        const level = process.env.SKIP_SENT_LEVEL === "room" ? "room" : "building";
        const result = filterOutAlreadySent(outgoing, sent, level);
        console.log(JSON.stringify({
          tag: "merge-pdfs:skip-sent", level,
          customer: resolvedCustomerId ? "by_id" : "by_conversation",
          incoming: outgoing.length, known: sent.length,
          dropped: result.dropped.length, unmatchable: result.unmatchable,
          url_unusable: result.urlUnusable,
          reasons: result.dropped.map((d) => d.reason),
        }));
        if (result.dropped.length > 0) {
          excludedNotice = buildExcludedNotice(result.dropped);
          const keep = new Set(result.keep);
          if (pdf_urls) pdf_urls = pdf_urls.filter((_, i) => keep.has(i));
          // 先に取った PDF も同じ組で落とす（pdf_data の経路は pdf_urls が無い）
          if (pdfsLoaded) pdfBase64List = pdfBase64List.filter((_, i) => keep.has(i));
          else keptIndexes = result.keep;
          property_summaries = renumberSummaries(property_summaries.filter((_, i) => keep.has(i)));
        }
      } catch (e) {
        // 外せなくても送信は止めない（外すのは付け足しの機能）
        console.warn("[merge-pdfs] 送付済みの除外に失敗（そのまま送る）:", e instanceof Error ? e.message : String(e));
      }
    }

    // 候補が全部「送付済み」だった時は、PDF を作らずスタッフに知らせるだけにする
    //   （何も言わずに終わると「送ったつもり」になるので、必ず1通は出す）
    //   反証 2026-09-25: pdf_data の経路（レインズ・pdf_urls が無い）も外した PDF を同じ組で落とすようにしたので、
    //   全件外れた時に「有効なPDFページがありませんでした」（400）にならないよう、説明文が0件になった時もここで知らせる
    if (send_to_line && excludedNotice && ((pdf_urls && pdf_urls.length === 0) || (property_summaries && property_summaries.length === 0))) {
      const groupId = await getGroupId();
      if (groupId && HANBANCYO_TOKEN) {
        const nameWithSan = customer_name ? (customer_name.endsWith("さん") ? customer_name : `${customer_name}さん`) : "";
        await pushLineMessage(groupId, `${nameWithSan} 物件（${site === "itandi" ? "itandi" : "リアプロ"}）\n今回の候補はすべて送付済みでした。\n${excludedNotice}`)
          .catch((e) => console.warn("[merge-pdfs] 全件送付済みの通知に失敗:", e));
      }
      return NextResponse.json({ ok: true, line_sent: true, all_already_sent: true, excluded: excludedNotice });
    }

    // PDF データを収集（名前の無い説明文のために先に取った時は取り直さない）
    if (!pdfsLoaded) {
      const err = await loadPdfs();
      if (err) return err;
      // pdf_data の経路（pdf_urls が無い）で送付済みを外した時も、同じ組で落とす
      if (keptIndexes && !(pdf_urls && pdf_urls.length > 0)) pdfBase64List = keptIndexes.map((i) => pdfBase64List[i]).filter((b): b is string => !!b);
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

        // 2026-09-24 竹内「今回、他の物件も AD あった」: 表の AD 列から取れなかった物件は、資料（元付の2ページ目）の文字から AD を補う。
        //   🌟 の順位付け・LINE の本文・送付記録（sent_properties.ad_months）・売上サポの判定が全部この説明文を読むので、ここで足す。
        // 2026-09-24 夜 竹内「賃料と間取りも㎡数取り入れる」「駅名や徒歩数も」: 物件名・号室・賃料・管理費・間取り・㎡・最寄り駅と徒歩も
        //   文字層から補う（説明文にある値が正・無い所だけ。先に補った説明文は足す物が無いのでそのまま）
        const summariesWithAd = property_summaries && property_summaries.length > 0
          ? await enrichSummariesFromPdf(property_summaries, pdfBase64List)
          : property_summaries;
        // 2026-09-25 任務B: 🌟 の判断に資料の表の事実（敷礼・築年・入居時期・よく訴求する設備）を「資料:」の1行で渡す（説明文・LINE の本文は変えない）
        const rankMaterials = summariesWithAd && summariesWithAd.length > 1 ? await buildRankMaterials(pdfBase64List) : null;
        // 2026-09-25 YUMA テスト: 🌟 に渡す条件は DB の条件の要約（設備・入居時期・初期費用・通勤も入る・家賃を丸めない）。無ければ拡張の文（loadRankConditions）
        const rankConditions = summariesWithAd && summariesWithAd.length > 1 ? await loadRankConditions(resolvedCustomerId, customer_conditions) : customer_conditions;
        const rankedSummaries = summariesWithAd && summariesWithAd.length > 0
          ? await rankAndAnnotateSummaries(summariesWithAd, rankConditions, rankMaterials)
          : summariesWithAd;
        const lineText = buildLineMessage(
          blob.url,
          name,
          merged.getPageCount(),
          customer_name,
          rankedSummaries,
          site === "itandi" ? "itandi" : site === "realpro" ? "リアプロ" :
            (pdf_urls && pdf_urls.some(u => !u.includes("realnetpro"))) ? "itandi" : "リアプロ",
          excludedNotice,
        );
        await pushLineMessage(groupId, lineText);

        // 2026-09-24 竹内「ピックアップしたのを一度アプリの売上サポに飛ばして…スタッフは確認してお客さんに送るだけ」:
        //   1回分を property_pickups に残す（PDF の文字層・判定・🌟・物件ごとの PDF）。応答は待たせない（waitUntil）。
        //   pdf_urls[i]・property_summaries[i]・pdfBase64List[i] は同じ並び（send-pairing.js が同じ組から作る・ranking は並びを変えない）。
        //   2026-09-24 竹内「これはブレインモードで拡張ツールを行った時の限定機能」: 拡張の brain_mode（通常・スタッフモードでは false）の時だけ。
        //   画像化と DeepSeek の読み取り（費用・時間）をブレインモード以外に広げない。
        if (brain_mode === true) {
          const summariesForPickup = rankedSummaries && rankedSummaries.length > 0 ? rankedSummaries : (property_summaries ?? []);
          if (summariesForPickup.length > 0 && (resolvedCustomerId || conversation_id)) {
            const pdfUrlsForPickup = summariesForPickup.map((_, i) => (pdf_urls?.[i] && /realnetpro\.com/.test(pdf_urls[i]) ? pdf_urls[i] : null));
            const base64ForPickup = summariesForPickup.map((_, i) => pdfBase64List[i] ?? null);
            const job = import("@/app/lib/property-pickups-server").then(({ recordPickupBatch }) => recordPickupBatch({
              batchId: name, propertyCustomerId: resolvedCustomerId, conversationId: conversation_id ?? null,
              customerName: customer_name ?? null, site: site ?? null,
              summaries: summariesForPickup, pdfUrls: pdfUrlsForPickup, pdfBase64List: base64ForPickup,
            })).catch((e) => console.warn("[merge-pdfs] property_pickups の記録に失敗:", e instanceof Error ? e.message : String(e)));
            try { waitUntil(job); } catch { /* Vercel 以外 */ }
          }
        }

        // 送付物件を sent_properties に記録（source: "line_group" でVision OCR経由と区別）
        // insert失敗してもLINE送信自体は成功として扱う（レスポンスは変えない）
        try {
          // property_customer_id は上で解決済み（body → conversation → 名前から引き直し の順）
          const propertyCustomerId: string | null = resolvedCustomerId;

          const summariesToRecord =
            rankedSummaries && rankedSummaries.length > 0
              ? rankedSummaries
              : property_summaries ?? [];

          // 物件名・号室・URL を全件抽出
          //
          // ⚠ 2026-09-21: ここは `/^【\d+🌟?★?】\s*/` で番号を剥がしていたが、**🌟 はサロゲートペア**なので
          //   u フラグの無い `🌟?` は「前半は必須・後半は任意」になり、**🌟 の付かない「【1】」に当たらなかった**。
          //   実測（scripts/audit-summary-no-bug.ts）で sent_properties の **81.2%（14,746件）** の物件名が
          //   「【5】エスリード新北野」のように番号付きで保存されていた。名前が違えば突き合わせは当たらないので、
          //   重複の警告も除外も効かない。parseSummaryHead（u フラグ付き・テスト済み）に統一する。
          //
          // ⚠ URL も入れる。号室は実測で 0.1% しか取れておらず（scripts/audit-summary-room.ts）、
          //   名前だけでは同じ建物の別部屋と区別できない（1回の送信の74.2%に別部屋が入っている）。
          //   リアプロの印刷用PDFの URL は物件ごとに違うので、これが号室の代わりの鍵になる。
          // ⚠ 家賃も説明文から読み直す（2026-09-21 竹内「ちゃんと物件を読み取ることできてるんかな？」）。
          //   拡張は同じセルの文字を説明文にはそのまま入れているのに、数値にする側は `/(\d+)万/` しか
          //   見ておらず「58,000円」に当たらないため、sent_properties.rent が **リアプロ20,854件中 0件**だった。
          //   説明文はここに届いているので、サーバー側で読めば拡張の再読み込みが要らない。
          type PropInfo = { propertyName: string; roomNo: string; url: string; rent: number | null; adMonths: number | null; adYen: number | null };
          const rawInfo: PropInfo[] = summariesToRecord.flatMap((summary, i) => {
            const head = parseSummaryHead(summary);
            if (!head) return [];
            // 2026-09-24 竹内「物件オススメ・ピックアップで送った物件なら AD も分かっているはず」: 説明文の「AD 2ヶ月」を送付記録に残す
            //   （見積書の割引と結び付けて利益を出す材料。判定は app/lib/property-brain.ts parsePropertyFacts と同じ読み方）
            const facts = parsePropertyFacts(summary);
            const rent = parseRentFromSummary(summary);
            const adYen = facts.adYen ?? (facts.adMonths != null && rent != null ? Math.round(facts.adMonths * rent) : null);
            return [{ ...head, url: normalizePropertyUrl(pdf_urls?.[i] ?? null), rent, adMonths: facts.adMonths, adYen }];
          });
          // ⚠ URL が物件を1件ずつ指していない形（path が同じでクエリで分ける等）だったら**記録しない**。
          //   そのまま入れると、次の送信で全部「送付済み」と判定されて消える。外す時と同じ確認（四者同名）。
          const urlUsable = urlKeysAreDistinct(rawInfo.map((p) => ({ url: p.url, propertyName: p.propertyName, roomNo: p.roomNo })));
          if (!urlUsable && rawInfo.some((p) => p.url)) {
            console.warn(JSON.stringify({
              tag: "merge-pdfs:url-not-distinct", count: rawInfo.length,
              note: "PDF の URL が物件ごとに違わないので鍵にしない（号室での判定だけ残る）",
            }));
          }
          const propInfoList: PropInfo[] = rawInfo.map((p) => ({ ...p, url: urlUsable ? p.url : "" }));

          if (propInfoList.length > 0) {
            // ── 2026-09-20 竹内「どれが物件ピックアップで送った物件かも理解できる」──
            //   実測（scripts/audit-sent-prop-link.ts・直近180日）: source="line_group" の 14,129件は
            //   **会話ID 0% / 物件顧客ID 0% / 号室 0%** ＝「誰に送ったか」分からない行だった。
            //   原因は Chrome 拡張（background.js）が property_customer_id を渡していなかったこと（2026-09-20 に修正）。
            //   ここでは残る副作用を塞ぐ: 紐付けがどちらも無い時、下の重複チェックは
            //   **全顧客の sent_properties から同名物件を探して**しまい、別のお客様に送った物件のせいで
            //   記録がスキップされていた。紐付けが無い時は重複チェックをかけない（誤って落とさない）。
            if (!propertyCustomerId && !conversation_id) {
              console.warn(JSON.stringify({
                tag: "merge-pdfs:sent-properties:no-link",
                customer_name: customer_name ?? null, count: propInfoList.length,
                note: "property_customer_id / conversation_id がどちらも無い。拡張が古い可能性（再読み込みが必要）",
              }));
            }
            // 1回の SELECT で全物件の重複チェック（N+1 → 1クエリに削減）
            const propertyNames = propInfoList.map((p) => p.propertyName);
            let dupQuery = supabase
              .from("sent_properties")
              .select("property_name, room_no, property_url")
              .in("property_name", propertyNames);
            if (propertyCustomerId) {
              dupQuery = dupQuery.eq("property_customer_id", propertyCustomerId);
            } else if (conversation_id) {
              dupQuery = dupQuery.eq("conversation_id", conversation_id);
            } else {
              // 紐付けが無い＝誰の物件か分からないので、他人の送付履歴で弾かない
              dupQuery = dupQuery.limit(0);
            }
            const { data: existingRows } = await dupQuery;
            // ⚠ 記録の重複判定は「同じ行をもう一度入れない」ためだけの物なので、
            //   URL か（名前＋号室）が完全に同じ時だけ弾く（外す判断とは別物・こちらは緩くてよい）。
            const existingSet = new Set(
              (existingRows ?? []).map((r) => `${r.property_name}__${r.room_no}`)
            );
            const existingUrls = new Set(
              (existingRows ?? []).map((r) => normalizePropertyUrl((r as { property_url?: string | null }).property_url)).filter(Boolean)
            );

            // 未登録の物件を一括 INSERT（N回 → 1クエリに削減）
            const toInsert = propInfoList
              .filter((p) => !(p.url ? existingUrls.has(p.url) : existingSet.has(`${p.propertyName}__${p.roomNo}`)))
              .map((p) => ({
                property_customer_id: propertyCustomerId,
                conversation_id: conversation_id ?? null,
                property_name: p.propertyName,
                room_no: p.roomNo,
                // 号室が 0.1% しか取れないので、次に外す時の鍵になるよう URL を残す
                property_url: p.url || null,
                // ブレイン・文生成が「送った物件の家賃」を読めるようにする（今まで 0% だった）
                rent: p.rent,
                // 送った時の AD（見積書の割引と結び付けて利益を出す材料）
                ad_months: p.adMonths,
                ad_yen: p.adYen,
                source: "line_group",
                // 2026-09-24 竹内「どれ物件ピックアップで送ったか物件オススメで送ったかもわかる」:
                //   ここは「グループに共有した」時点（お客様にはまだ送っていない）。お客様に送った行とは別の行として残し、
                //   読み手の側で delivery を見て分ける（除外系は共有も数えるまま・app/lib/sent-delivery.ts）
                delivery: "shared",
                channel: "extension_group",
              }));
            const gotRent = toInsert.filter((r) => r.rent !== null).length;
            if (toInsert.length > 0) {
              console.log(JSON.stringify({
                tag: "merge-pdfs:sent-properties:write",
                rows: toInsert.length, with_rent: gotRent, with_url: toInsert.filter((r) => r.property_url).length,
                with_room: toInsert.filter((r) => r.room_no).length, with_ad: toInsert.filter((r) => r.ad_months !== null || r.ad_yen !== null).length,
              }));
            }
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

        // 2026-09-24 竹内「更新日が抜けているので、ちゃんと設定されるようにする」:
        //   リアプロの送信は「前回出した日」（property_customers.last_property_sent_at）を更新していなかった
        //   （itandi だけ拡張が /api/property-tasks を叩いていた）。次回の更新日（1/3/7/14日以内）はこの日から計算するので、
        //   空のままだと「すべて表示」で検索していた。ここで更新すれば全サイト・古い拡張でも残る。
        //   PATCH /api/property-customers を通す（新規→毎日物件出しへの自動昇格・送信回数の管理が同じ所にある）。応答は待たせない。
        if (resolvedCustomerId) {
          const touchJob = fetch(new URL("/api/property-customers", req.url), {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: resolvedCustomerId, last_property_sent_at: new Date().toISOString() }),
          }).then((r) => { if (!r.ok) console.warn("[merge-pdfs] last_property_sent_at を更新できない: HTTP " + r.status); })
            .catch((e) => console.warn("[merge-pdfs] last_property_sent_at を更新できない:", e instanceof Error ? e.message : String(e)));
          try { waitUntil(touchJob); } catch { await touchJob; }
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
