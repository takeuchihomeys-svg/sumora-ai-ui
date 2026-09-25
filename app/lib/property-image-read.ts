// app/lib/property-image-read.ts
// スタッフが送った画像から物件名・号室を読む（DeepSeek-V4.1-Flash / モデルは設定で差し替え可）。
//
// 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは。
//   その画像の読み込みに限定して deepseek V4.1 Flash のモデルを使う」
//
// 【なぜ要るか】ブレインは送付済みの物件を sent_properties / sent_image_properties から知る。
//   これらは extract-property-info（物件出しツール・AIX）でしか書かれないので、
//   **スタッフが手で画像を送った時は1件も記録されない**:
//     スタッフ送信画像 1,624件（直近30日）→ 物件に直せているのは 24件（1%）
//     画像を送った会話 118件 → 1枚も直せていない会話 99件（84%）
//   物件を知らないまま文を書くとすれ違いが起きる（慶次さんの会話ではブレインが物件を1件も見ていなかった）。
//
// 【DeepSeek を使う理由（実測）】
//   deepseek-flash ＝「DeepSeek-V4.1-Flash」の正式なモデルIDで vision 対応。
//   同じ画像で Claude は物件名1件しか返さなかったが、DeepSeek は号室9室すべて読んだ。
//   費用: 実測 入力376 / 出力281 トークン × 公式価格 → 54枚/日で **月$0.36〜0.73**
//        （Claude Sonnet5 は月$9.79 ＝ 13倍）
//
// 【踏んだ罠】**推論モデルなので max_tokens を小さくすると答えが出ない**。
//   最初 max_tokens=200 で叩いたら completion 200 が全部 reasoning_tokens になり
//   content が空のまま finish_reason="length"。これを「画像を読めない」と誤判定した。
//   reasoning_content の中では画像をちゃんと見ていた（"Image shows property name: RISIN..."）。
//   ⚠ thinking:{type:"disabled"} は最速（1.4秒・推論0）だが「本町橋」を「本町筋」と誤読したので使わない。

export const PROPERTY_IMAGE_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
/** DeepSeek-V4.1-Flash。DeepSeek 側で新しい名前が出たら PROPERTY_IMAGE_MODEL で差し替える */
export const PROPERTY_IMAGE_MODEL_DEFAULT = "deepseek-flash";
/** 推論で使い切って答えが出ない事故を防ぐ余裕（実測は推論235〜442・答え46前後） */
export const PROPERTY_IMAGE_MAX_TOKENS = 8000;

// 2026-09-21 竹内「退去予定のところも実装／退去予定の物件を判断や、条件（家賃や敷金礼金などのところ）を
//   広げているのか物件ピックアップで文生成する際に画像を読み取ってそこから文はつくられているか」
//   物件名・号室だけでなく **募集状況（退去予定）と条件（家賃・敷金・礼金）** も読む。
//   読めた分は sent_properties の recruitment_status / rent に入れるので、
//   次に文を作る時は**画像を読み直さなくても**退去予定・家賃が分かる
//   （竹内さん「文生成される部分毎回直さなくて済む（退去予定物件の部分等）」）。
//   ⚠ 退去日の読み取りは AIX【物件オススメ】のプロンプト（aix/action:1938）と同じ線にする:
//     備考欄の「解約予定／退去予定／解約日」の日付が退去予定日。
//     「現況／入居時期」の欄は**退去後に入居できる日**であって退去予定日ではない。
//
// 2026-09-25 竹内「候補の記憶を太くする」（別の調査の結論「点より先に材料を残す」）:
//   お客様に送った画像1枚ごとに 管理費・間取り・㎡・最寄り駅と徒歩・築年月・AD も読み、sent_image_properties.facts に残す
//   （今までは家賃だけが sent_properties に残り、敷礼も読んでいたのに捨てていた）。**同じ1回の読み取りで足す**（呼び出しは増やさない）。
//   ⚠ ここで読んだ値は「記録と分析（🌟の候補一覧・ブレインの点の検証）」にだけ使う。返信の本文に数字を書く材料にはしない
//     （下の PROPERTY_IMAGE_DETAIL_PROMPT の「金額・住所・駅徒歩・面積は書かない」線はそのまま＝誤読がそのまま事故になるため）。
//   ⚠ 指示の文は固定で先頭（画像はその後）＝ DeepSeek のキャッシュが効く形のまま。お客様の画像・本人確認書類は呼び出し側で出さない
export const PROPERTY_IMAGE_PROMPT =`この画像から物件情報を読み取ってください。JSONのみ返答（説明文・コードブロック・前置き一切不要）：
{"items":[{"property_name":"","room_number":"","rent":null,"admin_fee":null,"deposit":null,"key_money":null,"floor_plan":"","area_sqm":null,"station":"","walk_minutes":null,"built":"","ad":"","status":"","vacancy_date":""}],"is_property":true}
- items: 画像に出ている物件を全部。1件だけなら1つ、一覧なら全部
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
- vacancy_date: 退去予定日（"M月D日" の形式。例 "6月30日"）。次のルールで読む
    ・備考欄に「解約予定」「退去予定」「解約日」と書かれた日付があればそれ
    ・「現況」「入居時期」「入居可能日」の欄は**退去後に入居できる日**なので退去予定日にしない
    ・読めなければ ""
- is_property: 物件の資料・マイソク・室内写真なら true、それ以外（見積書・本人確認書類・スクショ）なら false
- 画像に書かれていない物件名・金額・日付を作らないこと（読めない項目は null か "" のまま）`;

