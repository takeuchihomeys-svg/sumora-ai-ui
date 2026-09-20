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

export const PROPERTY_IMAGE_PROMPT = `この画像から物件情報を読み取ってください。JSONのみ返答（説明文・コードブロック・前置き一切不要）：
{"items":[{"property_name":"","room_number":""}],"is_property":true}
- items: 画像に出ている物件を全部。1件だけなら1つ、一覧なら全部
- property_name: マンション名のみ（号室は含めない）。読めなければ""
- room_number: 号室番号のみ（例: 502）。号室が無い・読めなければ""
- is_property: 物件の資料・マイソク・室内写真なら true、それ以外（見積書・本人確認書類・スクショ）なら false
- 画像に書かれていない物件名を作らないこと`;

export type ReadItem = { propertyName: string; roomNumber: string };
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
      // 号室が配列で返る事がある（物件一覧の画像）
      const rooms = Array.isArray(roomRaw) ? roomRaw.map((x) => String(x)) : [String(roomRaw ?? "")];
      for (const r of rooms) items.push({ propertyName: name, roomNumber: r.trim() });
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
