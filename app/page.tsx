"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_INPUTS,
  calculateEstimate,
  isValidInputs,
} from "@/lib/calculator";
import {
  DEFAULT_STORE_PRICING,
  STORES,
  computeCosts,
  getLocationInfo,
  migrateStorePricingMap,
  type PriceEntry,
  type Store,
  type StorePricing,
  type StorePricingMap,
} from "@/lib/pricing";
import type { Extracted, ProjectInputs } from "@/lib/types";

// Upload / analyze lifecycle. The extracted data is held separately
// in `aiSuggestions` so that the read-only suggestion state cannot be
// confused with the user-controlled input state.
type AiState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "ready" }
  | { status: "error"; message: string };

// Customer / project context for a saved estimate. Kept separate
// from ProjectInputs because none of these fields affect the math —
// they're metadata for record-keeping.
interface ProjectMeta {
  customerName: string;
  projectName: string;
  address: string;
  city: string;
  phone: string;
}

const DEFAULT_META: ProjectMeta = {
  customerName: "",
  projectName: "",
  address: "",
  city: "",
  phone: "",
};

// Real-world job tracking — what the contractor actually spent.
interface ActualValues {
  materialCost: number | null;
  laborCost: number | null;
  hours: number | null;
}

const DEFAULT_ACTUALS: ActualValues = {
  materialCost: null,
  laborCost: null,
  hours: null,
};

// Persisted projects in localStorage.
interface SavedProject {
  id: string;
  meta: ProjectMeta;
  inputs: ProjectInputs;
  pricing: StorePricingMap;
  finalPrice: number | null;
  actuals: ActualValues;
  timestamp: number;
}

const PROJECTS_STORAGE_KEY = "painting-calculator-projects-v1";

function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Migrates older saved projects into the latest shape. Idempotent.
function migrateSavedProject(raw: unknown): SavedProject | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;

  // Build a normalized record regardless of which version it came in as.
  const meta: ProjectMeta =
    r.meta && typeof r.meta === "object"
      ? (r.meta as ProjectMeta)
      : {
          customerName: "",
          projectName: typeof r.name === "string" ? r.name : "",
          address: "",
          city: "",
          phone: "",
        };

  const actuals: ActualValues =
    r.actuals && typeof r.actuals === "object"
      ? { ...DEFAULT_ACTUALS, ...(r.actuals as Partial<ActualValues>) }
      : DEFAULT_ACTUALS;

  return {
    id: r.id,
    meta,
    inputs: r.inputs as ProjectInputs,
    // Pricing was previously raw numbers; coerce to PriceEntry shape.
    pricing: migrateStorePricingMap(r.pricing),
    finalPrice: (r.finalPrice as number | null) ?? null,
    actuals,
    timestamp: typeof r.timestamp === "number" ? r.timestamp : Date.now(),
  };
}

