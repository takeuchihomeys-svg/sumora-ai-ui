// app/lib/customer-circumstances.ts — 把握「お客様の事情」（予定・都合・遠方・時期の事情・同行者・体調）。決定論・純関数。
//
// 2026-10-08 竹内「細かい部分に対応できるように、ブレインに足りていない部分があれば追加していく形で。今ある TPO の把握や日にちの把握みたいな形で」
//   実データ（scripts/audit-grasp-gaps.ts・7巡目の差の組 40日 521組＋正解の表 6/26〜 2,719番）で、まだ手当ての無い把握の型の最多が「お客様の事情」だった:
//   ・人はお客様が前に言った事情を行動に結び付けて書く（例: 「都合つくのが9月13日以降」＋「埋まる可能性高いですか」→
//     「お気に召されたお部屋を抑えた状態で、9月13日以降のご内覧日に実際室内確認頂き」／「広島に住んでいて内見が難しい」→「オンライン内見や室内の撮影も」／
//     「10月末にしか初期費用を用意出来ない」→「10月下旬以後でご都合よろしいお日にちに…ご案内」／「会社の移動先が変わるかも」→「移動先が分かりましたら新しいエリアでも」）。
//   ・AI は今の発言の言葉（appeal-timing の VIEWING_DELAYED_RE＝「予定が詰まって」「出張中」等の決まった言い方）しか見ておらず、
//     日付つきの「〇日以降」・前の発言の事情（遠方・転勤・同行者）は材料に無かった（ブレインは会話履歴から読む事もあるが当たり外れ）。
//   → TPO・日にちの把握と同じ形で、お客様の発言（申込の書類・条件のフォーム・画像の書き起こし・URL を除く）から事情を読み、
//     日付は JST の暦日に直し（「9/13（日）以降・今日から5日後」）、言った日と有効期限（鮮度）を付けてブレインに短い注記で渡す。
//     appeal-timing の「すぐ来られない」にも同じ判定を使う（前の発言の「〇日以降」・遠方を含める）。
//   推測しない: 読むのは決まった言い方だけ。言い回しの指示は書かない（材料だけ）。戻す: CUSTOMER_CIRCUMSTANCES=off（注記）／APPEAL_CIRCUMSTANCES=off（訴求）
// テスト: app/lib/__tests__/customer-circumstances.test.ts（実物の発言・伏せ字）

export type CircumstanceKind =
  | "available_from"   // 〇日以降なら来られる・〇日に帰国（日付つき）
  | "cannot_come_soon" // しばらく来られない（日付なし）
  | "remote"           // 遠方・海外にいる
  | "life_timing"      // 更新・転勤・異動先・出産・退去可能時期の確認 など、引越しの時期を決める事情
  | "companion"        // 同行者・一緒に決める人（彼氏が行く・主人と相談）
  | "health";          // 体調

export type Circumstance = {
  kind: CircumstanceKind;
  /** お客様の言葉（その文・40字まで） */
  quote: string;
  /** 言った時刻（ISO） */
  saidAt: string;
  /** available_from の日（JST のその日の 0 時・ms） */
  fromDayMs?: number;
  /** 今回の連投の中の発言か */
  thisTurn: boolean;
};

export type CustMsg = { text: string | null | undefined; createdAt: string };

const DAY = 86_400_000;
const JST = 9 * 3600_000;
const dayStart = (ms: number) => Math.floor((ms + JST) / DAY) * DAY - JST;
const jstYMD = (ms: number) => { const d = new Date(ms + JST); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() }; };
const jstDate = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - JST;
const WD = ["日", "月", "火", "水", "木", "金", "土"];

/** 有効期限（言った日から）: 種類ごと。available_from は日付が過ぎたら終わり */
export const CIRCUMSTANCE_TTL_DAYS: Record<CircumstanceKind, number> = {
  available_from: 60, cannot_come_soon: 10, remote: 60, life_timing: 60, companion: 21, health: 5,
};

