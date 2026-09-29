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
//     → 2026-09-29 に物件名の読み取り（readPropertyImage）だけ推論なしに変えた（ファイル末尾の注記・照合で会話の物件名に寄せる）。条件の行は推論 low のまま

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
// 2026-09-29: 値が空の行（「ペット: 」・文字層の読み取りで出た）と「ー」「－」（資料の空欄の横線）も同じ扱いにする
const EMPTY_VALUE_RE = /[:：]\s*(?:不明|記載なし|なし|-|—|―|ー|－|不詳|未記載|読み取れ(?:ない|ません)|空欄)?\s*$/;

/**
 * 120字を超える行（設備欄を全部写した行）を、区切り（、・，／ 空白）の所で 120字以内に切る（純関数）。
 * 2026-09-29: 推論なしの読み取りは設備欄を要約せずに全部写す（125〜978字）ので、旧は「120字超は捨てる」で設備の行が丸ごと落ちていた
 *   （監査 scripts/audit-sent-image-combined-read.ts: 30枚中 19〜20行）。区切りが無い長い行は今まで通り捨てる（地の文の可能性）
 */
export function clipLongLine(s: string, max = 120): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const cut = Math.max(head.lastIndexOf("、"), head.lastIndexOf("・"), head.lastIndexOf("，"), head.lastIndexOf(","), head.lastIndexOf("／"), head.lastIndexOf(" "));
  // 見出し（「設備:」）より後ろで切れる時だけ
  const colon = s.search(/[:：]/);
  if (cut <= Math.max(colon + 4, 20)) return s;
  return s.slice(0, cut).replace(/[、・，,／\s]+$/, "");
}

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
      .map((x) => clipLongLine(String(x ?? "").replace(/\s+/g, " ").trim()))
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
      sysHead: action === "property_image_detail" ? PROPERTY_IMAGE_DETAIL_PROMPT.slice(0, 200)
        : action === "property_image_transcribe" ? PROPERTY_IMAGE_TRANSCRIBE_PROMPT.slice(0, 200) : PROPERTY_IMAGE_PROMPT.slice(0, 200),
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
  opts?: { apiKey?: string; model?: string; timeoutMs?: number; thinking?: boolean },
): Promise<ReadResult> {
  const apiKey = (opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const model = (opts?.model ?? process.env.PROPERTY_IMAGE_MODEL ?? PROPERTY_IMAGE_MODEL_DEFAULT).trim();
  if (!apiKey || !imageUrl) return { items: [], isProperty: false, raw: "" };
  const thinking = opts?.thinking ?? propertyImageReadThinking();
  const maxTokens = thinking ? PROPERTY_IMAGE_MAX_TOKENS : PROPERTY_IMAGE_READ_NO_THINKING_MAX_TOKENS;
  const startedAt = Date.now();
  try {
    const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,   // ⚠ 推論ありで小さくすると推論で使い切って空応答になる
        // 2026-09-29: 推論なし・温度0（下の PROPERTY_IMAGE_READ_NO_THINKING_MAX_TOKENS の注記）
        ...(thinking ? {} : { thinking: { type: "disabled" }, temperature: 0 }),
        messages: [{ role: "user", content: [
          { type: "text", text: PROPERTY_IMAGE_PROMPT },
          { type: "image_url", image_url: { url: imageUrl } },
        ] }],
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      recordImageReadUsage("property_image_read", model, undefined, res.status, startedAt, "http_error", maxTokens);
      return { items: [], isProperty: false, raw: `HTTP ${res.status}` };
    }
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: DeepSeekUsage };
    const out = parseReadResult(String(j.choices?.[0]?.message?.content ?? ""));
    out.usage = { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0, cacheHit: j.usage?.prompt_cache_hit_tokens ?? 0 };
    recordImageReadUsage("property_image_read", model, j.usage, 200, startedAt, null, maxTokens);
    return out;
  } catch (e) {
    recordImageReadUsage("property_image_read", model, undefined, 0, startedAt, e instanceof Error ? e.name : "error", maxTokens);
    return { items: [], isProperty: false, raw: "" };
  }
}

