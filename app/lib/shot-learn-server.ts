// app/lib/shot-learn-server.ts
//
// 2026-11-14 竹内さん「弱い部分は学習データから写真で必要な部分読み取ったら学習できるのでは」
//
// なぜ要るか（実測で分かった事）:
//   ✅ `SHOT_LEARN_PROMPT`（写真から欄の種類を読む指示文）と `parseShotLearn` は**作ってあった**。
//   ⚠ だが **呼ぶ所が1か所も無かった**（実測 0箇所）。
//     だから `human_motion_learn.shot_learn` は **全件 0**（＝写真は撮れているのに、写真から何も学べていない）。
//   → 写真（Storage の JPEG）を **Vision で読んで**、欄の種類（select / input / checkbox …）と
//     画面の種類（form / modal / result）を `shot_learn` に**書き戻す**。
//
// 何を読むか（個人情報を読まない）:
//   ・欄の**種類**（見た目で決まる: プルダウン／入力／チェック／ボタン／リンク）
//   ・欄の**名前**（見出しの短い文字。40字以内）
//   ・画面の**種類**（form / modal / result / other）
//   ・押せるか（グレーでないか）
//   ⚠ 入力された中身（数字・文字・お客様の名前・住所）は**絶対に読ませない**（プロンプトで禁止）。
//
// 費用:
//   ⚠ Vision は1枚ごとにお金がかかる。**弱い所がある記録だけ**・**1回の上限枚数**を決めて読む。
//     既定は 20枚まで（`SHOT_LEARN_MAX` で変えられる）。
//   実行は**明示的に呼ばれた時だけ**（cron の自動では走らせない）。
import { supabase } from "./supabase-server";
import { SHOT_LEARN_PROMPT, parseShotLearn, type ShotLearn } from "./shot-learn";

const BUCKET = "human-motion-shots";

/** 1回に読む枚数の上限（費用の歯止め） */
export function shotLearnMax(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.SHOT_LEARN_MAX);
  if (Number.isFinite(v) && v > 0) return Math.min(60, Math.floor(v));
  return 20;
}

/** `shot_learn` がまだ無い記録から、写真の置き場所（shot_key）を集める */
export async function findShotsToLearn(opt: { site?: string | null; days?: number; limit?: number } = {}): Promise<
  Array<{ id: unknown; shot_key: string; site: string | null; mode: string | null }>
> {
  const days = Math.max(1, Math.min(30, opt.days ?? 7));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  /**
   * ⚠ 2026-11-14 竹内さん「1から順に進めていく」→ **実測で判明（2回目の罠）**:
   *   直近の写真を `limit` 件だけ取ってから並べ替えていたので、
   *   **大きい写真（1280px）が取った中に入っていない**と、小さい写真ばかり読んで
   *   「読めた0枚」になっていた（実測: 480x244 を3枚連続で読んで全滅）。
   *   → **DBの側で大きい順に並べて取る**（`order("shot_w")`）。
   *     ⚠ limit より前に並べる（取ってから並べ替えると窓の外が漏れる）。
   */
  let q = supabase
    .from("human_motion_learn")
    .select("id, shot_key, site, mode, shot_w, shot_taken, shot_learn")
    .gte("created_at", since)
    .eq("shot_taken", true)
    .order("shot_w", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(400, opt.limit ?? 200)));
  if (opt.site && opt.site !== "all") q = q.eq("site", opt.site);
  const { data, error } = await q;
  if (error) return [];
  return ((data ?? []) as Array<{ id: unknown; shot_key?: string | null; site?: string | null; mode?: string | null; shot_w?: number | null; shot_learn?: unknown }>)
    .filter((r) => !!r.shot_key && !r.shot_learn)                 // まだ読んでいない物だけ
    /**
     * ⚠ **実測**: 480x244 の小さい写真は欄が**1つも読めない**（`fields: []`）。
     *   読めない写真に1枚ずつお金を払うのは無駄。
     *   → **大きい写真（1000px以上・小窓が開いた瞬間に撮った物）を先に読む**（DBで並べた上で念のため）。
     *     ⚠ 小さい物も捨てない（後ろに回すだけ）。
     */
    .sort((a, b) => (Number(b.shot_w) || 0) - (Number(a.shot_w) || 0))
    .map((r) => ({ id: r.id, shot_key: String(r.shot_key), site: r.site ?? null, mode: r.mode ?? null }));
}

