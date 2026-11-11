// /api/human-motion — 通常モード・スタッフモードで覚えた「人の動き」を受け取る／見る
//   2026-11-11 竹内さん「普通モードでのマウスの動かし方やボタンのどこ押すかもちゃんとたまるんかな。画面のううごかしかたも」
//   「データベース等にはいっているのか」
//
//   POST … 拡張（human-learn-upload.js）から。1回分（1分ごと or タブを離れる時）を1行で入れる。
//          ⚠ 入れるのは**数と傾向だけ**。入力した中身（文字・数字）・お客様の名前・電話・住所は入れない。
//   GET  … 画面・スクリプトから。?days=30（既定30日）で新しい順。?summary=1 で平均・中央値にまとめた形。
//          写真は**この表に入れない**（Storage に置き、この表は shot_key だけ）。?shots=1 で写真のある回の一覧。
import { NextRequest, NextResponse } from "next/server";
import { completeAuthOk } from "@/app/lib/pickup-complete";
import { supabase } from "@/app/lib/supabase-server";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-automation-key",
};

const MAX_BODY_CHARS = 48_000;
/** 写真を付ける時は大きい（base64 で約1.3倍）。写真ありの時だけ上限を上げる */
const MAX_BODY_CHARS_WITH_SHOT = 4_500_000;
/** 1行に入れてよい数の上限（おかしな値で表が汚れないように） */
const LIMIT = {
  ops: 10_000, sessions: 10_000, gap_ms: 600_000,
  moves_n: 10_000, move_speed_px_s: 20_000, move_ms: 60_000, move_dist: 20_000, drag_n: 10_000,
  points_n: 10_000, scrolls_n: 10_000, scroll_dy: 5_000, scroll_down: 10_000, scroll_up: 10_000,
};

