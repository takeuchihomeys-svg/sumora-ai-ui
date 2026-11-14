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
    /**
     * ★ 2026-11-14 竹内さん「これで画像の部分から学習できるようにする」→ **実測で確立した方法**:
     *
     *   ⚠ 全体写真をそのまま読ませると、AI は**中央に重なった拡張の小窓**を読む（実測）:
     *     ビジポイント / 近い順で検索 / リアプロで看護師募集 / Bandit利用で割合 / 全自動キーコピー
     *     ＝ サイトの欄ではなく**拡張のボタン**（同じ位置・同じ形の別物）。
     *   ⚠ プロンプトに「小窓は読まない」と書いても直らない（小窓が後ろの欄を覆っていて見えない）。
     *
     *   → **左34%（検索条件のサイドバー）を切り出して 1200px に拡大**して読む（実測で確立）:
     *     マップ検索 / 閲覧履歴 / 駅からの移動手段(select) / 駅歩 / 交通手段 /
     *     賃料(select) / 上限なし / 下限なし / 共有部・共益費含む(checkbox) /
     *     敷金・礼金なし / フリーワード / 所在地域つり込み / 沿線・駅名つり込み
     *
     *   ⚠ 切り出す位置は**写真の左端から**（拡張の小窓は中央に浮いているので左には来ない）。
     *   ⚠ 座標は**切り出した画像の中の割合**になるので、元の写真の座標に戻す（`LEFT_CROP_RATIO` を掛ける）。
     *   ⚠ 小窓を隠した写真（v2.7.62以降）は全体を読んでもよいが、
     *     **左を切り出した方が確実**なので常に左を優先し、読めなかった時だけ全体で読む。
     */
    const LEFT_CROP_RATIO = 0.34;

    /** 写真を取って、左側を切り出して返す（sharp が無ければ null） */
    const cropLeft = async (): Promise<Buffer | null> => {
      try {
        const sharpMod = (await import("sharp")).default;
        const r = await fetch(url);
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        const meta = await sharpMod(buf).metadata();
        const W = Number(meta.width) || 0;
        const H = Number(meta.height) || 0;
        if (!W || !H) return null;
        const w = Math.max(80, Math.round(W * LEFT_CROP_RATIO));
        return await sharpMod(buf)
          .extract({ left: 0, top: 0, width: w, height: H })
          .resize({ width: 1200, kernel: "lanczos3" })
          .sharpen({ sigma: 0.8 })
          .jpeg({ quality: 90 })
          .toBuffer();
      } catch { return null; }
    };

    /** 1回読む（base64 を渡す） */
    const ask = async (b64: string, note: string): Promise<ShotLearn | null> => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.SHOT_LEARN_MODEL || "claude-haiku-4-5",
          max_tokens: 2000,
          system: SHOT_LEARN_PROMPT,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: note },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return null;
      const j = await res.json() as { content?: Array<{ text?: string }> };
      const text = String(j.content?.[0]?.text ?? "").trim();
      if (!text) return null;
      return parseShotLearn(text);
    };

    // ① 左側を切り出して読む（確実）
    const left = await cropLeft();
    if (left) {
      const sl = await ask(
        left.toString("base64"),
        "この画像は**画面の左側（検索条件の欄）だけ**を切り出した物です。"
        + "ここに見えているフォームの欄だけを JSON で返してください。"
        + "欄の名前は画像の文字をそのまま書き、読めない時は name を null にしてください。"
        + "x と y は**この画像の中**の割合（左端0・右端1）で返してください。",
      );
      if (sl && sl.fields.length) {
        /**
         * ⚠ 座標を**元の写真の割合**に戻す（切り出した幅の分だけ x を縮める）。
         *   戻さないと「画面の左34%の中の0.5」＝元の 0.17 を 0.5 として学習してしまう。
         */
        return {
          ...sl,
          fields: sl.fields.map((f) => ({
            ...f,
            x: typeof f.x === "number" ? Math.round(f.x * LEFT_CROP_RATIO * 100) / 100 : null,
          })),
        };
      }
    }

    // ② 左で読めなかった時だけ全体で読む（保険）
    const res = await fetch(url);
    if (!res.ok) return null;
    const whole = Buffer.from(await res.arrayBuffer());
    const sl2 = await ask(
      whole.toString("base64"),
      "この画面写真から、フォームの作りだけを読み取って JSON で返してください。"
      + "画面に重なっている拡張機能の小窓（AIXLINX・案内・学習中）は読まないでください。",
    );
    if (!sl2) return null;
    // 何も読めなかった時は保存しない（推測で埋めない）
    if (!sl2.fields.length && sl2.screen === "other") return null;
    return sl2;
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

