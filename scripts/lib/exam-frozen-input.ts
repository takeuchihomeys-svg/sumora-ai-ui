// scripts/lib/exam-frozen-input.ts — 試験の入力を決まった形にする（時計を問題ごとに固定・本番 DB の育つ材料を夜の写しに固定）
//
// 2026-11-05 作業員8（統括役の了承の 1・竹内さんの決まり「試験の質と費用の改善は聞かずに直す」の範囲・弱い所 314）:
//   録音の brain_full 1,431組で入力が同じは 24組。違いの出所は台帳（直した: fe0f621d）・時計 739・本番 DB の材料 694 だった。
//   ① 時計: 走らせた日の「今日」（曜日）が入る＝水曜と木曜で入力が変わる。→ 仮の今＝元の番の時刻を7日の倍数だけ進めた、今に一番近い過去の時刻。
//      曜日と時刻（夜の番は夜）は元の番と同じ・1週間は同じ値＝入力が毎日変わらない（日付は録音の鍵で伏せている）。
//   ② 本番 DB の育つ材料（返信例・ナレッジ・決まり・統計・RAG）: 学習の cron（JST 3:23）で毎日変わる。→ 試験の中だけ、その日（JST 4:00 区切り）に
//      最初に読んだ答えを置き場に控え、同じ日の同じ問い合わせはそれを返す（夜の基準と昼の依頼が同じ材料を見る）。会話ごとの行（テスト用の会話・条件の行の id を含む問い合わせ）は控えない。
//   止める: EXAM_FROZEN_CLOCK=off・EXAM_DB_SNAPSHOT=off
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskPII } from "../../app/lib/pii-mask";

const DAY = 86_400_000, WEEK = 7 * DAY;

// ─── ① 時計 ───────────────────────────────────────────────────────────
/**
 * 仮の今（純関数）: 元の番の時刻 atMs を 7日の倍数だけ進めて、realNowMs 以下で一番近い時刻。
 *   返す shiftDays は場面の文の日付のずらし（7の倍数＝曜日の言い方はそのまま）。atMs が未来なら 0。
 */
export function frozenSceneNow(atMs: number, realNowMs: number): { nowMs: number; shiftDays: number } {
  if (!Number.isFinite(atMs) || !Number.isFinite(realNowMs) || atMs >= realNowMs) return { nowMs: atMs, shiftDays: 0 };
  const k = Math.floor((realNowMs - atMs) / WEEK);
  return { nowMs: atMs + k * WEEK, shiftDays: k * 7 };
}

export const frozenClockOn = (env: Record<string, string | undefined> = process.env) => String(env.EXAM_FROZEN_CLOCK ?? "").trim().toLowerCase() !== "off";
export const dbSnapshotOn = (env: Record<string, string | undefined> = process.env) => String(env.EXAM_DB_SNAPSHOT ?? "").trim().toLowerCase() !== "off";

// ─── ② 本番 DB の育つ材料の夜の写し ─────────────────────────────────────────
/** 学習で育つ材料の表（会話ごとの表は入れない）。brain-core・reply-context が読む物（11/05 の grep） */
export const SNAPSHOT_TABLES: ReadonlySet<string> = new Set([
  "ai_reply_examples", "ai_reply_knowledge", "ai_prompt_rules", "trigger_action_rules", "aix_transition_stats", "winning_pattern_logs",
  "next_action_logs", "brain_manuals", "brain_weaknesses", "brain_unknowns", "brain_aix_feedback", "aix_action_attribution", "line_watch_turns",
  "system_design_thinking", "winning_patterns",
]);
export const SNAPSHOT_RPCS: ReadonlySet<string> = new Set(["match_winning_patterns", "match_templates", "match_reply_knowledge", "match_design_knowledge"]);

