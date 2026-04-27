import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Fetches a product page and pulls the first $XX.XX price out of the
// HTML. Naive but effective for retail product pages where the price
// appears prominently. Caller can always override the result manually.
async function extractPriceFromUrl(url: string): Promise<
  { price: number } | { error: string; status?: number }
> {
  let res: Response;
  try {
    res = await fetch(url, {
      // Common UA so retailers serve the regular product page.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; PaintCalcPriceBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : "Network error",
      status: 502,
    };
  }
  if (!res.ok) {
    return { error: `Fetch failed (${res.status})`, status: 502 };
  }
  const html = await res.text();
  // Match the first $XX.XX or $XX in the HTML.
  const match = html.match(/\$(\d{1,5}(?:\.\d{2})?)/);
  if (!match) {
    return { error: "No price found in page", status: 422 };
  }
  const price = parseFloat(match[1]);
  if (!Number.isFinite(price) || price < 0) {
    return { error: "Invalid price parsed", status: 422 };
  }
  return { price };
}

function isValidHttpsUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length > 2048) return false;
  return /^https?:\/\//.test(s);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON" },
      { status: 400 },
    );
  }
  const url = (body as { url?: unknown }).url;
  if (!isValidHttpsUrl(url)) {
    return NextResponse.json(
      { error: "Provide a valid http(s) URL" },
      { status: 400 },
    );
  }

  const result = await extractPriceFromUrl(url);
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status ?? 502 },
    );
  }
  return NextResponse.json({ price: result.price });
}
