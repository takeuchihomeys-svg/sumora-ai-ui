/**
 * 「DB に無い列があると、**その列だけ**外して読み直す」ための小さな道具。
 *
 * なぜ要るか（2026-11-13 竹内さん「なんで連携できていないのか」）:
 *   ⚠ これまでは `shot_ops` が無い時だけを想定して「`shot_ops` を外して読み直す」と書いていた。
 *     ところが実際に無かったのは **`shot_b64` と `shot_learn`** だった。
 *     `select` は**1列でも無いと全部落ちる**ので、
 *       - 学習（`/api/human-learn-profile`）… `shot_learn` が無い → `shot_ops` まで外して読み直し → **押す順番 0通り**
 *       - 写真の一覧（`/api/human-motion?shots=1`）… `shot_b64` が無い → 最後の受け皿まで落ちて **`shot_ops` が返らない**
 *     という「静かに壊れる」形になっていた（データには入っているのに読めない）。
 *
 * 直し方:
 *   - エラーの文から**無い列の名前**を拾い、**その列だけ**を外して同じ問い合わせをやり直す。
 *   - 拾えなければ、候補の列を1つずつ試して当たった物だけ残す（最後の受け皿）。
 *   - 何を外したかは `onDrop` で呼ぶ側に返す（黙って落とさない）。
 */

type SelErr = { message?: string | null; code?: string | null } | null;

export type SelectRunner<T> = (
  colsCsv: string,
) => PromiseLike<{ data: T[] | null; error: SelErr }>;

/** エラーの文から「無い列の名前」を拾う（拾えなければ null） */
export function missingColumnOf(message: string | null | undefined, candidates: readonly string[]): string | null {
  const msg = String(message ?? "");
  if (!msg) return null;
  const has = (name: string) => candidates.includes(name);

  // ① column human_motion_learn.shot_b64 does not exist
  // ② column "shot_b64" does not exist
  const m1 = /column\s+(?:"?[\w]+"?\.)?"?([A-Za-z_][\w]*)"?\s+does not exist/i.exec(msg);
  if (m1 && has(m1[1])) return m1[1];

  // ③ Could not find the 'shot_b64' column of 'human_motion_learn' in the schema cache
  const m2 = /could not find the\s+'([A-Za-z_][\w]*)'\s+column/i.exec(msg);
  if (m2 && has(m2[1])) return m2[1];

  // ④ column "shot_b64" of relation "human_motion_learn" does not exist
  const m3 = /column\s+"?([A-Za-z_][\w]*)"?\s+of relation/i.exec(msg);
  if (m3 && has(m3[1])) return m3[1];

  // ⑤ 文に候補の名前がそのまま出ている（形が変わっても拾えるように）
  const hit = candidates.filter((c) => msg.includes(c));
  return hit.length === 1 ? hit[0] : null;
}

/** 列が無い（または schema cache が古い）ことによるエラーか */
export function isMissingColumnError(err: SelErr): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code === "42703" || code === "PGRST204") return true;
  const msg = String(err.message ?? "");
  return /does not exist|schema cache|could not find the/i.test(msg);
}

/**
 * `cols` で読む。無い列があれば**その列だけ**外してやり直す。
 * 返す `cols` は最終的に読めた列（何を外したか分かるように）。
 */
export async function selectDroppingMissing<T>(
  cols: readonly string[],
  run: SelectRunner<T>,
  opt: { maxTries?: number; onDrop?: (col: string, err: SelErr) => void } = {},
): Promise<{ data: T[] | null; error: SelErr; cols: string[]; dropped: string[] }> {
  const maxTries = Math.max(1, opt.maxTries ?? cols.length + 2);
  let list = [...cols];
  const dropped: string[] = [];
  let last: SelErr = null;

  for (let i = 0; i < maxTries; i++) {
    if (!list.length) break;
    const r = await run(list.join(", "));
    if (!r.error) return { data: r.data, error: null, cols: list, dropped };
    last = r.error;
    if (!isMissingColumnError(r.error)) return { data: null, error: r.error, cols: list, dropped };

    const bad = missingColumnOf(r.error.message, list);
    if (bad) {
      list = list.filter((c) => c !== bad);
      dropped.push(bad);
      try { opt.onDrop?.(bad, r.error); } catch (_) {}
      continue;
    }
    // 名前が拾えない時の受け皿: 候補を1つずつ試して、通った物だけ残す
    const kept: string[] = [];
    for (const c of list) {
      const t = await run(c);
      if (!t.error) kept.push(c);
      else if (!isMissingColumnError(t.error)) return { data: null, error: t.error, cols: kept, dropped };
      else { dropped.push(c); try { opt.onDrop?.(c, t.error); } catch (_) {} }
    }
    if (!kept.length) return { data: null, error: last, cols: kept, dropped };
    const r2 = await run(kept.join(", "));
    return { data: r2.error ? null : r2.data, error: r2.error ?? null, cols: kept, dropped };
  }

  return { data: null, error: last, cols: list, dropped };
}
