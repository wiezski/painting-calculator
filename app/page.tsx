"use client";

import { useCallback, useRef, useState } from "react";
import type { TakeoffResult } from "@/lib/types";

type Status = "idle" | "uploading" | "ready" | "error";

export default function Page() {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TakeoffResult | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = useCallback((picked: FileList | File[] | null) => {
    if (!picked) return;
    const arr = Array.from(picked);
    setFiles(arr);
    setError(null);
    setResult(null);
    setStatus("idle");
  }, []);

  const submit = async () => {
    if (!files.length) return;
    setStatus("uploading");
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Server error (${res.status})`);
        setStatus("error");
        return;
      }
      setResult(json as TakeoffResult);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setStatus("error");
    }
  };

  const reset = () => {
    setFiles([]);
    setResult(null);
    setError(null);
    setStatus("idle");
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          Painting Calculator
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Upload architectural plans (PDF or images). The estimator extracts
          square footage, ceiling height, and door / window counts, then
          computes paint and materials using residential takeoff defaults.
        </p>
      </header>

      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onPick(e.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${
          dragOver
            ? "border-amber-500 bg-amber-500/5"
            : "border-zinc-800 bg-zinc-900/40"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => onPick(e.target.files)}
          className="hidden"
        />
        <button
          onClick={() => inputRef.current?.click()}
          className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400"
        >
          Choose files
        </button>
        <p className="mt-3 text-xs text-zinc-500">
          or drop PDFs / images here
        </p>

        {files.length > 0 && (
          <ul className="mt-6 space-y-1 text-left text-sm">
            {files.map((f, i) => (
              <li key={i} className="flex justify-between text-zinc-300">
                <span className="truncate">{f.name}</span>
                <span className="ml-4 shrink-0 text-zinc-500">
                  {(f.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={submit}
            disabled={!files.length || status === "uploading"}
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800 disabled:opacity-40"
          >
            {status === "uploading" ? "Analyzing…" : "Run takeoff"}
          </button>
          {(files.length > 0 || result) && (
            <button
              onClick={reset}
              className="rounded-md border border-zinc-800 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
            >
              Clear
            </button>
          )}
        </div>
      </section>

      {error && (
        <div className="mt-6 rounded-lg border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {result && <Results result={result} showJson={showJson} setShowJson={setShowJson} />}

      <footer className="mt-16 text-xs text-zinc-600">
        V1 takeoff: walls × {result?.assumptions.wall_multiplier ?? 2.6}, two
        coats, 10% waste. No window/door subtraction. Always sanity-check
        before ordering.
      </footer>
    </main>
  );
}

function Results({
  result,
  showJson,
  setShowJson,
}: {
  result: TakeoffResult;
  showJson: boolean;
  setShowJson: (v: boolean) => void;
}) {
  const { extracted, assumptions, areas, paint, materials } = result;
  return (
    <section className="mt-8 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Estimate</h2>
        <button
          onClick={() => setShowJson(!showJson)}
          className="text-xs text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline"
        >
          {showJson ? "Hide JSON" : "Show JSON"}
        </button>
      </div>

      <Card title="Extracted from plans">
        <Grid>
          <Stat label="Finished sq ft" value={fmt(extracted.finished_sq_ft)} />
          <Stat label="Garage sq ft" value={fmt(extracted.garage_sq_ft)} />
          <Stat label="Patio sq ft" value={fmt(extracted.patio_sq_ft)} />
          <Stat
            label="Ceiling height"
            value={
              extracted.ceiling_height_ft != null
                ? `${extracted.ceiling_height_ft} ft`
                : "—"
            }
          />
          <Stat label="Doors" value={fmt(extracted.door_count)} />
          <Stat label="Windows" value={fmt(extracted.window_count)} />
        </Grid>
        <p className="mt-4 text-xs text-zinc-500">
          Confidence:{" "}
          <span
            className={
              extracted.confidence === "high"
                ? "text-emerald-400"
                : extracted.confidence === "medium"
                ? "text-amber-400"
                : "text-red-400"
            }
          >
            {extracted.confidence}
          </span>
        </p>
        {extracted.notes && (
          <p className="mt-2 text-xs text-zinc-400">{extracted.notes}</p>
        )}
      </Card>

      <Card title="Areas">
        <Grid>
          <Stat
            label="Wall area"
            value={`${fmt(areas.wall_area_sq_ft)} sq ft`}
          />
          <Stat
            label="Ceiling area"
            value={`${fmt(areas.ceiling_area_sq_ft)} sq ft`}
          />
        </Grid>
        <p className="mt-3 text-xs text-zinc-500">
          Wall multiplier {assumptions.wall_multiplier}, {assumptions.coats}{" "}
          coats, {assumptions.waste_factor} waste.
        </p>
      </Card>

      <Card title="Paint (gallons)">
        <Grid>
          <Stat label="Walls" value={paint.wall_paint_gallons} />
          <Stat label="Ceilings" value={paint.ceiling_paint_gallons} />
          <Stat label="Trim" value={paint.trim_paint_gallons} />
          <Stat label="Doors" value={paint.door_paint_gallons} />
          <Stat label="Primer" value={paint.primer_gallons} />
        </Grid>
      </Card>

      <Card title="Materials">
        <Grid>
          <Stat label="Tape rolls" value={materials.tape_rolls} />
          <Stat label="Plastic rolls" value={materials.plastic_rolls} />
          <Stat label="Paper rolls" value={materials.paper_rolls} />
          <Stat label="Caulk tubes" value={materials.caulk_tubes} />
          <Stat label="Sanding pads" value={materials.sanding_pads} />
        </Grid>
      </Card>

      {showJson && (
        <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-300">
{JSON.stringify(result, null, 2)}
        </pre>
      )}
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
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

function Stat({ label, value }: { label: string; value: string | number }) {
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
  return n.toLocaleString();
}
