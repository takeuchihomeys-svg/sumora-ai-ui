// app/lib/vague-viewing-wish.ts — お部屋も日にちも決まっていない「ふわっとした内覧の希望」の読み（純関数）
//
// 2026-11-14 作業員B（q427 の細分化・統括役）。「内覧したい→AIX【内覧調整】」（feedback_viewing_request_aix・KB c91fa3f9）の
//   土台の下の細分け: 複数のお部屋を送った後に、どのお部屋かも日にちも言わずに「後内とかもしたいです」と来た番は、
//   竹内さんは返信で「お部屋のご案内も可能です！！お気に召されましたお部屋ご教授いただけましたらお部屋のご案内可否も確認させて頂きます😊！！」と受けて部屋を聞く。

/** 内覧の希望の語（内覧・内見・見学＋したい・希望 等）。「後内」は「あと内覧」の打ち間違い（q427） */
const VIEWING_WISH_RE = /(?:内覧|内見|見学|後内|ご案内)[^。\n]{0,10}?(?:したい|しても|させて|希望|行きたい|いきたい|見たい|みたい|お願い|出来|でき|可能)/;
/** 日時の語（これがあれば日にちの指定・問い合わせ＝別の場面） */
const DATE_WORD_RE = /[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}\s*日|[月火水木金土日]曜|明日|明後日|あした|今日|本日|来週|今週|再来週|週末|土日|平日|午前|午後|夕方|朝|夜|[0-9０-９]{1,2}\s*時|いつ|何時|日程|日時|空いて/;
/** 条件付き・仮定の内覧（今の希望にしない・viewing-flow の CONDITIONAL_WISH と同じ考え） */
//   「とかもしたい」の「もし」に当てない（q427）＝「もし」は文の頭か区切りの後だけ
const CONDITIONAL_RE = /(?:^|[、。,\s！!？?])もし|場合|次第|なら(?:ば)?[^。\n]{0,6}内|かもしれ/;

export function isVagueViewingWish(turn: string): boolean {
  const t = String(turn ?? "").normalize("NFKC");
  return VIEWING_WISH_RE.test(t) && !DATE_WORD_RE.test(t) && !CONDITIONAL_RE.test(t);
}

/** こちらが送った文からお部屋の名前（「〇〇 123号室」の〇〇）を取る（重ねない） */
export function sentRoomNames(staffTexts: string[]): string[] {
  const out = new Set<string>();
  for (const s of staffTexts) {
    for (const m of String(s ?? "").normalize("NFKC").matchAll(/([^\s【】「」『』🌟・、。！!？?()（）:：\n]{2,30}?)\s*[0-9]{1,4}\s*号室/g)) {
      const name = m[1].replace(/^(?:お送り頂きました|お送りさせて頂きました|こちらの|特に)/, "").trim();
      if (name.length >= 2) out.add(name);
    }
  }
  return [...out];
}

/** 番の文にお部屋の名前（先頭3字以上）が出るか */
export function viewingRoomNamed(turn: string, names: string[]): boolean {
  const t = String(turn ?? "").normalize("NFKC").replace(/\s+/g, "");
  return names.some((n) => { const k = n.replace(/\s+/g, ""); return k.length >= 3 && t.includes(k.slice(0, Math.min(4, k.length))); });
}

/** スタッフがどのお部屋かを聞く形（竹内さんの「お気に召されましたお部屋ご教授いただけましたら」等） */
export const ASK_ROOM_RE = /(?:お気に召(?:さ|し)?れ?(?:まし)?たお部屋|どちらのお部屋|どのお部屋|ご内覧(?:ご)?希望のお部屋|気になる(?:お部屋|物件)|ご覧になりたいお部屋)[^。\n]{0,30}(?:ご教授|教えて|お知らせ|お送り|ご連絡|お申し付け)/;
