"use client";

import { useMemo, useRef, useState } from "react";
import {
  DEFAULT_INPUTS,
  calculateEstimate,
  isValidInputs,
} from "@/lib/calculator";
import { STORES, computeCosts, type Store } from "@/lib/pricing";
import type { Extracted, ProjectInputs } from "@/lib/types";

// Upload / analyze lifecycle. The extracted data is held separately
// in `aiSuggestions` so that the read-only suggestion state cannot be
// confused with the user-controlled input state.
type AiState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "ready" }
  | { status: "error"; message: string };

export default function Page() {
  // ── State 1 of 2 ──────────────────────────────────────────────
  // `inputs` is the ONLY state used for calculations and for the
  // values shown in the input fields. User typing is the source of
  // truth. Required fields start as null.
  const [inputs, setInputs] = useState<ProjectInputs>(DEFAULT_INPUTS);

  // ── State 2 of 2 ──────────────────────────────────────────────
  // `aiSuggestions` is read-only data returned by the analyze API.
  // It is NEVER auto-copied into `inputs`. The only path from
  // suggestions to inputs is the explicit Apply button below.
  const [aiSuggestions, setAiSuggestions] = useState<Extracted | null>(null);

  // Upload / analyze status (separate from data).
  const [files, setFiles] = useState<File[]>([]);
  const [ai, setAi] = useState<AiState>({ status: "idle" });

  // The user must explicitly confirm inputs before the calculator
  // produces a result. This is the gate that turns the page from
  // "AI suggests / user edits" mode into "show me the numbers" mode.
  const [confirmed, setConfirmed] = useState(false);
  // Selected store for the single-store cost breakdown. Stored in
  // state, but doesn't change pricing yet (V1 — no API calls).
  const [store, setStore] = useState<Store>("sherwin-williams");
  // Compare-stores mode swaps the per-line view for a 3-column
  // store-vs-store totals view inside the Costs card.
  const [compareStores, setCompareStores] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reactive result, gated on confirm + valid inputs (sqFt, wallHeight,
  // doors, windows all required). Editing any field after confirming
  // recomputes the result live.
  const result = useMemo(() => {
    if (!confirmed) return null;
    if (!isValidInputs(inputs)) return null;
    return calculateEstimate(inputs);
  }, [inputs, confirmed]);

  // Costs derived from the estimate + inputs (labor/markup) + selected
  // store. Inputs are passed because labor cost and markup live there.
  const costs = useMemo(() => {
    if (!result) return null;
    return computeCosts(result, inputs, store);
  }, [result, inputs, store]);

  // Per-store costs for the comparison view. Computed regardless of
  // the toggle so flipping into compare mode is instant.
  const allStoreCosts = useMemo(() => {
    if (!result) return null;
    return STORES.map((s) => ({
      store: s,
      costs: computeCosts(result, inputs, s.id),
    }));
  }, [result, inputs]);

  const setField = <K extends keyof ProjectInputs>(
    key: K,
    value: ProjectInputs[K],
  ) => setInputs((prev) => ({ ...prev, [key]: value }));

  // runAnalyze takes the files explicitly so the auto-trigger path
  // doesn't have to wait for setFiles to flush.
  const runAnalyze = async (filesToAnalyze: File[]) => {
    if (!filesToAnalyze.length) return;
    setAi({ status: "uploading" });
    try {
      const fd = new FormData();
      for (const f of filesToAnalyze) fd.append("files", f);
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
      setAiSuggestions(extracted);
      setAi({ status: "ready" });
      // Auto-fill the editable inputs with whatever AI returned.
      // If a field came back null, keep whatever the user already
      // had. The user can edit any field afterward.
      setInputs((prev) => ({
        ...prev,
        sqFt: extracted.finished_sq_ft ?? prev.sqFt,
        wallHeight: extracted.ceiling_height_ft ?? prev.wallHeight,
        doors: extracted.door_count ?? prev.doors,
        windows: extracted.window_count ?? prev.windows,
      }));
      // Note: confirmed is NOT reset here. Once the user has confirmed,
      // calculations stay live and update on every input change —
      // including changes from a fresh AI run.
    } catch (e) {
      setAi({
        status: "error",
        message: e instanceof Error ? e.message : "Network error",
      });
    }
  };

  // Manual re-run of the same files (button in the panel).
  const analyze = () => runAnalyze(files);

  // Single entry point for drag-and-drop AND the hidden file input.
  // Auto-triggers AI analysis on selection.
  const onFiles = (picked: FileList | File[] | null) => {
    if (!picked) return;
    const arr = Array.from(picked);
    if (!arr.length) return;
    setFiles(arr);
    setAi({ status: "idle" });
    setAiSuggestions(null);
    runAnalyze(arr);
  };

  const clearAi = () => {
    setFiles([]);
    setAi({ status: "idle" });
    setAiSuggestions(null);
    if (inputRef.current) inputRef.current.value = "";
  };
  // Note: editing an input does NOT auto-reset `confirmed`. The user
  // has already chosen to see numbers; tweaking values just updates
  // the result via useMemo. `confirmed` only resets when AI auto-fills.

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

      {/* Step 1 — AI assist (top, optional) */}
      <AiSuggestPanel
        files={files}
        ai={ai}
        aiSuggestions={aiSuggestions}
        inputRef={inputRef}
        onFiles={onFiles}
        analyze={analyze}
        clear={clearAi}
      />

      {/* Step 2 — Project inputs (auto-filled by AI or typed manually) */}
      <div className="mt-6">
        <InputCard inputs={inputs} setField={setField} />
      </div>

      {/* Step 3 — Confirm + result */}
      <ResultArea
        result={result}
        inputs={inputs}
        costs={costs}
        allStoreCosts={allStoreCosts}
        store={store}
        onStoreChange={setStore}
        compareStores={compareStores}
        onToggleCompare={() => setCompareStores((v) => !v)}
        confirmed={confirmed}
        canConfirm={isValidInputs(inputs)}
        onConfirm={() => setConfirmed(true)}
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
}: {
  inputs: ProjectInputs;
  setField: <K extends keyof ProjectInputs>(
    key: K,
    value: ProjectInputs[K],
  ) => void;
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
          // Falls back to 2.6 if cleared so the field always holds a
          // number (matches ProjectInputs.wallMultiplier: number).
          value={inputs.wallMultiplier}
          onChange={(v) => setField("wallMultiplier", v ?? 2.6)}
          placeholder="2.6"
          min={0}
          step={0.1}
        />

        <NumberField
          label="Coats"
          // Coats is always a positive integer.
          value={inputs.coats}
          onChange={(v) => setField("coats", Math.max(1, Math.round(v ?? 2)))}
          placeholder="2"
          min={1}
          step={1}
        />

        <NumberField
          label="Doors"
          required
          // Required input. Null when blank, integer ≥ 0 otherwise.
          value={inputs.doors}
          onChange={(v) =>
            setField("doors", v === null ? null : Math.max(0, Math.round(v)))
          }
          placeholder="required"
          min={0}
          step={1}
        />

        <NumberField
          label="Windows"
          required
          // Required input. Null when blank, integer ≥ 0 otherwise.
          value={inputs.windows}
          onChange={(v) =>
            setField("windows", v === null ? null : Math.max(0, Math.round(v)))
          }
          placeholder="required"
          min={0}
          step={1}
        />

        <NumberField
          label="Hourly Rate ($)"
          // Default 35. Drives labor cost.
          value={inputs.hourlyRate}
          onChange={(v) => setField("hourlyRate", Math.max(0, v ?? 35))}
          placeholder="35"
          min={0}
          step={1}
        />

        <NumberField
          label="Number of Painters"
          // Default 1. Multiplies labor cost.
          value={inputs.numberOfPainters}
          onChange={(v) =>
            setField("numberOfPainters", Math.max(1, Math.round(v ?? 1)))
          }
          placeholder="1"
          min={1}
          step={1}
        />

        <NumberField
          label="Markup %"
          // Default 30. Applied to materials + labor subtotal.
          value={inputs.markup}
          onChange={(v) => setField("markup", Math.max(0, v ?? 30))}
          placeholder="30"
          min={0}
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
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  required?: boolean;
  min?: number;
  step?: number;
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
        // Reads ONLY from the inputs state passed in via `value`.
        // Never reads from aiSuggestions.
        value={value ?? ""}
        // Converts the raw input value to a Number on every keystroke
        // and bubbles it up. Empty string → null so required-field
        // validation works. NaN guard handles any edge case where the
        // browser gives us non-numeric content.
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : null);
        }}
        placeholder={placeholder}
        min={min}
        step={step}
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-amber-500"
      />
    </label>
  );
}

