"use client";

import { useCallback, useRef, useState } from "react";
import {
  DEFAULT_INPUTS,
  calculateEstimate,
  isValidInputs,
} from "@/lib/calculator";
import type { Extracted, ProjectInputs } from "@/lib/types";

type AiState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "ready"; extracted: Extracted }
  | { status: "error"; message: string };

export default function Page() {
  // Source of truth for the calculator. Required fields start as null —
  // we never silently default sqFt or wallHeight, even after AI extraction.
  const [inputs, setInputs] = useState<ProjectInputs>(DEFAULT_INPUTS);

  // Optional AI side panel.
  const [files, setFiles] = useState<File[]>([]);
  const [ai, setAi] = useState<AiState>({ status: "idle" });
  // Tracks the most recently applied AI suggestion so we can briefly
  // highlight the input field and show "Applied".
  const [recentlyApplied, setRecentlyApplied] = useState<
    keyof ProjectInputs | null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const result = isValidInputs(inputs) ? calculateEstimate(inputs) : null;

  const setField = <K extends keyof ProjectInputs>(
    key: K,
    value: ProjectInputs[K],
  ) => setInputs((prev) => ({ ...prev, [key]: value }));

  // Single connection between AI suggestions and Project Inputs.
  // Always uses setInputs against the latest state. Never runs except
  // when the user clicks "Apply".
  const applySuggestion = (
    field: "sqFt" | "wallHeight",
    value: number | null,
  ) => {
    if (value === null) return;
    setInputs((prev) => ({ ...prev, [field]: value }));
    setRecentlyApplied(field);
    window.setTimeout(() => {
      setRecentlyApplied((curr) => (curr === field ? null : curr));
    }, 1800);
  };

  const onFiles = useCallback((picked: FileList | File[] | null) => {
    if (!picked) return;
    setFiles(Array.from(picked));
    setAi({ status: "idle" });
  }, []);

  const analyze = async () => {
    if (!files.length) return;
    setAi({ status: "uploading" });
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setAi({
          status: "error",
          message: json.error || `Server error (${res.status})`,
        });
        return;
      }
      const extracted = json.extracted as Extracted;
      setAi({ status: "ready", extracted });
      // No auto-fill. Project Inputs only update when the user clicks
      // "Apply" on a specific suggestion.
    } catch (e) {
      setAi({
        status: "error",
        message: e instanceof Error ? e.message : "Network error",
      });
    }
  };

  const clearAi = () => {
    setFiles([]);
    setAi({ status: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Painting Calculator
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Enter the project values below to compute paint and materials. You
          can also upload plans and let the AI suggest values to start —
          you&apos;re always in control of the final numbers.
        </p>
      </header>

      <InputCard
        inputs={inputs}
        setField={setField}
        recentlyApplied={recentlyApplied}
      />

      <ResultArea result={result} inputs={inputs} />

      <AiSuggestPanel
        files={files}
        ai={ai}
        inputRef={inputRef}
        onFiles={onFiles}
        analyze={analyze}
        clear={clearAi}
        applySuggestion={applySuggestion}
        recentlyApplied={recentlyApplied}
      />

      <footer className="mt-12 text-xs text-zinc-600">
        Walls = sq ft × multiplier (default 2.6). Two coats. 10% waste. Always
        sanity-check before ordering.
      </footer>
    </main>
  );
}

/* ---------- Input section ---------- */

function InputCard({
  inputs,
  setField,
  recentlyApplied,
}: {
  inputs: ProjectInputs;
  setField: <K extends keyof ProjectInputs>(
    key: K,
    value: ProjectInputs[K],
  ) => void;
  recentlyApplied: keyof ProjectInputs | null;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-400">
        Project inputs
      </h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          label="Finished Sq Ft"
          required
          value={inputs.sqFt}
          onChange={(v) => setField("sqFt", v)}
          placeholder="e.g. 2500"
          min={0}
          step={1}
          flash={recentlyApplied === "sqFt"}
        />

        <div>
          <NumberField
            label="Wall Height (ft)"
            required
            value={inputs.wallHeight}
            onChange={(v) => setField("wallHeight", v)}
            placeholder="required"
            min={0}
            step={0.5}
            flash={recentlyApplied === "wallHeight"}
          />
          <div className="mt-2 flex gap-2">
            {[8, 9, 10].map((h) => {
              const active = inputs.wallHeight === h;
              return (
                <button
                  key={h}
                  type="button"
                  onClick={() => setField("wallHeight", h)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                    active
                      ? "border-amber-500 bg-amber-500/15 text-amber-300"
                      : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  {h}&apos;
                </button>
              );
            })}
          </div>
        </div>

        <NumberField
          label="Wall Multiplier"
          value={inputs.wallMultiplier}
          onChange={(v) => setField("wallMultiplier", v ?? 2.6)}
          placeholder="2.6"
          min={0}
          step={0.1}
        />

        <NumberField
          label="Coats"
          value={inputs.coats}
          onChange={(v) => setField("coats", Math.max(1, Math.round(v ?? 2)))}
          placeholder="2"
          min={1}
          step={1}
        />

        <label className="col-span-1 flex select-none items-center gap-2 sm:col-span-2">
          <input
            type="checkbox"
            checked={inputs.prime}
            onChange={(e) => setField("prime", e.target.checked)}
            className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 accent-amber-500"
          />
          <span className="text-sm text-zinc-200">Prime (one coat)</span>
        </label>
      </div>
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  placeholder,
  required,
  min,
  step,
  flash,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  required?: boolean;
  min?: number;
  step?: number;
  flash?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
        {label}
        {required && <span className="ml-1 text-amber-500">*</span>}
      </span>
      <input
        type="number"
        inputMode="decimal"
        value={value === null || Number.isNaN(value) ? "" : value}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") onChange(null);
          else {
            const n = parseFloat(raw);
            onChange(Number.isFinite(n) ? n : null);
          }
        }}
        placeholder={placeholder}
        min={min}
        step={step}
        className={`w-full rounded-md border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-amber-500 ${
          flash
            ? "border-amber-500 ring-2 ring-amber-500/40"
            : "border-zinc-700"
        }`}
      />
    </label>
  );
}