// Display name for a saved project: uses projectName if set, otherwise
// falls back to "Customer – sqFt sq ft", or a generic stamp if the
// customer is also blank.
function displayName(meta: ProjectMeta, inputs: ProjectInputs): string {
  const name = meta.projectName.trim();
  if (name) return name;
  const customer = meta.customerName.trim();
  if (customer) {
    return `${customer} – ${inputs.sqFt?.toLocaleString() ?? "?"} sq ft`;
  }
  return "Untitled estimate";
}

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
  // Editable pricing per store. Seeded from defaults; user can
  // override any cell — including pasting a product URL and pulling
  // a real price from /api/fetch-price.
  const [pricing, setPricing] = useState<StorePricingMap>(
    () => structuredClone(DEFAULT_STORE_PRICING),
  );
  const [showPricingSettings, setShowPricingSettings] = useState(false);
  const [pricingTab, setPricingTab] = useState<Store>("sherwin-williams");
  // Fetch state per "store/category/key" so each row can show its
  // own loading / error state without blocking siblings.
  const [fetchState, setFetchState] = useState<
    Record<string, { loading?: boolean; error?: string }>
  >({});
  // UX: Quick / Detailed mode toggle. Quick hides extra detail
  // sections to keep the screen lean for fast bidding.
  const [mode, setMode] = useState<"quick" | "detailed">("quick");
  // Collapsible sections — default collapsed in detailed mode.
  const [showMaterials, setShowMaterials] = useState(false);
  const [showLabor, setShowLabor] = useState(false);
  const [showCosts, setShowCosts] = useState(false);
  // Saved projects, persisted to localStorage.
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  // Project / customer metadata. Populated when a saved project is
  // loaded or by typing in the Project Info card. Used in copy / PDF.
  const [projectMeta, setProjectMeta] = useState<ProjectMeta>(DEFAULT_META);
  // Saved-projects search filter — matches displayName or city.
  const [search, setSearch] = useState("");
  // Tracks the project currently loaded for editing — used to scope
  // the Job Performance card's actuals editor.
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const setMetaField = <K extends keyof ProjectMeta>(
    key: K,
    value: ProjectMeta[K],
  ) => setProjectMeta((prev) => ({ ...prev, [key]: value }));

  // Load saved projects on mount. SSR-safe: runs only in the browser.
  // Each row is run through migrateSavedProject so older shapes (with
  // a top-level `name` field) keep working after this update.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const migrated = parsed
        .map(migrateSavedProject)
        .filter((p): p is SavedProject => p !== null);
      setSavedProjects(migrated);
    } catch {
      /* ignore */
    }
  }, []);

  const persistProjects = (next: SavedProject[]) => {
    setSavedProjects(next);
    try {
      window.localStorage.setItem(
        PROJECTS_STORAGE_KEY,
        JSON.stringify(next),
      );
    } catch {
      /* quota / private mode — silently ignore */
    }
  };

  // Reactive result, gated on confirm + valid inputs (sqFt, wallHeight,
  // doors, windows all required). Editing any field after confirming
  // recomputes the result live.
  const result = useMemo(() => {
    if (!confirmed) return null;
    if (!isValidInputs(inputs)) return null;
    return calculateEstimate(inputs);
  }, [inputs, confirmed]);

  // Region-based cost adjuster derived from the ZIP code.
  const locationInfo = useMemo(
    () => getLocationInfo(inputs.zipCode),
    [inputs.zipCode],
  );

  // Costs derived from the estimate + inputs + selected store +
  // editable pricing + ZIP-based location multiplier.
  const costs = useMemo(() => {
    if (!result) return null;
    return computeCosts(result, inputs, store, pricing, locationInfo.multiplier);
  }, [result, inputs, store, pricing, locationInfo.multiplier]);

  // Per-store costs for the comparison view. Computed regardless of
  // the toggle so flipping into compare mode is instant.
  const allStoreCosts = useMemo(() => {
    if (!result) return null;
    return STORES.map((s) => ({
      store: s,
      costs: computeCosts(result, inputs, s.id, pricing, locationInfo.multiplier),
    }));
  }, [result, inputs, pricing, locationInfo.multiplier]);

  // Currently loaded project (for the Job Performance card).
  const currentProject = useMemo(
    () =>
      currentProjectId
        ? savedProjects.find((p) => p.id === currentProjectId) ?? null
        : null,
    [currentProjectId, savedProjects],
  );

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

  // ── Saved-project actions ────────────────────────────────────
  // No prompt — user has already typed metadata in the Project Info
  // card. Auto-name kicks in on display when projectName is blank.
  const saveProject = () => {
    if (!costs) return;
    const project: SavedProject = {
      id: newProjectId(),
      meta: projectMeta,
      inputs,
      pricing,
      finalPrice: costs.jobPricing.finalPrice,
      actuals: DEFAULT_ACTUALS,
      timestamp: Date.now(),
    };
    persistProjects([project, ...savedProjects]);
    setCurrentProjectId(project.id);
  };

  const loadProject = (p: SavedProject) => {
    // Restore inputs, pricing, and metadata. Confirmed=true so the
    // result card renders immediately.
    setInputs(p.inputs);
    setPricing(p.pricing);
    setProjectMeta(p.meta);
    setConfirmed(true);
    setCurrentProjectId(p.id);
  };

  const duplicateProject = (p: SavedProject) => {
    const copy: SavedProject = {
      ...p,
      id: newProjectId(),
      meta: {
        ...p.meta,
        projectName: p.meta.projectName
          ? `${p.meta.projectName} (copy)`
          : "",
      },
      // Fresh copy starts with empty actuals — those are job-specific.
      actuals: DEFAULT_ACTUALS,
      timestamp: Date.now(),
    };
    persistProjects([copy, ...savedProjects]);
  };

  const deleteProject = (id: string) => {
    if (!window.confirm("Delete this project?")) return;
    if (id === currentProjectId) setCurrentProjectId(null);
    persistProjects(savedProjects.filter((p) => p.id !== id));
  };

  // Updates a single actuals field on the currently-loaded project
  // and writes the change back to localStorage immediately.
  const updateActuals = (
    field: keyof ActualValues,
    value: number | null,
  ) => {
    if (!currentProjectId) return;
    const next = savedProjects.map((p) =>
      p.id === currentProjectId
        ? {
            ...p,
            actuals: {
              ...DEFAULT_ACTUALS,
              ...p.actuals,
              [field]: value,
            },
          }
        : p,
    );
    persistProjects(next);
  };

  // ── Pricing entry mutators ─────────────────────────────────────
  // Section: "paint" or "materials". Key: paint key (walls/ceilings/…)
  // or material name. Patches a single PriceEntry inside the pricing
  // table without touching siblings.
  const updatePriceEntry = (
    storeId: Store,
    section: "paint" | "materials",
    key: string,
    patch: Partial<PriceEntry>,
  ) => {
    setPricing((prev) => {
      const store = prev[storeId];
      if (section === "paint") {
        const paint = store.paint;
        const current = paint[key as keyof StorePricing["paint"]];
        return {
          ...prev,
          [storeId]: {
            ...store,
            paint: {
              ...paint,
              [key]: { ...current, ...patch },
            },
          },
        };
      }
      const current =
        store.materials[key] ?? { price: 0, url: "", lastUpdated: null };
      return {
        ...prev,
        [storeId]: {
          ...store,
          materials: {
            ...store.materials,
            [key]: { ...current, ...patch },
          },
        },
      };
    });
  };

  // Pull a price from /api/fetch-price and patch the entry. Per-row
  // loading + error tracked so the UI can show feedback inline.
  const fetchPriceFor = async (
    storeId: Store,
    section: "paint" | "materials",
    key: string,
    url: string,
  ) => {
    const stateKey = `${storeId}|${section}|${key}`;
    if (!url || !/^https?:\/\//.test(url)) {
      setFetchState((s) => ({
        ...s,
        [stateKey]: { error: "Add a product URL first" },
      }));
      return;
    }
    setFetchState((s) => ({ ...s, [stateKey]: { loading: true } }));
    try {
      const res = await fetch("/api/fetch-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = await res.json();
      if (!res.ok || typeof json.price !== "number") {
        setFetchState((s) => ({
          ...s,
          [stateKey]: {
            error: json.error || `Could not update price (${res.status})`,
          },
        }));
        return;
      }
      updatePriceEntry(storeId, section, key, {
        price: json.price,
        lastUpdated: Date.now(),
      });
      setFetchState((s) => ({ ...s, [stateKey]: {} }));
    } catch (e) {
      setFetchState((s) => ({
        ...s,
        [stateKey]: {
          error: e instanceof Error ? e.message : "Could not update price",
        },
      }));
    }
  };

  // Bulk refresh: gather every entry that has a URL, send them to
  // /api/update-prices in one request, and patch the table from the
  // response. Single global state used to disable the button while
  // running.
  const [refreshing, setRefreshing] = useState(false);
  const refreshAllPrices = async () => {
    type Item = {
      storeId: Store;
      section: "paint" | "materials";
      key: string;
      url: string;
    };
    const items: Item[] = [];
    for (const storeId of Object.keys(pricing) as Store[]) {
      const store = pricing[storeId];
      (Object.keys(store.paint) as Array<keyof StorePricing["paint"]>).forEach(
        (k) => {
          const v = store.paint[k];
          if (v.url) items.push({ storeId, section: "paint", key: k, url: v.url });
        },
      );
      Object.entries(store.materials).forEach(([name, v]) => {
        if (v.url)
          items.push({ storeId, section: "materials", key: name, url: v.url });
      });
    }
    if (items.length === 0) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/update-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: items.map((i) => ({ url: i.url })) }),
      });
      const json = await res.json();
      const results: Array<{ url: string; price?: number; error?: string }> =
        Array.isArray(json.results) ? json.results : [];
      const now = Date.now();
      // Map URL → result. URL is unique enough for V1; if the same URL
      // is reused across stores, the first match wins.
      const byUrl = new Map(results.map((r) => [r.url, r]));
      items.forEach((it) => {
        const r = byUrl.get(it.url);
        if (r && typeof r.price === "number") {
          updatePriceEntry(it.storeId, it.section, it.key, {
            price: r.price,
            lastUpdated: now,
          });
        }
        const stateKey = `${it.storeId}|${it.section}|${it.key}`;
        setFetchState((s) => ({
          ...s,
          [stateKey]:
            r && typeof r.price === "number"
              ? {}
              : { error: r?.error || "Could not update price" },
        }));
      });
    } catch {
      /* network failure — leave existing prices intact */
    } finally {
      setRefreshing(false);
    }
  };

  // ── Export actions ───────────────────────────────────────────
  const copyEstimate = async () => {
    if (!costs) return;
    const lines: string[] = [
      displayName(projectMeta, inputs),
    ];
    if (projectMeta.customerName.trim()) {
      lines.push(`Customer:       ${projectMeta.customerName}`);
    }
    const cityLine = [projectMeta.address, projectMeta.city]
      .filter((s) => s.trim())
      .join(", ");
    if (cityLine) lines.push(`Address:        ${cityLine}`);
    if (projectMeta.phone.trim()) {
      lines.push(`Phone:          ${projectMeta.phone}`);
    }
    lines.push(
      "",
      `Sq Ft:          ${inputs.sqFt?.toLocaleString() ?? "—"}`,
      `Wall Height:    ${inputs.wallHeight ?? "—"} ft`,
      "",
      `Material Cost:  ${fmtMoney(costs.jobPricing.materials)}`,
      `Labor Cost:     ${fmtMoney(costs.jobPricing.labor)}`,
      `Final Price:    ${fmtMoney(costs.jobPricing.finalPrice)}`,
    );
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API may be blocked in some contexts; fall back to
      // a temporary textarea + execCommand. Either way silently noop
      // on failure rather than crashing.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        /* ignore */
      }
    }
  };

  const downloadPdf = () => {
    if (!costs) return;
    // Browser print → save as PDF. The print stylesheet hides
    // everything except the .printable summary card.
    window.print();
  };
  // Note: editing an input does NOT auto-reset `confirmed`. The user
  // has already chosen to see numbers; tweaking values just updates
  // the result via useMemo. `confirmed` only resets when AI auto-fills.

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      {/* Sticky bar: always-visible price + Quick/Detailed toggle. */}
      <div className="sticky top-0 z-20 -mx-6 mb-6 flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950/85 px-6 py-3 backdrop-blur">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            Estimated Price
          </div>
          <div className="text-2xl font-semibold text-amber-400">
            {costs ? fmtMoney(costs.jobPricing.finalPrice) : "—"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={saveProject}
            disabled={!costs}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save Estimate
          </button>
          <div className="inline-flex rounded-md border border-zinc-700 p-0.5 text-xs">
            {(["quick", "detailed"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-[0.3rem] px-3 py-1.5 font-medium transition ${
                  mode === m
                    ? "bg-amber-500 text-black"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {m === "quick" ? "Quick Estimate" : "Detailed Mode"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {savedProjects.length > 0 && (
        <SavedProjectsCard
          projects={savedProjects}
          search={search}
          onSearchChange={setSearch}
          onLoad={loadProject}
          onDuplicate={duplicateProject}
          onDelete={deleteProject}
        />
      )}

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

      <div className="mt-6">
        <ProjectInfoCard meta={projectMeta} setMetaField={setMetaField} />
      </div>

      {/* Step 2 — Project inputs (auto-filled by AI or typed manually) */}
      <div className="mt-6">
        <InputCard inputs={inputs} setField={setField} mode={mode} />
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
        pricing={pricing}
        setPricing={setPricing}
        showPricingSettings={showPricingSettings}
        onTogglePricingSettings={() =>
          setShowPricingSettings((v) => !v)
        }
        pricingTab={pricingTab}
        onPricingTabChange={setPricingTab}
        locationInfo={locationInfo}
        confirmed={confirmed}
        canConfirm={isValidInputs(inputs)}
        onConfirm={() => setConfirmed(true)}
        mode={mode}
        showMaterials={showMaterials}
        onToggleMaterials={() => setShowMaterials((v) => !v)}
        showLabor={showLabor}
        onToggleLabor={() => setShowLabor((v) => !v)}
        showCosts={showCosts}
        onToggleCosts={() => setShowCosts((v) => !v)}
        projectMeta={projectMeta}
        onCopyEstimate={copyEstimate}
        onDownloadPdf={downloadPdf}
        currentProject={currentProject}
        onUpdateActuals={updateActuals}
        updatePriceEntry={updatePriceEntry}
        fetchPriceFor={fetchPriceFor}
        fetchState={fetchState}
        refreshAllPrices={refreshAllPrices}
        refreshing={refreshing}
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
  mode,
}: {
  inputs: ProjectInputs;
  setField: <K extends keyof ProjectInputs>(
    key: K,
    value: ProjectInputs[K],
  ) => void;
  mode: "quick" | "detailed";
}) {
  const showAdvanced = mode === "detailed";
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

        {showAdvanced && (
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
        )}

        {showAdvanced && (
          <NumberField
            label="Coats"
            // Coats is always a positive integer.
            value={inputs.coats}
            onChange={(v) => setField("coats", Math.max(1, Math.round(v ?? 2)))}
            placeholder="2"
            min={1}
            step={1}
          />
        )}

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

        {showAdvanced && (
          <>
            <NumberField
              label="Hourly Rate ($)"
              value={inputs.hourlyRate}
              onChange={(v) => setField("hourlyRate", Math.max(0, v ?? 35))}
              placeholder="35"
              min={0}
              step={1}
            />

            <NumberField
              label="Number of Painters"
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
              value={inputs.markup}
              onChange={(v) => setField("markup", Math.max(0, v ?? 30))}
              placeholder="30"
              min={0}
              step={1}
            />

            <NumberField
              label="Wall Rate (sq ft/hr)"
              value={inputs.wallRate}
              onChange={(v) => setField("wallRate", Math.max(1, v ?? 150))}
              placeholder="150"
              min={1}
              step={5}
            />

            <NumberField
              label="Ceiling Rate (sq ft/hr)"
              value={inputs.ceilingRate}
              onChange={(v) => setField("ceilingRate", Math.max(1, v ?? 200))}
              placeholder="200"
              min={1}
              step={5}
            />

            <NumberField
              label="Trim Rate (sq ft/hr)"
              value={inputs.trimRate}
              onChange={(v) => setField("trimRate", Math.max(1, v ?? 80))}
              placeholder="80"
              min={1}
              step={5}
            />

            <NumberField
              label="Door Rate (doors/hr)"
              value={inputs.doorRate}
              onChange={(v) => setField("doorRate", Math.max(0.1, v ?? 2))}
              placeholder="2"
              min={0.1}
              step={0.5}
            />

            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Zip Code
              </span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={10}
                value={inputs.zipCode}
                onChange={(e) =>
                  setField("zipCode", e.target.value.replace(/[^\d-]/g, ""))
                }
                placeholder="84101"
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-amber-500"
              />
            </label>

            <label className="col-span-1 flex select-none items-center gap-2 sm:col-span-2">
              <input
                type="checkbox"
                checked={inputs.prime}
                onChange={(e) => setField("prime", e.target.checked)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 accent-amber-500"
              />
              <span className="text-sm text-zinc-200">Prime (one coat)</span>
            </label>
          </>
        )}
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
  pricing,
  setPricing,
  showPricingSettings,
  onTogglePricingSettings,
  pricingTab,
  onPricingTabChange,
  locationInfo,
  confirmed,
  canConfirm,
  onConfirm,
  mode,
  showMaterials,
  onToggleMaterials,
  showLabor,
  onToggleLabor,
  showCosts,
  onToggleCosts,
  projectMeta,
  onCopyEstimate,
  onDownloadPdf,
  currentProject,
  onUpdateActuals,
  updatePriceEntry,
  fetchPriceFor,
  fetchState,
  refreshAllPrices,
  refreshing,
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
  pricing: StorePricingMap;
  setPricing: React.Dispatch<React.SetStateAction<StorePricingMap>>;
  showPricingSettings: boolean;
  onTogglePricingSettings: () => void;
  pricingTab: Store;
  onPricingTabChange: (s: Store) => void;
  locationInfo: { region: string | null; multiplier: number };
  confirmed: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
  mode: "quick" | "detailed";
  showMaterials: boolean;
  onToggleMaterials: () => void;
  showLabor: boolean;
  onToggleLabor: () => void;
  showCosts: boolean;
  onToggleCosts: () => void;
  projectMeta: ProjectMeta;
  onCopyEstimate: () => void;
  onDownloadPdf: () => void;
  currentProject: SavedProject | null;
  onUpdateActuals: (field: keyof ActualValues, value: number | null) => void;
  updatePriceEntry: (
    storeId: Store,
    section: "paint" | "materials",
    key: string,
    patch: Partial<PriceEntry>,
  ) => void;
  fetchPriceFor: (
    storeId: Store,
    section: "paint" | "materials",
    key: string,
    url: string,
  ) => void;
  fetchState: Record<string, { loading?: boolean; error?: string }>;
  refreshAllPrices: () => void;
  refreshing: boolean;
}) {
  const isDetailed = mode === "detailed";
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

      {isDetailed && (
        <CollapsibleCard
          title="Materials"
          expanded={showMaterials}
          onToggle={onToggleMaterials}
        >
          <Grid>
            {result.materials.map((m) => (
              <Stat key={m.name} label={m.name} value={m.qty} />
            ))}
          </Grid>
        </CollapsibleCard>
      )}

      {isDetailed && (
        <PricingSettingsCard
          pricing={pricing}
          updatePriceEntry={updatePriceEntry}
          fetchPriceFor={fetchPriceFor}
          fetchState={fetchState}
          refreshAllPrices={refreshAllPrices}
          refreshing={refreshing}
          expanded={showPricingSettings}
          onToggle={onTogglePricingSettings}
          activeTab={pricingTab}
          onTabChange={onPricingTabChange}
          locationInfo={locationInfo}
        />
      )}

      {costs && isDetailed && (
        <CollapsibleCard
          title="Store Pricing & Comparison"
          expanded={showCosts}
          onToggle={onToggleCosts}
        >
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
            <StoreComparison
              allStoreCosts={allStoreCosts}
              onSelectStore={(s) => {
                onStoreChange(s);
                onToggleCompare();
              }}
            />
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
        </CollapsibleCard>
      )}

      {costs && !compareStores && isDetailed && (
        <CollapsibleCard
          title="Labor Breakdown"
          expanded={showLabor}
          onToggle={onToggleLabor}
        >
          <Grid>
            <Stat label="Walls (hrs)" value={costs.labor.wallHours.toFixed(1)} />
            <Stat
              label="Ceilings (hrs)"
              value={costs.labor.ceilingHours.toFixed(1)}
            />
            <Stat label="Trim (hrs)" value={costs.labor.trimHours.toFixed(1)} />
            <Stat label="Doors (hrs)" value={costs.labor.doorHours.toFixed(1)} />
            <Stat
              label="Total Hours"
              value={costs.labor.totalHours.toFixed(1)}
            />
            <Stat
              label="Labor Cost"
              value={fmtMoney(costs.labor.laborCost)}
            />
          </Grid>
        </CollapsibleCard>
      )}

      {costs && !compareStores && (
        <Card title="Job Pricing">
          <Grid>
            <Stat
              label="Material Cost"
              value={fmtMoney(costs.jobPricing.materials)}
            />
            <Stat
              label="Labor Cost"
              value={fmtMoney(costs.jobPricing.labor)}
            />
            <Stat
              label="Subtotal"
              value={fmtMoney(costs.jobPricing.subtotal)}
            />
            <Stat
              label="Markup"
              value={fmtMoney(costs.jobPricing.markupAmount)}
            />
            <Stat
              label="Final Price"
              value={fmtMoney(costs.jobPricing.finalPrice)}
            />
            <Stat
              label="Profit"
              value={fmtMoney(costs.jobPricing.profit)}
            />
            <Stat
              label="Margin"
              value={`${costs.jobPricing.marginPct.toFixed(1)}%`}
            />
          </Grid>
        </Card>
      )}

      {costs && (
        <EstimateSummaryCard
          projectMeta={projectMeta}
          inputs={inputs}
          costs={costs}
          onCopy={onCopyEstimate}
          onDownloadPdf={onDownloadPdf}
        />
      )}

      {currentProject && costs && (
        <JobPerformanceCard
          project={currentProject}
          costs={costs}
          onUpdate={onUpdateActuals}
        />
      )}
    </section>
  );
}

// Collapsible per-store pricing editor. Each row shows a price input,
// a product-URL input, a Fetch Price button, and a last-updated stamp.
// A Refresh All button at the top runs every URL in the table at once.
function PricingSettingsCard({
  pricing,
  updatePriceEntry,
  fetchPriceFor,
  fetchState,
  refreshAllPrices,
  refreshing,
  expanded,
  onToggle,
  activeTab,
  onTabChange,
  locationInfo,
}: {
  pricing: StorePricingMap;
  updatePriceEntry: (
    storeId: Store,
    section: "paint" | "materials",
    key: string,
    patch: Partial<PriceEntry>,
  ) => void;
  fetchPriceFor: (
    storeId: Store,
    section: "paint" | "materials",
    key: string,
    url: string,
  ) => void;
  fetchState: Record<string, { loading?: boolean; error?: string }>;
  refreshAllPrices: () => void;
  refreshing: boolean;
  expanded: boolean;
  onToggle: () => void;
  activeTab: Store;
  onTabChange: (s: Store) => void;
  locationInfo: { region: string | null; multiplier: number };
}) {
  const active = pricing[activeTab];
  const materialNames = Object.keys(active.materials);

  return (
    <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
            Pricing Settings
          </h2>
          {locationInfo.region ? (
            <p className="mt-1 text-xs text-emerald-300">
              Region detected: {locationInfo.region} ·{" "}
              {locationInfo.multiplier === 1
                ? "neutral"
                : `${locationInfo.multiplier > 1 ? "+" : ""}${(
                    (locationInfo.multiplier - 1) *
                    100
                  ).toFixed(0)}%`}{" "}
              multiplier
            </p>
          ) : (
            <p className="mt-1 text-xs text-zinc-500">
              Set a ZIP code in inputs to apply a regional multiplier.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshAllPrices}
            disabled={refreshing}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            {refreshing ? "Refreshing…" : "Refresh prices"}
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
          >
            {expanded ? "Hide pricing settings" : "Show pricing settings"}
          </button>
        </div>
      </header>

      {expanded && (
        <div className="mt-5">
          {/* Store tabs */}
          <div className="flex border-b border-zinc-800">
            {STORES.map((s) => {
              const isActive = s.id === activeTab;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onTabChange(s.id)}
                  className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium transition ${
                    isActive
                      ? "border-amber-500 text-amber-300"
                      : "border-transparent text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          {/* Paint */}
          <div className="mt-5">
            <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Paint ($ / gallon)
            </h4>
            <div className="space-y-2">
              {(
                [
                  ["walls", "Walls"],
                  ["ceilings", "Ceilings"],
                  ["trim", "Trim"],
                  ["primer", "Primer"],
                ] as const
              ).map(([key, label]) => (
                <PricingRow
                  key={key}
                  label={label}
                  entry={active.paint[key]}
                  fetchKey={`${activeTab}|paint|${key}`}
                  fetchState={fetchState}
                  onPriceChange={(price) =>
                    updatePriceEntry(activeTab, "paint", key, { price })
                  }
                  onUrlChange={(url) =>
                    updatePriceEntry(activeTab, "paint", key, { url })
                  }
                  onFetch={(url) =>
                    fetchPriceFor(activeTab, "paint", key, url)
                  }
                />
              ))}
            </div>
          </div>

          {/* Materials */}
          <div className="mt-5">
            <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Materials ($ / unit)
            </h4>
            <div className="max-h-[28rem] space-y-2 overflow-auto pr-1">
              {materialNames.map((name) => (
                <PricingRow
                  key={name}
                  label={name}
                  entry={active.materials[name]}
                  fetchKey={`${activeTab}|materials|${name}`}
                  fetchState={fetchState}
                  onPriceChange={(price) =>
                    updatePriceEntry(activeTab, "materials", name, { price })
                  }
                  onUrlChange={(url) =>
                    updatePriceEntry(activeTab, "materials", name, { url })
                  }
                  onFetch={(url) =>
                    fetchPriceFor(activeTab, "materials", name, url)
                  }
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function PricingRow({
  label,
  entry,
  fetchKey,
  fetchState,
  onPriceChange,
  onUrlChange,
  onFetch,
}: {
  label: string;
  entry: PriceEntry;
  fetchKey: string;
  fetchState: Record<string, { loading?: boolean; error?: string }>;
  onPriceChange: (price: number) => void;
  onUrlChange: (url: string) => void;
  onFetch: (url: string) => void;
}) {
  const state = fetchState[fetchKey] ?? {};
  const lastUpdated = entry.lastUpdated
    ? new Date(entry.lastUpdated).toLocaleDateString()
    : "never";
  return (
    <div className="rounded-md bg-zinc-950/40 p-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
          {label}
        </span>
        <input
          type="number"
          inputMode="decimal"
          value={entry.price}
          onChange={(e) => {
            const raw = e.target.value;
            const n = raw === "" ? 0 : Number(raw);
            onPriceChange(Number.isFinite(n) ? Math.max(0, n) : 0);
          }}
          min={0}
          step={0.5}
          className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-right text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
        />
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="url"
          value={entry.url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="Product URL (https://…)"
          className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 outline-none transition focus:border-amber-500"
        />
        <button
          type="button"
          onClick={() => onFetch(entry.url)}
          disabled={!entry.url || state.loading}
          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          {state.loading ? "Fetching…" : "Fetch Price"}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px]">
        <span className={state.error ? "text-red-400" : "text-zinc-600"}>
          {state.error
            ? `Could not update price: ${state.error}`
            : `Last updated: ${lastUpdated}`}
        </span>
      </div>
    </div>
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
  onSelectStore,
}: {
  allStoreCosts: Array<{
    store: { id: Store; label: string };
    costs: ReturnType<typeof computeCosts>;
  }>;
  onSelectStore: (s: Store) => void;
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

              <button
                type="button"
                onClick={() => onSelectStore(s.id)}
                className={`mt-3 w-full rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                  isBest
                    ? "border-emerald-500 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                    : "border-zinc-700 text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                Use this store
              </button>
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

// Clean export-ready summary. Tagged .printable so window.print()
// captures only this card. Copy / Download PDF buttons are .no-print
// so they don't appear in the exported view.
function EstimateSummaryCard({
  projectMeta,
  inputs,
  costs,
  onCopy,
  onDownloadPdf,
}: {
  projectMeta: ProjectMeta;
  inputs: ProjectInputs;
  costs: NonNullable<ReturnType<typeof computeCosts>>;
  onCopy: () => void;
  onDownloadPdf: () => void;
}) {
  const name = displayName(projectMeta, inputs);
  const cityLine = [projectMeta.address, projectMeta.city]
    .filter((s) => s.trim())
    .join(", ");

  return (
    <div className="printable rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h3 className="printable-title text-sm font-medium uppercase tracking-wide text-zinc-400">
          Estimate Summary
        </h3>
        <div className="no-print flex items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
          >
            Copy Estimate
          </button>
          <button
            type="button"
            onClick={onDownloadPdf}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400"
          >
            Download PDF
          </button>
        </div>
      </header>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between border-b border-zinc-800 pb-2">
          <span className="text-zinc-400">Project</span>
          <span className="font-medium text-zinc-100">{name}</span>
        </div>
        {projectMeta.customerName.trim() && (
          <div className="flex justify-between">
            <span className="text-zinc-400">Customer</span>
            <span className="font-medium text-zinc-100">
              {projectMeta.customerName}
            </span>
          </div>
        )}
        {cityLine && (
          <div className="flex justify-between">
            <span className="text-zinc-400">Address</span>
            <span className="font-medium text-zinc-100">{cityLine}</span>
          </div>
        )}
        {projectMeta.phone.trim() && (
          <div className="flex justify-between">
            <span className="text-zinc-400">Phone</span>
            <span className="font-medium text-zinc-100">
              {projectMeta.phone}
            </span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-zinc-400">Sq Ft</span>
          <span className="font-medium text-zinc-100">
            {inputs.sqFt?.toLocaleString() ?? "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-400">Wall Height</span>
          <span className="font-medium text-zinc-100">
            {inputs.wallHeight !== null ? `${inputs.wallHeight} ft` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-400">Material Cost</span>
          <span className="font-medium text-zinc-100">
            {fmtMoney(costs.jobPricing.materials)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-400">Labor Cost</span>
          <span className="font-medium text-zinc-100">
            {fmtMoney(costs.jobPricing.labor)}
          </span>
        </div>
        <div className="mt-2 flex justify-between border-t border-zinc-800 pt-3">
          <span className="text-base font-semibold text-zinc-200">
            Final Price
          </span>
          <span className="text-base font-bold text-amber-400">
            {fmtMoney(costs.jobPricing.finalPrice)}
          </span>
        </div>
      </div>
    </div>
  );
}

// Job Performance — only shown when a saved project is currently
// loaded (so we have a place to write back actuals). Lets the user
// enter Actual Material Cost / Labor Cost / Hours and shows a
// side-by-side estimate vs actual comparison with color feedback.
function JobPerformanceCard({
  project,
  costs,
  onUpdate,
}: {
  project: SavedProject;
  costs: NonNullable<ReturnType<typeof computeCosts>>;
  onUpdate: (field: keyof ActualValues, value: number | null) => void;
}) {
  const actuals = project.actuals;
  const finalPrice = project.finalPrice ?? costs.jobPricing.finalPrice;

  const estCost = costs.jobPricing.materials + costs.jobPricing.labor;
  const estProfit = finalPrice - estCost;
  const estMargin = finalPrice > 0 ? (estProfit / finalPrice) * 100 : 0;

  const hasActuals =
    actuals.materialCost !== null || actuals.laborCost !== null;
  const actualMaterialCost = actuals.materialCost ?? 0;
  const actualLaborCost = actuals.laborCost ?? 0;
  const actualCost = actualMaterialCost + actualLaborCost;
  const actualProfit = finalPrice - actualCost;
  const actualMargin = finalPrice > 0 ? (actualProfit / finalPrice) * 100 : 0;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-400">
        Job Performance
      </h3>

      <Grid>
        <NumberField
          label="Actual Material Cost"
          value={actuals.materialCost}
          onChange={(v) => onUpdate("materialCost", v)}
          placeholder="—"
          min={0}
          step={1}
        />
        <NumberField
          label="Actual Labor Cost"
          value={actuals.laborCost}
          onChange={(v) => onUpdate("laborCost", v)}
          placeholder="—"
          min={0}
          step={1}
        />
        <NumberField
          label="Actual Hours (optional)"
          value={actuals.hours}
          onChange={(v) => onUpdate("hours", v)}
          placeholder="—"
          min={0}
          step={0.5}
        />
      </Grid>

      {hasActuals ? (
        <div className="mt-5 space-y-1 text-sm">
          <ComparisonHeader />
          <ComparisonRow
            label="Cost"
            estimate={estCost}
            actual={actualCost}
            format="money"
          />
          <ComparisonRow
            label="Profit"
            estimate={estProfit}
            actual={actualProfit}
            format="money"
          />
          <ComparisonRow
            label="Margin"
            estimate={estMargin}
            actual={actualMargin}
            format="percent"
          />
        </div>
      ) : (
        <p className="mt-4 text-xs text-zinc-500">
          Enter at least one actual value above to see the comparison.
        </p>
      )}
    </div>
  );
}

function ComparisonHeader() {
  return (
    <div className="grid grid-cols-4 gap-3 border-b border-zinc-800 pb-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
      <div></div>
      <div>Estimate</div>
      <div>Actual</div>
      <div>Difference</div>
    </div>
  );
}

function ComparisonRow({
  label,
  estimate,
  actual,
  format,
}: {
  label: string;
  estimate: number;
  actual: number;
  format: "money" | "percent";
}) {
  const fmt = (n: number) =>
    format === "money" ? fmtMoney(n) : `${n.toFixed(1)}%`;
  const diff = actual - estimate;
  // Per spec: actual > estimate → green; actual < estimate → red.
  const color =
    diff > 0
      ? "text-emerald-300"
      : diff < 0
        ? "text-red-300"
        : "text-zinc-400";
  const sign = diff > 0 ? "+" : "";
  return (
    <div className="grid grid-cols-4 gap-3 py-1.5">
      <div className="text-zinc-400">{label}</div>
      <div className="text-zinc-100">{fmt(estimate)}</div>
      <div className="text-zinc-100">{fmt(actual)}</div>
      <div className={color}>
        {sign}
        {fmt(diff)}
      </div>
    </div>
  );
}

// Customer / project context. Drives the saved-project metadata,
// the Estimate Summary export, and the auto-name fallback. Doesn't
// affect calculations.
function ProjectInfoCard({
  meta,
  setMetaField,
}: {
  meta: ProjectMeta;
  setMetaField: <K extends keyof ProjectMeta>(
    key: K,
    value: ProjectMeta[K],
  ) => void;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-400">
        Project Info
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Customer Name"
          value={meta.customerName}
          onChange={(v) => setMetaField("customerName", v)}
          placeholder="e.g. Smith Family"
        />
        <TextField
          label="Project Name"
          value={meta.projectName}
          onChange={(v) => setMetaField("projectName", v)}
          placeholder="auto-named if blank"
        />
        <TextField
          label="Address"
          value={meta.address}
          onChange={(v) => setMetaField("address", v)}
          placeholder="123 Main St"
          colSpan2
        />
        <TextField
          label="City"
          value={meta.city}
          onChange={(v) => setMetaField("city", v)}
          placeholder="Salt Lake City"
        />
        <TextField
          label="Phone (optional)"
          value={meta.phone}
          onChange={(v) => setMetaField("phone", v)}
          placeholder="(555) 555-5555"
        />
      </div>
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  colSpan2,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  colSpan2?: boolean;
}) {
  return (
    <label className={`block ${colSpan2 ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-amber-500"
      />
    </label>
  );
}

// Saved projects list with search. One row per project shows
// customer + display name + city + final price.
function SavedProjectsCard({
  projects,
  search,
  onSearchChange,
  onLoad,
  onDuplicate,
  onDelete,
}: {
  projects: SavedProject[];
  search: string;
  onSearchChange: (v: string) => void;
  onLoad: (p: SavedProject) => void;
  onDuplicate: (p: SavedProject) => void;
  onDelete: (id: string) => void;
}) {
  const filtered = useMemoFilter(projects, search);

  return (
    <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
          Saved Projects ({filtered.length}
          {filtered.length !== projects.length && ` of ${projects.length}`})
        </h2>
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by name or city…"
          className="w-56 max-w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none transition focus:border-amber-500"
        />
      </header>

      {filtered.length === 0 ? (
        <p className="text-xs text-zinc-500">No matching projects.</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {filtered.map((p) => {
            const name = displayName(p.meta, p.inputs);
            const customer = p.meta.customerName.trim() || "—";
            const city = p.meta.city.trim() || "—";
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => onLoad(p)}
                  className="flex-1 truncate text-left transition hover:text-amber-300"
                >
                  <div className="truncate text-sm font-medium text-zinc-100">
                    {customer === "—" ? name : `${customer} · ${name}`}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {city} ·{" "}
                    {p.finalPrice !== null
                      ? fmtMoney(p.finalPrice)
                      : "no price"}{" "}
                    · {new Date(p.timestamp).toLocaleDateString()}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onDuplicate(p)}
                  className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(p.id)}
                  className="rounded-md border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 hover:border-red-500/60 hover:text-red-400"
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Filter saved projects by displayName or city, case-insensitive.
function useMemoFilter(projects: SavedProject[], search: string) {
  return useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => {
      const name = displayName(p.meta, p.inputs).toLowerCase();
      const city = p.meta.city.toLowerCase();
      const customer = p.meta.customerName.toLowerCase();
      return name.includes(q) || city.includes(q) || customer.includes(q);
    });
  }, [projects, search]);
}

// Same shell as Card, but the title bar is a click-toggle and the
// body only renders when `expanded` is true. Used for sections that
// add detail but bury it by default to keep the page lean.
function CollapsibleCard({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-sm font-medium uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
      >
        <span>{title}</span>
        <span className="text-base text-zinc-500" aria-hidden>
          {expanded ? "−" : "+"}
        </span>
      </button>
      {expanded && <div className="mt-4">{children}</div>}
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