function num(v: unknown, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, Math.round(n)));
}
function frac(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}
function siteOf(v: unknown): string | null {
  const s = String(v ?? "").toLowerCase();
  if (s === "realpro" || s === "realnetpro" || s === "リアプロ") return "realpro";
  if (s === "itandi") return "itandi";
  if (s === "reins" || s === "レインズ") return "reins";
  return null;
}
/** 文字の配列を整える（上限・空を落とす・名前は30字まで） */
function strArr(v: unknown, cap: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    const s = String(x ?? "").trim().slice(0, 30);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out.length ? out : null;
}
/** 点の形（[[[x,y],[x,y],...], ...]）を整える。数だけ・0〜1に丸める */
function shapesOf(v: unknown): number[][][] | null {
  if (!Array.isArray(v)) return null;
  const out: number[][][] = [];
  for (const row of v.slice(0, 6)) {
    if (!Array.isArray(row)) continue;
    const pts: number[][] = [];
    for (const p of row.slice(0, 24)) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = frac(p[0]), y = frac(p[1]);
      if (x == null || y == null) continue;
      pts.push([x, y]);
    }
    if (pts.length >= 2) out.push(pts);
  }
  return out.length ? out : null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const ok = completeAuthOk(
    { authorization: req.headers.get("authorization"), automationKey: req.headers.get("x-automation-key") },
    { internalSecret: process.env.INTERNAL_API_SECRET ?? null, automationKey: process.env.AUTOMATION_API_KEY ?? null },
  );
  if (!ok) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: CORS });

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_CHARS_WITH_SHOT) {
    return NextResponse.json({ ok: false, error: "too large" }, { status: 413, headers: CORS });
  }
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400, headers: CORS }); }

  const m = (body.motion && typeof body.motion === "object" ? body.motion : body) as Record<string, unknown>;
  const mv = (m.moves && typeof m.moves === "object" ? m.moves : {}) as Record<string, unknown>;
  const pt = (m.points && typeof m.points === "object" ? m.points : {}) as Record<string, unknown>;
  const sc = (m.scrolls && typeof m.scrolls === "object" ? m.scrolls : {}) as Record<string, unknown>;

  // 何も無い（操作0・動き0）行は入れない（空行で表を埋めない）。
  //   ⚠ 2026-11-11: 写真だけの回（操作0でも写真がある）は入れる（写真を見て確かめるため）
  const opsN = num(m.ops ?? m.n, LIMIT.ops) ?? 0;
  const movesN = num(mv.n, LIMIT.moves_n) ?? 0;
  const pointsN = num(pt.n, LIMIT.points_n) ?? 0;
  const scrollsN = num(sc.n, LIMIT.scrolls_n) ?? 0;
  const hasShot = typeof body.shot_b64 === "string" && body.shot_b64.length > 100;
  if (opsN === 0 && movesN === 0 && pointsN === 0 && scrollsN === 0 && !hasShot) {
    return NextResponse.json({ ok: true, skipped: "empty" }, { headers: CORS });
  }

  const mode = body.mode === "staff" ? "staff" : (body.mode === "normal" ? "normal" : null);
  const row: Record<string, unknown> = {
    install_id: typeof body.install_id === "string" ? body.install_id.slice(0, 64) : null,
    device_label: typeof body.device_label === "string" ? body.device_label.slice(0, 40) : null,
    site: siteOf(body.site),
    mode,
    ext_version: typeof body.ext_version === "string" ? body.ext_version.slice(0, 20) : null,
    session_at: typeof body.at === "number" && body.at > 0 ? new Date(body.at).toISOString() : new Date().toISOString(),
    ops: opsN,
    sessions: num(m.sessions, LIMIT.sessions) ?? 1,
    gap_ms: num(m.gap_ms, LIMIT.gap_ms),

    moves_n: movesN,
    move_speed_px_s: num(mv.speed_px_s, LIMIT.move_speed_px_s),
    move_curve: typeof mv.curve === "number" && mv.curve >= 1 ? Math.round(Math.min(3, mv.curve) * 100) / 100 : null,
    move_ms: num(mv.ms, LIMIT.move_ms),
    move_dist: num(mv.dist, LIMIT.move_dist),
    drag_n: num(mv.drag_n, LIMIT.drag_n) ?? 0,
    move_shapes: shapesOf(mv.shapes),

    points_n: pointsN,
    point_x: frac(pt.x),
    point_y: frac(pt.y),
    point_fields: (pt.fields && typeof pt.fields === "object" && !Array.isArray(pt.fields)) ? pt.fields : null,

    scrolls_n: scrollsN,
    scroll_dy: num(sc.dy, LIMIT.scroll_dy),
    scroll_down: num(sc.down, LIMIT.scroll_down) ?? 0,
    scroll_up: num(sc.up, LIMIT.scroll_up) ?? 0,
    scroll_y: frac(sc.y),
    scroll_ys: (() => {
      if (!Array.isArray(sc.y_samples)) return null;
      const ys = sc.y_samples.map((v) => frac(v)).filter((v): v is number => v != null).slice(-20);
      return ys.length ? ys : null;
    })(),

    kinds: (m.kinds && typeof m.kinds === "object" && !Array.isArray(m.kinds)) ? m.kinds : null,
    fields: strArr(m.fields, 40),
    field_order: strArr(m.order, 40),

    shot_taken: !!body.shot_taken,
    shot_key: typeof body.shot_key === "string" ? body.shot_key.slice(0, 200) : null,
    shot_w: num(body.shot_w, 10000),
    shot_h: num(body.shot_h, 10000),
  };

  // 写真の**中身**（base64 の画像）は**表には入れない**（1行が数百KBになり集計が重くなる）。
  //   2026-11-11 竹内さん「画面画像みればわかるのでは。画像みてボタンどこおしたかみればちゃんと検索おしてることわかる」:
  //   → 受け取った画像は **Storage に置き**、表には置いた場所の名前（shot_key）だけ持つ。
  //     表が軽いまま、竹内さんも私も写真を見て「検索を押せているか」を確かめられる。
  const BUCKET = "human-motion-shots";
  if (typeof body.shot_b64 === "string" && body.shot_b64.length > 100) {
    try {
      const raw64 = body.shot_b64.replace(/^data:image\/[a-z]+;base64,/, "");
      const buf = Buffer.from(raw64, "base64");
      // 大きすぎる写真は置かない（Storage と転送を守る）が、**理由を返す**（黙って捨てない）
      if (buf.length === 0) {
        return NextResponse.json({ ok: false, error: "image_empty" }, { status: 400, headers: CORS });
      }
      if (buf.length > 3_000_000) {
        // 2026-11-11 竹内さん「まだ写真クラウドにおくれていないのか」: 大きくて捨てた時は**理由を返す**
        console.warn("[human-motion] 写真が大きすぎます:", buf.length, "bytes");
        return NextResponse.json({ ok: false, error: "image_too_large", bytes: buf.length }, { status: 413, headers: CORS });
      }
      {
        const key = `${new Date().toISOString().slice(0, 10)}/${row.install_id || "unknown"}-${Date.now()}.jpg`;
        const up = await supabase.storage.from(BUCKET).upload(key, buf, { contentType: "image/jpeg", upsert: true });
        if (!up.error) {
          row.shot_taken = true;
          row.shot_key = key;
        } else {
          console.warn("[human-motion] 写真を置けません:", up.error.message);
          // 2026-11-11: 置けなかった理由を返す（「送ったのに届かない」を無くす）
          return NextResponse.json({ ok: false, error: "storage: " + up.error.message }, { status: 500, headers: CORS });
        }
      }
    } catch (e) {
      console.warn("[human-motion] 写真の処理に失敗:", e instanceof Error ? e.message : String(e));
    }
  }
  delete row.shot_b64;

  const ins = await supabase.from("human_motion_learn").insert(row);
  return NextResponse.json({ ok: !ins.error, error: ins.error?.message }, { status: ins.error ? 500 : 200, headers: CORS });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const days = Math.min(Math.max(Number(sp.get("days") ?? 30) || 30, 1), 365);
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 200) || 200, 1), 2000);

  // 写真の一覧（どこに置いたか・見るための URL）
  if (sp.get("shots") === "1") {
    const r = await supabase.from("human_motion_learn")
      .select("id, created_at, install_id, device_label, site, mode, shot_key, shot_w, shot_h, ops, points_n, point_fields")
      .gte("created_at", from).eq("shot_taken", true)
      .order("created_at", { ascending: false }).limit(limit);
    if (r.error) return NextResponse.json({ ok: false, error: r.error.message }, { status: 500, headers: CORS });
    // 写真を見る URL を付ける（Storage の公開 URL・無ければ署名付き）
    const rows = await Promise.all(((r.data ?? []) as Record<string, unknown>[]).map(async (row) => {
      const key = typeof row.shot_key === "string" ? row.shot_key : "";
      let url: string | null = null;
      if (key) {
        try {
          const pub = supabase.storage.from("human-motion-shots").getPublicUrl(key);
          url = pub?.data?.publicUrl ?? null;
        } catch { url = null; }
        if (!url) {
          try {
            const signed = await supabase.storage.from("human-motion-shots").createSignedUrl(key, 3600);
            url = signed?.data?.signedUrl ?? null;
          } catch { url = null; }
        }
      }
      return { ...row, shot_url: url };
    }));
    return NextResponse.json({ ok: true, days, rows }, { headers: CORS });
  }

  if (sp.get("summary") === "1") {
    // 集計: 期間内の全行から、回数で重み付けした平均と中央値を出す
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 20_000; i += 1000) {
      const r = await supabase.from("human_motion_learn")
        .select("ops, sessions, gap_ms, moves_n, move_speed_px_s, move_curve, move_ms, move_dist, drag_n, points_n, point_x, point_y, scrolls_n, scroll_dy, scroll_y, point_fields, kinds, site, mode")
        .gte("created_at", from).order("created_at", { ascending: false }).range(i, i + 999);
      if (r.error) return NextResponse.json({ ok: false, error: r.error.message }, { status: 500, headers: CORS });
      rows.push(...((r.data ?? []) as Record<string, unknown>[]));
      if (!r.data || r.data.length < 1000) break;
    }
    return NextResponse.json({ ok: true, days, rows: rows.length, summary: summarizeRows(rows) }, { headers: CORS });
  }

  const r = await supabase.from("human_motion_learn")
    .select("*").gte("created_at", from).order("created_at", { ascending: false }).limit(limit);
  return NextResponse.json({ ok: !r.error, days, rows: r.data ?? [], error: r.error?.message }, { status: r.error ? 500 : 200, headers: CORS });
}