/* ---------- Result section ---------- */

function ResultArea({
  result,
  inputs,
}: {
  result: ReturnType<typeof calculateEstimate>;
  inputs: ProjectInputs;
}) {
  if (!result) {
    return (
      <section className="mt-6 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-6 text-center text-sm text-zinc-400">
        Enter square footage and wall height to calculate estimate.
      </section>
    );
  }

  return (
    <section className="mt-6 space-y-4">
      <Card title="Project Summary">
        <Grid>
          <Stat label="Sq Ft" value={fmt(inputs.sqFt)} />
          <Stat
            label="Wall Height"
            value={
              inputs.wallHeight !== null ? `${inputs.wallHeight} ft` : "—"
            }
          />
          <Stat label="Multiplier" value={inputs.wallMultiplier} />
        </Grid>
      </Card>

      <Card title="Areas">
        <Grid>
          <Stat label="Wall Area" value={`${fmt(result.wallArea)} sq ft`} />
          <Stat
            label="Ceiling Area"
            value={`${fmt(result.ceilingArea)} sq ft`}
          />
        </Grid>
      </Card>

      <Card title="Paint (gallons)">
        <Grid>
          <Stat label="Walls" value={result.wallGallons} />
          <Stat label="Ceilings" value={result.ceilingGallons} />
          <Stat
            label="Primer"
            value={inputs.prime ? result.primerGallons : "off"}
          />
        </Grid>
      </Card>

      <Card title="Materials">
        <Grid>
          <Stat label="Tape" value={result.materials.tape} />
          <Stat label="Plastic" value={result.materials.plastic} />
          <Stat label="Paper" value={result.materials.paper} />
          <Stat label="Sanding pads" value={result.materials.sandingPads} />
        </Grid>
      </Card>
    </section>
  );
}

/* ---------- AI suggest panel ---------- */