// ─── 2026-09-21 竹内「引用とあれば引用先の画像を読み取れるように。こっちが送った画像なら
//   deepseek で読み取れるようになってるはずなので、そこで読み取ってちゃんとした文を生成できるようにする」──
//
// 【何が足りなかったか】引用先の画像は「どの物件か」（物件名・号室）までしか分からず、
//   **資料に書いてある中身**（駐車場・洗濯機置場・設備・階・向き・入居時期・フリーレント）は
//   生成に1文字も渡っていなかった。
//   実測（直近120日・こちらが送った画像への引用返信133件）:
//     資料を読まないと答えられない質問 … 44件（33.1%）
//     そのうちスタッフが「確認します」で受けずに**その場で答えた** … 33件（75.0%）
//   ＝ スタッフは手元の資料を見て即答している。AI にはその資料が渡っていなかった。
//
// ⚠ 読むのは**物件の資料だけ**。見積書・本人確認書類は中身を書き出さない（kind だけ返す）。
//   見積書の金額は本文に書かない決まり（AIX【見積書送る】が画像で送る）だし、
//   設計知見「画像は伏せようがない」の線をここでも守る。
// ⚠ **金額・住所・駅徒歩・面積は読まない**（実測で決めた線）。
//   同じ資料を読ませたら誤読が出た: 所在地「藤井寺市野中」→「堺市中区土佐屋」／
//   開口部方位の欄を「所有面積: 西」／号室 103 →「1階」／礼金「1ヶ月」→「108,000円」。
//   数字や住所をそのまま本文に書くと**そのまま事故になる**（金額は元々 AI に書かせない決まり）。
//   賃料・敷金・礼金・退去予定日は既に readPropertyImage が構造化して sent_properties に入れている。
//   ここで足したいのは「駐車場はあるか」「ペットは可か」「保証人は要るか」のような
//   **有無・可否**＝誤読しても文が壊れにくく、実際にお客様が聞いてくる事だけ。
export const PROPERTY_IMAGE_DETAIL_PROMPT = `この画像が何かを判定し、物件の資料なら**書いてある条件だけ**を書き出してください。JSONのみ返答（説明文・コードブロック一切不要）：
{"kind":"property","lines":["駐車場: 敷地内 空有","ペット: 不可"]}
- kind: "property"（物件の資料・マイソク・間取り図）／"estimate"（見積書・初期費用の明細）／"document"（本人確認書類・申込書）／"other"
- kind が "property" 以外なら lines は必ず空配列（中身は書き出さない）
- lines に入れてよいのは次の項目だけ。**画像に書いてある物だけ**（書いていない項目は行ごと作らない）:
  間取り／所在階／向き／築年／構造／現況／入居可能日／退去予定／駐車場／駐輪場／バイク置場／
  ペット／楽器／保証会社／連帯保証人／洗濯機置場／設備／フリーレント／入居条件
- **金額・住所・駅徒歩・専有面積は書かない**（別の所で扱う）
- 値は画像の文字をそのまま短く写す。推測しない。「不明」「記載なし」という行も作らない`;

