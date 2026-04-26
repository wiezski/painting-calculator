import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

import { EXTRACTION_SYSTEM_PROMPT } from "@/lib/prompt";
import { calculate, normalizeExtracted } from "@/lib/calculator";
import type { Extracted } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const PDF_TYPE = "application/pdf";

type ContentBlock =
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
      };
    }
  | { type: "text"; text: string };

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it in Vercel project settings or .env.local for local dev.",
    );
  }
  return key;
}

function getModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
}

function stripJsonFence(s: string): string {
  // Remove possible ```json ... ``` fences if the model adds them despite instructions.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return s.trim();
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const files = formData.getAll("files");

    if (!files.length) {
      return NextResponse.json(
        { error: "No files uploaded. Attach one or more plan PDFs or images." },
        { status: 400 },
      );
    }

    // Convert each file to a Claude content block.
    const blocks: ContentBlock[] = [];
    for (const f of files) {
      if (!(f instanceof File)) continue;
      const buf = Buffer.from(await f.arrayBuffer());
      const data = buf.toString("base64");
      const type = f.type;

      if (type === PDF_TYPE) {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data,
          },
        });
      } else if (SUPPORTED_IMAGE_TYPES.has(type)) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: type as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data,
          },
        });
      } else {
        return NextResponse.json(
          {
            error: `Unsupported file type: ${type || "unknown"} (${f.name}). Use PDF, PNG, JPEG, GIF, or WebP.`,
          },
          { status: 400 },
        );
      }
    }

    if (!blocks.length) {
      return NextResponse.json(
        { error: "No usable files in upload." },
        { status: 400 },
      );
    }

    blocks.push({
      type: "text",
      text: "Extract the values from these plans and return ONLY the JSON object as specified.",
    });

    const client = new Anthropic({ apiKey: getApiKey() });

    const response = await client.messages.create({
      model: getModel(),
      max_tokens: 1024,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          // The block shapes above match the SDK's content-block param union;
          // we cast through unknown because each block variant is typed
          // separately by the SDK.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: blocks as unknown as any,
        },
      ],
    });

    // Concatenate any text blocks the model returned.
    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    let parsed: Partial<Extracted>;
    try {
      parsed = JSON.parse(stripJsonFence(text));
    } catch (e) {
      return NextResponse.json(
        {
          error:
            "Model returned non-JSON output. Try uploading clearer plans or fewer pages.",
          raw: text,
        },
        { status: 502 },
      );
    }

    const extracted = normalizeExtracted(parsed);
    const result = calculate(extracted);

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    const status = message.includes("ANTHROPIC_API_KEY") ? 500 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
