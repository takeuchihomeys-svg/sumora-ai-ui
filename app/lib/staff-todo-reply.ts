// app/lib/staff-todo-reply.ts — スタッフのグループの返信（✅3・〇〇さん 完了）を【やることリスト】の行に結びつける（純関数・DB も LLM もなし）
//
// 2026-10-21 竹内さん G3「（グループの✅も済みに）する 基本はLINEから自動で判断出来れば理想」（設計知見 f87ccb7e）:
//   基本は LINE の送信（sent_facts・AIX）から自動で✅（staff-todo-list.ts）。送信に残らない済み（電話で済ませた・LINE アプリから直接送った）は
//   グループに返すと✅になる。
// 結びつけ方（一番単純で外れにくい形）:
//   ① 番号: 一覧の残りの行には ①② … の番号が付いている → 「✅3」「✅③⑤」「3 完了」「3,5済み」。一覧を引用して返した時はその一覧の番号、
//      引用が無ければ最後に送った一覧の番号（一覧は2時間ごとなので、古い一覧の番号は引用した時だけ使う）
//   ② お客様の名前: 「〇〇さん 完了」「✅〇〇さん」→ その一覧のそのお客様の残りの行を全部✅
//   ③ ☑（色の無いチェック・2026-10-21 竹内さんの決定 268a904a）: 「☑3」「〇〇さん なし」＝ターゲットの新着を確かめたが物件が無い。
//      番号はその行、名前はそのお客様の「新着の物件確認」の行だけを☑にする（他のやる事は済みにしない）
//   ✅／完了／済／☑／なし のどれも無い発言は読まない（グループの普段の会話を拾わない）。「完了 〇〇」（物件出しの完了の古いコマンド）は
//   先に物件出しの完了で読み、そこで見つからなかった時だけここで読む（hanbancyo-webhook）
// テスト: app/lib/__tests__/staff-todo-reply.test.ts

/** 送った一覧の控え（hanbancyo_settings の staff_todo_snapshots に新しい順で数件） */
export type TodoSnapshotItem = { n: number; key: string; conversationId: string; name: string; label: string };
export type TodoSnapshot = { messageId: string | null; sentAt: string; items: TodoSnapshotItem[] };

/** 控えの数（一覧は1時間ごと＝営業時間の1日分を少し超える数。引用して返した古い一覧も読める） */
export const TODO_SNAPSHOT_KEEP = 12;
/** 引用の無い返信が読む「最後の一覧」の有効時間（次の一覧が来るまで＋余裕） */
export const TODO_SNAPSHOT_FRESH_MS = 26 * 3600_000;

// 2026-10-21 確かめる人: 「すみ」（すみません）・「やった」・「終わり」は普段の会話に多く、番号・名前と一緒に誤って✅にするので読まない（✅／完了／済 だけ）
const DONE_WORD_RE = /✅|✔️?|完了|済|\bdone\b/i;
/** ☑（確かめたが物件が無い・2026-10-21 竹内さんの決定 268a904a）。☑ は✅と違う意味なので✅の言葉に入れない */
const NONE_MARK_RE = /☑/;
const NONE_WORD_RE = /なし|無し|ありませんでした|ありません|無かった|なかった/;
/** 半角・全角数字の番号は短い返信の時だけ読む（「申込完了しました！2回目で…」の 2 を番号にしない）。丸数字はいつでも読む */
const NUMBER_REPLY_MAX_CHARS = 20;

const CIRCLED: Array<[number, number, number]> = [[0x2460, 1, 20], [0x3251, 21, 35], [0x32b1, 36, 50]];
/** ①〜㊿ を数字に（それ以外は null） */
export function circledToNumber(ch: string): number | null {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [start, from, to] of CIRCLED) if (cp >= start && cp <= start + (to - from)) return from + (cp - start);
  return null;
}

export type ParsedTodoReply = { numbers: number[]; names: string[]; /** ☑（確かめたが物件が無い） */ none?: boolean };
/**
 * 返信を読む。✅／完了／済（✅）・☑／なし（☑）の言葉が無ければ null。番号（半角・全角・丸数字）と「〇〇さん」の名前を拾う。
 * 時刻・日付（10:30・10/21）や「残り 3件」の数は番号にしない。☑ の字があれば☑、✅の言葉が無く「なし」があれば☑
 */