/**
 * 詳細の読み取りの上限。
 * 実測: 項目を絞る前は 8000 を推論で使い切って **8枚中5枚が答え0文字**だった（out=7999/8000）。
 *   項目を絞ったら 3/4 が通り、残り1枚はやはり上限に当たった → 12000 にして救う。
 *   1枚あたりの実測は入力1,000／出力3,000前後（$0.003）。
 */
export const PROPERTY_IMAGE_DETAIL_MAX_TOKENS = 12000;

/** 画像の種類（物件の資料以外は中身を書き出さない） */
export type ImageKind = "property" | "estimate" | "document" | "other";
export type DetailResult = { kind: ImageKind; lines: string[]; raw: string; usage?: { input: number; output: number; cacheHit?: number } };

const KIND_OK = new Set<ImageKind>(["property", "estimate", "document", "other"]);
/** 中身が無い事を言っているだけの行（「不明」「記載なし」）。材料に入れると AI が「記載なし」と答えてしまう */
const EMPTY_VALUE_RE = /[:：]\s*(?:不明|記載なし|なし|-|—|―|不詳|未記載|読み取れ(?:ない|ません)|空欄)\s*$/;

/** 読み取り結果から「項目: 値」の行だけを取り出す（純関数・テストはここに当てる） */
export function parseDetailResult(content: string): DetailResult {
  const raw = (content ?? "").trim();
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (block ? block[1] : raw).trim();
  const jsonStr = body.startsWith("{") ? body : (body.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!jsonStr) return { kind: "other", lines: [], raw };
  try {
    const parsed = JSON.parse(jsonStr) as { kind?: unknown; lines?: unknown };
    const kindRaw = String(parsed.kind ?? "").trim() as ImageKind;
    const kind: ImageKind = KIND_OK.has(kindRaw) ? kindRaw : "other";
    if (kind !== "property") return { kind, lines: [], raw };
    const lines = (Array.isArray(parsed.lines) ? parsed.lines : [])
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
      .filter((s) => s.length >= 2 && s.length <= 120)
      .filter((s) => /[:：]/.test(s))          // 「項目: 値」の形だけ（地の文・感想を入れない）
      .filter((s) => !EMPTY_VALUE_RE.test(s))  // 「不明」「記載なし」は材料にしない
      .slice(0, 20);
    return { kind, lines, raw };
  } catch { return { kind: "other", lines: [], raw }; }
}

/**
 * 画像1枚の中身を読む（物件の資料だけ書き出す）。失敗しても投げない（lines が空になるだけ）。
 * ⚠ 推論モデルなので max_tokens は大きく（小さいと答えが1文字も出ない・上の【踏んだ罠】と同じ）
 */
export async function readPropertyImageDetail(
  imageUrl: string,
  opts?: { apiKey?: string; model?: string; timeoutMs?: number },
): Promise<DetailResult> {
  const apiKey = (opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const model = (opts?.model ?? process.env.PROPERTY_IMAGE_MODEL ?? PROPERTY_IMAGE_MODEL_DEFAULT).trim();
  if (!apiKey || !imageUrl) return { kind: "other", lines: [], raw: "" };
  const startedAt = Date.now();
  try {
    const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: PROPERTY_IMAGE_DETAIL_MAX_TOKENS,
        // 推論を軽くしないと更に時間がかかる
        // （dept_line_reply「VISION_ALT_EFFORT=low ← 推論を軽く（無いと29〜37秒かかる）」と同じ線）
        reasoning_effort: (process.env.PROPERTY_IMAGE_EFFORT ?? "low").trim(),
        messages: [{ role: "user", content: [
          { type: "text", text: PROPERTY_IMAGE_DETAIL_PROMPT },
          { type: "image_url", image_url: { url: imageUrl } },
        ] }],
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 25_000),
    });
    if (!res.ok) {
      // 400 の中身まで残す（画像URLが取れない・大きすぎる等を後で数える。設計知見「error を握り潰さない」）
      const body = await res.text().catch(() => "");
      recordImageReadUsage("property_image_detail", model, undefined, res.status, startedAt, "http_error", PROPERTY_IMAGE_DETAIL_MAX_TOKENS);
      return { kind: "other", lines: [], raw: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: DeepSeekUsage };
    const out = parseDetailResult(String(j.choices?.[0]?.message?.content ?? ""));
    out.usage = { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0, cacheHit: j.usage?.prompt_cache_hit_tokens ?? 0 };
    recordImageReadUsage("property_image_detail", model, j.usage, 200, startedAt, null, PROPERTY_IMAGE_DETAIL_MAX_TOKENS);
    return out;
  } catch (e) {
    recordImageReadUsage("property_image_detail", model, undefined, 0, startedAt, e instanceof Error ? e.name : "error", PROPERTY_IMAGE_DETAIL_MAX_TOKENS);
    return { kind: "other", lines: [], raw: "" };
  }
}