function AiSuggestPanel({
  files,
  ai,
  inputRef,
  onFiles,
  analyze,
  clear,
  applySuggestion,
  recentlyApplied,
}: {
  files: File[];
  ai: AiState;
  inputRef: React.RefObject<HTMLInputElement>;
  onFiles: (f: FileList | File[] | null) => void;
  analyze: () => void;
  clear: () => void;
  applySuggestion: (
    field: "sqFt" | "wallHeight",
    value: number | null,
  ) => void;
  recentlyApplied: keyof ProjectInputs | null;
}) {
  return (
    <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
        Optional · Let AI suggest values from plans
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        Upload PDFs or images. Claude reads schedules and notes and suggests
        sq ft and wall height. You can accept, edit, or ignore the
        suggestions.
      </p>

      <div className="mt-4">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => onFiles(e.target.files)}
          className="hidden"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-800"
          >
            Choose files
          </button>
          <button
            type="button"
            onClick={analyze}
            disabled={!files.length || ai.status === "uploading"}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-black hover:bg-amber-400 disabled:opacity-40"
          >
            {ai.status === "uploading" ? "Analyzing…" : "Suggest values"}
          </button>
          {(files.length > 0 || ai.status === "ready" || ai.status === "error") && (
            <button
              type="button"
              onClick={clear}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              Clear
            </button>
          )}
        </div>
        {files.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-zinc-400">
            {files.map((f, i) => (
              <li key={i} className="flex justify-between">
                <span className="truncate">{f.name}</span>
                <span className="ml-4 shrink-0 text-zinc-600">
                  {(f.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {ai.status === "error" && (
        <div className="mt-4 rounded-md border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300">
          {ai.message}
        </div>
      )}

      {ai.status === "ready" && (
        <Suggestions
          extracted={ai.extracted}
          applySuggestion={applySuggestion}
          recentlyApplied={recentlyApplied}
        />
      )}
    </section>
  );
}

function Suggestions({
  extracted,
  applySuggestion,
  recentlyApplied,
}: {
  extracted: Extracted;
  applySuggestion: (
    field: "sqFt" | "wallHeight",
    value: number | null,
  ) => void;
  recentlyApplied: keyof ProjectInputs | null;
}) {
  const items: Array<{
    label: string;
    value: number | null;
    field?: "sqFt" | "wallHeight";
    note?: string;
  }> = [
    {
      label: "Finished sq ft",
      value: extracted.finished_sq_ft,
      field: "sqFt",
    },
    {
      label: "Wall / ceiling height (ft)",
      value: extracted.ceiling_height_ft,
      field: "wallHeight",
    },
    {
      label: "Doors",
      value: extracted.door_count,
      note: "informational",
    },
    {
      label: "Windows",
      value: extracted.window_count,
      note: "informational",
    },
  ];
  return (
    <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="uppercase tracking-wide text-zinc-500">
          AI suggestions
        </span>
        <span
          className={
            extracted.confidence === "high"
              ? "text-emerald-400"
              : extracted.confidence === "medium"
                ? "text-amber-400"
                : "text-red-400"
          }
        >
          confidence: {extracted.confidence}
        </span>
      </div>
      <ul className="divide-y divide-zinc-800 text-sm">
        {items.map((it) => (
          <li
            key={it.label}
            className="flex items-center justify-between py-2"
          >
            <span className="text-zinc-300">{it.label}</span>
            <div className="flex items-center gap-3">
              <span className="text-zinc-100">
                {it.value === null ? "—" : it.value.toLocaleString()}
              </span>
              {it.field && it.value !== null && (
                <button
                  type="button"
                  onClick={() => applySuggestion(it.field!, it.value)}
                  className={`rounded border px-2 py-0.5 text-xs transition ${
                    recentlyApplied === it.field
                      ? "border-emerald-500 text-emerald-300"
                      : "border-zinc-700 text-zinc-300 hover:border-amber-500 hover:text-amber-300"
                  }`}
                >
                  {recentlyApplied === it.field ? "Applied ✓" : "Apply"}
                </button>
              )}
              {it.note && (
                <span className="text-[10px] uppercase tracking-wide text-zinc-600">
                  {it.note}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {extracted.notes && (
        <p className="mt-3 text-xs text-zinc-400">{extracted.notes}</p>
      )}
    </div>
  );
}

/* ---------- shared bits ---------- */

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{children}</div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-md bg-zinc-950/60 p-3">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">
        {value === null || value === undefined || value === "" ? "—" : value}
      </div>
    </div>
  );
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString();
}