// ─── 2026-09-29 竹内「更に節約できないか」（送る側の画像の読み取りの無駄）──────────────────
// 【何が無駄だったか（本番 llm_usage_logs 9/29 18:37・18:50・19:14）】送った画像1枚ごとに send-line-message の after が
//   ① recordSentImageProperty → readPropertyImage（物件名・号室・家賃…）… 推論は**既定の重さ**（reasoning_effort を送っていなかった）＝出力 1,900〜6,700・11〜30秒
//   ② ensureImageDetail → readPropertyImageDetail（条件の行・推論 low）… 出力 2,100〜9,100・12〜39秒
//   を同じ時刻に別々に呼んでいた。9/29 の直し（売上サポの行を先に引く）は AIX に pickup_ids が来た時と URL が行と同じ時だけ効き、
//   9/29 夕方の送付（62d01e33・f2967621・d25e07d1）はどれもその経路に乗らなかった（その会話の売上サポの行に無い物件・行 ID なし）。
// 【直し】
//   ① 物件名・号室・家賃などの読み取りは**推論なし・温度0**（出力 150〜500・3〜5秒）。
//      監査 scripts/audit-sent-image-combined-read.ts（本番で送った画像・照合済みの記録と比べる）で物件名・号室・家賃が推論ありと同じだった。
//      名前の読み違い（9/20 の「本町橋→本町筋」）は照合（resolveReadProperty）がその会話の物件名に寄せる。
//   ② 同じ URL の読み取りは1つの約束（Promise）を共有する（sharedPropertyImageRead）。ensureImageDetail が物件名を知りたい時は
//      記録の側と同じ読み取りを待つだけ＝物件名の読み取りは1枚1回。物件名と号室がその会話の売上サポの行に当たれば
//      行の image_lines か文字層（推論なし・$0.001）で条件の行を作り、画像の条件の読み取り（推論 low・30秒）を呼ばない。
//   ③ **条件の行（readPropertyImageDetail）は推論 low のまま残す**（出口の決定論: 誤りが0でなければ入れない）。
//      監査 scripts/audit-image-read-grounding.ts（PDF の文字層を正解の元に）で、推論なしは資料に無い可否を作った
//      （「ペット: 不可」「連帯保証人: 不要」＝指示の例を写す・24件中 6〜33行。推論 low は 1〜5行）・ペット／洗濯機置場／駐輪場の行も落ちた。
//      1回で両方を読む案（scripts/audit-image-both-prompt.ts）も同じ理由で入れなかった。
//   ④ 2026-09-29（その2）: ③の「条件の行を推論なしで直接書かせる」の代わりに、**書き写し（推論なし）→ 文字層と同じ読み方**の2段
//      （readPropertyImageDetailByTranscript・下）を送った画像の既定にした。判断（可否）を画像の読み取りにさせないので例を写さない。
//      監査（30枚ずつ・2通り）:
//        PDF の文字層を正解に（audit-image-read-grounding.ts）… 旧（推論 low）作った 3〜4・落ちた 28/119・出力 6,223・31秒
//                                                            → 新 作った 0〜4・落ちた 22〜26/124・出力 1,055〜1,434・13〜15秒
//        本番で送った画像（audit-sent-image-transcribe.ts・保存済みの行と1行ずつ）… 旧どうしの揺れ（同じ画像の読み直し）保存済みだけ 22 に対し
//          新 保存済みだけ 16〜19（退去予定は現況・入居可能日の行に入った物が大半）・出力 1,266〜1,362・9〜11秒
//      作った行は旧も新も同じ種類の読み違い（プレサンス松屋町グレースの「※プレサポ安心24」を旧の推論 low も新も「ペット飼育不可」と読む）＝推論の有無の差ではない。
//      新で見つけて直した物: 部屋の一覧（Goパレス福島 3室「状況 10/末」）が行から落ちた → 書き写しに一覧の写し方・文字の読み取りに
//      「2部屋以上なら現況の1行に」（PROPERTY_TRANSCRIPT_DETAIL_SYSTEM）。1部屋でも畳むと入居可能日「即入」を 14件落としたので2部屋以上に限った。
//      旧の保存済みの誤り（高殿サンクの「ペット: 不可」「所在階: 3階」＝資料に無い／レオンコンフォート難波クレアの「洗濯機置場: 室外」＝資料は室内）は新では出なかった。
// 【戻し方】PROPERTY_IMAGE_READ_THINKING=on で①を旧の推論ありに戻す。SENT_IMAGE_DETAIL_MODE=image で④を旧の画像読み（推論 low）に戻す。