/** DeepSeek の usage（キャッシュに当たった分・外れた分も返る） */
type DeepSeekUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };

/**
 * 2026-09-22 竹内「プロンプトキャッシュもちゃんとできているのか」:
 *   画像の読み取り（DeepSeek を直接呼ぶ）は費用の記録 llm_usage_logs に**1件も残っていなかった**（費用もキャッシュも後から追えない）。
 *   他の DeepSeek の呼び出しと同じ口（recordAltUsage）で1行残す。キャッシュに当たった分は cache_read に入れる。
 *   記録の失敗で読み取りを止めない。
 */
function recordImageReadUsage(action: string, model: string, u: DeepSeekUsage | undefined, status: number, startedAt: number, errorType: string | null, maxTokens: number): void {
  void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
    const hit = u?.prompt_cache_hit_tokens ?? 0;
    const miss = u?.prompt_cache_miss_tokens ?? Math.max(0, (u?.prompt_tokens ?? 0) - hit);
    recordAltUsage({
      model, action, conversationId: null,
      usage: { input_tokens: miss, output_tokens: u?.completion_tokens ?? 0, cache_read_input_tokens: hit },
      status, errorType, durationMs: Date.now() - startedAt,
      sysHead: action === "property_image_detail" ? PROPERTY_IMAGE_DETAIL_PROMPT.slice(0, 200) : PROPERTY_IMAGE_PROMPT.slice(0, 200),
      sysKeyFull: null, maxTokens,
    });
  }).catch(() => {});
}

export type ReadItem = {
  propertyName: string;
  roomNumber: string;
  /** 賃料（管理費を含まない月額）。読めなければ null */
  rent?: number | null;
  /** 敷金（0＝なし）。読めなければ null */
  deposit?: number | null;
  /** 礼金（0＝なし）。読めなければ null */
  keyMoney?: number | null;
  /** 募集状況（sent_properties.recruitment_status と同じ語彙）。読めなければ null */
  status?: string | null;
  /** 退去予定日（"6月30日"）。読めなければ null */
  vacancyDate?: string | null;
  /** 2026-09-25: 管理費・共益費の月額（0＝なし）・間取り・㎡・最寄り駅と徒歩・築年月の文字・AD の文字。読めなければ null */
  adminFee?: number | null;
  floorPlan?: string | null;
  areaSqm?: number | null;
  station?: string | null;
  walkMinutes?: number | null;
  built?: string | null;
  ad?: string | null;
};
export type ReadResult = { items: ReadItem[]; isProperty: boolean; raw: string; usage?: { input: number; output: number; cacheHit?: number } };

