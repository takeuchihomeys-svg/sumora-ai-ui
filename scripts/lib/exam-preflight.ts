// scripts/lib/exam-preflight.ts — 試験の依頼を積む時点の点検（純関数・LLM なし・費用0）
//
// 2026-11-15 作業員I（竹内さん 11/15「余計な試験をしないように具体的に細かく強化して、実際のブレインに質の高いデータを渡せるように」・統括役の数えの穴 2・3）:
//   今までは積んでから流す時に落ちていた:
//     ・作業ツリーに .env.local が無く、立ち上がりで落ちる（作業員H の3本）
//     ・見込みが上限（--cap-usd）を超え、流す前に止まる（h1115-keepaix-on の3本・fact-three-on-1113b）
//     ・前も今も解けない問題（q152 申込以降・q047 正解の書き方のずれ）＝比べに使えない
//     ・比べた問題が少なく「悪化0」が判断に使えない回（約6%）
//   → --add の時に全部確かめ、落ちる物は積まずに理由と直し方の案を出す。守りが無いのは積むが知らせる。
//   止める: EXAM_ADD_PREFLIGHT=off（今まで通り積む）／1本だけ通す: --force
// テスト: scripts/lib/__tests__/exam-preflight.test.ts

export type PreflightInput = {
  runner: string;
  cwd: string;
  /** cwd に .env.local があるか（呼ぶ側が見る） */
  hasEnvFile: boolean;
  /** .env.local のある試験の作業ツリー（替える案に出す・無ければ null） */
  fallbackCwd: string | null;
  ids: string[];
  guards: string[];
  /** 計画の見込み（前を作る分を含む） */
  planUsd: number;
  capUsd: number | null;
  /** 問題ごとの見込みの回数（揺れ4・安定1 等） */
  reps: Record<string, number>;
  unitUsd: number;
  /** 前も今も解けない問題（申込の門で外れた＝比べに使えない）→ 理由。積まない */
  unsolvable: Record<string, string>;
  /** 揺れの記録で n 回とも不合格の問題（直したい問題そのものの事がある＝積むが知らせる）→ 理由。2026-11-15 直近7日の依頼 281本に当てると、積まないにした時 123本が止まった＝直す狙いの問題を止めてしまう */
  neverPassed?: Record<string, string>;
  /** 掘り（--dig）は比べの数の線を見ない */
  dig?: boolean;
  /** 比べに要る最小の問題の数（既定 2・問題が1つだけの依頼は 1） */
  minCompare?: number;
};
/** drop＝積む前に外す問題（申込の門で外れた＝brain-exam が黙って飛ばす問題）。外した後の数で比べの線を見る */
export type PreflightResult = { go: boolean; blocks: string[]; warns: string[]; hints: string[]; comparable: string[]; drop: string[] };

export function preflightOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EXAM_ADD_PREFLIGHT ?? "").trim().toLowerCase() !== "off";
}