/** 回数で重み付けした平均（null は飛ばす） */
function wavg(rows: Record<string, unknown>[], key: string, weightKey: string): number | null {
  let sum = 0, w = 0;
  for (const r of rows) {
    const v = typeof r[key] === "number" ? (r[key] as number) : Number(r[key]);
    const n = Number(r[weightKey]) || 1;
    if (!Number.isFinite(v) || v <= 0) continue;
    sum += v * n; w += n;
  }
  return w > 0 ? Math.round((sum / w) * 100) / 100 : null;
}

/** 集計（画面・スクリプト用）。純関数に近い（DB を触らない） */
function summarizeRows(rows: Record<string, unknown>[]) {
  const bySite: Record<string, number> = {};
  let ops = 0, sessions = 0, moves = 0, points = 0, scrolls = 0, drags = 0;
  for (const r of rows) {
    ops += Number(r.ops) || 0;
    sessions += Number(r.sessions) || 0;
    moves += Number(r.moves_n) || 0;
    points += Number(r.points_n) || 0;
    scrolls += Number(r.scrolls_n) || 0;
    drags += Number(r.drag_n) || 0;
    const s = String(r.site ?? "?");
    bySite[s] = (bySite[s] || 0) + 1;
  }
  return {
    rows: rows.length,
    ops, sessions, moves, points, scrolls, drags,
    by_site: bySite,
    speed_px_s: wavg(rows, "move_speed_px_s", "moves_n"),
    curve: wavg(rows, "move_curve", "moves_n"),
    move_ms: wavg(rows, "move_ms", "moves_n"),
    move_dist: wavg(rows, "move_dist", "moves_n"),
    gap_ms: wavg(rows, "gap_ms", "ops"),
    point_x: wavg(rows, "point_x", "points_n"),
    point_y: wavg(rows, "point_y", "points_n"),
    scroll_dy: wavg(rows, "scroll_dy", "scrolls_n"),
    scroll_y: wavg(rows, "scroll_y", "scrolls_n"),
  };
}
