// app/lib/db-json-sanitize.ts — DB の jsonb 列に書く値から、JSON として壊れる文字だけを取り除く（純関数・意味は変えない）
//
// 2026-11-13 作業員8b（朝の拾い上げ・本番エラー最優先）: 会話 c40e1625 の判断が 11/11 20:46 JST から保存されず
//   「[brain-core] suggested_aix_meta update failed: … Empty or invalid json」が 11/12 だけで 138回（bg-async・brain-sweep が回り直し続けた）。
//   直前 20:45:52 のお客様の発言は 22字の最後が絵文字（UTF-16 では 23）。判断の欄のどこかで .slice(0, N) が絵文字の途中で切れると、
//   JSON.stringify は片割れを "\ud83d" と書き、PostgREST はその本文を「Empty or invalid json」で断る（LLM の出口は llm-request-sanitize が直しているが DB の書き込みは素通しだった）。
//   直す物: 対の無いサロゲート（取り除く）・\u0000（jsonb は受けない・取り除く）・NaN/Infinity（JSON に無い・null に）。正しい絵文字・他の文字はそのまま。
//   どの欄を直したかを paths で返す（呼ぶ側がログに出す＝次に出所の欄を特定できる）

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NUL_RE = /\u0000/g;
const LONE_TEST = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type DbJsonFix = { surrogates: number; nul: number; nonFinite: number; paths: string[] };

/** 値を歩いて壊れる文字だけ直す。直す物が無ければ同じ参照を返す（fixed=false） */
export function sanitizeJsonForDb<T>(value: T): { value: T; fixed: boolean; fix: DbJsonFix } {
  const fix: DbJsonFix = { surrogates: 0, nul: 0, nonFinite: 0, paths: [] };
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === "string") {
      let s = v, hit = false;
      if (LONE_TEST.test(s)) { s = s.replace(LONE_SURROGATE_RE, () => { fix.surrogates++; return ""; }); hit = true; }
      if (s.includes("\u0000")) { s = s.replace(NUL_RE, () => { fix.nul++; return ""; }); hit = true; }
      if (hit && fix.paths.length < 20) fix.paths.push(path || "(根)");
      return hit ? s : v;
    }
    if (typeof v === "number" && !Number.isFinite(v)) { fix.nonFinite++; if (fix.paths.length < 20) fix.paths.push(path || "(根)"); return null; }
    if (Array.isArray(v)) { let changed = false; const out = v.map((x, i) => { const y = walk(x, `${path}[${i}]`); if (y !== x) changed = true; return y; }); return changed ? out : v; }
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      let changed = false; const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const kk = LONE_TEST.test(k) ? k.replace(LONE_SURROGATE_RE, "") : k;
        const y = walk(x, path ? `${path}.${kk}` : kk);
        if (y !== x || kk !== k) changed = true;
        out[kk] = y;
      }
      return changed ? out : v;
    }
    return v;
  };
  const out = walk(value, "") as T;
  const fixed = fix.surrogates + fix.nul + fix.nonFinite > 0;
  return { value: fixed ? out : value, fixed, fix };
}
