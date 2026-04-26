import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

import { EXTRACTION_SYSTEM_PROMPT } from "@/lib/prompt";
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
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    }
  | { type: "text"; text: string };

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it in Vercel Project Settings → Environment Variables.",
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

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function safeInt(v: unknown): number | null {
  const n = safeNum(v);
  return n === null ? null : Math.round(n);
}

function normalizeExtracted(raw: Partial<Extracted>): Extracted {
  return {
    finished_sq_ft: safeNum(raw.finished_sq_ft),
    ceiling_height_ft: safeNum(raw.ceiling_height_ft),
    door_count: safeInt(raw.door_count),
    window_count: safeInt(raw.window_count),
    confidence:
      raw.confidence === "high" ||
      raw.confidence === "medium" ||
      raw.confidence === "low"
        ? raw.confidence
        : "low",
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
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

    const blocks: ContentBlock[] = [];
    for (const f of files) {
      if (!(f instanceof File)) continue;
      const buf = Buffer.from(await f.arrayBuffer());
      const data = buf.toString("base64");
      const type = f.type;

      if (type === PDF_TYPE) {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data },
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: blocks as unknown as any,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    let parsed: Partial<Extracted>;
    try {
      parsed = JSON.parse(stripJsonFence(text));
    } catch {
      return NextResponse.json(
        {
          error:
            "Model returned non-JSON output. Try uploading clearer plans or fewer pages.",
          raw: text,
        },
        { status: 502 },
      );
    }

    // Return ONLY the AI's suggestions. No calculations on the server.
    // The client runs the math after the user confirms / edits inputs.
    return NextResponse.json({ extracted: normalizeExtracted(parsed) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
