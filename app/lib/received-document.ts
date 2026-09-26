// app/lib/received-document.ts
// お客様から届いた書類（LINE の file メッセージ＝PDF 等・書類の画像）の扱い。純関数・DB 依存なし。
//
// 2026-09-17 竹内（友哉事例）「PDFお客さんから送られているのに、判断できていない。公式LINEには表示されているが
//   アプリには表示できていない。原因見つけて改善する」
//
// 友哉（イエヤス）9/16:
//   13:08 スタッフ「…在籍証明に関しては株式会社Dank-All からの定期的な収入がある証明となりますので、必要となります！！」
//   18:29 お客様 **労働条件通知書_中谷友哉.pdf**（LINE の file メッセージ）＋「いかがでしょうか」
//   19:02 スタッフ「お送りいただきありがとうございます！！／確認させていただきます😌！！」
//   9/17 09:04 お客様「お願いします」→ AI 下書き「かしこまりました！！／**在籍証明の作成、お願いできますと幸いです**😊！！」
//   ＝既に届いている書類を、もう一度お客様に作れと言っていた。
//
// 原因: line-webhook が msgType === "file" を保存せず捨てていた（video/audio/file は else で suggested_aix_meta を消すだけ）。
//   実データ365日: messages に "[ファイル]" は **0件**（"[画像]" は836件）＝ファイルは1通も残っていない。
//
// 実データ（365日・書類の画像が届いた直後のスタッフ実送信 53件）:
//   「お送りいただき/頂きありがとう」で始まる … 44件（83%）／「ありがとう」を含む … 46件（87%）
//   次にやる事を書く … お申込 37件・管理会社に共有 6件・確認させて頂きます 5件
//   同じ書類をもう一度依頼している … 4件（いずれも**別の**書類の追加依頼＝3親等以内のご情報・転勤先の住所）
//   ＝書類が届いた返信は「お礼 → こちらが次にやる事」で、届いた書類の再依頼はしない。

import { savedPersonalDocumentLabel, INCOME_DOCUMENT_TYPE, INCOME_DOCUMENT_LABEL } from "@/app/lib/personal-document-guard";

/** ファイルメッセージの本文の印（画像の "[画像]" と同じ役割） */
export const FILE_MSG_PREFIX = "[ファイル]";

/** messages.text に入れる本文（ファイル名が分かればその名前も残す＝ブレインが何の書類か読める） */
export function fileMessageText(fileName?: string | null): string {
  const n = (fileName ?? "").trim();
  return n ? `${FILE_MSG_PREFIX} ${n}` : FILE_MSG_PREFIX;
}

/** 本文からファイル名を取り出す（"[ファイル] 労働条件通知書_中谷友哉.pdf" → "労働条件通知書_中谷友哉.pdf"） */
export function fileNameFromText(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t.startsWith(FILE_MSG_PREFIX)) return null;
  const rest = t.slice(FILE_MSG_PREFIX.length).trim();
  return rest || null;
}

/**
 * 書類の種類（ファイル名・画像の読み取り文から）。
 * スタッフが会話で使う呼び名に揃える（在籍証明の代わりに労働条件通知書が届く場面がある＝友哉事例）。
 *
 * nameOnly: ファイル名と、保存した種類の名前（"[画像] 収入証明書（課税証明書）"）にだけ使う。
 *   昔の画像の書き起こし（全文）には当てない＝物件資料の必要書類欄「身分証・収入証明 連帯保証人様：印鑑証明書」を
 *   「収入証明書が届いた」にしない（2026-09-26 に足した種類は全部 nameOnly）。
 */
export const DOCUMENT_KINDS: readonly { label: string; re: RegExp; provesEmployment?: boolean; nameOnly?: boolean }[] = [
  { label: "労働条件通知書", re: /労働条件(?:通知書)?/, provesEmployment: true },
  { label: "雇用契約書", re: /雇用契約書?/, provesEmployment: true },
  { label: "内定通知書", re: /内定(?:通知書)?/, provesEmployment: true },
  { label: "在籍証明書", re: /在籍証明書?/, provesEmployment: true },
  { label: "源泉徴収票", re: /源泉徴収票?/, provesEmployment: true },
  { label: "給与明細", re: /給与明細|給料明細/, provesEmployment: true },
  { label: "確定申告書", re: /確定申告書?/, provesEmployment: true },
  // 2026-09-26 竹内「収入証明書なども収入証明書とするだけで、文字おこししないようにする」
  //   書き起こしを捨てて種類の名前だけ残す（personal-document-guard.ts）ので、その名前をここで読み戻す
  { label: "課税証明書", re: /課税証明|所得証明|非課税証明/, provesEmployment: true, nameOnly: true },
  { label: "年金の通知書", re: /年金.{0,4}通知書?|年金証書/, provesEmployment: true, nameOnly: true },
  { label: "辞令", re: /辞令/, provesEmployment: true, nameOnly: true },
  { label: "収入証明書", re: /収入証明/, provesEmployment: true, nameOnly: true },
  { label: "印鑑登録証明書", re: /印鑑登録証明|印鑑証明/, nameOnly: true },
  { label: "運転免許証", re: /運転免許(?:証)?|免許証/ },
  { label: "マイナンバーカード", re: /マイナンバー|個人番号/ },
  { label: "保険証", re: /保険証|健康保険/ },
  { label: "住民票", re: /住民票/ },
  { label: "申込書", re: /申込書|申し込み?書|入居申込/ },
  { label: "通帳", re: /通帳|口座/ },
  { label: "年金手帳", re: /年金手帳?/ },
];

