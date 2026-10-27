// app/lib/aix-check-staff-note.ts — AIX【物件確認した】を開いた時の、スタッフ向けの小さな注記（管理会社に一緒に聞く条件）を作る（純関数・画面からも import できる）
//
// 2026-10-28 竹内さん（10/15 会話D・owner-fb:1015-pet-count-note）「送られた物件は AIX 物件確認した。加えて管理会社に聞く要る条件（小型犬2匹）を
//   スタッフ向けの小さな注記で AIX の指示に出す」。
//   実物: お客様の条件「ペット2匹（小型犬）可」・お客様「どうしても2匹難しいですかね？」→ スタッフ「上野芝2LDK1階の募集状況と、ペットの小型犬2匹の
//   飼育可否を合わせて管理会社に確認させて頂きます」。募集状況だけを確かめると、2匹不可の部屋を「募集中」で返してしまう。
//   出すのはお客様の条件の欄・お客様の発言にある「管理会社でないと分からない、部屋ごとに違う可否」だけ（ペットの種類と数・二人入居・楽器・事務所利用）。
//   文はお客様に送らない（画面の注記だけ）。NEXT_PUBLIC_AIX_CHECK_STAFF_NOTE=on の時だけ（既定 off）。
// テスト: app/lib/__tests__/aix-check-staff-note.test.ts

export function aixCheckStaffNoteEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.NEXT_PUBLIC_AIX_CHECK_STAFF_NOTE ?? "").trim().toLowerCase() === "on";
}

const N = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");
/** 否定（「ペットなし」「ペットは飼っていない」「ペット不要」）は外す */
const PET_NEG_RE = /ペット(?:は|も)?\s*(?:なし|無し|いない|いません|飼っていない|飼ってない|不要|NG|なしです)|(?:犬|猫)(?:は|も)?\s*(?:いない|いません|飼っていない)/;
const PET_KIND_RE = /(小型犬|中型犬|大型犬|犬|猫|うさぎ|ウサギ|鳥|インコ|フェレット|ハムスター)/;
const PET_COUNT_RE = /([0-9]+)\s*(?:匹|頭|羽)/;
const PET_WORD_RE = /ペット|小型犬|中型犬|大型犬|犬|猫|うさぎ|ウサギ|インコ|フェレット/;

/** ペットの注記（「小型犬2匹」等）。条件・発言にペットの話が無ければ null */
export function petNoteOf(texts: ReadonlyArray<string | null | undefined>, opts: { strictFrom?: number } = {}): string | null {
  let kind: string | null = null, count: number | null = null;
  // strictFrom 番目以降（お客様の発言）は種類か数がある文だけ（監査 10/28: 発言の「ペット」の語だけで 96/251 回に出て多すぎた）
  for (const [idx, raw] of texts.entries()) {
    const strict = opts.strictFrom != null && idx >= opts.strictFrom;
    if (strict && !PET_KIND_RE.test(N(raw)) && !PET_COUNT_RE.test(N(raw))) continue;
    const t = N(raw);
    if (!PET_WORD_RE.test(t) || PET_NEG_RE.test(t)) continue;
    for (const part of t.split(/[。\n、,]/)) {
      if (!PET_WORD_RE.test(part) || PET_NEG_RE.test(part)) continue;
      const k = part.match(PET_KIND_RE)?.[1] ?? null;
      const c = part.match(PET_COUNT_RE)?.[1];
      if (k && (!kind || (kind === "犬" && /型犬/.test(k)))) kind = k;
      if (c && Number(c) > (count ?? 0)) count = Number(c);
      if (!kind && /ペット/.test(part)) kind = "ペット";
    }
  }
  if (!kind) return null;
  return `${kind === "ペット" ? "ペット" : kind}${count && count >= 2 ? `${count}匹` : ""}`;
}

/**
 * 注記の行（「※ 小型犬2匹の飼育可否も一緒に管理会社に確認」）。無ければ空。
 *   conditionsText … お客様の条件の欄（customerConditions）・customerTexts … お客様の最近の発言（新しい物ほど効く必要は無い＝どれかにあれば出す）
 */
export function checkResultStaffNotes(conditionsText: string | null | undefined, customerTexts: ReadonlyArray<string | null | undefined>): string[] {
  const all = [conditionsText, ...customerTexts];
  const out: string[] = [];
  const pet = petNoteOf(all, { strictFrom: 1 });
  if (pet) out.push(`※ ${pet}の飼育可否も一緒に管理会社に確認（お客様の条件）`);
  // 二人入居・楽器・事務所利用はお客様の条件の欄だけで見る（発言の語だけでは出さない＝監査 10/28 の出過ぎ）
  const joined = N(conditionsText);
  if (/(?:2|二)人(?:入居|暮らし)|同棲|カップル|夫婦/.test(joined) && !/(?:2|二)人入居(?:は)?(?:なし|しない|ではない)/.test(joined)) out.push("※ 二人入居の可否も一緒に確認");
  if (/楽器|ピアノ|ギター/.test(joined) && !/楽器(?:は)?(?:なし|弾かない|使わない)/.test(joined)) out.push("※ 楽器の使用の可否も一緒に確認");
  if (/事務所利用|SOHO|ソーホー|法人登記/.test(joined)) out.push("※ 事務所利用（SOHO）の可否も一緒に確認");
  return out;
}