/* ---------- Result section ---------- */

function ResultArea({
  result,
  inputs,
  costs,
  allStoreCosts,
  store,
  onStoreChange,
  compareStores,
  onToggleCompare,
  confirmed,
  canConfirm,
  onConfirm,
}: {
  result: ReturnType<typeof calculateEstimate>;
  inputs: ProjectInputs;
  costs: ReturnType<typeof computeCosts> | null;
  allStoreCosts:
    | Array<{
        store: { id: Store; label: string };
        costs: ReturnType<typeof computeCosts>;
      }>
    | null;
  store: Store;
  onStoreChange: (s: Store) => void;
  compareStores: boolean;
  onToggleCompare: () => void;
  confirmed: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
}) {
  // Step 3a — not confirmed yet: show the gate.
  if (!confirmed) {
    return (
      <section className="mt-6 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-6 text-center">
        <p className="text-sm text-zinc-400">
          Review and confirm inputs to calculate estimate.
        </p>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm}
          className={`mt-4 rounded-md px-4 py-2 text-sm font-medium transition ${
            canConfirm
              ? "bg-amber-500 text-black hover:bg-amber-400"
              : "cursor-not-allowed bg-zinc-800 text-zinc-500"
          }`}
        >
          Confirm inputs
        </button>
        {!canConfirm && (
          <p className="mt-3 text-xs text-zinc-500">
            Square footage and wall height are required.
          </p>
        )}
      </section>
    );
  }

  // Step 3b — confirmed but inputs went invalid (user cleared a field).
  if (!result) {
    return (
      <section className="mt-6 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-6 text-center text-sm text-zinc-400">
        Enter square footage and wall height to calculate estimate.
      </section>
    );
  }

  return (
    <section className="mt-6 space-y-4">
      {/* No "Edit inputs" gate — once confirmed, results stay live and
          recalculate on every input change. */}
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
          <Stat label="Trim Area" value={`${fmt(result.trimArea)} sq ft`} />
        </Grid>
      </Card>

      <Card title="Paint (gallons)">
        <Grid>
          <Stat label="Walls" value={result.wallGallons} />
          <Stat label="Ceilings" value={result.ceilingGallons} />
          <Stat label="Trim" value={result.trimGallons} />
          <Stat label="Doors" value={result.doorGallons} />
          <Stat
            label="Primer"
            value={inputs.prime ? result.primerGallons : "off"}
          />
        </Grid>
      </Card>

      <Card title="Materials">
        <Grid>
          {result.materials.map((m) => (
            <Stat key={m.name} label={m.name} value={m.qty} />
          ))}
        </Grid>
      </Card>

      {costs && (
        <Card title="Costs">
          {/* Top bar: store selector + compare toggle */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-wide text-zinc-500">
                Store
              </span>
              <select
                value={store}
                onChange={(e) => onStoreChange(e.target.value as Store)}
                disabled={compareStores}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none disabled:opacity-40"
              >
                {STORES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={onToggleCompare}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                compareStores
                  ? "border-amber-500 bg-amber-500/10 text-amber-300"
                  : "border-zinc-700 text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              {compareStores ? "Hide comparison" : "Compare stores"}
            </button>
          </div>

          {compareStores && allStoreCosts ? (
            <StoreComparison allStoreCosts={allStoreCosts} />
          ) : (
            <div className="space-y-5">
              <CostSubsection title="Paint costs">
                <Grid>
                  <Stat
                    label="Walls"
                    value={fmtMoney(costs.paintCosts.walls)}
                  />
                  <Stat
                    label="Ceilings"
                    value={fmtMoney(costs.paintCosts.ceilings)}
                  />
                  <Stat
                    label="Trim"
                    value={fmtMoney(costs.paintCosts.trim)}
                  />
                  <Stat
                    label="Primer"
                    value={fmtMoney(costs.paintCosts.primer)}
                  />
                </Grid>
              </CostSubsection>

              <CostSubsection title="Material costs">
                <Grid>
                  {costs.materialCosts.map((m) => (
                    <Stat
                      key={m.name}
                      label={m.name}
                      value={fmtMoney(m.cost)}
                    />
                  ))}
                </Grid>
              </CostSubsection>

              <CostSubsection title="Totals">
                <Grid>
                  <Stat
                    label="Paint Total"
                    value={fmtMoney(costs.totals.paint)}
                  />
                  <Stat
                    label="Materials Total"
                    value={fmtMoney(costs.totals.materials)}
                  />
                  <Stat
                    label="Grand Total"
                    value={fmtMoney(costs.totals.grand)}
                  />
                </Grid>
              </CostSubsection>
            </div>
          )}
        </Card>
      )}

      {costs && !compareStores && (
        <Card title="Job Pricing">
          <div className="space-y-5">
            <CostSubsection title="Materials">
              <Grid>
                <Stat
                  label="Materials Cost"
                  value={fmtMoney(costs.jobPricing.materials)}
                />
              </Grid>
            </CostSubsection>

            <CostSubsection title="Labor">
              <Grid>
                <Stat
                  label="Hours"
                  value={costs.labor.hours.toFixed(1)}
                />
                <Stat
                  label="Cost / Painter"
                  value={fmtMoney(costs.labor.costPerPainter)}
                />
                <Stat
                  label="Total Labor"
                  value={fmtMoney(costs.labor.totalCost)}
                />
              </Grid>
            </CostSubsection>

            <CostSubsection title="Totals">
              <Grid>
                <Stat
                  label="Subtotal"
                  value={fmtMoney(costs.jobPricing.subtotal)}
                />
                <Stat
                  label="Markup Amount"
                  value={fmtMoney(costs.jobPricing.markupAmount)}
                />
                <Stat
                  label="Final Price"
                  value={fmtMoney(costs.jobPricing.finalPrice)}
                />
              </Grid>
            </CostSubsection>
          </div>
        </Card>
      )}
    </section>
  );
}

function CostSubsection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {title}
      </h4>
      {children}
    </div>
  );
}