/**
 * ファイル名・読み取り文から書類の種類を1つ決める（分からなければ null）
 * opts.transcript: 画像の書き起こし（全文）に当てる時は nameOnly の種類を使わない
 */
export function classifyDocumentName(name: string | null | undefined, opts: { transcript?: boolean } = {}): string | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  for (const k of DOCUMENT_KINDS) {
    if (opts.transcript && k.nameOnly) continue;
    if (k.re.test(n)) return k.label;
  }
  return null;
}

/** その書類が「在籍・収入の証明」にあたるか（＝在籍証明の再依頼をしてはいけない） */
export function provesEmployment(label: string | null | undefined): boolean {
  if (!label) return false;
  return DOCUMENT_KINDS.some((k) => k.label === label && k.provesEmployment === true);
}

export type ReceivedDoc = {
  /** 届いた形（ファイル＝PDF 等／画像＝写真で送られた書類） */
  via: "file" | "image";
  /** ファイル名（画像には無い） */
  fileName: string | null;
  /** 書類の種類（分からなければ null） */
  label: string | null;
  /** 届いた時刻の表示（"9/16 18:29"） */
  at: string | null;
};

type MsgLike = { sender?: string | null; text?: string | null; image_type?: string | null; created_at?: string | null; rawCreatedAt?: string | null };

function jstStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 9 * 60 * 60 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 直近の会話からお客様が送ってきた書類を拾う。
 * ・ファイル（[ファイル] 〜）は種類が分からなくても「書類が届いた」として拾う（PDF を送る用件は書類がほとんど）
 * ・画像は種類が読めた物（本人確認書類・書類名が読み取り文にある物）だけ＝物件のスクショを書類にしない
 */
export function detectReceivedDocuments(messages: readonly MsgLike[], opts: { limit?: number } = {}): ReceivedDoc[] {
  const limit = opts.limit ?? 5;
  const out: ReceivedDoc[] = [];
  for (const m of messages) {
    if ((m.sender ?? "") !== "customer") continue;
    const text = (m.text ?? "").trim();
    const at = jstStamp(m.rawCreatedAt ?? m.created_at ?? null);
    const fileName = fileNameFromText(text);
    if (text.startsWith(FILE_MSG_PREFIX)) {
      out.push({ via: "file", fileName, label: classifyDocumentName(fileName), at });
      continue;
    }
    if (!text.startsWith("[画像]")) continue;
    // 2026-09-26: 収入・身元の証明書類は書き起こしを捨てて "[画像] 収入証明書（給与明細）" の形で保存する。
    //   まずその形を読み戻す（形そのものの時だけ）→ 無ければ従来どおり書き起こし（昔の行）から読む
    const label = savedPersonalDocumentLabel(text) ?? classifyDocumentName(text, { transcript: true });
    if (!label && m.image_type !== "id_document" && m.image_type !== INCOME_DOCUMENT_TYPE) continue;
    out.push({ via: "image", fileName: null, label: label ?? (m.image_type === INCOME_DOCUMENT_TYPE ? INCOME_DOCUMENT_LABEL : "本人確認書類"), at });
  }
  // 新しい物を優先して上限まで（同じ種類は1つに）
  const seen = new Set<string>();
  const uniq: ReceivedDoc[] = [];
  for (const d of out.slice().reverse()) {
    const key = d.fileName ?? d.label ?? d.via;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(d);
    if (uniq.length >= limit) break;
  }
  return uniq.reverse();
}

/**
 * 生成に渡す材料・指示（お客様から届いている書類）。
 * 届いていなければ空文字＝何も足さない。
 */
export function buildReceivedDocumentNote(docs: readonly ReceivedDoc[]): string {
  if (docs.length === 0) return "";
  const lines = docs.map((d) => {
    const what = d.fileName ?? d.label ?? "書類";
    const kind = d.label && d.fileName ? `（${d.label}）` : "";
    return `・${what}${kind}${d.at ? ` — ${d.at} 受信` : ""}`;
  });
  const employment = docs.some((d) => provesEmployment(d.label));
  return [
    "【お客様から既に届いている書類（もう一度お願いしない）】",
    ...lines,
    "・上の書類の作成・送付をこの返信で改めてお願いしない（既に届いている）",
    // 2026-09-17 本番検証: 「こちらの書類で在籍・収入面の確認は完了となります！！」と**完了を断言**する下書きが出た。
    //   実送信は「確認させて頂きます」までで、審査や確認の結果はこの時点で断言しない
    ...(employment
      ? ["・在籍・収入の証明はこの書類で受け取れている。「在籍証明の作成をお願いします」等の再依頼は書かない",
         "・ただし「確認は完了となります」「これで審査に進めます」等、確認・審査の結果は断言しない（確認はこれから）"]
      : []),
    "・書類が届いた返信は「お送りいただきありがとうございます😊！！」から始め、こちらが次にやる事（確認させて頂きます／お申込完了させて頂きます／管理会社に共有させて頂きます）を書く（実送信53件中44件がこの型）",
  ].join("\n");
}
