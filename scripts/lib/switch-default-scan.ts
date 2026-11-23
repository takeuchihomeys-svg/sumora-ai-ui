// scripts/lib/switch-default-scan.ts — スイッチのコードの既定を、ソースの読み方から決まった形で読む（純関数・LLM なし・DB なし）
//
// 2026-11-15 作業員L（連携の地図・KB P0 3041baaa）。地図の行のスイッチが「コードの既定で on か」を人が手で書くと、コードが変わった時にずれる。
//   ソースの `env.NAME ?? "x"` と、その後の比べ方（=== "on" ／ !== "off" ／ === "off" ? "off" : "shadow"）から既定を読む。
//   読めない形は "?"（地図では「既定が読めない」と出す・推測で埋めない）。同じ名前が別の形で読まれていたら多い方＋split=true。
// 使う所: scripts/linkage-switch-defaults.ts（app/lib/linkage-switch-defaults.ts を作り直す）。

export type SwitchDefault = { name: string; def: string; split: boolean; files: number };

/** 1つの読み方の断片（env.NAME から 260字）→ 既定の値 */
export function defaultOfSnippet(snip: string, name: string): string {
  const after = snip.slice(snip.indexOf(name) + name.length);
  const dflt = after.match(/^\s*\)?\s*\?\?\s*["'`]([^"'`]*)["'`]/);
  const given = dflt ? dflt[1].trim().toLowerCase() : null;
  if (given) return given;
  // ?? "" か ?? 無し: 比べ方で決める（最初に出た比べ方を見る）
  // 2026-11-23 作業員L: 比べ方は同じ行のを先に見る（次の行の別のスイッチの !== "off" を拾い、SITUATION_TIMELINE_WIDE の既定 off を on と読んでいた）
  const s0 = after.slice(0, 220), line0 = s0.split(/\r?\n/)[0];
  const s = /===|!==|\.includes\(/.test(line0) ? line0 : s0;
  const m1 = s.match(/===\s*["']off["']\s*\?\s*["']off["']\s*:\s*["']([a-z0-9_]+)["']/);
  if (m1) return m1[1];
  const m2 = s.match(/===\s*["']([a-z0-9_]+)["']\s*\?\s*["']([a-z0-9_]+)["']\s*:\s*["']([a-z0-9_]+)["']/);
  if (m2) return m2[3];
  if (/!==\s*["'](?:off|0|false)["']/.test(s)) return "on";
  if (/===\s*["'](?:on|shadow|1|true|log|record)["']/.test(s)) return "off";
  if (/\.includes\(\s*["'](?:on|shadow)/.test(s) || /\[\s*["'](?:on|shadow)["']/.test(s)) return "off";
  // const v = (env.X ?? "")…; の後ろの return v === … を見る
  const v = s.match(/;\s*(?:return\s+)?v\s*===\s*["']off["']\s*\?\s*["']off["']\s*:\s*["']([a-z0-9_]+)["']/);
  if (v) return v[1];
  if (/;\s*(?:return\s+)?v\s*!==\s*["']off["']/.test(s)) return "on";
  if (/;\s*(?:return\s+)?(?:v\s*===\s*["'](?:on|shadow)["'])/.test(s)) return "off";
  if (/return\s+v\s*===\s*["']shadow["']\s*\|\|\s*v\s*===\s*["']on["']\s*\?\s*["']shadow["']\s*:\s*["']off["']/.test(s)) return "off";
  return "?";
}

/** ファイルの中身の並び → 名前ごとの既定 */
export function scanSwitchDefaults(names: ReadonlyArray<string>, sources: ReadonlyArray<{ path: string; text: string }>): SwitchDefault[] {
  return names.map((name) => {
    // env.NAME・process.env.NAME・envOf(env).NAME・(env ?? process.env).NAME（前の 30字に env がある .NAME）
    const re = new RegExp(`\\.${name}\\b|\\[["']${name}["']\\]`, "g");
    const votes = new Map<string, number>();
    let files = 0;
    for (const src of sources) {
      if (/__tests__|\.test\.ts$/.test(src.path)) continue;
      let hit = false;
      for (const m of src.text.matchAll(re)) {
        const before = src.text.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0);
        if (!/env/i.test(before)) continue;
        const snip = src.text.slice(m.index ?? 0, (m.index ?? 0) + 260);
        if (/^\.\w+\s*=[^=]/.test(snip) || /\bdelete\s+[\w.]*$/.test(before)) continue; // 書き込み・消す所は読み方ではない
        hit = true;
        // !off(envOf(env).NAME) ＝ off と書かない限り on ／ on(envOf(env).NAME) ＝ on と書いた時だけ
        const d = /!\s*off\(\s*[\w.()]*$/.test(before) ? "on" : /(?:^|[^\w])on\(\s*[\w.()]*$/.test(before) ? "off" : defaultOfSnippet(snip, name);
        votes.set(d, (votes.get(d) ?? 0) + 1);
      }
      if (hit) files++;
    }
    if (!votes.size) return { name, def: "なし", split: false, files: 0 };
    const known = [...votes.entries()].filter(([k]) => k !== "?").sort((a, b) => b[1] - a[1]);
    const def = known.length ? known[0][0] : "?";
    return { name, def, split: known.length > 1, files };
  });
}
