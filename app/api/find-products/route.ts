import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const maxDuration = 60;

// Maps store IDs to the domains we tell Claude to search on.
const STORE_DOMAINS: Record<string, string> = {
  "home-depot": "homedepot.com",
  lowes: "lowes.com",
  "sherwin-williams": "sherwin-williams.com",
};

interface FindResult {
  store: string;
  url: string | null;
  productName: string | null;
  error?: string;
}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set in the environment.",
    );
  }
  return key;
}

function getModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
}

function stripJsonFence(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return s.trim();
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

  const description = (body as { description?: unknown }).description;
  const stores = (body as { stores?: unknown }).stores;
  const materialOptions = (body as { materialOptions?: unknown })
    .materialOptions;

  if (typeof description !== "string" || description.trim().length < 2) {
    return NextResponse.json(
      { error: "Provide a non-empty description" },
      { status: 400 },
    );
  }
  if (!Array.isArray(stores) || stores.length === 0) {
    return NextResponse.json(
      { error: "stores must be a non-empty array" },
      { status: 400 },
    );
  }

  const validStores = (stores as unknown[]).filter(
    (s): s is string => typeof s === "string" && s in STORE_DOMAINS,
  );
  if (!validStores.length) {
    return NextResponse.json(
      { error: "No valid stores supplied" },
      { status: 400 },
    );
  }

  const validMaterialOptions = Array.isArray(materialOptions)
    ? (materialOptions as unknown[]).filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      )
    : [];

  const storeList = validStores
    .map((s) => `- ${s} (${STORE_DOMAINS[s]})`)
    .join("\n");

  // When we have a list of material categories the result must map to
  // one of them, so the frontend can write prices into the right cell.
  const matchBlock = validMaterialOptions.length
    ? `\n\nIn addition to finding products, identify which of these existing material categories best matches the description. The targetMaterial field MUST be exactly one of these strings:\n${validMaterialOptions
        .map((m) => `- ${m}`)
        .join("\n")}\nIf nothing fits, set targetMaterial to null.`
    : "";

  // Web-search-enabled prompt. Claude calls the web_search tool then
  // returns a JSON object summarizing the matches.
  const prompt = `You are helping a contractor source painting supplies.

Find the most relevant product matching the description below on each retailer's website. Use the web_search tool to find current product URLs.

Description: "${description.trim()}"

Stores to search:
${storeList}

For each store:
- Use web_search to find a product page on that exact retailer's website (use a search like "site:DOMAIN ${description.trim()}").
- Pick the most relevant single product (consumer-grade, common pack size).
- Return the direct product page URL — not a search results page or category page.
- Return a short product name as displayed on the page.
- If you cannot find a clear product page on that retailer, return null for url and productName.${matchBlock}

Return ONLY this JSON shape (no commentary, no code fences):

{
  "targetMaterial": "<one of the categories above>" or null,
  "results": [
    { "store": "<store-id>", "url": "<https://...>" or null, "productName": "<name>" or null }
  ]
}

The "store" field MUST be one of the IDs in the list above (not the domain).${
    validMaterialOptions.length === 0 ? "\nIf no material list was provided, set targetMaterial to null." : ""
  }`;

  let client: Anthropic;
  try {
    client = new Anthropic({ apiKey: getApiKey() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Anthropic client error" },
      { status: 500 },
    );
  }

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: getModel(),
      max_tokens: 2048,
      // The web_search tool lets the model hit live URLs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: validStores.length * 2,
        } as any,
      ],
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `AI search failed: ${e.message}`
            : "AI search failed",
      },
      { status: 502 },
    );
  }

  // Pull the final text block from the response.
  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  let parsed: { results?: unknown };
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    return NextResponse.json(
      {
        error:
          "Model did not return JSON. Try rephrasing the description.",
        raw: text,
      },
      { status: 502 },
    );
  }

  const arr = Array.isArray(parsed.results) ? parsed.results : [];
  const results: FindResult[] = validStores.map((store) => {
    const found = arr.find(
      (r) =>
        r &&
        typeof r === "object" &&
        (r as Record<string, unknown>).store === store,
    ) as Record<string, unknown> | undefined;
    if (!found) return { store, url: null, productName: null };
    const url =
      typeof found.url === "string" && /^https?:\/\//.test(found.url)
        ? found.url
        : null;
    const productName =
      typeof found.productName === "string" ? found.productName : null;
    return { store, url, productName };
  });

  // Validate targetMaterial against the supplied list. If the model
  // returned a string outside the allowed set, drop it.
  const rawTarget = (parsed as { targetMaterial?: unknown }).targetMaterial;
  const targetMaterial =
    typeof rawTarget === "string" &&
    (validMaterialOptions.length === 0 ||
      validMaterialOptions.includes(rawTarget))
      ? rawTarget
      : null;

  return NextResponse.json({ results, targetMaterial });
}
