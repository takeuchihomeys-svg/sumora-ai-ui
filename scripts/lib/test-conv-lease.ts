// scripts/lib/test-conv-lease.ts — テスト用の会話（YUMA・YUMA2〜YUMA5）を担当ごとに占有する鍵
//
// 2026-10-09 竹内さん承認「YUMA の他に、LINE につながっていないテスト専用の会話を数本作り、担当ごとに別の会話で並べて回せるようにする」:
//   1巡＝試験121問を YUMA 1本で順番待ちして数時間 → 担当ごとに別の会話（YUMA2〜YUMA5・app/lib/test-conversations.ts の NO_LINE_TEST_CONVERSATIONS）で並べる。
//   同じ会話を2つの実行で使うと、場面の通・条件の行の写し・線（REPLAY_FLOOR_FILE）が混ざる → 鍵のファイルで1会話1実行にする。
//
// 使い方（スクリプトの先頭・setupLlmTest より前でよい）:
//   const lease = acquireTestConversation(arg("conv"), "brain-exam-<label>");
//     ""（指定なし）… YUMA（今まで通り・鍵は取らない＝YUMA の順番待ちは今までの仕組み＝条件の写しの控え・waitUntilYumaQuiet）
//     "auto"        … 空いているテスト専用の会話（YUMA2→YUMA5 の順）を取る。全部使われていたら止まる
//     "YUMA3"・id   … その会話を取る（他の生きている実行が持っていたら止まる）
//   lease.id / lease.name / lease.tag（ファイル名に使う小文字）… 終わると自動で鍵を外す（process の exit）。lease.release() でも外せる
// 鍵: scripts/.replay-out/.test-conv-<NAME>.lock（{pid, owner, at}）。持ち主の pid が死んでいたら取り直せる（落ちた実行の鍵は残っても詰まらない）
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { YUMA_CONVERSATION_ID, NO_LINE_TEST_CONVERSATIONS, resolveTestOnlyConversation } from "../../app/lib/test-conversations";

export type TestConvLease = {
  id: string; name: string; tag: string; isYuma: boolean;
  /** 鍵のファイル（YUMA は null） */ lockFile: string | null;
  release: () => void;
};

export const LEASE_DIR_DEFAULT = "scripts/.replay-out";
export const lockFileOf = (name: string, dir = LEASE_DIR_DEFAULT) => `${dir}/.test-conv-${name.toUpperCase()}.lock`;

type LockBody = { pid: number; owner: string; at: string };
const defaultAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; } };

/** 鍵の中身を読む（壊れた・空のファイルは null） */
export function readLock(file: string): LockBody | null {
  try { const j = JSON.parse(readFileSync(file, "utf8")) as Partial<LockBody>; return typeof j.pid === "number" ? (j as LockBody) : null; } catch { return null; }
}

/** 鍵を取る（取れたら true）。生きている他の実行が持っていたら false。死んだ実行の鍵・空の鍵は取り直す */
export function tryLock(file: string, owner: string, opts: { pid?: number; alive?: (pid: number) => boolean } = {}): boolean {
  const pid = opts.pid ?? process.pid, alive = opts.alive ?? defaultAlive;
  const body = JSON.stringify({ pid, owner, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx"); // 無い時だけ作る（同時に取りに来ても片方だけ）
      writeFileSync(fd, body); closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      const cur = readLock(file);
      if (cur && cur.pid === pid) { writeFileSync(file, body); return true; }
      if (cur && alive(cur.pid)) return false;
      try { unlinkSync(file); } catch { /* 他が先に消した */ }
    }
  }
  return false;
}

/** 自分の鍵だけ外す */
export function unlock(file: string, pid = process.pid): void {
  const cur = readLock(file);
  if (cur && cur.pid === pid) { try { unlinkSync(file); } catch { /* */ } }
}

/**
 * 会話を選んで鍵を取る（純粋に近い: 鍵の場所・pid・生死の判定は差し替えられる＝テスト用）。
 * @param want "" | "auto" | "YUMA2" | 会話 id
 */
export function acquireTestConversation(want: string | null | undefined, owner: string, opts: { dir?: string; pid?: number; alive?: (pid: number) => boolean; exitHook?: boolean } = {}): TestConvLease {
  const w = String(want ?? "").trim();
  const dir = opts.dir ?? LEASE_DIR_DEFAULT;
  if (!w || w.toUpperCase() === "YUMA" || w === YUMA_CONVERSATION_ID) {
    return { id: YUMA_CONVERSATION_ID, name: "YUMA", tag: "yuma", isYuma: true, lockFile: null, release: () => { /* YUMA は鍵を取らない */ } };
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const candidates = w.toLowerCase() === "auto"
    ? NO_LINE_TEST_CONVERSATIONS.map((c) => ({ id: c.id, name: c.name }))
    : (() => { const c = resolveTestOnlyConversation(w); if (!c) throw new Error(`--conv=${w} はテスト用の会話ではありません（使えるのは auto・${NO_LINE_TEST_CONVERSATIONS.map((x) => x.name).join("・")}・YUMA）`); return [c]; })();
  const held: string[] = [];
  for (const c of candidates) {
    const file = lockFileOf(c.name, dir);
    if (tryLock(file, owner, opts)) {
      const pid = opts.pid ?? process.pid;
      const release = () => unlock(file, pid);
      if (opts.exitHook !== false) process.once("exit", release);
      return { id: c.id, name: c.name, tag: c.name.toLowerCase(), isYuma: false, lockFile: file, release };
    }
    const cur = readLock(file);
    held.push(`${c.name}（${cur?.owner ?? "?"}・pid ${cur?.pid ?? "?"}）`);
  }
  throw new Error(`テスト専用の会話が空いていません: ${held.join("、")}。終わるのを待つか、別の会話を --conv=YUMA2〜YUMA5 で選んでください`);
}