// ─── ③ 鍵が要る読み（近い竹内さんの番）── 2026-11-07 統括役の決め B（作業員9・作業員4）────────────────
//   試験は公開キーで動くので、近い竹内さんの番の読み（RLS・サーバーの鍵だけ）は 42501／空になる。DDL も anon への許可も足さない。
//   試験の中ではこの読みを「頼み」として置き場の pending に残すだけ（公開キーの答えは控えない）。夜に鍵のある env の小さな台本
//   （scripts/exam-near-resolve.ts --env-file=<鍵のある env>）が頼みを鍵で読み、決めた欄だけに絞って同じ鍵の控えに書く＝次の試験は控えを返す。
//   残す欄は近い番の id・場面・重点・距離・時刻・竹内さんの一手（AIX の種類と道）・keep の真偽だけ。本文・要約（situation・text）は残さない
export const KEYED_RPCS: ReadonlySet<string> = new Set(["match_conductor_focus", "match_conductor_turns"]);
export const KEYED_TABLES: ReadonlySet<string> = new Set(["takeuchi_compose_examples", "conductor_turn_vectors"]);
/** 鍵の要る読みか（純関数） */
export function keyedTarget(url: string, method: string): string | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const m = u.pathname.match(/\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
  if (!m) return null;
  const meth = (method || "GET").toUpperCase();
  if (m[1]) return meth === "POST" && KEYED_RPCS.has(m[2]) ? m[2] : null;
  return meth === "GET" && KEYED_TABLES.has(m[2]) ? m[2] : null;
}
export type ProblemTurn = { conv: string; at: string };
/**
 * 近い番の読みから答えの番を外す（純関数・2026-11-10 作業員4 の見つけ）。
 *   試験の時計は元の番の時刻を7日の倍数だけ進める（frozenSceneNow）＝本番の p_before（今の番の時刻）が未来になり、p_exclude_conv は借りた YUMA の会話。
 *   そのままだと match_conductor_focus／turns が、問題の元の会話の竹内さんの答えの番そのもの（距離 0.00〜0.02）を近い番に返していた
 *   （11/06・11/07 の控えの近い番の読み 317本のうち、一番近い番が距離 0.01 未満が 30本以上・q371 の元の番 11/03 10:35 が 0.001）
 *   ＝入口の意見・重点の近い番を使う試験が、答えを見ていた。
 *   本番と同じにする: p_exclude_conv を元の会話に、p_before を元の番の時刻（今の値がそれより後なら）に置き換える。他の読み・形の分からない body はそのまま
 */
export function leakSafeKeyedBody(name: string, body: string, turn: ProblemTurn | null): string {
  if (!turn?.conv || !turn.at || !(name === "match_conductor_focus" || name === "match_conductor_turns")) return body;
  let b: Record<string, unknown>;
  try { b = JSON.parse(body) as Record<string, unknown>; } catch { return body; }
  if (!b || typeof b !== "object" || Array.isArray(b)) return body;
  const out: Record<string, unknown> = { ...b, p_exclude_conv: turn.conv };
  if ("p_before" in b) {
    const cur = Date.parse(String(b.p_before ?? "")), orig = Date.parse(turn.at);
    if (Number.isFinite(orig) && (!Number.isFinite(cur) || cur > orig)) out.p_before = turn.at;
  }
  return JSON.stringify(out);
}
/** 鍵の要る読みの鍵（純関数）: 借りたテスト用の会話・条件の行の id は伏せる（レーンが違っても同じ問い合わせは同じ鍵） */
export function keyedKey(url: string, method: string, body: string, excludeIds: readonly string[], hint?: string | null): string {
  const hide = (s: string) => excludeIds.filter(Boolean).reduce((t, id) => t.split(id).join("<x>"), s);
  // 2026-11-07 作業員4の見つけ（nop2-on で控えに当たらず全部 null）: 近い番の RPC の query_embedding は状況の文から作る＝文に「今」からの経過が入り、
  //   回ごと・時刻ごとに埋め込みが変わる。p_before も本当の今。試験の問題（hint＝今の問題 id）があれば、埋め込みと p_before を鍵から外し問題で鍵にする
  //   （同じ問題の同じ番は同じ控え・回が違っても同じ）。問題が分からない時は今まで通り body 丸ごと
  if (hint) {
    try {
      const b = JSON.parse(body) as Record<string, unknown>;
      if (b && typeof b === "object" && "query_embedding" in b) {
        const { query_embedding: _e, p_before: _p, ...rest } = b; void _e; void _p;
        return snapshotKey(hide(url), method, JSON.stringify({ problem: hint, ...rest }));
      }
    } catch { /* 読めない body は丸ごと */ }
  }
  return snapshotKey(hide(url), method, hide(body));
}
/** 控えに残す欄だけにする（純関数）。分からない形は空の配列（本文を残さない側に倒す） */
/**
 * situations: 2026-11-07 統括役の決め（作業員4・KB e786394e）: 一番近い番だけ、要約（situation の「お客様:」の部分・伏せた60字）を残してよい。
 *   入れるかは夜の台本が決める（PII の伏せ・申込の書類以降の番は入れない）。ここでは渡された番の要約だけを残す
 */