// ─── 2026-09-29（B・その2）条件の行を「書き写す（推論なし）→ 文字層と同じ読み方」の2段で作る案 ─────────────
// 推論なしで条件の行を直接書かせると、可否を**判断**させる所で指示の例を写した（上の【直し】③）。
// 書き写しだけなら判断が無い（見出しと値をそのまま写す＝文字を読むだけ）。写しを文字層の読み取り（readPropertyDetailFromText・
// 出口の dropUngroundedLines＝写しに言葉の無い可否は落とす）に渡せば、文字層がある資料と同じ形で行が作れる。
// 監査 scripts/audit-image-read-grounding.ts の ocr（PDF の文字層を正解の元に・作った行／落ちた行を推論 low と並べる）で決める。
export const PROPERTY_IMAGE_TRANSCRIBE_PROMPT = `この画像の文字を、書いてあるとおりに書き写してください（書き写しだけ。説明・要約・判断は不要）。
1行目は画像の種類を次のどれか1つで書く: 【物件の資料】【見積書】【本人確認書類・申込書】【その他】
【物件の資料】（マイソク・募集図面・間取り図）の時だけ、2行目から書き写す:
- 表の欄は「見出し: 値」の形で1行ずつ。値が空欄の見出しは写さない
- 部屋の一覧の表（号室・家賃・状況・入居時期など）は1部屋1行で「号室: 203 / 状況: 10/末」のように列の見出しと値の組で写す
- 設備・条件・備考・特約の欄は書いてある言葉を全部写す（○・✕・チェックの印が付いていれば印もそのまま）
- 大きな文字の宣伝の文句（「インターネット無料」など）も写す
- 地図・周辺の施設・会社の案内は写さなくてよい
- 読めない文字は飛ばす。画像に無い言葉を足さない・推測しない
【物件の資料】以外は1行目だけで終わる（中身は写さない）`;
/** 書き写しの上限（推論なし＝出力は写した文字だけ。資料1枚で 600〜1,500 前後の見込み・上限は費用にならない） */
export const PROPERTY_IMAGE_TRANSCRIBE_MAX_TOKENS = 3000;

const TRANSCRIBE_KIND: Array<[RegExp, ImageKind]> = [
  [/^【?物件の資料】?/, "property"], [/^【?見積書】?/, "estimate"], [/^【?本人確認書類/, "document"], [/^【?その他】?/, "other"],
];
/**
 * 書き写しの1行目（種類）と本文を分ける（純関数）。1行目に種類が無ければ kind=null（本文は全部＝文字層の読み取りに種類を決めさせる）
 */
export function parseTranscript(text: string): { kind: ImageKind | null; body: string } {
  const t = String(text ?? "").replace(/\r/g, "").replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  const [first, ...rest] = t.split("\n");
  const head = (first ?? "").trim();
  for (const [re, kind] of TRANSCRIBE_KIND) if (re.test(head)) return { kind, body: rest.join("\n").trim() };
  return { kind: null, body: t };
}

/** 送った画像の条件の行をどう読むか（既定は書き写し・SENT_IMAGE_DETAIL_MODE=image で旧の推論 low の画像読みに戻す） */
export function sentImageDetailMode(env: Record<string, string | undefined> = process.env): "transcribe" | "image" {
  return (env.SENT_IMAGE_DETAIL_MODE ?? "").trim().toLowerCase() === "image" ? "image" : "transcribe";
}

/**
 * 画像1枚の条件の行を「書き写し（推論なし・温度0）→ 文字層と同じ読み方（readPropertyDetailFromText・推論なし・出口の dropUngroundedLines）」で作る。
 * 書き写しか文字の読み取りが失敗した時は旧の画像読み（readPropertyImageDetail・推論 low）に倒す＝材料は減らさない（費用は失敗した回だけ）。
 * 物件の資料以外（見積書・本人確認書類・その他）は中身を書き出さない（kind だけ・書き写しの本文も文字の読み取りに渡さない）。
 * 費用は llm_usage_logs に action="property_image_transcribe"（書き写し）＋ "property_text_detail"（文字の読み取り）で残る。
 */
