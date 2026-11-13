// POST /api/shot-learn
// 画面の写真から学ぶ（2026-11-13 竹内さん
//   「画面の写真から判断できる。そこの部分強化するようにする。
//     画像を見れば学習できるし弱い部分等は学習の統括が判断して学習を繰り返していく」)
//
// 何をするか:
//   ① 写真（Storage の shot_key）を取る
//   ② **決定論で読める物は決定論で**（画面に select があるか・欄の数・小窓か）＝お金をかけない
//   ③ 決定論で足りない時だけ LLM（Vision）に「欄の種類」を読ませる
//   ④ 読んだ物を `human_motion_learn.shot_learn` に残す（学習の束がそれを数値と突き合わせて使う）
//
// ⚠ 読むのは**欄の種類・画面の種類・押せるか**だけ。入力された中身・名前・住所は読まない。
// ⚠ 費用: LLM は 1回1枚のみ（既定は無効・`SHOT_LEARN_LLM=on` で使う）。決定論だけで動く。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { cleanFields, cleanScreen, screenOf, parseShotLearn, describeShotLearn, SHOT_LEARN_PROMPT, type ShotLearn } from "@/app/lib/shot-learn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-automation-key",
};
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

/** 決定論で読んだ物（写真を見ずに、記録の数値から分かる事だけ） */
function deterministicFrom(row: Record<string, unknown>): ShotLearn {
  /**
   * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい」:
   *   ⚠ 旧は URL だけで画面を推していた（`shot_ops` を見ていなかった）。
   *   → 操作の名前（地域・駅の段）と欄の種類から**画面を判定**する。
   */
  const fields = cleanFields(
    (Array.isArray(row.shot_ops) ? row.shot_ops : []).map((o) => {
      const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
      return { name: x.f, kind: x.w, x: null, y: null };
    }),
  );
  const screen: ShotLearn["screen"] = screenOf({
    url: row.url,
    ops: (Array.isArray(row.shot_ops) ? row.shot_ops : []) as Array<{ f?: unknown }>,
    fields,
  });
  return { screen, fields, by: "deterministic", confidence: fields.length ? 0.9 : 0.3 };
}

export async function POST(req: NextRequest) {
  let body: { shot_key?: unknown; llm?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400, headers: CORS }); }
  const key = typeof body.shot_key === "string" ? body.shot_key.slice(0, 200) : "";
  if (!key) return NextResponse.json({ ok: false, error: "shot_key_required" }, { status: 400, headers: CORS });

  // ① その写真の行を取る
  const r = await supabase.from("human_motion_learn")
    .select("id, url, site, shot_ops, created_at")
    .eq("shot_key", key).limit(1);
  if (r.error) return NextResponse.json({ ok: false, error: r.error.message }, { status: 500, headers: CORS });
  const row = (r.data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return NextResponse.json({ ok: false, error: "row_not_found" }, { status: 404, headers: CORS });

  // ② 決定論で読む
  let learn = deterministicFrom(row);
  let usedLlm = false;

  // ③ 足りない時だけ LLM（既定 off・費用を勝手にかけない）
  const wantLlm = String(process.env.SHOT_LEARN_LLM ?? "").toLowerCase() === "on" && (body.llm === true || learn.fields.length === 0);
  if (wantLlm) {
    try {
      const pub = supabase.storage.from("human-motion-shots").getPublicUrl(key);
      const url = pub?.data?.publicUrl;
      const key2 = process.env.ANTHROPIC_API_KEY;
      if (url && key2) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key2, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-sonnet-5",
            max_tokens: 2000,
            system: SHOT_LEARN_PROMPT,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "url", url } },
                { type: "text", text: "この画面のフォームの作りだけを JSON で返してください。" },
              ],
            }],
          }),
          signal: AbortSignal.timeout(40000),
        });
        if (res.ok) {
          const j = await res.json() as { content?: Array<{ type?: string; text?: string }> };
          const txt = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
          const llm = parseShotLearn(txt);
          if (llm.fields.length) { learn = llm; usedLlm = true; }
        }
      }
    } catch { /* LLM が落ちても決定論で返す */ }
  }

  const screen = cleanScreen(learn.screen);
  const out: ShotLearn = { ...learn, screen, fields: cleanFields(learn.fields) };

  // ④ 残す（列が無いDBでも止めない）
  let saved = false;
  try {
    const { error } = await supabase.from("human_motion_learn")
      .update({ shot_learn: out })
      .eq("id", row.id as number);
    saved = !error;
    if (error && !/shot_learn|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ ok: false, error: error.message, learn: out }, { status: 500, headers: CORS });
    }
  } catch { /* 残せなくても読んだ結果は返す */ }

  return NextResponse.json({
    ok: true, saved, used_llm: usedLlm,
    key,
    screen: out.screen,
    fields: out.fields,
    confidence: out.confidence,
    note: describeShotLearn(out),
  }, { headers: CORS });
}