// 3-column comparison of paint / materials / grand totals across
// stores. Highlights the lowest grand total when there's a real
// spread; if pricing is currently uniform across stores, shows a
// neutral note instead.
function StoreComparison({
  allStoreCosts,
}: {
  allStoreCosts: Array<{
    store: { id: Store; label: string };
    costs: ReturnType<typeof computeCosts>;
  }>;
}) {
  const totals = allStoreCosts.map((s) => s.costs.totals.grand);
  const minTotal = Math.min(...totals);
  const maxTotal = Math.max(...totals);
  const spread = maxTotal - minTotal;

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {allStoreCosts.map(({ store: s, costs: c }) => {
          const isBest = c.totals.grand === minTotal && spread > 0;
          return (
            <div
              key={s.id}
              className={`rounded-lg border p-4 transition ${
                isBest
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-zinc-800 bg-zinc-950/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-zinc-100">
                  {s.label}
                </h4>
                {isBest && (
                  <span className="rounded border border-emerald-700/60 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                    Lowest
                  </span>
                )}
              </div>

              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between text-zinc-400">
                  <dt>Paint</dt>
                  <dd className="font-medium text-zinc-100">
                    {fmtMoney(c.totals.paint)}
                  </dd>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <dt>Materials</dt>
                  <dd className="font-medium text-zinc-100">
                    {fmtMoney(c.totals.materials)}
                  </dd>
                </div>
                <div
                  className={`mt-2 flex justify-between border-t pt-2 ${
                    isBest ? "border-emerald-700/40" : "border-zinc-800"
                  }`}
                >
                  <dt className="font-medium text-zinc-200">Grand Total</dt>
                  <dd
                    className={`text-base font-semibold ${
                      isBest ? "text-emerald-300" : "text-zinc-100"
                    }`}
                  >
                    {fmtMoney(c.totals.grand)}
                  </dd>
                </div>
              </dl>

              {isBest && (
                <p className="mt-2 text-xs text-emerald-400">
                  Save {fmtMoney(spread)} vs highest option
                </p>
              )}
            </div>
          );
        })}
      </div>

      {spread === 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          Pricing is currently uniform across stores. When per-store
          pricing comes online, the lowest grand total will be highlighted
          here automatically.
        </p>
      )}
    </div>
  );
}

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

/* ---------- AI suggest panel ---------- */

function AiSuggestPanel({
  files,
  ai,
  aiSuggestions,
  inputRef,
  onFiles,
  analyze,
  clear,
}: {
  files: File[];
  ai: AiState;
  aiSuggestions: Extracted | null;
  inputRef: React.RefObject<HTMLInputElement>;
  onFiles: (f: FileList | File[] | null) => void;
  analyze: () => void;
  clear: () => void;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
        Step 1 · Optional — Let AI suggest values from plans
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        Upload PDFs or images. Claude reads schedules and notes and fills
        the inputs below with sq ft and wall height. You can edit any
        value before confirming.
      </p>

      <Dropzone
        files={files}
        ai={ai}
        inputRef={inputRef}
        onFiles={onFiles}
        analyze={analyze}
        clear={clear}
      />

      {ai.status === "error" && (
        <div className="mt-4 rounded-md border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300">
          {ai.message}
        </div>
      )}

      {ai.status === "ready" && aiSuggestions && (
        <Suggestions extracted={aiSuggestions} />
      )}
    </section>
  );
}

// Drag-and-drop + click-to-upload zone. Selecting files auto-triggers
// onFiles, which the parent uses to start AI analysis immediately.
function Dropzone({
  files,
  ai,
  inputRef,
  onFiles,
  analyze,
  clear,
}: {
  files: File[];
  ai: AiState;
  inputRef: React.RefObject<HTMLInputElement>;
  onFiles: (f: FileList | File[] | null) => void;
  analyze: () => void;
  clear: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      onFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiles(e.target.files);
    // Reset so picking the same file again still fires onChange.
    e.target.value = "";
  };

  const handleClick = () => inputRef.current?.click();

  return (
    <div className="mt-4">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition ${
          dragOver
            ? "border-amber-500 bg-amber-500/5"
            : "border-zinc-700 hover:border-zinc-500 hover:bg-zinc-900/40"
        }`}
      >
        <p className="text-sm text-zinc-200">
          {ai.status === "uploading"
            ? "Analyzing…"
            : "Drag & drop a plan here or click to upload"}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          PDF, PNG, JPEG, GIF, or WebP
        </p>
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

      {/* Manual re-run + clear actions, available once files are picked. */}
      {(files.length > 0 || ai.status === "ready" || ai.status === "error") && (
        <div className="mt-3 flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={analyze}
            disabled={!files.length || ai.status === "uploading"}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            {ai.status === "uploading" ? "Analyzing…" : "Re-run AI"}
          </button>
          <button
            type="button"
            onClick={clear}
            className="text-zinc-400 hover:text-zinc-200"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

// Pure read-only summary of what the AI returned. The fill happens
// inside analyze(); this component just shows what was extracted
// (and confidence + notes) for the user to verify.
function Suggestions({
  extracted,
}: {
  extracted: Extracted;
}) {
  const items: Array<{
    label: string;
    value: number | null;
    unit?: string;
    note?: string;
  }> = [
    {
      label: "Finished sq ft",
      value: extracted.finished_sq_ft,
      unit: "sq ft",
    },
    {
      label: "Wall / ceiling height",
      value: extracted.ceiling_height_ft,
      unit: "ft",
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
      <div className="mb-3 flex items-center justify-between text-xs">
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
            <div className="flex items-center gap-3 text-xs">
              <span className="font-medium text-zinc-100">
                {it.value === null
                  ? "—"
                  : `${it.value.toLocaleString()}${it.unit ? " " + it.unit : ""}`}
              </span>
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

      <p className="mt-3 text-xs text-zinc-500">
        These values were copied into the input fields below. Edit anything
        before you confirm.
      </p>
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