/**
 * ★ 2026-11-14 竹内さん「直近画像から 画像を連続でみて左側の押したところのこと…データベースの入っている直近の録画から連続して統括が学習する」
 *
 *   **1枚だけ読むと誤読する**（実測: 「磁性会社こらみ」「所在物件つじ込み」「駅徒歩駅中」）。
 *   同じ欄は**複数の写真に写っている**ので、**位置ごとに多数決**すれば確かな物だけ残せる。
 *
 *   実測（録画 mwgf1gx3_n1k5 の 1280px 15枚 → 多数決）:
 *     32個の欄が2枚以上に出た（select 2・checkbox 4・text 8・button 18）
 *       0.15,0.10 マップ検索（14回とも同じ名前）
 *       0.15,0.20 閲覧履歴 / 0.15,0.30 リセット / 0.15,0.70 検索
 *       0.15,0.40 駅からの移動手段 / 0.10,0.80 select 賃料 / 0.10,0.25 select 下限なし
 *
 *   ⚠ 位置は **0.05 刻み**に丸めて同じ欄とみなす（撮影ごとに数pxずれる）。
 *   ⚠ **2枚以上**出た位置だけ採用（1枚だけは偶然・誤読の可能性）。
 *   ⚠ 名前は「同じ名前が一番多く出た物」。1回しか出ていない名前は**空にする**（嘘を残さない）。
 */