/** 応答から JSON を取り出す（```json で囲まれる事がある） */
export function parseReadResult(content: string): ReadResult {
  const raw = (content ?? "").trim();
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (block ? block[1] : raw).trim();
  const jsonStr = body.startsWith("{") || body.startsWith("[") ? body : (body.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0] ?? "");
  if (!jsonStr) return { items: [], isProperty: false, raw };
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    // {"items":[...]} でも [{...}] でも {"property_name":...} でも受ける（モデルが形を変える事がある）
    const arr: Array<Record<string, unknown>> =
      Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>)
      : Array.isArray((parsed as { items?: unknown }).items) ? ((parsed as { items: Array<Record<string, unknown>> }).items)
      : [parsed as Record<string, unknown>];
    const items: ReadItem[] = [];
    for (const o of arr) {
      // 日本語のキーで返す事もあった（{"物件名":"…","号室":[...]}）
      const name = String(o.property_name ?? o["物件名"] ?? "").trim();
      const roomRaw = o.room_number ?? o["号室"];
      if (!name) continue;
      // 2026-09-21: 条件（家賃・敷金・礼金）と募集状況・退去予定日も読む。
      //   ⚠ 読めなかった項目は **null のまま**にする（0 や "" に丸めると「敷金0円」と区別が付かない）
      const num = (v: unknown): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(String(v).replace(/[^0-9.]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      const rent = num(o.rent ?? o["賃料"] ?? o["家賃"]);
      const deposit = num(o.deposit ?? o["敷金"]);
      const keyMoney = num(o.key_money ?? o["礼金"]);
      const STATUS_OK = new Set(["open", "move_out_planned", "under_construction", "occupied"]);
      const rawStatus = String(o.status ?? o["募集状況"] ?? "").trim();
      const status = STATUS_OK.has(rawStatus) ? rawStatus : null;
      const vacancyRaw = String(o.vacancy_date ?? o["退去予定日"] ?? "").trim();
      // 「6月30日」の形だけ受ける（西暦付き・曖昧な語は捨てる）
      const vacancyDate = /^[0-9０-９]{1,2}月[0-9０-９]{1,2}日$/.test(vacancyRaw) ? vacancyRaw : null;
      // 2026-09-25: 候補の記録用（管理費・間取り・㎡・駅と徒歩・築年月・AD）。読めない・空は null
      const str = (v: unknown): string | null => { const t = String(v ?? "").trim(); return t && t !== "null" ? t.slice(0, 40) : null; };
      const extra = {
        adminFee: num(o.admin_fee ?? o["管理費"]),
        floorPlan: str(o.floor_plan ?? o["間取り"]),
        areaSqm: num(o.area_sqm ?? o["専有面積"]),
        station: str(o.station ?? o["最寄り駅"]),
        walkMinutes: num(o.walk_minutes ?? o["徒歩"]),
        built: str(o.built ?? o["築年月"]),
        ad: str(o.ad ?? o["広告料"]),
      };
      // 号室が配列で返る事がある（物件一覧の画像）
      const rooms = Array.isArray(roomRaw) ? roomRaw.map((x) => String(x)) : [String(roomRaw ?? "")];
      for (const r of rooms) items.push({ propertyName: name, roomNumber: r.trim(), rent, deposit, keyMoney, status, vacancyDate, ...extra });
    }
    const isProp = typeof (parsed as { is_property?: unknown }).is_property === "boolean"
      ? Boolean((parsed as { is_property: boolean }).is_property) : items.length > 0;
    return { items, isProperty: isProp, raw };
  } catch { return { items: [], isProperty: false, raw }; }
}

/**
 * 画像を1枚読む。失敗しても投げない（読めなければ items が空＝記録しないだけ）。
 * @param imageUrl 公開URL（LINE の画像は Supabase Storage の公開URLになっている）
 */
export async function readPropertyImage(
  imageUrl: string,
  opts?: { apiKey?: string; model?: string; timeoutMs?: number },
): Promise<ReadResult> {
  const apiKey = (opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const model = (opts?.model ?? process.env.PROPERTY_IMAGE_MODEL ?? PROPERTY_IMAGE_MODEL_DEFAULT).trim();
  if (!apiKey || !imageUrl) return { items: [], isProperty: false, raw: "" };
  const startedAt = Date.now();
  try {
    const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: PROPERTY_IMAGE_MAX_TOKENS,   // ⚠ 小さくすると推論で使い切って空応答になる
        messages: [{ role: "user", content: [
          { type: "text", text: PROPERTY_IMAGE_PROMPT },
          { type: "image_url", image_url: { url: imageUrl } },
        ] }],
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      recordImageReadUsage("property_image_read", model, undefined, res.status, startedAt, "http_error", PROPERTY_IMAGE_MAX_TOKENS);
      return { items: [], isProperty: false, raw: `HTTP ${res.status}` };
    }
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: DeepSeekUsage };
    const out = parseReadResult(String(j.choices?.[0]?.message?.content ?? ""));
    out.usage = { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0, cacheHit: j.usage?.prompt_cache_hit_tokens ?? 0 };
    recordImageReadUsage("property_image_read", model, j.usage, 200, startedAt, null, PROPERTY_IMAGE_MAX_TOKENS);
    return out;
  } catch (e) {
    recordImageReadUsage("property_image_read", model, undefined, 0, startedAt, e instanceof Error ? e.name : "error", PROPERTY_IMAGE_MAX_TOKENS);
    return { items: [], isProperty: false, raw: "" };
  }
}