/** 上限に入る分け方の案（問題を見込みの安い順に詰める） */
export function splitToCap(ids: string[], reps: Record<string, number>, unitUsd: number, capUsd: number, fixedUsd = 0): string[][] {
  const cost = (id: string) => (reps[id] ?? 1) * unitUsd * 2; // 前と今
  const parts: string[][] = [];
  let cur: string[] = [], sum = fixedUsd;
  for (const id of [...ids].sort((a, b) => cost(a) - cost(b))) {
    if (cur.length && sum + cost(id) > capUsd) { parts.push(cur); cur = []; sum = fixedUsd; }
    cur.push(id); sum += cost(id);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

export function preflightAdd(i: PreflightInput): PreflightResult {
  const blocks: string[] = [], warns: string[] = [], hints: string[] = [];
  const isExam = i.runner === "brain-exam";
  // ① 鍵（.env.local）
  if ((isExam || i.runner === "cmd") && !i.hasEnvFile) {
    blocks.push(`作業ツリーに .env.local が無い（立ち上がりで落ちる）: ${i.cwd}`);
    if (i.fallbackCwd) hints.push(`--cwd=${i.fallbackCwd} に替える（その作業ツリーを origin/main に揃えてから: cd ${i.fallbackCwd} && git fetch origin && git checkout --detach origin/main）`);
  }
  if (!isExam) return { go: !blocks.length, blocks, warns, hints, comparable: [], drop: [] };
  // ② 前も今も解けない問題（比べに使えない）
  const bad = i.ids.filter((id) => i.unsolvable[id]);
  const comparable = i.ids.filter((id) => !i.unsolvable[id]);
  // 2026-11-15: 直近7日の依頼に当てると、まるごと積まないにした時 38本が止まった＝外して積む（brain-exam は門で外れた問題を黙って飛ばしていた＝比べた問題が減っていた）
  if (bad.length) warns.push(`前も今も解けない問題を外して積む（比べに使えない）: ${bad.map((id) => `${id}（${i.unsolvable[id]}）`).join("・")}`);
  // ③ 比べられる問題の数
  const minC = i.minCompare ?? Math.min(2, i.ids.length);
  const targets = comparable.filter((id) => !i.guards.includes(id));
  if (!i.dig && targets.length + (i.guards.length ? 1 : 0) < minC) blocks.push(`両方で解ける問題が ${targets.length}問（守り ${i.guards.length}）＝比べた問題が少なく判断に使えない（${minC}問以上）`);
  // ④ 上限
  if (i.capUsd != null && i.planUsd > i.capUsd) {
    blocks.push(`見込み $${i.planUsd.toFixed(2)} が上限 $${i.capUsd.toFixed(2)} を超える（流す前に止まる）`);
    const parts = splitToCap(comparable, i.reps, i.unitUsd, i.capUsd);
    if (parts.length > 1 && parts.every((p) => p.length >= Math.min(2, minC))) hints.push(`${parts.length}本に分ける: ${parts.map((p) => `--only=${p.join(",")}`).join(" ／ ")}`);
    hints.push(`上限を --cap-usd=${(Math.ceil(i.planUsd * 10) / 10).toFixed(1)} に上げる`);
    const flaky = comparable.filter((id) => (i.reps[id] ?? 1) > 1);
    if (flaky.length) hints.push(`揺れる問題（回数 ${flaky.map((id) => `${id}×${i.reps[id]}`).join("・")}）を減らすか、夜の基準ができた後に流す（--night）`);
  }
  const np = i.ids.filter((id) => i.neverPassed?.[id] && !i.unsolvable[id]);
  if (np.length) warns.push(`記録では一度も合格していない問題（直す狙いでなければ比べに使えない）: ${np.map((id) => `${id}（${i.neverPassed![id]}）`).join("・")}`);
  // ⑤ 守り
  if (!i.guards.length && !i.dig) warns.push("守りの問題が無い（悪化0でも直していない所の悪化は見えない）。--only に道が安定した問題を1つ足すと守りになる");
  return { go: !blocks.length, blocks, warns, hints, comparable, drop: bad };
}

/** 揺れの記録から「前も今も解けない」を読む（直近の記録が n 回以上・一度も合格なし）。sig の形は exam-flake.sigOfRow（道|○✕|…） */
export function unsolvableFromObs(obs: ReadonlyArray<{ sig: string; at?: string }>, minN = 4): string | null {
  if (obs.length < minN) return null;
  const passes = obs.filter((o) => /\|○/.test(o.sig)).length;
  return passes === 0 ? `直近の記録 ${obs.length}回とも不合格` : null;
}

/** 夜の基準に入れる問題: 前を作る分で流す前に止まった依頼（直近 days 日・結果の verdict が「流す前に止めた」）の問題（穴1） */
export function stoppedForBaseIds(results: ReadonlyArray<{ label?: string; verdict?: string; at?: string; only?: string }>, o: { nowMs: number; days?: number }): string[] {
  const since = o.nowMs - (o.days ?? 2) * 86_400_000;
  const s = new Set<string>();
  for (const r of results) {
    if (!/^流す前に止めた/.test(String(r.verdict ?? ""))) continue;
    if (r.at && Date.parse(r.at) < since) continue;
    for (const id of String(r.only ?? "").split(",")) if (id.trim()) s.add(id.trim());
  }
  return [...s].sort();
}
