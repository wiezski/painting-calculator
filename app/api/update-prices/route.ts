import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Same regex extraction as /api/fetch-price, but in batch.
async function fetchOne(url: string): Promise<
  { url: string; price?: number; error?: string }
> {
  if (!url || !/^https?:\/\//.test(url)) {
    return { url, error: "Invalid URL" };
  }
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; PaintCalcPriceBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return { url, error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const match = html.match(/\$(\d{1,5}(?:\.\d{2})?)/);
    if (!match) return { url, error: "No price found" };
    const price = parseFloat(match[1]);
    if (!Number.isFinite(price)) {
      return { url, error: "Invalid price parsed" };
    }
    return { url, price };
  } catch (e) {
    return {
      url,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
}

// Accepts { items: [{ url }] } and returns { results: [{ url, price?, error? }] }.
// Designed so a future cron can call this on a schedule, or the
// frontend "Refresh Prices" button can hit it once.
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
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return NextResponse.json(
      { error: "items must be an array of { url } records" },
      { status: 400 },
    );
  }

  const results = await Promise.all(
    items.map((it) => {
      const url =
        it && typeof it === "object" && "url" in it
          ? String((it as { url: unknown }).url)
          : "";
      return fetchOne(url);
    }),
  );

  return NextResponse.json({ results });
}

// Health-check / GET for cron services that ping with no body.
export async function GET() {
  return NextResponse.json({ ready: true });
}
