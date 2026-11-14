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
import { selectDroppingMissing } from "@/app/lib/supabase-safe-select";

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
    /**
     * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
     *   押したら**何が開いたか**（小窓／選択肢／入力欄／結果）を欄ごとに残す。
     *   `opens` … `{ "左の所在地絞り込み＋｜span": { opens: "modal", n: 3 } }`
     *   `open_kinds` … `{ modal: 3, options: 5 }`（全体の内訳・すぐ集計できる形）
     *   ⚠ 入れるのは**開いた物の種類と数**だけ（中身・文字は入れない）。
     */
    opens: (() => {
      const v = m.opens;
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      const okKind = /^(modal|options|form|result|modal_close|none)$/;
      const out: Record<string, { opens: string; n: number; stage: string | null }> = {};
      let cnt = 0;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (cnt++ >= 60) break;
        const name = String(k ?? "").trim().slice(0, 30);
        if (!name) continue;
        const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
        const kind = String(r.opens ?? "").trim();
        if (!okKind.test(kind)) continue;
        out[name] = {
          opens: kind,
          n: Math.max(0, Math.min(9999, Number(r.n) || 0)),
          stage: r.stage ? String(r.stage).slice(0, 10) : null,
        };
      }
      return Object.keys(out).length ? out : null;
    })(),
    open_kinds: (() => {
      const v = m.open_kinds;
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      const okKind = /^(modal|options|form|result|modal_close|none)$/;
      const out: Record<string, number> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (!okKind.test(k)) continue;
        out[k] = Math.max(0, Math.min(99999, Number(x) || 0));
      }
      return Object.keys(out).length ? out : null;
    })(),

    shot_taken: !!body.shot_taken,
    shot_key: typeof body.shot_key === "string" ? body.shot_key.slice(0, 200) : null,
    shot_w: num(body.shot_w, 10000),
    shot_h: num(body.shot_h, 10000),
    /**
     * 2026-11-13 竹内さん「写真から学習する。押す場所や押す順番などもりかいできるから」
     *   「おしかたのボタンの仕様の理解の為にも」:
     *   写真の**直前までの操作の並び**（時刻・種類・どの欄か）を残す。
     *   → 写真と操作が結びつき、「この画面では次にこれを押す」を学べる。
     *   ⚠ 入れるのは欄の名前と操作の種類・時刻だけ（入力した中身は入れない）。
     */
    shot_ops: (() => {
      const ops = (body as Record<string, unknown>).shot_ops;
      if (!Array.isArray(ops)) return null;
      const out = ops.slice(-80).map((o) => {
        const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
        return {
          t: typeof r.t === "number" ? r.t : null,
          k: typeof r.k === "string" ? r.k.slice(0, 10) : null,
          f: typeof r.f === "string" ? r.f.slice(0, 30) : null,
          /**
           * 2026-11-13 竹内さん「どこがダウンドロップでどこが入力する部分か」:
           *   ⚠ 旧はここで `w`（要素の種類）を**捨てていた**ので、拡張が送っても DB に入らなかった
           *     （実際に 0件だった）。→ 通す。
           */
          ...(typeof r.w === "string" && r.w ? { w: r.w.slice(0, 10) } : {}),
          /**
           * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか」:
           *   直前の操作からの**間隔**（人が次を押すまで待つ時間）。0〜60000ms に丸める。
           *   ⚠ 旧は捨てていたので、サーバーは `move_ms`（移動時間）で代用していた（別物）。
           */
          ...(typeof r.g === "number" && r.g >= 0 && r.g <= 60000 ? { g: Math.round(r.g) } : {}),
          /**
           * 2026-11-14 竹内さん「通常モードで行っているのはスタッフ等人間が実際の動きをしているので
           *   そこを理解して学習する」:
           *   **人が押したのか拡張が押したのか**（`isTrusted` から作った印）を残す。
           *   ⚠ これを捨てていたので、学習で「人の手本」と「機械の動き」を区別できなかった
           *     （実測 394件すべて `by` が無かった）。
           */
          ...(r.by === "human" || r.by === "auto" ? { by: r.by } : {}),
          /**
           * 2026-11-14 竹内さん「取り組む」（材料つき記録が 7% しかない）:
           *   操作が取れなかった**理由**（`k:"diag"` の1件）を残す。
           *   ⚠ これは**診断**なので、欄の名前（`f`）は null のまま＝学習には使われない。
           *     中身は「ring_empty:tab123」「no_answer:tab123」のような短い言葉だけ。
           */
          ...(typeof r.why === "string" && r.why ? { why: r.why.slice(0, 60) } : {}),
          /**
           * 2026-11-14 竹内さん「足りていない部分や弱い部分はきょうかするようにする」:
           *   同じ画像が何枚続いたか（`k:"same"`）。統括が「画面が変わっていない」を判断できる。
           */
          ...(typeof (r as Record<string, unknown>).same === "number" ? { same: Math.max(0, Math.min(9999, Number((r as Record<string, unknown>).same))) } : {}),
        };
      }).filter((o) => o.k || o.f);
      return out.length ? out : null;
    })(),
  };

  // 写真の**中身**（base64 の画像）は**表には入れない**（1行が数百KBになり集計が重くなる）。
  //   2026-11-11 竹内さん「画面画像みればわかるのでは。画像みてボタンどこおしたかみればちゃんと検索おしてることわかる」:
  //   → 受け取った画像は **Storage に置き**、表には置いた場所の名前（shot_key）だけ持つ。
  //     表が軽いまま、竹内さんも私も写真を見て「検索を押せているか」を確かめられる。
  //
  // 2026-11-12 竹内さん「データベースに画像入るようにしたらよいのでは。データベースにテーブルをつくって
  //   そこにはいるようにする形にすればできるのではないかな」:
  //   → **Storage に置けなかった時は、表（`human_motion_learn.shot_b64`）に画像そのものを入れる**（受け皿）。
  //     Storage が落ちていても・バケットの権限が変わっても、写真が**消えない**。
  //     ⚠ 表に画像を入れるのは**最後の受け皿だけ**（1行が数百KBになり集計が重くなるため、通常は Storage）。
  const BUCKET = "human-motion-shots";
  let shotBytes: Buffer | null = null;
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
      shotBytes = buf;
      {
        const key = `${new Date().toISOString().slice(0, 10)}/${row.install_id || "unknown"}-${Date.now()}.jpg`;
        const up = await supabase.storage.from(BUCKET).upload(key, buf, { contentType: "image/jpeg", upsert: true });
        if (!up.error) {
          row.shot_taken = true;
          row.shot_key = key;
        } else {
          /**
           * 2026-11-12 竹内さん「データベースに画像入るようにしたらよいのでは」:
           *   Storage に置けなくても**捨てない**。表の `shot_b64` に入れて、写真を残す
           *   （GET ?shots=1 が `data:` の URL として返す＝そのまま見られる）。
           */
          console.warn("[human-motion] 写真を置けません → 表に入れます:", up.error.message);
          row.shot_b64 = "data:image/jpeg;base64," + raw64.slice(0, 2_900_000);
        }
      }
    } catch (e) {
      console.warn("[human-motion] 写真の処理に失敗:", e instanceof Error ? e.message : String(e));
      // 例外でも捨てない（表に入れられるなら入れる）
      try {
        const raw64 = String(body.shot_b64).replace(/^data:image\/[a-z]+;base64,/, "").slice(0, 2_900_000);
        if (raw64.length > 100) { row.shot_b64 = "data:image/jpeg;base64," + raw64; row.shot_taken = true; }
      } catch (_) {}
    }
  }
  delete row.shot_b64_pending;
    void shotBytes;

  /**
   * 2026-11-12: `shot_b64` / `shot_in_db` の列が**まだ無い**環境でも壊れないようにする。
   *   列が無いと insert が 42703（column does not exist）で落ち、**写真も動きの記録も消える**。
   *   → 落ちたら列を外してもう一度入れる（画像は Storage の shot_key で残っている）。
   */
  let ins = await supabase.from("human_motion_learn").insert(row);
  /** 無い列を外した記録（点検用に返す・静かに握りつぶさない） */
  const droppedCols: string[] = [];
  const _isMissing = (e: { code?: string | null; message?: string | null } | null | undefined) =>
    !!e && (e.code === "42703" || e.code === "PGRST204" || /column .* does not exist|Could not find the .* column/i.test(String(e.message ?? "")));
  if (_isMissing(ins.error)) {
    console.warn("[human-motion] shot_b64 列がありません → 列を外して入れ直します（写真は Storage に残っています）:", ins.error?.message);
    const r2 = { ...row } as Record<string, unknown>;
    delete r2.shot_b64;
    delete r2.shot_in_db;
    ins = await supabase.from("human_motion_learn").insert(r2);
    /**
     * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
     *   `opens` / `open_kinds` は**新しい列**。migrate がまだ当たっていない環境では
     *   42703 で insert が落ち、**動きの記録ごと消える**（今まで何度も踏んだ「静かに壊れる」）。
     *   → 無い列を**1つずつ外して入れ直す**（最大6回・外した列は点検用に返す）。
     *     ⚠ 記録そのものは捨てない（開き方が入らないだけ）。
     */
    for (let _i = 0; _i < 6 && _isMissing(ins.error); _i++) {
      const m = /column "?([a-z_]+)"? of|'([a-z_]+)' column|column "?([a-z_]+)"? does not exist|Could not find the '([a-z_]+)' column/i.exec(String(ins.error?.message ?? ""));
      const col = m ? (m[1] || m[2] || m[3] || m[4]) : null;
      if (!col || !(col in (r2 as Record<string, unknown>))) break;
      console.warn("[human-motion] 列がありません → 外して入れ直します:", col);
      droppedCols.push(col);
      delete (r2 as Record<string, unknown>)[col];
      ins = await supabase.from("human_motion_learn").insert(r2);
    }
  }
  /**
   * 2026-11-12 竹内さん「くれさん通常モードで検索したけどちゃんと画面録画はできるようになっているかな」:
   *   写真は Storage に上がったのに**表に1行も入っていなかった**（今日 0件）。
   *   手元で試すと `new row violates row-level security policy for table "human_motion_learn"`（42501）で拒否されていた。
   *   → 写真が上がったのに表へ入れられない時は、**写真を消さずに理由を返す**（黙って成功にしない）。
   *     呼ぶ側（拡張）は `axlx_human_shot_upload` に理由を残し、小窓の帯に出る。
   */
  if (ins.error) {
    console.warn("[human-motion] 表に入れられません:", ins.error.message, "／ 写真:", row.shot_key || "(なし)");
  }
  return NextResponse.json(
    {
      ok: !ins.error, error: ins.error?.message, code: ins.error?.code ?? null,
      /** 2026-11-14: DB に無くて外した列（あれば migrate を当てる合図） */
      dropped_cols: droppedCols.length ? droppedCols : null,
      shot_key: row.shot_taken ? (row.shot_key ?? "(表)") : null,
      /** 表に入れたかは `shot_b64` の中身から判断（列が無いDBでも正しく返す） */
      shot_in_db: typeof row.shot_b64 === "string" && row.shot_b64.length > 100,
    },
    { status: ins.error ? 500 : 200, headers: CORS },
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const days = Math.min(Math.max(Number(sp.get("days") ?? 30) || 30, 1), 365);
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 200) || 200, 1), 2000);

  // 写真の一覧（どこに置いたか・見るための URL）
  if (sp.get("shots") === "1") {
    /**
     * 2026-11-13 竹内さん「データベースとの連携をちゃんとできているようにする」:
     *   ⚠ `shot_in_db` は**列が無いDBがある**（足しても何度も「無い」と言われた）。
     *     列に頼ると、**写真があるのに一覧が 500 で落ちる**（実際に起きた）。
     *   → **その列は読まない**。表に入っているかは `shot_b64` の中身から**その場で判断**する
     *     （`shot_in_db` は便利な印でしかなく、無くても同じ事が分かる）。
     *   `shot_ops` も列が無いDBがあり得るので、同じく外して読み直せるようにする。
     */
    /**
     * 2026-11-13 竹内さん「なんで連携できていないのか」:
     *   ⚠ 旧は「`shot_ops` が無い時は shot_ops を外して読み直す」だけだった。
     *     実際に無かったのは **`shot_b64`**（＋ `shot_learn`）で、`select` は1列でも無いと全部落ちる。
     *     → 受け皿の「最小の列」まで落ちて、**`shot_ops` が返らず「押す順番 0通り」**になっていた。
     *   → **無い列だけ**を外して読み直す（`selectDroppingMissing`）。外した列は `dropped_cols` で返す。
     */
    const BASE = ["id", "created_at", "install_id", "device_label", "site", "mode", "ext_version", "shot_key", "shot_w", "shot_h", "ops", "points_n", "point_fields", "shot_ops", "shot_b64"];
    const fetchShots = (cols: string) => supabase.from("human_motion_learn")
      .select(cols)
      .gte("created_at", from).eq("shot_taken", true)
      .order("created_at", { ascending: false }).limit(limit);
    const sel = await selectDroppingMissing(BASE, fetchShots, {
      onDrop: (c, e) => console.warn("[human-motion] 列が無いので外します:", c, e?.message ?? ""),
    });
    if (sel.error) return NextResponse.json({ ok: false, error: sel.error.message, dropped_cols: sel.dropped }, { status: 500, headers: CORS });
    const r = { data: sel.data, error: null as typeof sel.error };
    // 写真を見る URL を付ける（Storage の公開 URL・無ければ署名付き・無ければ表の画像）
    const rows = await Promise.all(((r.data ?? []) as unknown as Record<string, unknown>[]).map(async (row) => {
      const key = typeof row.shot_key === "string" ? row.shot_key : "";
      const inDb = typeof row.shot_b64 === "string" && row.shot_b64.length > 100;
      let url: string | null = inDb ? (row.shot_b64 as string) : null;   // 表に入っていればそれをそのまま使う
      if (!url && key) {
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
      // 一覧では画像の中身を返さない（重い）。URL で見る
      const out = { ...row } as Record<string, unknown>;
      delete out.shot_b64;
      return { ...out, shot_in_db: inDb, shot_url: url };
    }));
    return NextResponse.json({ ok: true, days, rows, dropped_cols: sel.dropped, cols: sel.cols }, { headers: CORS });
  }

  /**
   * 2026-11-14 竹内さん「今新しく通常で一連の流れをおこなった。データベースからできていない部分学習するようにする」:
   *   ⚠ `?shots=1` は **写真が撮れた行だけ**返す（`shot_taken=true`）。
   *     写真が撮れていない回は**一覧に出てこない**ので、「記録が0件」に見えてしまっていた。
   *   → `?recent=1` は**写真の有無に関係なく**新しい順に返す（点検用・読み取りだけ）。
   */
  if (sp.get("recent") === "1") {
    const BASE = [
      "id", "created_at", "install_id", "site", "mode", "ext_version",
      "ops", "points_n", "point_fields", "field_order", "shot_taken", "shot_key",
      "shot_ops", "shot_learn", "opens", "open_kinds", "gap_ms", "moves_n",
    ];
    const fetchRecent = (cols: string) => supabase.from("human_motion_learn")
      .select(cols).gte("created_at", from)
      .order("created_at", { ascending: false }).limit(limit);
    const sel = await selectDroppingMissing(BASE, fetchRecent, {
      onDrop: (c, e) => console.warn("[human-motion] 列が無いので外します:", c, e?.message ?? ""),
    });
    if (sel.error) return NextResponse.json({ ok: false, error: sel.error.message, dropped_cols: sel.dropped }, { status: 500, headers: CORS });
    return NextResponse.json({ ok: true, days, rows: sel.data ?? [], dropped_cols: sel.dropped, cols: sel.cols }, { headers: CORS });
  }

  if (sp.get("summary") === "1") {    // 集計: 期間内の全行から、回数で重み付けした平均と中央値を出す
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
