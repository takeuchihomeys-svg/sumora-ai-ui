/**
 * 統括に考えさせる cron（2026-11-15 竹内さん）
 *
 *   竹内さん「統括がメインなのでその考えは絶対事項／統括がブレインとしてまとめるようにする」
 *     「日々進化していくように統括のがブレインとなって強化していく」
 *     「vercelで動かす形の方が良いのかな？」→ **Vercel の夜の cron で動かす**（承認済み）
 *
 * ★ 何をするか
 *   ① 本番の材料（束）を取る
 *   ② 決定論の統括（今までの判断）を作る
 *   ③ **DeepSeek V4 Pro に材料から「次に何を直すか」を1つ選ばせる**
 *   ④ 両方を `learn_supervisor_log` に残す（`meeting.llm_think`）
 *      ⚠ LLM が答えられなくても**決定論の判断は残す**（止まらない）
 *
 * ★ 実測（2026-11-15・材料712字）
 *   29.6秒・推論6,930字・出力2,315トークン・約$0.003
 *   答え「検索ボタンの種別判定」… 「検索を押す」が止まりやすい（50回）
 *   ⚠ **私が書いたルールに無い視点**を自分で見つけた（＝LLM に任せる価値がある）
 *
 * ★ 実行
 *   GET /api/cron/supervisor-think          （Vercel cron・毎晩）
 *   GET /api/cron/supervisor-think?dry=1    （保存しない・考えた内容だけ返す）
 *   GET /api/cron/supervisor-think?scope=all
 *
 * ⚠ CRON_SECRET が要る（Vercel cron は自動で付ける）。
 * ⚠ 費用がかかる（1回 約$0.003）。cron は**1日1回**（`vercel.json`）。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { thinkAsSupervisor, supervisorMaterialText } from "@/app/lib/learn-supervisor-llm";

export const dynamic = "force-dynamic";
/** ⚠ LLM の思考に 29.6秒かかる（実測）。既定の10秒では切れる。 */
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

/** Vercel cron の合言葉（cron は自動で付ける） */
function authed(req: NextRequest): boolean {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) return true;   // ⚠ 未設定なら通す（設定漏れで cron が止まる方が困る）
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const u = req.nextUrl.searchParams.get("secret");
  return !!u && u === secret;
}

type Bundle = {
  rows?: number; with_ops?: number; next_n?: number; points_n?: number;
  weak?: Array<{ kind?: string; name?: string; why?: string }>;
  scene_flows?: Array<{ scene?: string; runs?: number; ops?: number; steps?: string[]; variants?: number }>;
  stopped_scene?: string | null;
  improvements?: { total?: number; recent?: Array<{ area?: string; title?: string }> } | null;
  human_ops?: number; auto_ops?: number; same_runs?: number;
};

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: CORS });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const scope = (req.nextUrl.searchParams.get("scope") || "realpro").slice(0, 20);
  const model = (req.nextUrl.searchParams.get("model") || "").slice(0, 40) || undefined;
  const t0 = Date.now();

  try {
    // ① 材料を取る（束を作り直す＝最新）
    const base = process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin;
    const r = await fetch(`${base}/api/human-learn-profile?scope=${encodeURIComponent(scope)}&fresh=1`, { cache: "no-store" });
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: "bundle_http_" + r.status }, { status: 502, headers: CORS });
    }
    const j = (await r.json()) as { bundle?: Bundle & { supervisor?: { lines?: string[] } } };
    const b = j.bundle ?? {};
    const material = supervisorMaterialText(b);

    // ② 決定論の判断（今までの統括・材料に必ず入っている）
    const deterministic = Array.isArray(b.supervisor?.lines) ? b.supervisor!.lines!.slice(0, 20) : [];

    // ③ LLM に考えさせる
    const think = await thinkAsSupervisor(material, { model });

    // ④ 両方を残す
    const out = {
      ok: true,
      scope,
      ms: Date.now() - t0,
      material_chars: material.length,
      deterministic_lines: deterministic.length,
      llm: think
        ? { next: think.next, why: think.why, how: think.how, model: think.model, ms: think.ms, usage: think.usage }
        : null,
      llm_error: think ? null : "no_answer（鍵が無い・時間切れ・答えの形が違う）→ 決定論を使います",
    };

    if (!dry && think) {
      try {
        const nowIso = new Date().toISOString();
        await supabase.from("learn_supervisor_log").insert({
          scope,
          verdict: "llm_think",
          headline: "統括が材料から考えた（" + think.model + "）",
          coverage: null,
          weak_n: Array.isArray(b.weak) ? b.weak.length : null,
          next_n: b.next_n ?? null,
          points_n: b.points_n ?? null,
          rows: b.rows ?? null,
          meeting: {
            llm_think: {
              next: think.next, why: think.why, how: think.how,
              model: think.model, ms: think.ms, usage: think.usage,
              material_chars: material.length, at: nowIso,
            },
            deterministic_lines: deterministic,
          },
          bundle_at: nowIso,
        });
      } catch (e) {
        out.ok = true;
        (out as Record<string, unknown>).save_error = String((e as Error)?.message || e).slice(0, 120);
      }
    }

    return NextResponse.json(out, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message || e).slice(0, 200), ms: Date.now() - t0 },
      { status: 500, headers: CORS },
    );
  }
}