export function parseTodoReply(text: string | null | undefined): ParsedTodoReply | null {
  const raw = text ?? "";
  if (!raw.trim()) return null;
  const done = DONE_WORD_RE.test(raw);
  const none = NONE_MARK_RE.test(raw) || (!done && NONE_WORD_RE.test(raw));
  if (!done && !none) return null;
  // 一覧そのものを貼り返した長文は読まない
  if (raw.includes("【やることリスト】")) return null;
  const numbers = new Set<number>();
  for (const ch of raw) { const n = circledToNumber(ch); if (n) numbers.add(n); }
  // 全角数字を半角に（丸数字は上で読んだので NFKC は使わない＝①が 1 にならないように）
  const ascii = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const noTime = ascii.replace(/\d{1,2}[:：]\d{2}/g, " ").replace(/\d{1,2}\/\d{1,2}/g, " ").replace(/\d+\s*(?:件|日|時|分|人|名|号室|号|室|万|円|回|つ|組|目|階|通|枚|個|部屋|月|年|週|歳|才|%|％)/g, " ");
  if (raw.replace(/\s/g, "").length <= NUMBER_REPLY_MAX_CHARS) for (const m of noTime.matchAll(/(?<![\d.])(\d{1,3})(?![\d.])/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 200) numbers.add(n);
  }
  const names = new Set<string>();
  for (const m of raw.matchAll(/([^\s、,，。!！?？✅☑️✔️（）()「」:：・]{1,20}?)\s*(?:さん|様|さま)/g)) {
    const nm = m[1].replace(/^(?:完了|済み|済|✅|☑️?)+/, "").trim();
    if (nm) names.add(nm);
  }
  if (numbers.size === 0 && names.size === 0) return null;
  return { numbers: [...numbers].sort((a, b) => a - b), names: [...names], ...(none ? { none: true } : {}) };
}
/** ターゲットの毎日の新着確認の行の鍵（staff-todo-list.newArrivalKey） */
export const isNewArrivalKey = (key: string) => key.startsWith("newarrival:");

/** 名前の比べ方（空白・記号・大小を外す） */
export function normName(s: string | null | undefined): string {
  return (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・.。、,!！?？~〜ー\-_'"’”]/g, "").replace(/(?:さん|様|さま)$/, "");
}

/** どの一覧で読むか: 引用した一覧 → 無ければ最後の一覧（新しすぎず古すぎない物） */
export function pickTodoSnapshot(snaps: ReadonlyArray<TodoSnapshot>, quotedMessageId: string | null | undefined, nowMs: number): TodoSnapshot | null {
  if (quotedMessageId) {
    const q = snaps.find((s) => s.messageId && s.messageId === quotedMessageId);
    if (q) return q;
  }
  const latest = [...snaps].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0];
  if (!latest || nowMs - Date.parse(latest.sentAt) > TODO_SNAPSHOT_FRESH_MS) return null;
  return latest;
}

export type TodoReplyResolution = { hits: TodoSnapshotItem[]; unknownNumbers: number[]; unknownNames: string[]; none?: boolean };
/** 返信 → 一覧の行。名前は一覧のお客様の名前と前方・部分一致（2文字以上） */
export function resolveTodoReply(parsed: ParsedTodoReply, snap: TodoSnapshot): TodoReplyResolution {
  const hits = new Map<string, TodoSnapshotItem>();
  const unknownNumbers: number[] = [];
  for (const n of parsed.numbers) {
    const it = snap.items.find((x) => x.n === n);
    if (it) hits.set(it.key, it); else unknownNumbers.push(n);
  }
  const unknownNames: string[] = [];
  for (const raw of parsed.names) {
    const q = normName(raw);
    if (q.length < 2 && !/[^\x00-\x7f]/.test(q)) { unknownNames.push(raw); continue; }
    // ☑ の名前はそのお客様の新着確認の行だけ（他のやる事は済みにしない）
    const pool = parsed.none ? snap.items.filter((x) => isNewArrivalKey(x.key)) : snap.items;
    const exact = pool.filter((x) => normName(x.name) === q);
    const part = exact.length ? exact : pool.filter((x) => { const nm = normName(x.name); return nm.length >= 2 && q.length >= 2 && (nm.includes(q) || q.includes(nm)); });
    // 違うお客様が2人以上当たる時は決めない（番号で返してもらう）
    const people = new Set(part.map((x) => x.conversationId));
    if (people.size !== 1) { unknownNames.push(raw); continue; }
    for (const it of part) hits.set(it.key, it);
  }
  return { hits: [...hits.values()].sort((a, b) => a.n - b.n), unknownNumbers, unknownNames, ...(parsed.none ? { none: true } : {}) };
}

/** グループへの返事（返信の replyToken で返す・push の数を使わない） */
export function renderTodoReplyAck(r: TodoReplyResolution, remaining: number | null): string | null {
  const lines: string[] = [];
  for (const h of r.hits) lines.push(r.none ? `☑${h.n} ${h.name}さん ${h.label}（確認済み・物件なし）` : `✅${h.n} ${h.name}さん ${h.label}`);
  if (r.unknownNumbers.length) lines.push(`⚠️ 番号 ${r.unknownNumbers.join("・")} は一覧にありません`);
  if (r.unknownNames.length) lines.push(`⚠️「${r.unknownNames.join("・")}」は一覧で1人に決まりません（番号で「✅3」と返してください）`);
  if (lines.length === 0) return null;
  if (r.hits.length && remaining !== null) lines.push(remaining > 0 ? `残り ${remaining}件` : "🎉 一覧の残りは全部✅！");
  return lines.join("\n");
}

/** 「完了 3」「完了 ③⑤」のように番号だけ（物件出しの「完了 [顧客名]」と見分ける） */
export function isTodoNumbersOnly(rest: string): boolean {
  const s = rest.trim();
  if (!s) return false;
  return [...s].every((ch) => /[0-9０-９\s,、，・.。]/.test(ch) || circledToNumber(ch) !== null);
}