/** 材料にしない発言（申込の書類・条件のフォーム・画像の書き起こし・URL だけ・スタンプ） */
function skipMessage(t: string): boolean {
  if (!t.trim()) return true;
  if (/^\s*\[(?:画像|動画|スタンプ|ファイル|位置情報)/.test(t)) return true;
  if (/①|【ご入居の時期】|ご希望のお部屋探しご条件/.test(t)) return true;
  if (/生年月日|携帯番号|勤務先(?:名|所在地|電話)|年収|フリガナ/.test(t)) return true;
  return false;
}

// 日付の言い方（その発言の日を基準に暦日へ）
const DATE_SRC = "(?:(\\d{1,2})月(\\d{1,2})日?|(\\d{1,2})[\\/／](\\d{1,2})|(\\d{1,2})月(?:の)?(上旬|中旬|下旬|頭|初め|はじめ|末|半ば|中ごろ|中頃)|(\\d{1,2})月|再来週|来週末?|週明け|来月(?:の)?(?:上旬|中旬|下旬|頭|初め|末)?|今月末|月末|(\\d{1,2})日)";
const DATE_RE = new RegExp(DATE_SRC);

/** 日付の言い方を暦日（JST 0時）に。end=true は「〇まで」の終わりの日 */
export function resolveDateExpr(expr: string, saidMs: number, end = false): number | null {
  const t = expr.normalize("NFKC");
  const m = t.match(DATE_RE);
  if (!m) return null;
  const now = jstYMD(saidMs);
  const ymd = (mo: number, d: number) => {
    let y = now.y;
    // 言った月より前の月は来年（12月に「1月」と言った等）。同じ月で日が過ぎていても今年のまま（「〇日以降」は過去日なら有効期限で落ちる）
    if (mo < now.m - 1) y += 1;
    return jstDate(y, mo, Math.min(d, 31));
  };
  if (m[1] && m[2]) return ymd(Number(m[1]), Number(m[2]));
  if (m[3] && m[4]) return ymd(Number(m[3]), Number(m[4]));
  if (m[5] && m[6]) {
    const mo = Number(m[5]); const part = m[6];
    const d = /上旬|頭|初め|はじめ/.test(part) ? (end ? 10 : 1) : /中旬|半ば|中ごろ|中頃/.test(part) ? (end ? 20 : 11) : /下旬/.test(part) ? (end ? 31 : 21) : (end ? 31 : 25);
    return ymd(mo, d);
  }
  if (m[7]) return ymd(Number(m[7]), end ? 31 : 1);
  const base = dayStart(saidMs);
  if (/再来週/.test(m[0])) { const toMon = ((8 - now.dow) % 7) || 7; return base + (toMon + 7 + (end ? 6 : 0)) * DAY; }
  if (/来週末/.test(m[0])) { const toMon = ((8 - now.dow) % 7) || 7; return base + (toMon + 5 + (end ? 1 : 0)) * DAY; }
  if (/来週|週明け/.test(m[0])) { const toMon = ((8 - now.dow) % 7) || 7; return base + (toMon + (end ? 6 : 0)) * DAY; }
  if (/来月/.test(m[0])) {
    const mo = now.m === 12 ? 1 : now.m + 1; const y = now.m === 12 ? now.y + 1 : now.y;
    const part = m[0].replace(/来月(?:の)?/, "");
    const d = /上旬|頭|初め/.test(part) ? (end ? 10 : 1) : /中旬/.test(part) ? (end ? 20 : 11) : /下旬/.test(part) ? (end ? 31 : 21) : /末/.test(part) ? (end ? 31 : 25) : (end ? 31 : 1);
    return jstDate(y, mo, d);
  }
  if (/今月末|月末/.test(m[0])) return jstDate(now.y, now.m, end ? 31 : 25);
  if (m[8]) { // 「13日」だけ: 言った日より前なら来月
    const d = Number(m[8]);
    return d >= now.d ? jstDate(now.y, now.m, d) : jstDate(now.m === 12 ? now.y + 1 : now.y, now.m === 12 ? 1 : now.m + 1, d);
  }
  return null;
}

const COME_CTX = /都合|行け|行ける|伺え|伺う|内覧|内見|見に|見学|空い|空き|予定|来れ|来られ|こられ|帰|戻|時間|案内|出張/;
// 〇日以降・〇日から（来られる）
const FROM_RE = new RegExp(`${DATE_SRC}(?:の)?(?:以降|以後|から)`);
// 〇日まで（は）来られない
const UNTIL_RE = new RegExp(`${DATE_SRC}(?:まで|中)は?[^。\\n]{0,8}(?:行け|伺え|無理|難し|忙し|予定|仕事|出張|帰れ|いない|居ない|不在)`);
// 〇日に帰国・帰ってくる
const RETURN_RE = new RegExp(`${DATE_SRC}(?:に|頃に?|ごろに?)?(?:は)?(?:日本|大阪|こっち)?(?:に|へ)?(?:帰国|帰って|戻って|戻り|帰り|帰ります|戻ります|戻る|帰る|来阪|大阪に来)`);
// 「〇日以降」がお客様自身の都合である印（行ける・伺える・都合・予定・大阪にいない・お願いします 等）
const SELF_CTX = /都合|行け|伺え|伺い|予定|いない|居ない|帰|来ます|来れ|来られ|お願い|希望|空いて|休み|時間/;
const SOON_RE = /予定(?:が)?(?:詰ま|埋ま|立た)|しばらく(?:は)?(?:行け|伺え|難し|無理)|当分(?:は)?(?:行け|伺え|難し|無理)|今週は(?:内覧に|内見に)?(?:行けない|無理|難し)|出張中|出張で[^。\n]{0,8}(?:行け|伺え|厳し|無理|難し)|(?:内覧|内見)(?:は|に)?(?:行けない|行けません|伺えない|難しい状況)/;
const REMOTE_RE = /(?:今|現在|いま)?(?:は)?(?:東京|神奈川|千葉|埼玉|名古屋|愛知|静岡|福岡|広島|岡山|山口|四国|九州|北海道|沖縄|東北|新潟|長野|石川|富山|海外|県外|地方)(?:に|で|の方に|在住)?(?:住んで|在住|に住|おり|いて|居て|暮らし)|海外にいて|今海外|遠方(?:に住|在住|のため|なので|に)/;
const LIFE_RE = /(?:\d{1,2}月の?)?更新(?:月|を|まで|せず|しない|の時期|前)|転勤|異動|(?:移動|配属|勤務)先(?:が|は)?(?:変わ|決ま|未定)|出産|入社(?:予定|日)|(?:今|現在)(?:の|住んで(?:い)?る)?(?:家|お部屋|部屋|ところ|所)?の?退去(?:可能|日|時期|予告)|解約(?:予告|通知)/;
const COMPANION_RE = /(彼氏|彼女|主人|旦那|夫|妻|嫁|両親|親|母|父|家族|パートナー|相方|同居人|友人|友達)(?:さん)?(?:が|と|に|も|の方が)(?:[^。\n]{0,6})(?:行|見|内覧|内見|相談|確認|決め|住|一緒|来|立ち会)/;
const HEALTH_RE = /熱が|発熱|体調(?:が|を)?(?:悪|崩|優れ)|入院|風邪(?:を|引)/;

function sentenceOf(text: string, idx: number): string {
  const s = Math.max(text.lastIndexOf("\n", idx), text.lastIndexOf("。", idx), text.lastIndexOf("！", idx), text.lastIndexOf("？", idx)) + 1;
  const ends = [text.indexOf("\n", idx), text.indexOf("。", idx), text.indexOf("！", idx), text.indexOf("？", idx)].filter((x) => x >= 0);
  const e = ends.length ? Math.min(...ends) : text.length;
  return text.slice(s, e).trim().slice(0, 40);
}

/** お客様の発言（古い順）から事情を読む。turnStartMs 以降の発言は thisTurn */
export function extractCircumstances(custMsgs: ReadonlyArray<CustMsg>, turnStartMs: number): Circumstance[] {
  const out: Circumstance[] = [];
  for (const m of custMsgs) {
    const raw = String(m.text ?? "");
    if (skipMessage(raw)) continue;
    const t = raw.normalize("NFKC");
    const at = Date.parse(m.createdAt);
    if (!Number.isFinite(at)) continue;
    const thisTurn = at >= turnStartMs;
    const push = (c: Omit<Circumstance, "saidAt" | "thisTurn">) => out.push({ ...c, saidAt: m.createdAt, thisTurn });
    // 日付つき（〇以降・〇まで無理・〇に帰国）— 同じ文に来る・行く・内覧の言葉がある時だけ（「11月以降入居」は入居の時期＝条件なので外す）
    let hit = false;
    for (const [re, end] of [[FROM_RE, false], [UNTIL_RE, true], [RETURN_RE, false]] as const) {
      const mm = t.match(re);
      if (!mm || mm.index == null) continue;
      const sent = sentenceOf(t, mm.index);
      // お部屋の話（退去予定・募集・いつから見られるか）・入居の時期は、お客様の都合ではない
      if (/退去|募集|入居|引っ?越|契約|申込|更新|入社|探して|探し/.test(sent)) continue;
      if (/(?:でき|出来|行け|見られ|見れ)る(?:の|ん)(?:でしょう|です)?か|可能(?:でしょう|です)か|でしょ[?？]*$|どうですか|としたら/.test(sent)) continue;
      if (re !== RETURN_RE && !COME_CTX.test(sent)) continue;
      if (re === FROM_RE && !SELF_CTX.test(sent)) continue;
      const d = resolveDateExpr(mm[0], at, end);
      if (d == null) continue;
      push({ kind: "available_from", quote: sent, fromDayMs: end ? d + DAY : d });
      hit = true; break;
    }
    if (!hit) { const mm = t.match(SOON_RE); if (mm && mm.index != null && !/(?:です|ます|感じ|でしょう)か|[?？]/.test(sentenceOf(t, mm.index))) push({ kind: "cannot_come_soon", quote: sentenceOf(t, mm.index) }); }
    { const mm = t.match(REMOTE_RE); if (mm && mm.index != null && !/大阪/.test(mm[0])) push({ kind: "remote", quote: sentenceOf(t, mm.index) }); }
    { const mm = t.match(LIFE_RE); if (mm && mm.index != null && !/選択|の方は|ですか[?？]*$/.test(sentenceOf(t, mm.index))) push({ kind: "life_timing", quote: sentenceOf(t, mm.index) }); }
    // 保証・審査・申込の書類の話の家族（親に連絡が行く・同居人の滞納）・鍵の受け取りは、同行・一緒に決める人ではない
    { const mm = t.match(COMPANION_RE); if (mm && mm.index != null && !/保証|審査|滞納|連絡(?:が)?(?:行|い)く|本人確認|書類|受け取り|取りに|カード決済|鍵/.test(sentenceOf(t, mm.index))) push({ kind: "companion", quote: sentenceOf(t, mm.index) }); }
    { const mm = t.match(HEALTH_RE); if (mm && mm.index != null) push({ kind: "health", quote: sentenceOf(t, mm.index) }); }
  }
  return out;
}

/** 今も有効な事情（鮮度: 種類ごとの期限・日付が過ぎた「〇日以降」は落とす・同じ種類は新しい物だけ） */
export function validCircumstances(items: ReadonlyArray<Circumstance>, nowMs: number): Circumstance[] {
  const keep = items.filter((c) => {
    const age = nowMs - Date.parse(c.saidAt);
    if (age > CIRCUMSTANCE_TTL_DAYS[c.kind] * DAY) return false;
    if (c.kind === "available_from" && c.fromDayMs != null && c.fromDayMs <= dayStart(nowMs)) return false;
    return true;
  });
  const latest = new Map<CircumstanceKind, Circumstance>();
  for (const c of keep) { const p = latest.get(c.kind); if (!p || Date.parse(c.saidAt) >= Date.parse(p.saidAt)) latest.set(c.kind, c); }
  return [...latest.values()];
}

/**
 * 内覧の日時より先に「お申込みでお部屋を抑えた状態でご内覧頂く」提案をする事情か（理由の文・無ければ null）。
 *   2026-10-08 竹内さん「期間が1週間以上空いた場合や、遠方の方には、そのように提案する」:
 *   「〇日以降」が今日から7日以上先／遠方 の時だけ。7日未満・遠方でない時は入れない（日付の無い「しばらく来られない」もこの線では入れない）。
 *   戻す: HOLD_FIRST_MIN_DAYS=<日数>（既定 7）／APPEAL_CIRCUMSTANCES=off で appeal-timing に効かせない
 */
export function holdFirstMinDays(): number {
  const n = Number(process.env.HOLD_FIRST_MIN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}
export function holdFirstReason(valid: ReadonlyArray<Circumstance>, nowMs: number, env: Record<string, string | undefined> = process.env): string | null {
  const min = holdFirstMinDays();
  const from = valid.find((c) => c.kind === "available_from" && c.fromDayMs != null);
  if (from && from.fromDayMs != null) {
    const days = Math.round((from.fromDayMs - dayStart(nowMs)) / DAY);
    if (days >= min) return `内覧に来られるのが今日から${days}日後（${min}日以上先）`;
  }
  if (valid.some((c) => c.kind === "remote")) return "遠方のお客様";
  // 2026-10-08 竹内さん「（予定が詰まって・出張中＝日付なし）先に部屋を抑える方向で」: 日付の無い時は7日の線にそろえず抑える提案に倒す。
  //   日付のある「〇日以降」がある時はそちら（上の7日の線）が正。戻す CIRCUMSTANCE_UNDATED_HOLD=off
  if (!from && (env.CIRCUMSTANCE_UNDATED_HOLD ?? "").trim().toLowerCase() !== "off") {
    const soon = valid.find((c) => c.kind === "cannot_come_soon" && undatedHoldKind(c.quote));
    if (soon) return undatedHoldKind(soon.quote) === "business_trip" ? "出張中で内覧にすぐ来られない（日付なし）" : "予定が詰まっていて内覧にすぐ来られない（日付なし）";
  }
  return null;
}

/**
 * 日付の無い「すぐ来られない」のうち、先に抑える提案に倒す物（2026-10-08 竹内さんの決定）。
 *   business_trip＝出張中（オンライン内見も伝える）／busy＝予定が詰まって・しばらく・当分。「今週は無理」「内覧行けない」だけは入れない（来週なら来られる＝短い）
 */
export function undatedHoldKind(quote: string): "business_trip" | "busy" | null {
  const t = String(quote ?? "").normalize("NFKC");
  if (DATE_RE.test(t)) return null; // 日付のある言い方は「〇日以降」の7日の線が正
  if (/出張(?:中|で)/.test(t)) return "business_trip";
  if (/予定(?:が)?(?:詰ま|埋ま|立た)|しばらく|当分/.test(t)) return "busy";
  return null;
}

/**
 * 出張中・遠方の時にオンライン内見を伝える言い回し（竹内さんの実際の LINE＝messages.staff_writer='takeuchi'・全期間）。
 *   2026-10-08 竹内さん「出張中ならオンライン内見も対応可能と伝える。これは実際の LINE にある言い回し」:
 *   竹内さんがお客様にオンライン内見を案内した手打ち 5通（8/30〜9/22）は全部「オンライン内見」（「内覧」は日程の確定の通だけ）・3通が室内の撮影と並べる
 *   （「オンライン内見や、室内の撮影もご対応させて頂きます😊！！」広島在住 8/30／「オンライン内見や、室内撮影も行わせていただきます！！」9/1／
 *    「一度弊社撮影またはオンライン内見をさせて頂き…抑えた状態で…ご内覧」9月13日以降 8/30）。最多の形＝下の1文
 */
export const ONLINE_VIEWING_LINE = "オンライン内見や、室内の撮影もご対応させて頂きます😊！！";
/** オンライン内見を伝える事情か（出張中＝日付なしのすぐ来られない／遠方）。戻す CIRCUMSTANCE_ONLINE_VIEWING=off */
export function onlineViewingReason(valid: ReadonlyArray<Circumstance>, env: Record<string, string | undefined> = process.env): "business_trip" | "remote" | null {
  if ((env.CIRCUMSTANCE_ONLINE_VIEWING ?? "").trim().toLowerCase() === "off") return null;
  if (valid.some((c) => c.kind === "cannot_come_soon" && undatedHoldKind(c.quote) === "business_trip")) return "business_trip";
  if (valid.some((c) => c.kind === "remote")) return "remote";
  return null;
}
/** 内覧にすぐ来られない事情（appeal-timing の viewingDelayed に足す）＝ holdFirstReason がある時だけ */
export function circumstanceDelaysViewing(valid: ReadonlyArray<Circumstance>, nowMs: number): boolean {
  if ((process.env.APPEAL_CIRCUMSTANCES ?? "").toLowerCase() === "off") return false;
  return holdFirstReason(valid, nowMs) !== null;
}

const KIND_JA: Record<CircumstanceKind, string> = {
  available_from: "内覧に来られる日", cannot_come_soon: "しばらく来られない", remote: "遠方", life_timing: "引越しの時期の事情", companion: "同行・一緒に決める人", health: "体調",
};
/** その種類の事情を、今の場面で渡すか（feedback_scene_first: 要る場面だけ） */
const SCENES_FOR: Record<CircumstanceKind, RegExp> = {
  available_from: /viewing|apply|considering|ack|other|property_share|cost/,
  cannot_come_soon: /viewing|apply|considering|ack|other|property_share/,
  remote: /viewing|apply|considering|ack|other|property_share|question/,
  life_timing: /conditions|apply|viewing|considering|other/,
  companion: /viewing|apply|considering/,
  health: /apply|viewing|considering|ack|other/,
};

/** ブレインに渡す短い注記（無ければ空文字）。scene は reply-scene の場面（null なら全部） */
export function buildCircumstancesNote(valid: ReadonlyArray<Circumstance>, o: { nowMs: number; scene?: string | null }): string {
  if ((process.env.CUSTOMER_CIRCUMSTANCES ?? "").toLowerCase() === "off") return "";
  const use = valid.filter((c) => c.thisTurn || !o.scene || SCENES_FOR[c.kind].test(o.scene));
  if (!use.length) return "";
  const md = (ms: number) => { const p = jstYMD(ms); return `${p.m}/${p.d}（${WD[p.dow]}）`; };
  const lines = use.map((c) => {
    const said = Date.parse(c.saidAt);
    const when = c.thisTurn ? "今回の発言" : `${md(said)} の発言`;
    if (c.kind === "available_from" && c.fromDayMs != null) {
      const days = Math.round((c.fromDayMs - dayStart(o.nowMs)) / DAY);
      return `- ${KIND_JA[c.kind]}: ${md(c.fromDayMs)} 以降（今日から${days}日後）＝${when}「${c.quote}」`;
    }
    return `- ${KIND_JA[c.kind]}: ${when}「${c.quote}」`;
  });
  // 2026-10-08 竹内さん: 内覧の候補日は AIX【内覧調整】で「来られる日」以降から出す（返信の本文に日時を書かない）／
  //   「〇日以降」が7日以上先・遠方の時だけ、内覧の日時より先にお部屋を抑える提案（7日未満・遠方でない時は入れない）
  const hold = use.some((c) => c.kind === "available_from" || c.kind === "remote" || c.kind === "cannot_come_soon") ? holdFirstReason(use, o.nowMs) : null;
  const online = onlineViewingReason(use);
  const guide: string[] = [];
  if (use.some((c) => c.kind === "available_from")) guide.push("内覧の候補日は AIX【内覧調整】で来られる日以降から出す（返信の本文に日時を書かない・来られる日より前の日時で内覧を組まない）");
  // 2026-10-08 竹内さん②「予定が詰まっている時の室内撮影: 基本は撮影して送る→気に入ってから抑える。かなり刺さっているなら抑える提案をしてから撮影して送る」:
  //   予定が詰まって（日付なし）は刺さり具合（appeal-timing の【訴求のタイミング】・property-appeal-fit）で分ける。戻す CIRCUMSTANCE_BUSY_BY_APPEAL=off（いつも抑える提案）
  const busyOnly = hold != null && /予定が詰まって/.test(hold) && (process.env.CIRCUMSTANCE_BUSY_BY_APPEAL ?? "").toLowerCase() !== "off";
  if (busyOnly) guide.push(`${hold}: かなり刺さっている物件なら内覧の日時より先に「お申込みでお部屋を抑えた状態でご内覧頂く」提案をしてから室内を撮影してお送りする／そうでなければ一度室内を撮影してお送りし（撮影して送るのは AIX）、お気に召されてから抑える（どちらかは【訴求のタイミング】の刺さり具合で決める）`);
  else if (hold) guide.push(`${hold}のため、内覧の日時より先に「お申込みでお部屋を抑えた状態でご内覧頂く」提案を入れる`);
  // 2026-10-08 竹内さん「出張中ならオンライン内見も対応可能と伝える」（竹内さんの実送信の形・ONLINE_VIEWING_LINE）
  if (online) guide.push(`${online === "business_trip" ? "出張中" : "遠方"}なのでオンライン内見も対応可能と伝える（竹内さんの実送信の形「${ONLINE_VIEWING_LINE}」）`);
  else if (use.some((c) => c.kind === "available_from")) guide.push("来られる日まで7日未満なので、お部屋を抑える提案は入れない");
  return `【お客様の事情（会話から決定論で読んだ・言った日つき）】\n${lines.join("\n")}\n`
    + `→ 次の一手・返信の方向はこの事情に合わせる${guide.length ? `（${guide.join("／")}）` : ""}。事情を推測で広げない・言い換えて断言しない。`;
}