/** 写真1枚を Vision で読む（読めなければ null・投げない） */
export async function readShotFields(shotKey: string): Promise<ShotLearn | null> {
  try {
    /**
     * Storage の**署名付き URL** を作る（非公開でも読める・公開設定に依存しない）。
     *   ⚠ 写真そのものをDBから読み直さない（重い）。Storage から直接読む。
     */
    const signed = await supabase.storage.from(BUCKET).createSignedUrl(shotKey, 60 * 10);
    const url = signed?.data?.signedUrl ?? null;
    if (!url) return null;
    /**
     * 2026-11-14 竹内さん「1から順に進めていく」→ **実測で判明（DeepSeek では読めない）**:
     *
     *   DeepSeek-V4.1-Flash に画像つきで投げると、**推論にトークンを全部使って `content` が空**になる。
     *     max_tokens 700  → content 0字（推論 550）
     *     max_tokens 2500 → content 0字（推論 2500・finish=length・推論 7,827字）
     *   ⚠ HTTP は 200 で返るので**成功に見える**（これが「読めた0枚」の正体）。
     *   ⚠ 小さい写真（480x244）では 2500 で `{"screen":"modal","fields":[]}` が返ったが、
     *     これは**欄が1つも読めていない**（＝写真が小さすぎる）。
     *
     *   Claude（claude-haiku-4-5）は同じ写真で **欄5個を正しく読めた**（実測・1枚 約6秒）:
     *     ピンポイント radio / 近い駅で検索 radio / リアプロで賃貸検索 button / 全条件キープ button
     *   → **Claude で読む**。DeepSeek が使えるのは「文を作る」ような推論が短くて済む仕事。
     */
    const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
    if (!apiKey) return null;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.SHOT_LEARN_MODEL || "claude-haiku-4-5",
        max_tokens: 1500,
        system: SHOT_LEARN_PROMPT,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "この画面写真から、フォームの作りだけを読み取って JSON で返してください。" },
            { type: "image", source: { type: "url", url } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { content?: Array<{ text?: string }> };
    const text = String(j.content?.[0]?.text ?? "").trim();
    if (!text) return null;
    const parsed = parseShotLearn(text);
    // 何も読めなかった時は保存しない（推測で埋めない）
    if (!parsed.fields.length && parsed.screen === "other") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 弱い所がある写真だけ読んで `shot_learn` に書き戻す。
 *   ⚠ `dry_run` の時は**読むだけで書かない**（費用を確かめる時）。
 */
export async function learnFromWeakShots(
  opt: { site?: string | null; days?: number; limit?: number; dryRun?: boolean } = {},
): Promise<{ tried: number; learned: number; saved: number; skipped: number; fields: number; errors: string[] }> {
  const max = Math.max(1, Math.min(shotLearnMax(), opt.limit ?? shotLearnMax()));
  const out = { tried: 0, learned: 0, saved: 0, skipped: 0, fields: 0, errors: [] as string[] };
  const targets = (await findShotsToLearn({ site: opt.site, days: opt.days, limit: max })).slice(0, max);
  for (const t of targets) {
    out.tried++;
    const sl = await readShotFields(t.shot_key);
    if (!sl) { out.skipped++; continue; }
    out.learned++;
    out.fields += sl.fields.length;
    if (opt.dryRun) continue;
    const { error } = await supabase
      .from("human_motion_learn")
      .update({ shot_learn: sl })
      .eq("id", t.id);
    if (error) out.errors.push(String(error.message).slice(0, 120));
    else out.saved++;
  }
  return out;
}