export function voteFieldsFromRuns(
  perShot: ReadonlyArray<ReadonlyArray<{ name?: string | null; kind?: string; x?: number | null; y?: number | null }>>,
  opt: { minVotes?: number; minNameVotes?: number } = {},
): Array<{ name: string | null; kind: string; x: number; y: number; votes: number; nameVotes: number }> {
  const minVotes = opt.minVotes ?? 2;
  const minNameVotes = opt.minNameVotes ?? 2;
  /**
   * ⚠ 2026-11-14 **実測で分かった誤り**: 最初は**位置（0.05刻み）で束ねて**多数決しようとしたが、
   *   同じ欄でも写真ごとに **y が 0.47〜0.50 もずれた**（実測）:
   *     リセット   y=0.49/0.68/0.22/0.28/0.72/0.67  ← ばらつき 0.50
   *     検索       y=0.56/0.78/0.31/0.36            ← ばらつき 0.47
   *     フリーワード y=0.63/0.40/0.44/0.88           ← ばらつき 0.48
   *   ⚠ 理由: **写真ごとに画面のスクロール位置・小窓の高さが違う**（同じ欄が別の高さに写る）。
   *     だから位置で束ねると**同じ欄がバラバラに数えられ**、名前が `null` ばかりになった。
   *
   *   → **名前で束ねる**（位置は平均を取る）。
   *     ⚠ 名前が読めなかった物（null）は束ねられないので**捨てる**（学習に使えない）。
   *     ⚠ 名前が**2枚以上で同じ**なら確か（1枚だけの名前は誤読の可能性＝捨てる）。
   */
  const acc = new Map<string, { kinds: Map<string, number>; xs: number[]; ys: number[]; n: number }>();
  for (const fields of perShot) {
    const seen = new Set<string>();   // 1枚の中で同じ名前を2回数えない
    for (const f of Array.isArray(fields) ? fields : []) {
      const nm = typeof f?.name === "string" ? f.name.trim() : "";
      if (!nm) continue;              // 名前が無い物は学習に使えない（捨てる）
      if (seen.has(nm)) continue;
      seen.add(nm);
      if (!acc.has(nm)) acc.set(nm, { kinds: new Map(), xs: [], ys: [], n: 0 });
      const v = acc.get(nm)!;
      v.n++;
      const kd = String(f.kind || "other");
      v.kinds.set(kd, (v.kinds.get(kd) || 0) + 1);
      if (typeof f.x === "number") v.xs.push(f.x);
      if (typeof f.y === "number") v.ys.push(f.y);
    }
  }
  const med = (a: number[]) => {
    if (!a.length) return 0;
    const s = a.slice().sort((p, q) => p - q);
    return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
  };
  const out: Array<{ name: string | null; kind: string; x: number; y: number; votes: number; nameVotes: number }> = [];
  for (const [nm, v] of acc) {
    if (v.n < Math.max(minVotes, minNameVotes)) continue;
    const kind = [...v.kinds.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // ⚠ 位置は**中央値**（ばらつきが大きいので平均より外れに強い）
    out.push({ name: nm, kind, x: med(v.xs), y: med(v.ys), votes: v.n, nameVotes: v.n });
  }
  return out.sort((a, b) => b.votes - a.votes);
}

/**
 * 直近の録画（1つの `run_id`）を**連続で読んで多数決**し、確かな欄を返す。
 *   ⚠ 費用がかかる（1枚ごと）。`maxShots` で上限を決める（既定5枚）。
 *   ⚠ `dryRun` の時は**書かない**（読むだけ）。
 */
export async function learnFromLatestRun(
  opt: { maxShots?: number; dryRun?: boolean; runId?: string } = {},
): Promise<{
  run: string | null; shots: number; read: number; fields: number;
  byKind: Record<string, number>; saved: number; sample: Array<{ name: string | null; kind: string; votes: number }>;
}> {
  const maxShots = Math.max(1, Math.min(12, opt.maxShots ?? 5));
  const empty = { run: null, shots: 0, read: 0, fields: 0, byKind: {}, saved: 0, sample: [] };
  try {
    // ① 直近の写真から run_id を決める（指定が無ければ一番新しい物）
    const { data: recent } = await supabase
      .from("human_motion_learn")
      .select("id, created_at, shot_key, shot_w, shot_taken, shot_learn")
      .eq("shot_taken", true).not("shot_key", "is", null)
      .order("created_at", { ascending: false }).limit(200);
    const rows = (recent ?? []) as Array<{ id: unknown; created_at: string; shot_key: string; shot_w?: number | null; shot_learn?: unknown }>;
    if (!rows.length) return empty;
    const runOf = (k: string) => (k.match(/run_([a-z0-9_]+)\//i) || [])[1] || "";
    const run = opt.runId || runOf(rows[0].shot_key);
    if (!run) return empty;

    /**
     * ② その録画の写真を**大きい順**に取る（1280px＝小窓/プルダウンが開いた瞬間が一番読める）。
     *   ⚠ まだ読んでいない物を優先（既に `shot_learn` がある物は飛ばす）。
     */
    const inRun = rows.filter((r) => runOf(r.shot_key) === run);
    const unlearned = inRun.filter((r) => !r.shot_learn);
    const pick = (unlearned.length ? unlearned : inRun)
      .slice()
      .sort((a, b) => (Number(b.shot_w) || 0) - (Number(a.shot_w) || 0))
      .slice(0, maxShots);
    if (!pick.length) return { ...empty, run };

    // ③ 1枚ずつ読む
    const perShot: Array<Array<{ name: string | null; kind: string; x?: number | null; y?: number | null }>> = [];
    let read = 0;
    for (const p of pick) {
      const sl = await readShotFields(p.shot_key);
      if (!sl) continue;
      read++;
      perShot.push(sl.fields);
    }
    if (!read) return { ...empty, run, shots: pick.length };

    // ④ 多数決
    const voted = voteFieldsFromRuns(perShot);
    const byKind: Record<string, number> = {};
    for (const v of voted) byKind[v.kind] = (byKind[v.kind] || 0) + 1;

    // ⑤ 代表の1行（一番大きい写真）に書き戻す
    /**
     * ⚠ 2026-11-14 竹内さん「これで画像の部分から学習できるようにする」:
     *   旧は**代表の1行にしか書いていなかった**ので、同じ録画の他の写真は
     *   `shot_learn` が空のままだった（＝その写真は「まだ読んでいない」と数えられ、
     *   次の実行でまた読んで**同じ費用を何度も払う**）。
     *   → 同じ録画（run）の写真は**同じ画面**なので、多数決の結果を**全枚に配る**。
     *     ⚠ 配るのは `run` を付けた結果だけ（別の録画には配らない＝画面が違う）。
     *     ⚠ 写真ごとに読んだ結果ではないので `by` は `llm_run`（区別できるように）。
     */
    let saved = 0;
    const payload = {
      screen: "form" as const,
      by: "llm_run" as const,
      confidence: Math.min(0.95, Math.round((voted.filter((v) => v.votes >= 3).length / Math.max(1, voted.length)) * 100) / 100),
      fields: voted.map((v) => ({ name: v.name ?? "", kind: v.kind, x: v.x, y: v.y })),
      run_id: run,
      votes: voted.map((v) => ({ x: v.x, y: v.y, n: v.votes, name_n: v.nameVotes })),
      learned_shots: read,
      applied_to: "run",
    };
    if (!opt.dryRun && voted.length) {
      // ① 代表の1行（読んだ写真の中で一番大きい物）
      const target = pick[0];
      const one = await supabase.from("human_motion_learn").update({ shot_learn: payload }).eq("id", target.id);
      if (!one.error) saved = 1;
      // ② 同じ録画の残り（まだ shot_learn が空の物だけ）
      try {
        const ids = inRun.filter((r) => !r.shot_learn && String(r.id) !== String(target.id)).map((r) => r.id);
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          if (!chunk.length) continue;
          const up = await supabase.from("human_motion_learn").update({ shot_learn: payload }).in("id", chunk);
          if (!up.error) saved += chunk.length;
        }
      } catch { /* 配れなくても代表の1行は入っている */ }
    }

    return {
      run, shots: pick.length, read, fields: voted.length, byKind, saved,
      sample: voted.slice(0, 10).map((v) => ({ name: v.name, kind: v.kind, votes: v.votes })),
    };
  } catch {
    return empty;
  }
}
