// ネットワーク障害などで学習データが欠損しないよう、最重要APIコールにリトライを付与する
// 用途: fire-and-forget の学習API呼び出し（save-reply-example等）
// リトライは非同期で行い、UIをブロックしない

// fire-and-forget 用（戻り値不要の場合）
export async function retryFetch(
  url: string,
  options: RequestInit,
  maxRetries = 2,
): Promise<void> {
  await retryFetchResponse(url, options, maxRetries);
}

// レスポンスが必要な場合（example_id取得など）
export async function retryFetchResponse(
  url: string,
  options: RequestInit,
  maxRetries = 2,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      // 4xx は即時中断（再試行しても無意味）
      if (res.status >= 400 && res.status < 500) return res;
    } catch {
      // ネットワークエラーはリトライ
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return null;
}