export function reduceKeyedBody(name: string, text: string, situations: Readonly<Record<string, string>> = {}): string {
  let rows: unknown; try { rows = JSON.parse(text); } catch { return "[]"; }
  if (!Array.isArray(rows)) return "[]";
  const pick = (r: Record<string, unknown>): Record<string, unknown> => {
    const a = (r.actual ?? null) as Record<string, unknown> | null;
    // picker はボタンの細目の名前（available・mgmt_equipment 等の決まった名前）＝本文ではない
    const act = a ? { aix: a.aix ?? null, route: a.route ?? null, shape: a.shape ?? null, picker: typeof a.picker === "string" && /^[a-z_]{1,40}$/.test(a.picker) ? a.picker : null } : null;
    if (name === "match_conductor_focus" || name === "match_conductor_turns") return { source_key: r.source_key ?? null, scene: r.scene ?? null, focus: r.focus ?? null, distance: r.distance ?? null, turn_at: r.turn_at ?? null, actual: act };
    if (name === "takeuchi_compose_examples") return { message_id: r.message_id ?? null, keep: r.keep === true ? true : r.keep === false ? false : null };
    if (name === "conductor_turn_vectors") { const k = String(r.source_key ?? ""); return { source_key: r.source_key ?? null, turn_at: r.turn_at ?? null, ...(act ? { actual: act } : {}), situation: k && situations[k] ? situations[k] : null }; }
    return {};
  };
  return JSON.stringify(rows.map((r) => pick((r ?? {}) as Record<string, unknown>)));
}

/**
 * 一番近い番の要約（2026-11-07 統括役の決め・作業員4）: ① situation の「お客様:」の行を60字まで ② PII の伏せ（maskPII）を通す
 *   ③ 申込の書類以降の番は入れない（afterCutoff・loadDeepseekCutoff と同じ線・線が読めない時も入れない）
 */
export function nearestSummaryOf(situation: string | null | undefined): string | null {
  const s = String(situation ?? "");
  const i = s.indexOf("お客様:");
  if (i < 0) return null;
  const body = s.slice(i + 4).split("\n")[0].trim();
  const out = maskPII(body).slice(0, 60).trim();
  return out || null;
}
/** その番が申込の書類以降か（null＝線が読めない→以降とみる・NO_CUTOFF（数）＝申込の記録なし→以前） */
export function afterCutoff(turnAt: string, cutoff: string | number | null): boolean {
  if (cutoff === null) return true;
  if (typeof cutoff === "number") return false;
  return Date.parse(turnAt) >= Date.parse(cutoff);
}

/** 写しの日（JST 4:00 で区切る＝学習の cron 3:23 の後）。"YYYY-MM-DD" */
export function snapshotDay(realNowMs: number): string {
  return new Date(realNowMs + 9 * 3_600_000 - 4 * 3_600_000).toISOString().slice(0, 10);
}

/** 控えてよい問い合わせか（純関数）: GET の表か POST の rpc で、会話ごとの id（excludeIds）を含まない */
export function snapshotTarget(url: string, method: string, body: string, excludeIds: readonly string[]): string | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const m = u.pathname.match(/\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
  if (!m) return null;
  const isRpc = !!m[1], name = m[2];
  const meth = (method || "GET").toUpperCase();
  if (isRpc ? meth !== "POST" || !SNAPSHOT_RPCS.has(name) : meth !== "GET" || !SNAPSHOT_TABLES.has(name)) return null;
  const hay = decodeURIComponent(url) + "\n" + (body ?? "");
  if (excludeIds.some((id) => id && hay.includes(id))) return null;
  return name;
}

/** 鍵（純関数）: 時刻（ISO）は日付まで・数字だけのミリ秒の時刻も伏せる＝同じ日の同じ問い合わせは同じ鍵 */
export function snapshotKey(url: string, method: string, body: string): string {
  const norm = (s: string) => s
    .replace(/(\d{4}-\d{2}-\d{2})[T ]\d{2}(?::|%3A)\d{2}(?:(?::|%3A)\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::|%3A)?\d{2}|%2B\d{2}(?::|%3A)\d{2})?/gi, "$1")
    .replace(/\b1[6-9]\d{11}\b/g, "<ms>");
  return createHash("sha256").update(`${(method || "GET").toUpperCase()}\n${norm(url)}\n${norm(body ?? "")}`).digest("hex").slice(0, 40);
}

