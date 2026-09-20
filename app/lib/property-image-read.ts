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
export const PROPERTY_IMAGE_PROMPT = `この画像から物件情報を読み取ってください。JSONのみ返答（説明文・コードブロック・前置き一切不要）：
{"items":[{"property_name":"","room_number":"","rent":null,"deposit":null,"key_money":null,"status":"","vacancy_date":""}],"is_property":true}
- items: 画像に出ている物件を全部。1件だけなら1つ、一覧なら全部
- property_name: マンション名のみ（号室は含めない）。読めなければ""
- room_number: 号室番号のみ（例: 502）。号室が無い・読めなければ""
- rent: 賃料（管理費・共益費を含めない月額の数字のみ。例 106000）。読めなければ null
- deposit: 敷金の金額（0円・なしなら 0）。読めなければ null
- key_money: 礼金の金額（0円・なしなら 0）。読めなければ null
- status: 募集状況。次の4つのどれか。読めなければ""
    "open"（空室・即入居可）／"move_out_planned"（退去予定・解約予定）／
    "under_construction"（建築中・新築未完成・竣工予定）／"occupied"（申込あり・満室・募集終了）
- vacancy_date: 退去予定日（"M月D日" の形式。例 "6月30日"）。次のルールで読む
    ・備考欄に「解約予定」「退去予定」「解約日」と書かれた日付があればそれ
    ・「現況」「入居時期」「入居可能日」の欄は**退去後に入居できる日**なので退去予定日にしない
    ・読めなければ ""
- is_property: 物件の資料・マイソク・室内写真なら true、それ以外（見積書・本人確認書類・スクショ）なら false
- 画像に書かれていない物件名・金額・日付を作らないこと（読めない項目は null か "" のまま）`;

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
};
export type ReadResult = { items: ReadItem[]; isProperty: boolean; raw: string; usage?: { input: number; output: number } };

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
      // 号室が配列で返る事がある（物件一覧の画像）
      const rooms = Array.isArray(roomRaw) ? roomRaw.map((x) => String(x)) : [String(roomRaw ?? "")];
      for (const r of rooms) items.push({ propertyName: name, roomNumber: r.trim(), rent, deposit, keyMoney, status, vacancyDate });
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
    if (!res.ok) return { items: [], isProperty: false, raw: `HTTP ${res.status}` };
    const j = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const out = parseReadResult(String(j.choices?.[0]?.message?.content ?? ""));
    out.usage = { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 };
    return out;
  } catch {
    return { items: [], isProperty: false, raw: "" };
  }
}
