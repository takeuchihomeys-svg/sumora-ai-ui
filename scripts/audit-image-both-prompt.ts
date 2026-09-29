// scripts/audit-image-both-prompt.ts — 監査だけで使う「1回で両方（物件名などと条件の行）・推論なし」の読み方（本番では使わない）
//
// 2026-09-29 竹内「更に節約できないか」: 送った画像1枚を property_image_read と property_image_detail の2回（どちらも推論あり）で読んでいたのを、
//   1回・推論なしにまとめる案。監査（audit-image-read-grounding.ts・audit-sent-image-combined-read.ts）で比べた結果、
//   **条件の行は推論なしだと資料に無い可否を作る**（「連帯保証人: 不要」「ペット: 不可」＝指示の例を写す・24件中 6〜19行）・ペット／洗濯機置場／駐輪場の行が落ちる
//   ので本番には入れなかった（出口の決定論: 誤りが0でなければ入れない）。物件名・号室・家賃の読み取りだけ推論なしにした（property-image-read.ts）。
//   案を試し直す時のためにここに残す。
import { parseDetailResult, parseReadResult, PROPERTY_IMAGE_MODEL_DEFAULT, type DetailResult, type ReadResult } from "../app/lib/property-image-read";
import { callDeepSeek } from "../app/lib/vision-alt-provider";

export const PROPERTY_IMAGE_BOTH_PROMPT = `この画像を読み取ってください。JSONのみ返答（説明文・コードブロック・前置き一切不要）：
{"kind":"property","lines":["間取り: 1K","構造: 鉄筋コンクリート造"],"items":[{"property_name":"","room_number":"","rent":null,"admin_fee":null,"deposit":null,"key_money":null,"floor_plan":"","area_sqm":null,"station":"","walk_minutes":null,"built":"","ad":"","status":"","vacancy_date":""}]}
■ kind: "property"（物件の資料・マイソク・間取り図・室内写真）／"estimate"（見積書・初期費用の明細）／"document"（本人確認書類・申込書）／"other"（それ以外・スクショ）
  kind が "property" 以外なら lines と items は必ず空配列（中身は書き出さない）
■ lines: 資料に**書いてある条件だけ**を「項目: 値」で1行ずつ。入れてよいのは次の項目だけ（書いていない項目は行ごと作らない）:
  間取り／所在階／向き／築年／構造／現況／入居可能日／退去予定／駐車場／駐輪場／バイク置場／
  ペット／楽器／保証会社／連帯保証人／洗濯機置場／設備／フリーレント／入居条件
- 可否・有無の項目（ペット・楽器・連帯保証人・駐車場・駐輪場・バイク置場・洗濯機置場・フリーレント）は、**資料にその言葉が書いてある時だけ**行にする。
  書いていなければ行を作らない（「不可」「不要」「なし」と決めつけない）。設備欄の中に書いてあればその言葉のまま写す
- 設備は設備欄の文字を読点でつないで1行
- lines には**金額・住所・駅徒歩・専有面積を書かない**（items で扱う）
- 値は画像の文字をそのまま短く写す。推測しない。「不明」「記載なし」という行も作らない
■ items: 画像に出ている物件を全部。1件だけなら1つ、一覧なら全部
- property_name: マンション名のみ（号室は含めない）。読めなければ""
- room_number: 号室番号のみ（例: 502）。号室が無い・読めなければ""
- rent: 賃料（管理費・共益費を含めない月額の数字のみ。例 106000）。読めなければ null
- admin_fee: 管理費・共益費の月額（両方あれば合計・なしなら 0）。読めなければ null
- deposit: 敷金の金額（0円・なしなら 0。「1ヶ月」のように月数で書いてあれば月数の数字 1）。読めなければ null
- key_money: 礼金の金額（0円・なしなら 0。月数で書いてあれば月数の数字）。読めなければ null
- floor_plan: 間取り（例 "1K" "1LDK"。ワンルームは "1R"）。読めなければ ""
- area_sqm: 専有面積の数字（㎡。例 25.5）。読めなければ null
- station: 一番近い駅の名前（「駅」は付けない。バス停は除く）。walk_minutes: その駅から徒歩の分の数字。読めなければ "" と null
- built: 築年月（例 "2019年3月"。新築なら "新築"）。読めなければ ""
- ad: 広告料・AD（業者向けの欄に書いてあれば文字のまま。例 "100%" "1ヶ月" "50,000円"）。書いていなければ ""
- status: 募集状況。次の4つのどれか。読めなければ""
    "open"（空室・即入居可）／"move_out_planned"（退去予定・解約予定）／
    "under_construction"（建築中・新築未完成・竣工予定）／"occupied"（申込あり・満室・募集終了）
- vacancy_date: 退去予定日（"M月D日" の形式。例 "6月30日"）。備考欄に「解約予定」「退去予定」「解約日」と書かれた日付があればそれ。
    「現況」「入居時期」「入居可能日」の欄は**退去後に入居できる日**なので退去予定日にしない。読めなければ ""
■ 画像に書かれていない物件名・金額・日付を作らないこと（読めない項目は null か "" のまま）`;

export type BothResult = { read: ReadResult; detail: DetailResult; failed: boolean; ms: number; out: number };

/** 1回の応答を両方の形に分ける（純関数）。JSON が無い・kind が無い（壊れた）なら null＝読み直しの合図 */
export function parseBothResult(content: string): { read: ReadResult; detail: DetailResult } | null {
  const raw = (content ?? "").trim();
  if (!/\{[\s\S]*\}/.test(raw) || !/"kind"\s*:/.test(raw)) return null;
  const detail = parseDetailResult(raw);
  // 物件以外（見積書・本人確認書類・スクショ）は items も捨てる（物件として記録しない・中身を書き出さない）
  if (detail.kind !== "property") return { read: { items: [], isProperty: false, raw }, detail };
  const read = parseReadResult(raw);
  return { read: { ...read, isProperty: true }, detail };
}

/** 1回で読む（推論なし・温度0）。DB には書かない */
export async function readPropertyImageBoth(imageUrl: string): Promise<BothResult> {
  const t0 = Date.now();
  const r = await callDeepSeek(null, [{ type: "text", text: PROPERTY_IMAGE_BOTH_PROMPT }, { type: "image_url", image_url: { url: imageUrl } }],
    { model: process.env.PROPERTY_IMAGE_MODEL ?? PROPERTY_IMAGE_MODEL_DEFAULT, maxTokens: 3000, timeoutMs: 60_000, thinking: false, temperature: 0 });
  const p = r ? parseBothResult(r.text) : null;
  if (!r || !p) return { read: { items: [], isProperty: false, raw: r?.text ?? "" }, detail: { kind: "other", lines: [], raw: "" }, failed: true, ms: Date.now() - t0, out: r?.usage.output ?? 0 };
  const usage = { input: r.usage.input, output: r.usage.output, cacheHit: r.usage.cacheHit };
  return { read: { ...p.read, usage }, detail: { ...p.detail, usage }, failed: false, ms: Date.now() - t0, out: r.usage.output };
}