type Snap = { status: number; contentType: string | null; contentRange: string | null; body: string; at: string; table: string };
export type SnapshotStats = { hit: number; miss: number; skip: number };

/**
 * globalThis.fetch を包む（brain-exam の setupLlmTest の後に1回）。控えるのは成功（2xx）の答えだけ。
 *   dir＝<置き場>/db-snapshot・excludeIds＝今の会話・条件の行の id（呼ぶたびに読む）
 */
export function installDbSnapshot(opts: { dir: string; excludeIds: () => string[]; nowMs?: () => number; /** 今の問題 id（鍵の要る近い番の読みの鍵・11/07） */ keyHint?: () => string | null; /** 今の問題の元の番（会話・時刻）＝近い番の読みから答えの番を外す（11/10・leakSafeKeyedBody） */ problemTurn?: () => ProblemTurn | null }): SnapshotStats {
  const stats: SnapshotStats = { hit: 0, miss: 0, skip: 0 };
  const inner = globalThis.fetch;
  const now = opts.nowMs ?? (() => Date.now());
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? (input as Request).method : "GET")) || "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    // ③ 鍵が要る読み: 控え（夜の台本が鍵で読んで絞った物）があれば返す。無ければ頼みを pending に残し、公開キーの答え（42501／空）はそのまま返して控えない
    const keyed = keyedTarget(url, method);
    if (keyed) {
      // 2026-11-10 作業員4: 鍵と頼みは答えの番を外した形で（夜の台本はこの形のまま鍵で読む）。前の控え（外す前の鍵）には当たらない＝漏れた控えは使われない
      const kbody = leakSafeKeyedBody(keyed, body, opts.problemTurn?.() ?? null);
      const kday = (process.env.EXAM_DB_SNAPSHOT_DAY ?? "").trim() || snapshotDay(now());
      const kkey = keyedKey(url, method, kbody, opts.excludeIds(), opts.keyHint?.() ?? null);
      const kfile = join(opts.dir, kday, `k-${kkey}.json`);
      if (existsSync(kfile)) {
        try { const s = JSON.parse(readFileSync(kfile, "utf8")) as Snap; stats.hit++; const h = new Headers(); h.set("content-type", s.contentType ?? "application/json"); return new Response(s.body, { status: 200, headers: h }); } catch { /* 読み直す */ }
      }
      try {
        const pdir = join(opts.dir, kday, "pending"); mkdirSync(pdir, { recursive: true });
        const pf = join(pdir, `k-${kkey}.json`);
        if (!existsSync(pf)) writeFileSync(pf, JSON.stringify({ name: keyed, url, method, body: kbody, at: new Date().toISOString() }));
      } catch { /* 頼みを残せなくても試験は続ける */ }
      stats.skip++;
      return inner(input, init);
    }
    const table = snapshotTarget(url, method, body, opts.excludeIds());
    if (!table) return inner(input, init);
    // 2026-11-06 作業員8（弱い所 354・作業員1の気付き）: 夜の基準（22時台＝その日）と翌朝の依頼（4:00 以降＝次の日）で写しの日が分かれていた。
    //   EXAM_DB_SNAPSHOT_DAY があればその日の写しを読む（夜の基準で比べる依頼と前を作る子に、夜の基準の写しの日を渡す）
    const day = (process.env.EXAM_DB_SNAPSHOT_DAY ?? "").trim() || snapshotDay(now());
    const file = join(opts.dir, day, `${snapshotKey(url, method, body)}.json`);
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, "utf8")) as Snap;
        stats.hit++;
        const h = new Headers(); if (s.contentType) h.set("content-type", s.contentType); if (s.contentRange) h.set("content-range", s.contentRange);
        return new Response(s.body, { status: s.status, headers: h });
      } catch { /* 壊れた控えは読み直す */ }
    }
    const res = await inner(input, init);
    if (!res.ok) { stats.skip++; return res; }
    const text = await res.text();
    stats.miss++;
    try {
      mkdirSync(join(opts.dir, day), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, JSON.stringify({ status: res.status, contentType: res.headers.get("content-type"), contentRange: res.headers.get("content-range"), body: text, at: new Date().toISOString(), table } satisfies Snap));
      renameSync(tmp, file);
    } catch { /* 控えられなくても答えは返す */ }
    const h = new Headers(res.headers); h.delete("content-length"); h.delete("content-encoding");
    return new Response(text, { status: res.status, statusText: res.statusText, headers: h });
  };
  globalThis.fetch = wrapped;
  return stats;
}