export async function readPropertyImageDetailByTranscript(
  imageUrl: string,
  opts?: { apiKey?: string; model?: string; timeoutMs?: number; conversationId?: string | null },
): Promise<DetailResult & { via: "transcribe" | "image_fallback" }> {
  const apiKey = (opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const model = (opts?.model ?? process.env.PROPERTY_IMAGE_MODEL ?? PROPERTY_IMAGE_MODEL_DEFAULT).trim();
  if (!apiKey || !imageUrl) return { kind: "other", lines: [], raw: "", via: "transcribe" };
  const budget = opts?.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  const fallback = async (why: string) => {
    console.warn(JSON.stringify({ tag: "image-detail:transcribe-fallback", why, imageUrl: imageUrl.slice(-40) }));
    const left = Math.max(10_000, budget - (Date.now() - startedAt));
    return { ...(await readPropertyImageDetail(imageUrl, { apiKey, model, timeoutMs: left })), via: "image_fallback" as const };
  };
  let text = "";
  let usage: DeepSeekUsage | undefined;
  // 書き写しは1回だけ読み直す（監査で 30枚中1枚が一時的な HTTP 400 で旧の画像読み＝出力 6,179 に倒れた。書き写しの読み直しは出力 1,000 前後）
  let why = "";
  for (let attempt = 0; attempt < 2 && !text; attempt++) {
    const t1 = Date.now();
    const left = budget - (t1 - startedAt);
    if (attempt > 0 && left < 20_000) break;
    try {
      const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: PROPERTY_IMAGE_TRANSCRIBE_MAX_TOKENS,
          thinking: { type: "disabled" }, temperature: 0,
          messages: [{ role: "user", content: [
            { type: "text", text: PROPERTY_IMAGE_TRANSCRIBE_PROMPT },
            { type: "image_url", image_url: { url: imageUrl } },
          ] }],
        }),
        signal: AbortSignal.timeout(Math.min(left, 45_000)),
      });
      if (!res.ok) {
        recordImageReadUsage("property_image_transcribe", model, undefined, res.status, t1, "http_error", PROPERTY_IMAGE_TRANSCRIBE_MAX_TOKENS);
        why = `http_${res.status}`;
        continue;
      }
      const j = await res.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: DeepSeekUsage };
      text = String(j.choices?.[0]?.message?.content ?? "").trim();
      usage = j.usage;
      recordImageReadUsage("property_image_transcribe", model, j.usage, 200, t1, text ? null : "empty", PROPERTY_IMAGE_TRANSCRIBE_MAX_TOKENS);
      if (!text) why = "transcribe_empty";
    } catch (e) {
      recordImageReadUsage("property_image_transcribe", model, undefined, 0, t1, e instanceof Error ? e.name : "error", PROPERTY_IMAGE_TRANSCRIBE_MAX_TOKENS);
      why = "transcribe_error";
    }
  }
  if (!text) return await fallback(why || "transcribe_empty");
  const tr = parseTranscript(text);
  const tUsage = { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0, cacheHit: usage?.prompt_cache_hit_tokens ?? 0 };
  // 物件の資料以外は中身を書き出さない（本文を文字の読み取りにも渡さない）
  if (tr.kind && tr.kind !== "property") return { kind: tr.kind, lines: [], raw: "", usage: tUsage, via: "transcribe" };
  // 資料と言ったが写した文字が無い（室内写真・間取り図だけ等）＝書き出す行が無い
  if (tr.kind === "property" && tr.body.replace(/\s+/g, "").length < 10) return { kind: "property", lines: [], raw: text, usage: tUsage, via: "transcribe" };
  const { readPropertyDetailFromText, PROPERTY_TRANSCRIPT_DETAIL_SYSTEM } = await import("./property-detail-source");
  const left = Math.max(5_000, budget - (Date.now() - startedAt));
  const d = await readPropertyDetailFromText(tr.body, { apiKey, model, timeoutMs: left, conversationId: opts?.conversationId ?? null, system: PROPERTY_TRANSCRIPT_DETAIL_SYSTEM });
  if (d.failed) return await fallback("text_read_failed");
  return {
    kind: tr.kind ?? d.kind, lines: d.kind === "property" || tr.kind === "property" ? d.lines : [], raw: d.raw,
    usage: { input: tUsage.input + (d.usage?.input ?? 0), output: tUsage.output + (d.usage?.output ?? 0), cacheHit: (tUsage.cacheHit ?? 0) + (d.usage?.cacheHit ?? 0) },
    via: "transcribe",
  };
}

/** 送った画像の物件名などの読み取りの時間切れ（recordSentImageProperty と ensureImageDetail が同じ読み取りを待つので同じ値） */
export const SENT_IMAGE_READ_TIMEOUT_MS = 80_000;

/** 推論なしの時の上限（答えだけ・一覧の画像 9室でも 1,500 前後。上限は費用にならない） */
export const PROPERTY_IMAGE_READ_NO_THINKING_MAX_TOKENS = 3000;

/** 物件名などの読み取りで推論を使うか（既定は使わない・PROPERTY_IMAGE_READ_THINKING=on で旧に戻す） */
export function propertyImageReadThinking(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_IMAGE_READ_THINKING ?? "").trim().toLowerCase() === "on";
}

/**
 * 同じ URL の物件名などの読み取りを処理の中で1つにまとめる（recordSentImageProperty と ensureImageDetail が並んで走っても1回）。
 * 読めなかった結果は持たない（次の機会に読み直せるように）。3分で忘れる（募集状況は日で変わるので長く持たない）
 */
const SHARED_READ_TTL_MS = 3 * 60_000;
const sharedReads = new Map<string, { at: number; p: Promise<ReadResult> }>();
export function sharedPropertyImageRead(imageUrl: string, opts?: { timeoutMs?: number }): Promise<ReadResult> {
  const now = Date.now();
  for (const [k, v] of sharedReads) if (now - v.at > SHARED_READ_TTL_MS) sharedReads.delete(k);
  const hit = sharedReads.get(imageUrl);
  if (hit) return hit.p;
  const p = readPropertyImage(imageUrl, { timeoutMs: opts?.timeoutMs }).then((r) => {
    if (r.items.length === 0 && !r.raw.startsWith("{")) sharedReads.delete(imageUrl);
    return r;
  }, (e) => { sharedReads.delete(imageUrl); throw e; });
  sharedReads.set(imageUrl, { at: now, p });
  return p;
}
