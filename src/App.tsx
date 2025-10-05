// src/App.tsx — Reservations v1 (Calendar .ics import + manual add)
// ---------------------------------------------------------------
// Requirements (install):
//   npm i react-globe.gl three topojson-client world-atlas i18n-iso-countries world-countries d3-geo
//   npm i -D @types/three
// TS config tips:
//   - "resolveJsonModule": true (to import world-atlas JSON)
//   - "esModuleInterop": true (recommended)
// ---------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import Globe from "react-globe.gl";
import * as topojson from "topojson-client";
import * as THREE from "three";
import world110m from "world-atlas/countries-110m.json";
import countriesISO from "i18n-iso-countries";
import worldCountries from "world-countries";
import { geoCentroid, geoArea, geoContains } from "d3-geo";

/* ---------- Types ---------- */
type CountryFeature = {
  id: string | number;
  properties: { name?: string };
  geometry: any;
};

type VisitsMap = Record<string, { alpha2?: string; name?: string; dates: string[] }>;

type Anchor = { id: string | number; name: string; lat: number; lng: number; area: number };

type Plan = {
  id: string | number;
  alpha2?: string;
  name: string;
  startISO: string;
  endISO?: string;
  /** @deprecated kept for older localStorage payloads */
  dateISO?: string;
};

type TripActivityCategory = "experience" | "meal" | "travel" | "free" | string;

type TripActivity = {
  id: string;
  title: string;
  startISO: string;
  endISO: string;
  category?: TripActivityCategory;
  notes?: string;
};

type TripSchedules = Record<string, Record<string, TripActivity[]>>;

type Screen = "map" | "trips" | "reservations" | "settings";

type MapStyle = "earth" | "plain";

/* ---------- Reservations Types ---------- */
type ReservationType = "flight" | "hotel" | "train" | "event";

interface ReservationBase {
  id: string;
  type: ReservationType;
  startISO: string;
  endISO?: string;
  title: string;
  location?: { city?: string; country?: string; lat?: number; lng?: number };
  notes?: string;
  attachments?: { name: string; url?: string; mime?: string }[];
  meta?: Record<string, any>;
}

type Reservation = ReservationBase;

/* ---------- LocalStorage keys ---------- */
const LS_VISITS = "visited-country-ids";
const LS_VISITS_META = "visit-dates-by-country";
const LS_PLANS = "planned-trips";
const LS_RESERVATIONS = "reservations";
const LS_TRIP_SCHEDULES = "trip-schedules";

/* ---------- Zoom/label behaviour ---------- */
const ALT_MIN = 0.7;
const ALT_MAX = 3.6;
const COUNTRY_ON = 1.25;
const COUNTRY_OFF = 1.65;
const CONT_ON = 2.4;
const CONT_OFF = 2.05;

/* ---------- Textures / styles ---------- */
const GLOBE_TEXTURE_EARTH =
  "https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg";

/* ---------- Helpers ---------- */
const pad3 = (n: string | number) => String(n).padStart(3, "0");

function flagFromAlpha2(code?: string) {
  if (!code || code.length !== 2) return "🏳️";
  const A = 0x1f1e6;
  const [c1, c2] = code.toUpperCase().split("");
  return (
    String.fromCodePoint(A + (c1.charCodeAt(0) - 65)) +
    String.fromCodePoint(A + (c2.charCodeAt(0) - 65))
  );
}

function monthInputToLabel(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const tryDate = new Date(s);
  if (!Number.isNaN(tryDate.getTime())) {
    const m = tryDate.toLocaleString("en-GB", { month: "short" });
    const y = tryDate.getFullYear();
    return `${m} ${y}`;
  }
  const mmYYYY = s.match(/^(\d{1,2})\s*[/\-.]\s*(\d{2,4})$/);
  if (mmYYYY) {
    let mm = parseInt(mmYYYY[1], 10);
    let yy = parseInt(mmYYYY[2], 10);
    if (yy < 100) yy = 2000 + yy;
    if (mm >= 1 && mm <= 12) {
      const d = new Date(yy, mm - 1, 1);
      const m = d.toLocaleString("en-GB", { month: "short" });
      return `${m} ${yy}`;
    }
  }
  return s;
}

function groupDatesByYear(dates: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  dates.forEach((label) => {
    const [mon, year] = label.split(" ");
    const y = year || "Unknown";
    if (!out[y]) out[y] = [];
    if (!out[y].includes(mon)) out[y].push(mon);
  });
  const ORDER = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  Object.keys(out).forEach((y) =>
    (out[y] = out[y].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)))
  );
  return out;
}

function toRad(d: number) {
  return (d * Math.PI) / 180;
}

function angDist(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const A = { lat: toRad(a.lat), lng: toRad(a.lng) };
  const B = { lat: toRad(b.lat), lng: toRad(b.lng) };
  const cos =
    Math.sin(A.lat) * Math.sin(B.lat) +
    Math.cos(A.lat) * Math.cos(B.lat) * Math.cos(A.lng - B.lng);
  const deg = Math.acos(Math.min(1, Math.max(-1, cos))) * (180 / Math.PI);
  return deg;
}

const MINUTES_IN_DAY = 24 * 60;

function normalizeHHMM(value: string, fallback = "09:00") {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/^\d{1,2}$/.test(trimmed)) {
    return `${trimmed.padStart(2, "0")}:00`;
  }
  if (/^\d{1,2}:\d{1,2}$/.test(trimmed)) {
    const [hStr, mStr] = trimmed.split(":");
    const h = Math.max(0, Math.min(23, parseInt(hStr, 10) || 0));
    const m = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return fallback;
}

function timeToMinutes(value: string) {
  const [hStr = "0", mStr = "0"] = value.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return Math.max(0, Math.min(MINUTES_IN_DAY, h * 60 + m));
}

function minutesToHHMM(min: number) {
  const clamped = Math.max(0, Math.min(min, MINUTES_IN_DAY - 1));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function ensureEndAfterStart(start: string, end: string) {
  const startMin = timeToMinutes(start);
  let endMin = timeToMinutes(end);
  if (endMin <= startMin) {
    endMin = Math.min(MINUTES_IN_DAY - 1, startMin + 60);
  }
  return { start, end: minutesToHHMM(endMin) };
}

function clipRangeToDay(
  dateISO: string,
  startISO: string,
  endISO?: string
): { startMin: number; endMin: number } | null {
  const dayStart = new Date(`${dateISO}T00:00:00`);
  const dayEnd = new Date(`${dateISO}T23:59:59`);
  const start = new Date(startISO);
  const end = endISO ? new Date(endISO) : new Date(start.getTime() + 60 * 60000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const startMs = Math.max(dayStart.getTime(), start.getTime());
  const endMs = Math.min(dayEnd.getTime(), Math.max(startMs + 30 * 60000, end.getTime()));
  if (endMs < dayStart.getTime() || startMs > dayEnd.getTime()) return null;
  const startMin = Math.max(
    0,
    Math.floor((startMs - dayStart.getTime()) / 60000)
  );
  const endMin = Math.max(
    startMin + 30,
    Math.ceil((endMs - dayStart.getTime()) / 60000)
  );
  return {
    startMin,
    endMin: Math.min(MINUTES_IN_DAY, endMin),
  };
}

/* ---------- Continent anchors ---------- */
const CONTINENTS = [
  { name: "North America", lat: 45, lng: -100 },
  { name: "South America", lat: -15, lng: -60 },
  { name: "Europe", lat: 54, lng: 15 },
  { name: "Africa", lat: 5, lng: 20 },
  { name: "Asia", lat: 30, lng: 100 },
  { name: "Oceania", lat: -25, lng: 135 },
  { name: "Antarctica", lat: -80, lng: 0 },
];

/* ---------- Progress ring ---------- */
function ProgressRing({ pct, size = 44 }: { pct: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const R = (size - 12) / 2;
  const C = 2 * Math.PI * R;
  const off = C * (1 - clamped / 100);
  const center = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block" }}
    >
      <circle cx={center} cy={center} r={R} stroke="#e9ecef" strokeWidth={6} fill="none" />
      <circle
        cx={center}
        cy={center}
        r={R}
        stroke="#0ea5a8"
        strokeWidth={6}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${C} ${C}`}
        strokeDashoffset={off}
        transform={`rotate(-90 ${center} ${center})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="middle"
        textAnchor="middle"
        fontSize={Math.max(10, size * 0.26)}
        fill="#0f172a"
        fontWeight={700}
      >
        {Math.round(clamped)}%
      </text>
    </svg>
  );
}

/* ================================= App ================================= */
export default function App() {
  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#f5efe6",
        color: "#111827",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue"',
      }}
    >
      <style>{`
        html, body, #root, #__next { height: 100%; margin: 0; padding: 0; }
        body { margin: 0; }
        *, *::before, *::after { box-sizing: border-box; }
      `}</style>

      <AppInner />
    </div>
  );
}

function AppInner() {
  /* Geo features */
  const countries = useMemo<CountryFeature[]>(() => {
    const fc = topojson.feature(
      world110m as any,
      (world110m as any).objects.countries
    ) as any;
    return fc.features as CountryFeature[];
  }, []);

  /* id -> alpha2 + name */
  const idInfo = useMemo(() => {
    const geoms = (world110m as any).objects.countries.geometries;
    const m = new Map<string | number, { alpha2?: string; name?: string }>();
    for (const g of geoms) {
      const id = g.id;
      const alpha2 = countriesISO.numericToAlpha2(pad3(id));
      let name: string | undefined = undefined;
      if (alpha2) {
        const rec = (worldCountries as any[]).find((c) => c.cca2 === alpha2);
        name = rec?.name?.common;
      }
      m.set(id, { alpha2: alpha2 || undefined, name });
    }
    return m;
  }, []);

  /* Robust anchor + area */
  function bestAnchorFor(f: CountryFeature): [number, number] {
    const c = geoCentroid(f as any);
    if (geoContains(f as any, [c[0], c[1]])) return [c[0], c[1]];
    const g = f.geometry || {};
    if (g.type === "MultiPolygon") {
      let best: any = g.coordinates[0];
      let bestA = -Infinity;
      for (const poly of g.coordinates as any[]) {
        const feat = {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: poly },
        } as any;
        const a = geoArea(feat);
        if (a > bestA) {
          bestA = a;
          best = poly;
        }
      }
      const cent = geoCentroid({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: best },
      } as any);
      return [cent[0], cent[1]];
    }
    return [c[0], c[1]];
  }

  const countryAnchors = useMemo<Anchor[]>(() => {
    return countries.map((f) => {
      const [lng, lat] = bestAnchorFor(f);
      const info = idInfo.get(f.id) || {};
      const area = geoArea(f as any);
      return { id: f.id, name: info.name || "Unknown", lat, lng, area };
    });
  }, [countries, idInfo]);

  /* list for search */
  const allCountries = useMemo(() => {
    return Array.from(idInfo.entries())
      .map(([id, v]) => ({
        id,
        alpha2: v.alpha2,
        name: v.name || "Unknown",
        flag: flagFromAlpha2(v.alpha2),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [idInfo]);

  /* state & persistence (SSR-safe) */
  const [visited, setVisited] = useState<Set<string | number>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem(LS_VISITS);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });

  const [visits, setVisits] = useState<VisitsMap>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(window.localStorage.getItem(LS_VISITS_META) || "{}");
    } catch {
      return {};
    }
  });

  const [plans, setPlans] = useState<Plan[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = JSON.parse(window.localStorage.getItem(LS_PLANS) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw
        .map((p: any) => {
          const startISO = p?.startISO || p?.dateISO || p?.date || "";
          const endISO = p?.endISO || p?.finishISO || undefined;
          return {
            ...p,
            startISO,
            endISO,
          } as Plan;
        })
        .filter((p) => Boolean(p.startISO));
    } catch {
      return [];
    }
  });

  const [tripSchedules, setTripSchedules] = useState<TripSchedules>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = JSON.parse(
        window.localStorage.getItem(LS_TRIP_SCHEDULES) || "{}"
      );
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  });

  const [reservations, setReservations] = useState<Reservation[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(window.localStorage.getItem(LS_RESERVATIONS) || "[]");
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(LS_VISITS, JSON.stringify([...visited]));
  }, [visited]);

  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(LS_VISITS_META, JSON.stringify(visits));
  }, [visits]);

  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(LS_PLANS, JSON.stringify(plans));
  }, [plans]);

  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(LS_RESERVATIONS, JSON.stringify(reservations));
  }, [reservations]);

  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(
        LS_TRIP_SCHEDULES,
        JSON.stringify(tripSchedules)
      );
  }, [tripSchedules]);

  const visitedCount = useMemo(() => Object.keys(visits).length, [visits]);

  const visitedList = useMemo(() => {
    const entries = Object.entries(visits).map(([id, v]) => ({
      id,
      name: v.name || "Unknown",
      alpha2: v.alpha2,
      dates: v.dates,
    }));
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }, [visits]);

  const totalCountries = countries.length;
  /* Global map state (Settings) */
  const [showCountryNameLabels, setShowCountryNameLabels] = useState(true);
  const [showContinentNameLabels, setShowContinentNameLabels] = useState(true);
  const [showBorders, setShowBorders] = useState(true);
  const [mapStyle, setMapStyle] = useState<MapStyle>("earth");

  /* Nav */
  const [screen, setScreen] = useState<Screen>("map");

  /* shared handlers */
  function addVisitById(id: string | number) {
    const info = idInfo.get(id) || {};
    const alpha2 = info.alpha2;
    const name = info.name || "Unknown";
    const ask = `When did you travel to ${flagFromAlpha2(alpha2)} ${name}?\n(e.g., Sep 2024 or 09/2024)`;
    const label = monthInputToLabel(
      typeof window !== "undefined" ? window.prompt(ask) : null
    );
    if (!label) return;
    setVisits((prev) => {
      const key = String(id);
      const existed = prev[key] || { alpha2, name, dates: [] };
      const nextDates = existed.dates.includes(label)
        ? existed.dates
        : [...existed.dates, label];
      return {
        ...prev,
        [key]: {
          alpha2: alpha2 ?? existed.alpha2,
          name: name ?? existed.name,
          dates: nextDates,
        },
      };
    });
    setVisited((prev) => new Set(prev).add(id));
  }

  function visitCountFor(id: string | number) {
    const v = visits[String(id)];
    return v ? v.dates.length : 0;
  }

  function addPlanFromPick(
    countryId: string | number,
    startISO: string,
    endISO?: string
  ) {
    const info = idInfo.get(countryId) || {};
    const name = info.name || "Unknown";
    const alpha2 = info.alpha2;
    if (!startISO) return;
    setPlans((prev) => {
      const exists = prev.find(
        (p) => String(p.id) === String(countryId) && p.startISO === startISO
      );
      if (exists) return prev;
      return [
        ...prev,
        { id: countryId, alpha2, name, startISO, endISO },
      ].sort(
        (a, b) =>
          new Date(a.startISO).getTime() - new Date(b.startISO).getTime()
      );
    });
  }

  function removePlan(idx: number) {
    setPlans((prev) => {
      const plan = prev[idx];
      if (plan) {
        setTripSchedules((prevSchedules) => {
          const key = String(plan.id);
          if (!(key in prevSchedules)) return prevSchedules;
          const next = { ...prevSchedules };
          delete next[key];
          return next;
        });
      }
      return prev.filter((_, i) => i !== idx);
    });
  }

  function sortActivities(items: TripActivity[]) {
    return items.slice().sort((a, b) => a.startISO.localeCompare(b.startISO));
  }

  function addTripActivity(
    planId: string | number,
    dateISO: string,
    input: { title: string; start: string; end: string; category?: string; notes?: string }
  ) {
    const title = input.title?.trim();
    if (!title || !input.start || !input.end) return;
    const planKey = String(planId);
    const normalizedStart = normalizeHHMM(input.start);
    const normalizedEnd = normalizeHHMM(input.end, normalizedStart);
    const { end } = ensureEndAfterStart(normalizedStart, normalizedEnd);
    const startISO = `${dateISO}T${normalizedStart}:00`;
    const endISO = `${dateISO}T${end}:00`;
    const item: TripActivity = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      startISO,
      endISO,
      category: input.category || undefined,
      notes: input.notes || undefined,
    };
    setTripSchedules((prev) => {
      const dayMap = { ...(prev[planKey] || {}) };
      const dayItems = sortActivities([...(dayMap[dateISO] || []), item]);
      return {
        ...prev,
        [planKey]: {
          ...dayMap,
          [dateISO]: dayItems,
        },
      };
    });
  }

  function updateTripActivity(
    planId: string | number,
    dateISO: string,
    activityId: string,
    updates: { title?: string; start?: string; end?: string; category?: string; notes?: string }
  ) {
    const planKey = String(planId);
    setTripSchedules((prev) => {
      const dayMap = { ...(prev[planKey] || {}) };
      const items = (dayMap[dateISO] || []).slice();
      const idx = items.findIndex((it) => it.id === activityId);
      if (idx === -1) return prev;
      const existing = items[idx];
      const existingStartHHMM = existing.startISO.slice(11, 16) || "09:00";
      const existingEndHHMM = existing.endISO
        ? existing.endISO.slice(11, 16)
        : minutesToHHMM(timeToMinutes(existingStartHHMM) + 60);
      const nextStartHHMM = updates.start
        ? normalizeHHMM(updates.start, existingStartHHMM)
        : existingStartHHMM;
      const nextEndHHMM = updates.end
        ? normalizeHHMM(updates.end, existingEndHHMM)
        : existingEndHHMM;
      const ensured = ensureEndAfterStart(nextStartHHMM, nextEndHHMM);
      const nextStart = `${dateISO}T${nextStartHHMM}:00`;
      const nextEnd = `${dateISO}T${ensured.end}:00`;
      const nextTitle =
        "title" in updates
          ? updates.title?.trim() || existing.title
          : existing.title;
      const nextCategory =
        "category" in updates
          ? updates.category || undefined
          : existing.category;
      const nextNotes =
        "notes" in updates
          ? updates.notes?.trim() || undefined
          : existing.notes;
      items[idx] = {
        ...existing,
        title: nextTitle,
        category: nextCategory,
        notes: nextNotes,
        startISO: nextStart,
        endISO: nextEnd,
      };
      dayMap[dateISO] = sortActivities(items);
      return {
        ...prev,
        [planKey]: dayMap,
      };
    });
  }

  function removeTripActivity(
    planId: string | number,
    dateISO: string,
    activityId: string
  ) {
    const planKey = String(planId);
    setTripSchedules((prev) => {
      const dayMap = { ...(prev[planKey] || {}) };
      const items = (dayMap[dateISO] || []).filter((it) => it.id !== activityId);
      if (!items.length) {
        if (!dayMap[dateISO]) return prev;
        delete dayMap[dateISO];
      } else {
        dayMap[dateISO] = items;
      }
      const next = { ...prev };
      if (Object.keys(dayMap).length === 0) {
        delete next[planKey];
      } else {
        next[planKey] = dayMap;
      }
      return next;
    });
  }

  return (
    <>
      {screen === "map" && (
        <MapScreen
          countries={countries}
          countryAnchors={countryAnchors}
          allCountries={allCountries}
          visited={visited}
          visits={visits}
          visitedList={visitedList}
          visitedCount={visitedCount}
          totalCountries={totalCountries}
          onAddVisit={addVisitById}
          getVisitCount={visitCountFor}
          mapStyle={mapStyle}
          showBorders={showBorders}
          showCountryNameLabels={showCountryNameLabels}
          showContinentNameLabels={showContinentNameLabels}
        />
      )}
      {screen === "trips" && (
        <TripsScreen
          plans={plans}
          allCountries={allCountries}
          reservations={reservations}
          schedules={tripSchedules}
          onAdd={(id, startISO, endISO) => addPlanFromPick(id, startISO, endISO)}
          onRemove={removePlan}
          onAddActivity={addTripActivity}
          onUpdateActivity={updateTripActivity}
          onRemoveActivity={removeTripActivity}
        />
      )}
      {screen === "reservations" && (
        <ReservationsScreen
          reservations={reservations}
          onImport={(items) => setReservations((prev) => mergeReservations(prev, items))}
          onAdd={(item) => setReservations((prev) => mergeReservations(prev, [item]))}
          onRemove={(id) => setReservations((prev) => prev.filter((r) => r.id !== id))}
        />
      )}
      {screen === "settings" && (
        <SettingsScreen
          mapStyle={mapStyle}
          onMapStyleChange={setMapStyle}
          showBorders={showBorders}
          onToggleBorders={() => setShowBorders((s) => !s)}
          showCountryNameLabels={showCountryNameLabels}
          onToggleCountryNames={() => setShowCountryNameLabels((s) => !s)}
          showContinentNameLabels={showContinentNameLabels}
          onToggleContinentNames={() => setShowContinentNameLabels((s) => !s)}
        />
      )}

      <TabBar current={screen} onChange={setScreen} />
    </>
  );
}

/* ============================== MAP SCREEN ============================== */
function MapScreen(props: {
  countries: CountryFeature[];
  countryAnchors: Anchor[];
  allCountries: { id: string | number; alpha2?: string; name: string; flag: string }[];
  visited: Set<string | number>;
  visits: VisitsMap;
  visitedList: { id: string | number; name: string; alpha2?: string; dates: string[] }[];
  visitedCount: number;
  totalCountries: number;
  onAddVisit: (id: string | number) => void;
  getVisitCount: (id: string | number) => number;
  mapStyle: MapStyle;
  showBorders: boolean;
  showCountryNameLabels: boolean;
  showContinentNameLabels: boolean;
}) {
  const {
    countries,
    countryAnchors,
    allCountries,
    visited,
    visits,
    visitedList,
    visitedCount,
    totalCountries,
    onAddVisit,
    getVisitCount,
    mapStyle,
    showBorders,
    showCountryNameLabels,
    showContinentNameLabels,
  } = props;

  const [homeQuery, setHomeQuery] = useState("");

  const topResults = useMemo(() => {
    const q = homeQuery.trim().toLowerCase();
    if (!q) return [] as typeof allCountries;
    return allCountries
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) || (c.alpha2 || "").toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [homeQuery, allCountries]);

  const [controlsDisabled, setControlsDisabled] = useState(false);
  const [altitude, setAltitude] = useState(1.8);
  const [camera, setCamera] = useState({ lat: 0, lng: 0 });
  const [countryLabelsOn, setCountryLabelsOn] = useState(false);
  const [continentLabelsOn, setContinentLabelsOn] = useState(true);

  useEffect(() => {
    setCountryLabelsOn((prev) => (prev ? altitude < COUNTRY_OFF : altitude < COUNTRY_ON));
  }, [altitude]);

  useEffect(() => {
    setContinentLabelsOn((prev) => (prev ? altitude > CONT_OFF : altitude > CONT_ON));
  }, [altitude]);

  const globeRef = useRef<any>(null);

  function focusCountryById(id: string | number) {
    const found = countryAnchors.find((c) => String(c.id) === String(id));
    if (!found || !globeRef.current) return;
    globeRef.current.pointOfView({ lat: found.lat, lng: found.lng, altitude: 1.1 }, 1000);
    setHomeQuery("");
  }

  function countryLabelCapForAltitude(a: number) {
    if (a >= 3.2) return 10;
    if (a >= 2.6) return 16;
    if (a >= 2.0) return 22;
    return 34;
  }

  function areaThreshold(a: number) {
    const t = Math.min(1, Math.max(0, (a - ALT_MIN) / (ALT_MAX - ALT_MIN)));
    return 0.00005 + 0.0015 * t;
  }

  const countriesFacingCamera = useMemo(() => {
    if (!countryLabelsOn || !showCountryNameLabels) return [] as Anchor[];
    const cap = countryLabelCapForAltitude(altitude);
    const ath = areaThreshold(altitude);
    const facing = countryAnchors
      .filter((c) => c.area >= ath)
      .filter((c) => angDist({ lat: c.lat, lng: c.lng }, camera) < (altitude > 2.6 ? 30 : 36))
      .sort((a, b) => b.area - a.area)
      .slice(0, cap);
    return facing;
  }, [countryAnchors, camera, countryLabelsOn, altitude, showCountryNameLabels]);

  const [hoverId, setHoverId] = useState<string | number | null>(null);
  const hoverAnchor = useMemo(() => {
    if (!hoverId) return null;
    return countryAnchors.find((c) => String(c.id) === String(hoverId)) || null;
  }, [hoverId, countryAnchors]);

  const labelData = useMemo(() => {
    const cont =
      continentLabelsOn && showContinentNameLabels
        ? CONTINENTS.map((d) => ({
            kind: "continent" as const,
            id: d.name,
            name: d.name,
            lat: d.lat,
            lng: d.lng,
            area: 99,
          }))
        : [];
    const cnts = countriesFacingCamera.map((d) => ({
      kind: "country" as const,
      id: d.id,
      name: d.name,
      lat: d.lat,
      lng: d.lng,
      area: d.area,
      visited: props.getVisitCount?.(d.id) ? 1 : 0,
    }));
    const hover =
      hoverAnchor && !cnts.some((c) => String(c.id) === String(hoverAnchor.id))
        ? [
            {
              kind: "country" as const,
              id: hoverAnchor.id,
              name: hoverAnchor.name,
              lat: hoverAnchor.lat,
              lng: hoverAnchor.lng,
              area: hoverAnchor.area,
              visited: 1,
            },
          ]
        : [];
    return [...cont, ...cnts, ...hover];
  }, [
    continentLabelsOn,
    showContinentNameLabels,
    countriesFacingCamera,
    hoverAnchor,
    props,
  ]);

  /* ---------- Countries log overlay state ---------- */
  const [showCountriesOverlay, setShowCountriesOverlay] = useState(false);
  const [overlayQuery, setOverlayQuery] = useState("");

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setShowCountriesOverlay(false);
    }
    if (showCountriesOverlay && typeof window !== "undefined")
      window.addEventListener("keydown", onEsc);
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("keydown", onEsc);
      }
    };
  }, [showCountriesOverlay]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const wrap = document.querySelector(".globe-wrap");
    if (!wrap) return;

    const els = Array.from(wrap.querySelectorAll<HTMLDivElement>(".globe-pill"));
    els.forEach((e) => {
      e.style.visibility = "visible";
    });

    type Entry = { el: HTMLDivElement; rect: DOMRect; prio: number };
    const entries: Entry[] = els
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const kind = el.dataset.kind || "country";
        const area = Number(el.dataset.area || "0");
        const visited = el.dataset.visited === "1";
        const isHover = el.dataset.hover === "1";
        let prio = 0;
        if (kind === "continent") prio += 1_000_000;
        if (visited) prio += 50_000;
        if (isHover) prio += 500_000;
        prio += area * 1_000_000;
        return { el, rect, prio };
      })
      .sort((a, b) => b.prio - a.prio);

    const kept: DOMRect[] = [];
    const margin = 6;
    const intersects = (a: DOMRect, b: DOMRect) =>
      !(
        a.right + margin < b.left ||
        b.right + margin < a.left ||
        a.bottom + margin < b.top ||
        b.bottom + margin < a.top
      );

    for (const e of entries) {
      if (e.el.dataset.kind === "continent") {
        kept.push(e.rect);
        continue;
      }
      if (e.el.dataset.hover === "1") {
        kept.push(e.rect);
        continue;
      }
      if (kept.some((r) => intersects(r, e.rect))) {
        e.el.style.visibility = "hidden";
      } else {
        kept.push(e.rect);
      }
    }
  }, [labelData, altitude]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <style>{`
        .top-search-input { color:#111 !important; }
        .top-search-input::placeholder { color:#6b7280 !important; }
        input, button { font-size: 16px; }
        .globe-wrap .globe-pill { pointer-events: none; color: #334155; background: rgba(255,255,255,0.94); border: 1px solid #e5e7eb; padding: 2px 8px; border-radius: 9999px; font-weight: 700; font-size: 12px; line-height: 1.2; white-space: nowrap; box-shadow: 0 6px 18px rgba(0,0,0,.08); transform-origin: center; -webkit-font-smoothing: antialiased; }
        .globe-wrap .globe-pill.country { color: #334155; }
        .globe-wrap .globe-pill.continent { color: #475569; font-weight: 800; }
      `}</style>

      {/* Top centered search */}
      <div
        style={{
          position: "fixed",
          top: "calc(10px + env(safe-area-inset-top, 0px))",
          left: 0,
          right: 0,
          zIndex: 120,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div style={{ width: "min(720px, 92vw)", position: "relative", pointerEvents: "auto" }}>
          <input
            className="top-search-input"
            type="search"
            placeholder="Search country…"
            value={homeQuery}
            onChange={(e) => setHomeQuery(e.target.value)}
            onFocus={() => setControlsDisabled(true)}
            onBlur={() => setControlsDisabled(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && topResults.length) focusCountryById(topResults[0].id);
            }}
            inputMode="search"
            autoCorrect="off"
            spellCheck={false}
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: 14,
              border: "1px solid #e9ecef",
              outline: "none",
              background: "rgba(255,255,255,0.95)",
              boxShadow: "0 8px 28px rgba(0,0,0,.12)",
            }}
          />
          {homeQuery && topResults.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                right: 0,
                background: "#fff",
                border: "1px solid #e9ecef",
                borderRadius: 12,
                overflow: "hidden",
                boxShadow: "0 12px 40px rgba(0,0,0,.18)",
              }}
              onMouseEnter={() => setControlsDisabled(true)}
              onMouseLeave={() => setControlsDisabled(false)}
            >
              {topResults.map(({ id, name, flag }) => (
                <button
                  key={String(id)}
                  onClick={() => focusCountryById(id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 12px",
                    background: "#fff",
                    border: 0,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontSize: 18, marginRight: 8, verticalAlign: "-2px" }}>{flag}</span>
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
</div>

      {/* Globe wrapper to host HTML labels */}
      <div className="globe-wrap" style={{ position: "absolute", inset: 0 }}>
        <GlobeView
          innerRef={globeRef}
          countries={countries}
          visited={visited}
          onCountryClick={(id) => onAddVisit(id)}
          labels={labelData}
          altitude={altitude}
          controlsDisabled={controlsDisabled || showCountriesOverlay}
          onPOVChange={(pov) => {
            setAltitude(pov.altitude ?? altitude);
            setCamera({ lat: pov.lat ?? camera.lat, lng: pov.lng ?? camera.lng });
          }}
          showBorders={showBorders}
          getVisitCount={getVisitCount}
          mapStyle={mapStyle}
          onHoverChange={(id) => setHoverId(id ?? null)}
        />
      </div>

      {/* Bottom-left Countries chip */}
      <button
        aria-label="Open countries list"
        onClick={() => setShowCountriesOverlay(true)}
        style={{
          position: "fixed",
          left: 12,
          bottom: "calc(80px + env(safe-area-inset-bottom, 0px))",
          zIndex: 120,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          background: "#fff",
          border: "1px solid #ddd",
          borderRadius: 999,
          boxShadow: "0 6px 18px rgba(0,0,0,0.08)",
          cursor: "pointer",
          userSelect: "none",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <strong>Countries</strong> <span style={{ opacity: 0.7 }}>• {visitedCount}</span>
      </button>

      {/* Countries overlay popup */}
      {showCountriesOverlay && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.25)",
            display: "grid",
            placeItems: "center",
            zIndex: 200,
          }}
          onClick={() => setShowCountriesOverlay(false)}
          onMouseEnter={() => setControlsDisabled(true)}
          onMouseLeave={() => setControlsDisabled(false)}
        >
          <div
            style={{
              width: "min(760px, 92vw)",
              maxHeight: "86vh",
              background: "#fff",
              borderRadius: 18,
              boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
              color: "#111",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                borderBottom: "1px solid #eee",
              }}
            >
              <h2 style={{ margin: 0, lineHeight: 1 }}>Countries</h2>
              <button
                onClick={() => setShowCountriesOverlay(false)}
                style={{
                  background: "#e9ecef",
                  border: 0,
                  padding: "8px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 16px",
                gap: 12,
                borderBottom: "1px solid #f0f0f0",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ProgressRing pct={(visitedCount / totalCountries) * 100} size={44} />
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {Math.round((visitedCount / totalCountries) * 100)}% visited
                  </div>
                  <div style={{ fontSize: 12, color: "#475569" }}>
                    {visitedCount} / {totalCountries}
                  </div>
                </div>
              </div>
              <div
                style={{
                  flex: "1 1 auto",
                  maxWidth: 280,
                  marginLeft: 8,
                  height: 8,
                  background: "#f1f3f5",
                  borderRadius: 999,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${(visitedCount / totalCountries) * 100}%`,
                    height: "100%",
                    background: "linear-gradient(90deg,#06b6d4,#0ea5a8)",
                  }}
                />
              </div>
            </div>

            <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0" }}>
              <input
                type="text"
                placeholder="Search country by name or code (e.g., Italy or IT)…"
                value={overlayQuery}
                onChange={(e) => setOverlayQuery(e.target.value)}
                inputMode="search"
                autoCorrect="off"
                spellCheck={false}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  fontSize: 16,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #e9ecef",
                  outline: "none",
                }}
              />
            </div>

            <div
              style={{
                padding: 16,
                overflow: "auto",
                flex: "1 1 auto",
                WebkitOverflowScrolling: "touch",
              }}
            >
              {overlayQuery.trim() ? (
                <>
                  <div style={{ fontWeight: 700, margin: "8px 0", color: "#0b7285" }}>
                    Search results
                  </div>
                  <SearchOrVisitedList
                    mode="search"
                    countries={allCountries.filter(
                      (c) =>
                        c.name.toLowerCase().includes(overlayQuery.trim().toLowerCase()) ||
                        (c.alpha2 || "").toLowerCase().includes(overlayQuery.trim().toLowerCase())
                    )}
                    visits={visits}
                    onAddDate={onAddVisit}
                  />
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, margin: "8px 0", color: "#0b7285" }}>
                    Visited Countries ({visitedCount})
                  </div>
                  <SearchOrVisitedList mode="visited" visitedList={visitedList} />
                </>
              )}

              <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                <button
                  onClick={() => {
                    if (window.confirm("Clear all visited countries + dates?")) {
                      try {
                        window.localStorage.removeItem(LS_VISITS_META);
                        window.localStorage.removeItem(LS_VISITS);
                      } finally {
                        window.location.reload();
                      }
                    }
                  }}
                  style={{
                    background: "#ffebee",
                    color: "#b71c1c",
                    border: "1px solid #e57373",
                    padding: "8px 10px",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  Clear All
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================ TRIPS SCREEN ============================ */

function TripsScreen(props: {
  plans: Plan[];
  allCountries: { id: string | number; alpha2?: string; name: string; flag: string }[];
  reservations: Reservation[];
  schedules: TripSchedules;
  onAdd: (id: string | number, startISO: string, endISO?: string) => void;
  onRemove: (index: number) => void;
  onAddActivity: (
    planId: string | number,
    dateISO: string,
    input: { title: string; start: string; end: string; category?: string; notes?: string }
  ) => void;
  onUpdateActivity: (
    planId: string | number,
    dateISO: string,
    activityId: string,
    updates: { title?: string; start?: string; end?: string; category?: string; notes?: string }
  ) => void;
  onRemoveActivity: (
    planId: string | number,
    dateISO: string,
    activityId: string
  ) => void;
}): JSX.Element {
  const {
    plans,
    allCountries,
    reservations,
    schedules,
    onAdd,
    onRemove,
    onAddActivity,
    onUpdateActivity,
    onRemoveActivity,
  } = props;
  const [planQuery, setPlanQuery] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<{ id: string | number; alpha2?: string; name: string; flag: string } | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [openTrip, setOpenTrip] = useState<Plan | null>(null);

  // Cover images saved locally per plan id (so we don't need parent mutator)
  const [coverMap, setCoverMap] = useState<Record<string, string>>({});

  const openTripSchedule = useMemo(() => {
    if (!openTrip) return {} as Record<string, TripActivity[]>;
    return schedules[String((openTrip as any).id)] || {};
  }, [openTrip, schedules]);

  const openTripReservations = useMemo(() => {
    if (!openTrip) return [] as Reservation[];
    const planId = String((openTrip as any).id);
    const start = new Date(openTrip.startISO + "T00:00:00");
    const end = new Date(
      ((openTrip as any).endISO || openTrip.startISO) + "T23:59:59"
    );
    const startMs = start.getTime();
    const endMs = end.getTime();
    return reservations
      .filter((r) => {
        if (String((r as any).planId || "") === planId) return true;
        const resStart = new Date(r.startISO).getTime();
        const resEnd = r.endISO
          ? new Date(r.endISO).getTime()
          : resStart;
        if (!Number.isFinite(resStart)) return false;
        return resStart <= endMs && resEnd >= startMs;
      })
      .sort((a, b) => a.startISO.localeCompare(b.startISO));
  }, [reservations, openTrip]);

  const suggestions = useMemo(() => {
    const q = planQuery.trim().toLowerCase();
    if (!q) return [] as { id: string | number; alpha2?: string; name: string; flag: string }[];
    return allCountries
      .filter(c => c.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [planQuery, allCountries]);

  function coverFor(id: string | number, fallback?: string) {
    return coverMap[String(id)] || fallback || "";
  }

  return (<>
    <div
      style={{
        position: "relative",
        width: "100%",
        minHeight: "calc(100svh - 76px)",
        background: "#fff",
        color: "#111827",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        padding: "16px 12px",
      }}
    >
      {/* Add trip bar */}
      <div style={{ position:"relative", marginBottom: 12 }}>
        <input
          type="search"
          placeholder="Search country to add a trip…"
          value={planQuery}
          onChange={(e) => setPlanQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && suggestions.length) {
              setSelectedCountry(suggestions[0]);
              setShowDatePicker(true);
            }
          }}
          style={{
            width: "100%",
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid #e5e7eb",
            outline: "none",
            fontSize: 15,
          }}
        />
        {planQuery.trim() && suggestions.length > 0 && !selectedCountry && (
          <div style={{ position:"absolute", left:0, right:0, top:"calc(100% + 6px)", border:"1px solid #e5e7eb", background:"#fff", borderRadius:12, boxShadow:"0 12px 40px rgba(0,0,0,.18)", zIndex:10, maxHeight:260, overflow:"auto" }}>
            {suggestions.map((c) => (
              <button
                key={String(c.id)}
                onClick={() => { setSelectedCountry(c); setPlanQuery(c.name); setShowDatePicker(true); }}
                style={{ display:"block", width:"100%", textAlign:"left", padding:"10px 12px", border:0, background:"#fff", cursor:"pointer" }}
              >
                <span style={{ marginRight:8 }}>{c.flag}</span>{c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Trips list */}
      <div style={{ fontWeight:900, fontSize:16, color:"#0f172a", marginBottom:8 }}>Planned trips</div>
      {plans.length === 0 ? (
        <div style={{ color:"#64748b" }}>No trips yet. Add one above.</div>
      ) : (
        <ul style={{ listStyle:"none", margin:0, padding:0, display:"grid", gap:12 }}>
          {plans.map((pl, idx) => {
            const cover = coverFor(pl.id, (pl as any).coverUrl);
            const daysLeft = Math.ceil((new Date(pl.startISO).getTime() - Date.now()) / (24*3600*1000));
            return (
              <li key={String(pl.id)}>
                <div style={{ border:"1px solid #e5e7eb", borderRadius:16, background:"#fff", overflow:"hidden" }}>
                  <div style={{ position:"relative", height: 140, background: cover ? `center/cover url(${cover})` : "#e2e8f0" }}>
                    <button
                      onClick={() => setOpenTrip(pl)}
                      style={{ position:"absolute", inset:0, border:0, background:"transparent", cursor:"pointer" }}
                      aria-label="Open trip"
                    />
                  </div>
                  <div style={{ padding:12, display:"grid", gap:6 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontSize:20 }}>{(pl as any).country?.flag || ""}</span>
                      <div style={{ fontWeight:800 }}>{(pl as any).country?.name || "Trip"}</div>
                      <div style={{ marginLeft:"auto", fontSize:12, color:"#64748b" }}>
                        {isFinite(daysLeft) ? (daysLeft >= 0 ? `${daysLeft} days` : `started`) : ""}
                      </div>
                    </div>
                    <div style={{ fontSize:12, color:"#475569" }}>
                      {pl.startISO} {(pl as any).endISO ? `→ ${(pl as any).endISO}` : ""}
                    </div>
                    <div style={{ display:"flex", gap:8, marginTop:4 }}>
                      <button onClick={() => setOpenTrip(pl)} style={{ border:"1px solid #e5e7eb", borderRadius:8, padding:"6px 10px" }}>Open</button>
                      <button onClick={() => onRemove(idx)} style={{ border:"1px solid #fee2e2", background:"#fef2f2", color:"#991b1b", borderRadius:8, padding:"6px 10px" }}>Remove</button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>

    {/* Date picker overlay */}
    {showDatePicker && selectedCountry && (
      <TripDatePicker
        country={selectedCountry}
        onConfirm={(startISO, endISO) => {
          onAdd(selectedCountry.id, startISO, endISO);
          setShowDatePicker(false);
          setSelectedCountry(null);
          setPlanQuery("");
        }}
        onClose={() => setShowDatePicker(false)}
      />
    )}

    {/* Trip details overlay with 24h timeline and Change cover */}
    {openTrip && (
      <TripDetailsOverlay
        plan={openTrip}
        reservations={openTripReservations}
        activitiesByDay={openTripSchedule}
        onAddActivity={(dateISO, payload) =>
          onAddActivity((openTrip as any).id, dateISO, payload)
        }
        onUpdateActivity={(dateISO, activityId, updates) =>
          onUpdateActivity((openTrip as any).id, dateISO, activityId, updates)
        }
        onRemoveActivity={(dateISO, activityId) =>
          onRemoveActivity((openTrip as any).id, dateISO, activityId)
        }
        coverUrl={coverFor((openTrip as any).id, (openTrip as any).coverUrl)}
        onChangeCover={(dataUrl) => setCoverMap(prev => ({ ...prev, [String((openTrip as any).id)]: dataUrl }))}
        onClose={() => setOpenTrip(null)}
      />
    )}
  </>);
}



function TripDatePicker({ country, onConfirm, onClose }: {
  country: { id: string | number; alpha2?: string; name: string; flag: string };
  onConfirm: (startISO: string, endISO?: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.40)", display:"grid", placeItems:"center", zIndex:600 }} onClick={onClose}>
      <div style={{ width:"min(440px,92vw)", background:"#fff", borderRadius:16, boxShadow:"0 24px 80px rgba(0,0,0,.35)", padding:16 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
          <div style={{ fontSize:24 }}>{country.flag}</div>
          <div style={{ fontWeight:800, fontSize:16 }}>{country.name}</div>
        </div>
        <div style={{ display:"grid", gap:8 }}>
          <label style={{ fontSize:12, color:"#475569" }}>Start date</label>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={{ padding:"10px 12px", borderRadius:10, border:"1px solid #e5e7eb" }} />
          <label style={{ fontSize:12, color:"#475569" }}>End date (optional)</label>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={{ padding:"10px 12px", borderRadius:10, border:"1px solid #e5e7eb" }} />
          <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:8 }}>
            <button onClick={onClose} style={{ padding:"8px 12px", borderRadius:10, border:"1px solid #e5e7eb" }}>Cancel</button>
            <button onClick={() => { if (!start) return; onConfirm(start, end || undefined); }} style={{ padding:"8px 12px", borderRadius:10, border:"1px solid #0ea5a8", backgroundImage:"linear-gradient(90deg,#06b6d4,#0ea5a8)", color:"#fff", fontWeight:800 }}>Add trip</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TripDetailsOverlay({
  plan,
  reservations,
  activitiesByDay,
  onAddActivity,
  onUpdateActivity,
  onRemoveActivity,
  coverUrl,
  onChangeCover,
  onClose,
}: {
  plan: Plan;
  reservations: Reservation[];
  activitiesByDay: Record<string, TripActivity[]>;
  onAddActivity: (
    dateISO: string,
    input: { title: string; start: string; end: string; category?: string; notes?: string }
  ) => void;
  onUpdateActivity: (
    dateISO: string,
    activityId: string,
    updates: { title?: string; start?: string; end?: string; category?: string; notes?: string }
  ) => void;
  onRemoveActivity: (dateISO: string, activityId: string) => void;
  coverUrl?: string;
  onChangeCover?: (dataUrl: string) => void;
  onClose: () => void;
}): JSX.Element {
  const dayList = useMemo(() => {
    const days: string[] = [];
    const start = new Date(plan.startISO + "T00:00:00");
    const end = new Date(((plan as any).endISO || plan.startISO) + "T00:00:00");
    for (let t = start.getTime(); t <= end.getTime(); t += 24 * 3600 * 1000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    return days;
  }, [plan.startISO, (plan as any).endISO]);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", display:"grid", placeItems:"center", zIndex:650 }} onClick={onClose}>
      <div style={{ width:"min(900px,96vw)", background:"#fff", borderRadius:16, boxShadow:"0 24px 80px rgba(0,0,0,.45)", padding:16, maxHeight:"90svh", overflow:"auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ fontSize:22 }}>{(plan as any).country?.flag || ""}</div>
            <div style={{ fontWeight:900 }}>{(plan as any).country?.name || "Trip"}</div>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <input id={"cover-file-"+String((plan as any).id)} type="file" accept="image/*" style={{ display:"none" }} onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f || !onChangeCover) return;
              const r = new FileReader();
              r.onload = () => onChangeCover(String(r.result));
              r.readAsDataURL(f);
            }} />
            <button onClick={() => { const el = document.getElementById("cover-file-"+String((plan as any).id)) as HTMLInputElement | null; el?.click(); }} style={{ border:"1px solid #e5e7eb", borderRadius:8, padding:"6px 10px" }}>Change cover</button>
            <button onClick={onClose} style={{ border:"1px solid #e5e7eb", borderRadius:8, padding:"6px 10px" }}>Close</button>
          </div>
        </div>

        <div style={{ height:220, marginTop:12, borderRadius:12, background: coverUrl ? `center/cover url(${coverUrl})` : "#e2e8f0" }} />

        <div style={{ marginTop:12, fontSize:12, color:"#475569" }}>{plan.startISO} {(plan as any).endISO ? `→ ${(plan as any).endISO}` : ""}</div>

        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: 12,
            marginTop: 12,
          }}
        >
          {dayList.map((d) => (
            <li
              key={d}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 16,
                background: "#f8fafc",
                padding: 0,
              }}
            >
              <DayPlanner
                dateISO={d}
                activities={activitiesByDay[d] || []}
                reservations={reservations}
                onAdd={(payload) => onAddActivity(d, payload)}
                onUpdate={(activityId, updates) =>
                  onUpdateActivity(d, activityId, updates)
                }
                onRemove={(activityId) => onRemoveActivity(d, activityId)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

type DayPlannerProps = {
  dateISO: string;
  activities: TripActivity[];
  reservations: Reservation[];
  onAdd: (input: {
    title: string;
    start: string;
    end: string;
    category?: string;
    notes?: string;
  }) => void;
  onUpdate: (
    activityId: string,
    updates: {
      title?: string;
      start?: string;
      end?: string;
      category?: string;
      notes?: string;
    }
  ) => void;
  onRemove: (activityId: string) => void;
};

const CATEGORY_OPTIONS = [
  { value: "experience", label: "Experience", icon: "🗺️" },
  { value: "meal", label: "Meal", icon: "🍽️" },
  { value: "travel", label: "Travel", icon: "🚆" },
  { value: "free", label: "Downtime", icon: "🧘" },
];

function categoryStyle(category?: string) {
  const key = category?.toLowerCase();
  switch (key) {
    case "meal":
      return {
        bg: "#fef3c7",
        border: "#fcd34d",
        text: "#92400e",
        badgeBg: "rgba(217, 119, 6, 0.12)",
        badgeText: "#92400e",
        label: "Meal",
        icon: "🍽️",
      };
    case "travel":
      return {
        bg: "#fee2e2",
        border: "#fca5a5",
        text: "#991b1b",
        badgeBg: "rgba(185, 28, 28, 0.12)",
        badgeText: "#991b1b",
        label: "Travel",
        icon: "🚆",
      };
    case "other":
      return {
        bg: "#f1f5f9",
        border: "#cbd5e1",
        text: "#0f172a",
        badgeBg: "rgba(15, 23, 42, 0.08)",
        badgeText: "#0f172a",
        label: "Custom",
        icon: "✨",
      };
    case "free":
      return {
        bg: "#e2e8f0",
        border: "#cbd5e1",
        text: "#1e293b",
        badgeBg: "rgba(30, 41, 59, 0.08)",
        badgeText: "#475569",
        label: "Downtime",
        icon: "🧘",
      };
    case "experience":
    default:
      return {
        bg: "#dcfce7",
        border: "#86efac",
        text: "#166534",
        badgeBg: "rgba(22, 101, 52, 0.12)",
        badgeText: "#166534",
        label: "Experience",
        icon: "🗺️",
      };
  }
}

function formatReservationType(type: ReservationType) {
  switch (type) {
    case "flight":
      return "Flight";
    case "hotel":
      return "Hotel";
    case "train":
      return "Train";
    case "event":
    default:
      return "Event";
  }
}

function DayPlanner({
  dateISO,
  activities,
  reservations,
  onAdd,
  onUpdate,
  onRemove,
}: DayPlannerProps): JSX.Element {
  const dayDate = useMemo(() => new Date(`${dateISO}T00:00:00`), [dateISO]);
  const headerLabel = dayDate.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sortedActivities = useMemo(
    () => activities.slice().sort((a, b) => a.startISO.localeCompare(b.startISO)),
    [activities]
  );

  const dayReservations = useMemo(
    () =>
      reservations.filter(
        (res) => clipRangeToDay(dateISO, res.startISO, res.endISO) !== null
      ),
    [reservations, dateISO]
  );

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    start: "09:00",
    end: "11:00",
    category: "experience",
    notes: "",
  });

  const resetDraft = () => {
    setDraft({ title: "", start: "09:00", end: "11:00", category: "experience", notes: "" });
    setEditingId(null);
  };

  const beginEdit = (activity: TripActivity) => {
    setShowForm(true);
    setEditingId(activity.id);
    setDraft({
      title: activity.title,
      start: activity.startISO.slice(11, 16),
      end: activity.endISO.slice(11, 16),
      category: activity.category || "experience",
      notes: activity.notes || "",
    });
  };

  const cancelForm = () => {
    resetDraft();
    setShowForm(false);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    const start = normalizeHHMM(draft.start);
    const endNormalized = normalizeHHMM(draft.end, start);
    const ensured = ensureEndAfterStart(start, endNormalized);
    const payload = {
      title,
      start,
      end: ensured.end,
      category: draft.category,
      notes: draft.notes.trim() || undefined,
    };
    if (editingId) {
      onUpdate(editingId, payload);
    } else {
      onAdd(payload);
    }
    resetDraft();
    setShowForm(false);
  };

  const pxPerHour = 36;
  const pxPerMinute = pxPerHour / 60;
  const timelineHeight = pxPerHour * 24;

  const timelineBlocks = useMemo(() => {
    const blocks: {
      id: string;
      top: number;
      height: number;
      title: string;
      subtitle?: string;
      bg: string;
      border: string;
      text: string;
      badge?: string;
      badgeBg?: string;
      badgeText?: string;
      icon?: string;
    }[] = [];

    const formatRange = (startISO: string, endISO?: string) => {
      const start = startISO.slice(11, 16);
      const end = (endISO || startISO).slice(11, 16);
      return `${start} – ${end}`;
    };

    dayReservations.forEach((res) => {
      const clipped = clipRangeToDay(dateISO, res.startISO, res.endISO);
      if (!clipped) return;
      const { startMin, endMin } = clipped;
      const title = res.title || formatReservationType(res.type);
      const subtitleParts = [
        formatRange(res.startISO, res.endISO),
        formatReservationType(res.type),
      ];
      if (res.location?.city) subtitleParts.push(res.location.city);
      const subtitle = subtitleParts.join(" · ");
      blocks.push({
        id: `res-${res.id}`,
        top: startMin * pxPerMinute,
        height: Math.max(34, (endMin - startMin) * pxPerMinute),
        title,
        subtitle,
        bg: "#dbeafe",
        border: "#93c5fd",
        text: "#1d4ed8",
        badge: "Reservation",
        badgeBg: "rgba(59,130,246,0.14)",
        badgeText: "#1d4ed8",
        icon: "📌",
      });
    });

    sortedActivities.forEach((activity) => {
      const clipped = clipRangeToDay(
        dateISO,
        activity.startISO,
        activity.endISO
      );
      if (!clipped) return;
      const { startMin, endMin } = clipped;
      const style = categoryStyle(activity.category);
      const subtitleParts = [
        `${activity.startISO.slice(11, 16)} – ${activity.endISO.slice(11, 16)}`,
      ];
      if (activity.notes) subtitleParts.push(activity.notes);
      blocks.push({
        id: `act-${activity.id}`,
        top: startMin * pxPerMinute,
        height: Math.max(40, (endMin - startMin) * pxPerMinute),
        title: activity.title,
        subtitle: subtitleParts.join(" · "),
        bg: style.bg,
        border: style.border,
        text: style.text,
        badge: style.label,
        badgeBg: style.badgeBg,
        badgeText: style.badgeText,
        icon: style.icon,
      });
    });

    return blocks.sort((a, b) => a.top - b.top);
  }, [sortedActivities, dayReservations, dateISO, pxPerMinute]);

  const disableSubmit = !draft.title.trim();

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>{headerLabel}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              background: "#e0f2fe",
              color: "#0369a1",
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {dayReservations.length} reservation{dayReservations.length === 1 ? "" : "s"}
          </span>
          <span
            style={{
              background: "#dcfce7",
              color: "#15803d",
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {sortedActivities.length} planned item{sortedActivities.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 12 }}>
        <div
          style={{
            display: "grid",
            gridTemplateRows: `repeat(24, ${pxPerHour}px)`,
            justifyItems: "flex-end",
            fontSize: 11,
            color: "#94a3b8",
            paddingTop: 2,
            rowGap: 0,
          }}
        >
          {Array.from({ length: 24 }).map((_, hour) => (
            <div key={hour}>{String(hour).padStart(2, "0")}:00</div>
          ))}
        </div>
        <div
          style={{
            position: "relative",
            border: "1px solid #e2e8f0",
            borderRadius: 16,
            height: timelineHeight,
            background: "#f8fafc",
            overflow: "hidden",
          }}
        >
          {Array.from({ length: 25 }).map((_, idx) => (
            <div
              key={`hour-${idx}`}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: idx * pxPerHour,
                borderTop: idx === 0 ? "none" : "1px solid rgba(148,163,184,0.28)",
              }}
            />
          ))}
          {Array.from({ length: 24 }).map((_, idx) => (
            <div
              key={`half-${idx}`}
              style={{
                position: "absolute",
                left: 8,
                right: 8,
                top: idx * pxPerHour + pxPerHour / 2,
                borderTop: "1px dashed rgba(148,163,184,0.2)",
              }}
            />
          ))}
          {timelineBlocks.map((block) => (
            <div
              key={block.id}
              style={{
                position: "absolute",
                left: 10,
                right: 10,
                top: block.top,
                height: block.height,
                background: block.bg,
                border: `1px solid ${block.border}`,
                color: block.text,
                borderRadius: 14,
                padding: "10px 12px",
                boxShadow: "0 14px 30px rgba(15, 23, 42, 0.08)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {block.icon && <span>{block.icon}</span>}
                  {block.title}
                </span>
                {block.badge && (
                  <span
                    style={{
                      background: block.badgeBg || "rgba(15,23,42,0.06)",
                      color: block.badgeText || "#0f172a",
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  >
                    {block.badge}
                  </span>
                )}
              </div>
              {block.subtitle && (
                <div style={{ fontSize: 11, color: "rgba(15,23,42,0.7)" }}>
                  {block.subtitle}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Planned items</div>
        {sortedActivities.length === 0 ? (
          <div style={{ fontSize: 13, color: "#64748b" }}>
            No custom plans yet. Add ideas below to build your perfect day.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {sortedActivities.map((activity) => {
              const style = categoryStyle(activity.category);
              return (
                <div
                  key={activity.id}
                  style={{
                    border: `1px solid ${style.border}`,
                    background: "#fff",
                    borderRadius: 14,
                    padding: "12px 14px",
                    display: "grid",
                    gap: 6,
                    boxShadow: "0 10px 30px rgba(15,23,42,0.05)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontWeight: 700, color: "#0f172a", display: "flex", gap: 8, alignItems: "center" }}>
                      <span>{style.icon}</span>
                      <span>{activity.title}</span>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => beginEdit(activity)}
                        style={{
                          border: "1px solid #cbd5e1",
                          background: "#f8fafc",
                          borderRadius: 999,
                          padding: "4px 10px",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => onRemove(activity.id)}
                        style={{
                          border: "1px solid #fecaca",
                          background: "#fee2e2",
                          color: "#b91c1c",
                          borderRadius: 999,
                          padding: "4px 10px",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "#1e293b" }}>
                    {activity.startISO.slice(11, 16)} – {activity.endISO.slice(11, 16)}
                    {style.label ? ` · ${style.label}` : ""}
                  </div>
                  {activity.notes && (
                    <div style={{ fontSize: 12, color: "#475569" }}>{activity.notes}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Reservations</div>
        {dayReservations.length === 0 ? (
          <div style={{ fontSize: 13, color: "#64748b" }}>
            No reservations block this day yet.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {dayReservations.map((res) => (
              <div
                key={res.id}
                style={{
                  border: "1px solid #bfdbfe",
                  background: "#eff6ff",
                  borderRadius: 12,
                  padding: "10px 12px",
                  display: "grid",
                  gap: 4,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 700, color: "#1d4ed8" }}>
                  {res.title || formatReservationType(res.type)}
                </div>
                <div style={{ color: "#1e3a8a" }}>
                  {res.startISO.slice(11, 16)} – {(res.endISO || res.startISO).slice(11, 16)}
                  {res.location?.city ? ` · ${res.location.city}` : ""}
                </div>
                {res.notes && (
                  <div style={{ color: "#334155" }}>{res.notes}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          border: "1px dashed #cbd5e1",
          borderRadius: 16,
          padding: "16px",
          background: showForm ? "#ffffff" : "#f8fafc",
          display: "grid",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>
            {editingId ? "Update plan item" : "Add to this day"}
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              style={{
                border: "1px solid #38bdf8",
                background: "linear-gradient(135deg,#06b6d4,#0ea5a8)",
                color: "#fff",
                borderRadius: 999,
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Plan something
            </button>
          )}
        </div>
        {showForm && (
          <form onSubmit={handleSubmit} style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>Title</label>
              <input
                value={draft.title}
                onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="e.g. TeamLab Planets"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #cbd5e1",
                  fontSize: 13,
                }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 12 }}>
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>Start</label>
                <input
                  value={draft.start}
                  onChange={(e) => setDraft((prev) => ({ ...prev, start: e.target.value }))}
                  type="time"
                  style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1" }}
                />
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>End</label>
                <input
                  value={draft.end}
                  onChange={(e) => setDraft((prev) => ({ ...prev, end: e.target.value }))}
                  type="time"
                  style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1" }}
                />
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>Category</label>
                <select
                  value={draft.category}
                  onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
                  style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 13 }}
                >
                  {CATEGORY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.icon} {opt.label}
                    </option>
                  ))}
                  <option value="other">✨ Something else</option>
                </select>
              </div>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>Notes</label>
              <textarea
                value={draft.notes}
                onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))}
                rows={3}
                placeholder="Add details, confirmation numbers, meeting points…"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #cbd5e1",
                  fontSize: 13,
                  resize: "vertical",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={cancelForm}
                style={{
                  border: "1px solid #cbd5e1",
                  background: "#f8fafc",
                  borderRadius: 999,
                  padding: "6px 14px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={disableSubmit}
                style={{
                  border: "none",
                  background: disableSubmit
                    ? "#cbd5e1"
                    : "linear-gradient(135deg,#06b6d4,#0ea5a8)",
                  color: disableSubmit ? "#fff" : "#fff",
                  borderRadius: 999,
                  padding: "6px 18px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: disableSubmit ? "not-allowed" : "pointer",
                  opacity: disableSubmit ? 0.7 : 1,
                }}
              >
                {editingId ? "Save changes" : "Add to plan"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ======================== RESERVATIONS SCREEN ======================== */
function ReservationsScreen(props: {
  reservations: Reservation[];
  onImport: (items: Reservation[]) => void;
  onAdd: (item: Reservation) => void;
  onRemove: (id: string) => void;
}) {
  const { reservations, onImport, onAdd, onRemove } = props;
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<ReservationType>("flight");
  const [formTitle, setFormTitle] = useState("");
  const [formStart, setFormStart] = useState("");
  const [formEnd, setFormEnd] = useState("");
  const [formLocation, setFormLocation] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [flightNo, setFlightNo] = useState("");
  const [fromIATA, setFromIATA] = useState("");
  const [toIATA, setToIATA] = useState("");
  const [pnr, setPNR] = useState("");

  function resetForm() {
    setFormType("flight");
    setFormTitle("");
    setFormStart("");
    setFormEnd("");
    setFormLocation("");
    setFormNotes("");
    setFlightNo("");
    setFromIATA("");
    setToIATA("");
    setPNR("");
  }

  function handleAdd() {
    if (!formStart || !formTitle) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base: Reservation = {
      id,
      type: formType,
      startISO: formStart,
      endISO: formEnd || undefined,
      title: formTitle,
      location: formLocation ? { city: formLocation } : undefined,
      notes: formNotes || undefined,
      meta:
        formType === "flight"
          ? {
              flightNo: flightNo || undefined,
              fromIATA: fromIATA || undefined,
              toIATA: toIATA || undefined,
              pnr: pnr || undefined,
            }
          : undefined,
    };
    onAdd(base);
    setShowForm(false);
    resetForm();
  }

  async function onICSSelected(file: File) {
    const txt = await file.text();
    const events = parseICS(txt);
    const mapped = events.map(icsToReservation).filter(Boolean) as Reservation[];
    onImport(mapped);
  }

  const grouped = useMemo(() => {
    const arr = [...reservations].sort(
      (a, b) => new Date(a.startISO).getTime() - new Date(b.startISO).getTime()
    );
    const byDay = new Map<string, Reservation[]>();
    for (const r of arr) {
      const d = new Date(r.startISO);
      const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(r);
    }
    return Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [reservations]);

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        background: "#fff",
        color: "#111827",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        .res-actions { display:flex; gap:8px; flex-wrap:wrap; }
        .res-file { position: relative; display:inline-block; }
        .res-file input[type=file]{ position:absolute; inset:0; opacity:0; cursor:pointer; }
        .ticket { border:1px solid #e8eef2; border-radius:16px; box-shadow:0 12px 40px rgba(0,0,0,.06); overflow:hidden; background:#fff; }
        .ticket .row { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; }
        .ticket .top { background:linear-gradient(90deg,#06b6d4,#0ea5a8); color:#fff; font-weight:800; }
        .ticket .code { font-size:24px; letter-spacing:1px; }
        .chip { display:inline-block; padding:4px 8px; border-radius:999px; border:1px solid #e5e7eb; background:#f8fafc; font-size:12px; color:#334155; }
      `}</style>

      <div
        style={{
          padding: "14px 16px",
          paddingTop: "calc(14px + env(safe-area-inset-top, 0px))",
          borderBottom: "1px solid #eee",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 style={{ margin: 0 }}>Reservations</h2>
        <div className="res-actions">
          <label className="res-file">
            <span className="chip">Import .ics</span>
            <input
              type="file"
              accept=".ics,text/calendar"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onICSSelected(f);
                (e.currentTarget as HTMLInputElement).value = "";
              }}
            />
          </label>
          <button
            onClick={() => setShowForm((s) => !s)}
            className="chip"
            style={{ background: showForm ? "#dcfce7" : "#f8fafc" }}
          >
            {showForm ? "Close form" : "Add reservation"}
          </button>
        </div>
      </div>

      {showForm && (
        <div style={{ padding: 12, borderBottom: "1px solid #eef2f7", display: "grid", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr", gap: 8 }}>
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value as ReservationType)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
            >
              <option value="flight">Flight</option>
              <option value="hotel">Hotel</option>
              <option value="train">Train</option>
              <option value="event">Event</option>
            </select>
            <input
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              placeholder={formType === "flight" ? "e.g., BA 1423 LHR → CDG" : "Title"}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
            />
            <input
              value={formLocation}
              onChange={(e) => setFormLocation(e.target.value)}
              placeholder="Location / City"
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input
              type="datetime-local"
              value={formStart}
              onChange={(e) => setFormStart(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
            />
            <input
              type="datetime-local"
              value={formEnd}
              onChange={(e) => setFormEnd(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
            />
          </div>

          {formType === "flight" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
              <input
                value={flightNo}
                onChange={(e) => setFlightNo(e.target.value)}
                placeholder="Flight No (e.g., BA1423)"
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
              />
              <input
                value={fromIATA}
                onChange={(e) => setFromIATA(e.target.value.toUpperCase())}
                placeholder="From (IATA)"
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
              />
              <input
                value={toIATA}
                onChange={(e) => setToIATA(e.target.value.toUpperCase())}
                placeholder="To (IATA)"
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
              />
              <input
                value={pnr}
                onChange={(e) => setPNR(e.target.value.toUpperCase())}
                placeholder="PNR"
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef" }}
              />
            </div>
          )}

          <textarea
            value={formNotes}
            onChange={(e) => setFormNotes(e.target.value)}
            placeholder="Notes"
            rows={3}
            style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #e9ecef", resize: "vertical" }}
          />

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => { resetForm(); setShowForm(false); }} className="chip">
              Cancel
            </button>
            <button
              onClick={handleAdd}
              className="chip"
              style={{ background: "#e6fffb", borderColor: "#0ea5a8", color: "#0b7285", fontWeight: 800 }}
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div style={{ padding: 12, overflow: "auto", flex: "1 1 auto" }}>
        {grouped.length === 0 ? (
          <p style={{ color: "#475569", margin: 0 }}>
            No reservations yet. Import an .ics file or add one manually.
          </p>
        ) : (
          grouped.map(([dayISO, items]) => (
            <div key={dayISO} style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontWeight: 800,
                  color: "#0b7285",
                  background: "#e7f5ff",
                  padding: "4px 10px",
                  borderRadius: 999,
                  display: "inline-block",
                  marginBottom: 8,
                }}
              >
                {new Date(dayISO).toLocaleDateString()}
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                {items.map((r) => (
                  <ReservationCard key={r.id} r={r} onRemove={() => onRemove(r.id)} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ReservationCard({ r, onRemove }: { r: Reservation; onRemove: () => void }) {
  const start = new Date(r.startISO);
  const end = r.endISO ? new Date(r.endISO) : null;
  const range = end
    ? `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.ceil(
    (start.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000
  );

  if (r.type === "flight") {
    const fno = r.meta?.flightNo || (r.title.match(/[A-Z]{2,3}\s?\d{2,4}/)?.[0] ?? "");
    const from = r.meta?.fromIATA || r.title.match(/\((?<iata>[A-Z]{3})\).*?→/u)?.groups?.iata;
    const to = r.meta?.toIATA || r.title.match(/→.*?\((?<iata>[A-Z]{3})\)/u)?.groups?.iata;
    const pnr = r.meta?.pnr;
    return (
      <div className="ticket">
        <div className="row top">
          <div className="code">{from || "???"} → {to || "???"}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {pnr && (
              <span
                className="chip"
                style={{ background: "rgba(255,255,255,.18)", borderColor: "rgba(255,255,255,.35)", color: "#fff" }}
              >
                PNR {pnr}
              </span>
            )}
            {fno && (
              <span
                className="chip"
                style={{ background: "rgba(255,255,255,.18)", borderColor: "rgba(255,255,255,.35)", color: "#fff" }}
              >
                {fno}
              </span>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <div style={{ fontWeight: 800 }}>
            {start.toLocaleDateString()} <span style={{ opacity: 0.7, fontWeight: 600 }}>{range}</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="chip" style={{ background: "#f1f5f9" }}>
              {days < 0 ? `${Math.abs(days)}d ago` : `in ${days}d`}
            </span>
            <button
              onClick={onRemove}
              className="chip"
              style={{ background: "#fee2e2", borderColor: "#fecaca", color: "#991b1b" }}
            >
              Remove
            </button>
          </div>
        </div>
        {r.notes && (
          <div className="row" style={{ paddingTop: 0, color: "#475569" }}>
            {r.notes}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="ticket">
      <div className="row top">
        <div style={{ fontWeight: 800 }}>{r.type.toUpperCase()}</div>
        <div style={{ fontWeight: 700 }}>{r.location?.city || r.location?.country || ""}</div>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div style={{ fontWeight: 800 }}>{r.title}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="chip" style={{ background: "#f1f5f9" }}>
            {start.toLocaleDateString()} {r.endISO ? (<>
              • {new Date(r.endISO).toLocaleDateString()}
            </>) : null}
          </span>
          <button
            onClick={onRemove}
            className="chip"
            style={{ background: "#fee2e2", borderColor: "#fecaca", color: "#991b1b" }}
          >
            Remove
          </button>
        </div>
      </div>
      {r.notes && (
        <div className="row" style={{ paddingTop: 0, color: "#475569" }}>
          {r.notes}
        </div>
      )}
    </div>
  );
}

/* --------------------- ICS parse + mapping helpers -------------------- */
function foldICSLines(text: string) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseICSTimestamp(raw: string): string | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = "00", mm = "00", ss = "00", z] = m;
  const iso = `${y}-${mo}-${d}T${hh}:${mm}:${ss}${z ? "Z" : ""}`;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function parseICS(text: string): Array<{
  uid?: string;
  summary?: string;
  location?: string;
  description?: string;
  dtstart?: string;
  dtend?: string;
}> {
  const flat = foldICSLines(text);
  const events: Array<any> = [];
  const blocks = flat.split(/\n(?=BEGIN:VEVENT)/);
  for (const b of blocks) {
    if (!/BEGIN:VEVENT/.test(b)) continue;
    const ev: any = {};
    for (const line of b.split(/\n/)) {
      if (line.startsWith("SUMMARY")) ev.summary = line.split(":").slice(1).join(":").trim();
      else if (line.startsWith("LOCATION")) ev.location = line.split(":").slice(1).join(":").trim();
      else if (line.startsWith("DESCRIPTION")) ev.description = line.split(":").slice(1).join(":").trim();
      else if (line.startsWith("UID")) ev.uid = line.split(":").slice(1).join(":").trim();
      else if (/^DTSTART/.test(line)) ev.dtstart = parseICSTimestamp(line.split(":").pop()!.trim());
      else if (/^DTEND/.test(line)) ev.dtend = parseICSTimestamp(line.split(":").pop()!.trim());
    }
    if (ev.dtstart || ev.summary) events.push(ev);
  }
  return events;
}

function icsToReservation(ev: {
  uid?: string;
  summary?: string;
  location?: string;
  description?: string;
  dtstart?: string;
  dtend?: string;
}): Reservation | null {
  const id = ev.uid || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startISO = ev.dtstart || new Date().toISOString();
  const endISO = ev.dtend;
  const title = ev.summary || ev.location || "Reservation";
  const notes = ev.description;
  const s = (ev.summary || "").toUpperCase();
  const loc = ev.location || "";
  const isFlight = /\b([A-Z]{2,3})\s?\d{2,4}\b/.test(s) || /FLIGHT/.test(s);
  const isHotel = /HOTEL|CHECK-IN|CHECK IN|RESORT|LODGE/i.test(s + " " + loc);
  const isTrain = /TRAIN|RAIL|ICE|TGV|AVE|EUROSTAR/i.test(s + " " + loc);

  if (isFlight) {
    const flightNo = (s.match(/\b[A-Z]{2,3}\s?\d{2,4}\b/) || [""])[0].replace(/\s+/g, "");
    const fromIATA = (s.match(/\(([A-Z]{3})\).*?→/) || ["", ""])[1] || undefined;
    const toIATA = (s.match(/→.*?\(([A-Z]{3})\)/) || ["", ""])[1] || undefined;
    const pnrMatch = (ev.description || "").match(/\b([A-Z0-9]{5,7})\b/);
    return {
      id,
      type: "flight",
      startISO,
      endISO,
      title,
      notes,
      meta: { flightNo: flightNo || undefined, fromIATA, toIATA, pnr: pnrMatch?.[1] },
    };
  }

  if (isHotel) {
    return { id, type: "hotel", startISO, endISO, title, notes, location: { city: loc } };
  }
  if (isTrain) {
    return { id, type: "train", startISO, endISO, title, notes, location: { city: loc } };
  }
  return { id, type: "event", startISO, endISO, title, notes, location: { city: loc } };
}

function mergeReservations(existing: Reservation[], incoming: Reservation[]): Reservation[] {
  const byKey = new Map<string, Reservation>();
  const keyOf = (r: Reservation) => `${r.type}|${r.startISO}|${r.endISO || ""}|${r.meta?.flightNo || r.title}`;
  for (const r of existing) byKey.set(keyOf(r), r);
  for (const r of incoming) {
    byKey.set(keyOf(r), r);
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(a.startISO).getTime() - new Date(b.startISO).getTime()
  );
}

/* =========================== SETTINGS SCREEN =========================== */
function SettingsScreen(props: {
  mapStyle: MapStyle;
  onMapStyleChange: (s: MapStyle) => void;
  showBorders: boolean;
  onToggleBorders: () => void;
  showCountryNameLabels: boolean;
  onToggleCountryNames: () => void;
  showContinentNameLabels: boolean;
  onToggleContinentNames: () => void;
}) {
  const {
    mapStyle,
    onMapStyleChange,
    showBorders,
    onToggleBorders,
    showCountryNameLabels,
    onToggleCountryNames,
    showContinentNameLabels,
    onToggleContinentNames,
  } = props;

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        background: "#fff",
        color: "#111827",
        overflowX: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        .settings-scroll { overflow: auto; -webkit-overflow-scrolling: touch; padding-bottom: calc(70px + env(safe-area-inset-bottom, 0px)); }
        .toggle-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 8px; border-top: 1px dashed #eee; gap: 12px; }
        .toggle-row span { flex: 1; }
        input, button { font-size: 16px; }
      `}</style>

      <div style={{ padding: "14px 16px", paddingTop: "calc(14px + env(safe-area-inset-top, 0px))", borderBottom: "1px solid #eee" }}>
        <h2 style={{ margin: 0 }}>Settings</h2>
      </div>

      <div className="settings-scroll" style={{ padding: 12, display: "grid", gap: 12 }}>
        <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Map style</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => onMapStyleChange("earth")}
              style={{ padding: "10px 12px", borderRadius: 999, border: "1px solid #ddd", background: mapStyle === "earth" ? "#e6fffb" : "#fff" }}
            >
              🌎 Earth (imagery)
            </button>
            <button
              onClick={() => onMapStyleChange("plain")}
              style={{ padding: "10px 12px", borderRadius: 999, border: "1px solid #ddd", background: mapStyle === "plain" ? "#e6fffb" : "#fff" }}
            >
              🗺️ Plain (vector)
            </button>
          </div>
        </div>

        <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Labels & borders</div>
          <div className="toggle-row">
            <span>Show country names</span>
            <button
              onClick={onToggleCountryNames}
              style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid #ddd", background: showCountryNameLabels ? "#dcfce7" : "#f1f5f9", fontWeight: 700, minWidth: 84 }}
            >
              {showCountryNameLabels ? "On" : "Off"}
            </button>
          </div>
          <div className="toggle-row">
            <span>Show continent names</span>
            <button
              onClick={onToggleContinentNames}
              style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid #ddd", background: showContinentNameLabels ? "#dcfce7" : "#f1f5f9", fontWeight: 700, minWidth: 84 }}
            >
              {showContinentNameLabels ? "On" : "Off"}
            </button>
          </div>
          <div className="toggle-row">
            <span>Show borders</span>
            <button
              onClick={onToggleBorders}
              style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid #ddd", background: showBorders ? "#dcfce7" : "#f1f5f9", fontWeight: 700, minWidth: 84 }}
            >
              {showBorders ? "On" : "Off"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =============================== TAB BAR =============================== */
function TabBar({ current, onChange }: { current: Screen; onChange: (s: Screen) => void }) {
  const items: { key: Screen; label: string; icon: string }[] = [
    { key: "map", label: "Map", icon: "🧭" },
    { key: "trips", label: "Trips", icon: "🛫" },
    { key: "reservations", label: "Reservations", icon: "🎟️" },
    { key: "settings", label: "Settings", icon: "⚙️" },
  ];
  return (
    <nav
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 80,
        background: "#fff",
        borderTop: "1px solid #e5e7eb",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", maxWidth: 560, margin: "0 auto" }}>
        {items.map((it) => {
          const active = current === it.key;
          return (
            <button
              key={it.key}
              onClick={() => onChange(it.key)}
              style={{
                padding: "10px 8px",
                background: "transparent",
                border: 0,
                borderTop: active ? "3px solid #0ea5a8" : "3px solid transparent",
                color: active ? "#0ea5a8" : "#334155",
                fontWeight: active ? 800 : 600,
              }}
            >
              <div style={{ fontSize: 18 }}>{it.icon}</div>
              <div style={{ fontSize: 12 }}>{it.label}</div>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* =============================== LISTS =============================== */
function SearchOrVisitedList(props: {
  mode: "search" | "visited";
  countries?: { id: string | number; name: string; alpha2?: string; flag: string }[];
  visits?: VisitsMap;
  visitedList?: { id: string | number; name: string; alpha2?: string; dates: string[] }[];
  onAddDate?: (id: string | number) => void;
}) {
  if (props.mode === "search") {
    const countries = props.countries || [];
    const visits = props.visits || {};
    if (countries.length === 0) return <p>No matches.</p>;
    return (
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {countries.map(({ id, name, flag }) => {
          const logged = visits[String(id)];
          const isVisited = !!logged;
          const byYear = isVisited ? groupDatesByYear(logged.dates) : ({} as Record<string, string[]>);
          const years = isVisited ? Object.keys(byYear).sort((a, b) => Number(b) - Number(a)) : [];
          return (
            <li key={String(id)} style={{ padding: "6px 0", borderBottom: "1px solid #eee" }}>
              <div style={{ display: "grid", gridTemplateColumns: "36px 1fr", gap: 10 }}>
                <div style={{ fontSize: 20, lineHeight: "36px" }}>{flag}</div>
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: "#374151" }}>{name}</div>
                  {isVisited ? (
                    <div style={{ display: "grid", gap: 6 }}>
                      {years.map((y) => (
                        <div key={y} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 8 }}>
                          <div
                            style={{
                              fontWeight: 700,
                              color: "#0b7285",
                              background: "#e7f5ff",
                              padding: "2px 8px",
                              borderRadius: 999,
                              fontSize: 12,
                              width: "max-content",
                            }}
                          >
                            {y}
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {byYear[y].map((m) => (
                              <span
                                key={m + y}
                                style={{
                                  padding: "2px 8px",
                                  borderRadius: 999,
                                  background: "#f1f3f5",
                                  color: "#475569",
                                  fontSize: 12,
                                  border: "1px solid #e9ecef",
                                }}
                              >
                                {m}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#666", fontSize: 13 }}>
                      Not logged yet
                      <button
                        onClick={() => props.onAddDate?.(id)}
                        style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid #0b7285", background: "#fff", color: "#0b7285", cursor: "pointer" }}
                      >
                        Add date
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  const visitedList = props.visitedList || [];
  if (visitedList.length === 0)
    return <p>No countries logged yet. Click a country and enter month &amp; year.</p>;

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {visitedList.map(({ id, name, alpha2, dates }) => {
        const byYear = groupDatesByYear(dates);
        const years = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));
        const flag = flagFromAlpha2(alpha2);
        return (
          <li key={String(id)} style={{ padding: "6px 0", borderBottom: "1px solid #eee" }}>
            <div style={{ display: "grid", gridTemplateColumns: "36px 1fr", gap: 10 }}>
              <div style={{ fontSize: 20, lineHeight: "36px" }}>{flag}</div>
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ fontWeight: 600, fontSize: 15, color: "#374151" }}>{name}</div>
                <div style={{ display: "grid", gap: 6 }}>
                  {years.map((y) => (
                    <div key={y} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 8 }}>
                      <div
                        style={{
                          fontWeight: 700,
                          color: "#0b7285",
                          background: "#e7f5ff",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 12,
                          width: "max-content",
                        }}
                      >
                        {y}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {byYear[y].map((m) => (
                          <span
                            key={m + y}
                            style={{
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "#f1f3f5",
                              color: "#475569",
                              fontSize: 12,
                              border: "1px solid #e9ecef",
                            }}
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ================================ GLOBE ================================ */
function GlobeView(props: {
  innerRef: any;
  countries: CountryFeature[];
  visited: Set<string | number>;
  onCountryClick: (id: string | number) => void;
  labels: Array<{
    kind: "continent" | "country";
    id: string | number;
    name: string;
    lat: number;
    lng: number;
    area?: number;
    visited?: number;
    hover?: number;
  }>;
  altitude: number;
  controlsDisabled: boolean;
  onPOVChange: (pov: { lat?: number; lng?: number; altitude?: number }) => void;
  showBorders?: boolean;
  getVisitCount?: (id: string | number) => number;
  mapStyle: MapStyle;
  onHoverChange?: (id: string | number | null) => void;
}) {
  const { innerRef } = props;

  useEffect(() => {
    const g = innerRef?.current;
    if (!g) return;
    const scene: THREE.Scene | undefined = g.scene?.();
    if (!scene) return;
    const old = scene.getObjectByName("globe-light-group");
    if (old) scene.remove(old);

    const group = new THREE.Group();
    group.name = "globe-light-group";

    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    const dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(200, 180, 120);

    group.add(ambient, dir);
    scene.add(group);
  }, [innerRef]);

  useEffect(() => {
    if (!innerRef?.current) return;
    const controls = innerRef.current.controls?.();
    if (!controls) return;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.85;
    controls.minDistance = 60;
    controls.maxDistance = 520;
    controls.enabled = !props.controlsDisabled;

    const canvas: HTMLCanvasElement | undefined = innerRef.current.renderer?.()?.domElement;
    if (canvas) Object.assign(canvas.style, { borderRadius: "0px", background: "transparent" });

    const last = { t: 0 };
    const onChange = () => {
      const now = performance.now();
      if (now - last.t < 60) return;
      last.t = now;
      const p = innerRef.current.pointOfView?.();
      if (!p) return;
      const alt = Math.max(ALT_MIN, Math.min(ALT_MAX, p.altitude ?? 1.8));
      if (alt !== p.altitude) innerRef.current.pointOfView?.({ ...p, altitude: alt }, 0);
      props.onPOVChange({ lat: p.lat, lng: p.lng, altitude: alt });
    };
    controls.addEventListener("change", onChange);
    const p0 = innerRef.current.pointOfView?.();
    if (p0) props.onPOVChange({ ...p0 });
    return () => controls.removeEventListener("change", onChange);
  }, [innerRef, props.controlsDisabled, props.onPOVChange]);

  function capColor(d: any) {
    const cnt = props.getVisitCount ? props.getVisitCount(d.id) : props.visited.has(d.id) ? 1 : 0;
    if (props.mapStyle === "plain") {
      if (cnt <= 0) return "rgba(216, 227, 220, 0.92)";
      const c = Math.min(5, cnt);
      const alpha = 0.25 + c * 0.1;
      return `rgba(255,170,66,${alpha.toFixed(2)})`;
    }
    if (cnt <= 0) return "rgba(255,255,255,0.12)";
    const c = Math.min(5, cnt);
    const alpha = 0.18 + c * 0.12;
    return `rgba(255,170,66,${alpha.toFixed(2)})`;
  }

  const globeMaterialPlain = useMemo(() => {
    const m = new THREE.MeshPhongMaterial({ color: 0xb9e6ff });
    m.shininess = 5;
    return m;
  }, []);

  return (
    <Globe
      ref={innerRef}
      globeImageUrl={props.mapStyle === "earth" ? GLOBE_TEXTURE_EARTH : undefined}
      globeMaterial={props.mapStyle === "plain" ? globeMaterialPlain : undefined}
      backgroundColor="rgba(0,0,0,0)"
      showAtmosphere
      atmosphereColor="white"
      atmosphereAltitude={0.18}
      rendererConfig={{ antialias: false, powerPreference: "high-performance" }}
      animateIn={false}
      onPolygonHover={(poly: any) => props.onHoverChange?.(poly?.id ?? null)}
      polygonsData={props.countries}
      polygonAltitude={(d: any) => (props.mapStyle === "plain" ? 0.0015 : (props.getVisitCount?.(d.id) ?? 0) > 0 ? 0.004 : 0.003)}
      polygonCapColor={capColor}
      polygonSideColor={() => (props.mapStyle === "plain" ? "rgba(255,255,255,0.0)" : "rgba(255,255,255,0.22)")}
      polygonStrokeColor={() => (props.showBorders ? "rgba(90,90,90,0.38)" : "rgba(0,0,0,0)")}
      polygonsTransitionDuration={0}
      onPolygonClick={(d: any) => props.onCountryClick(d.id)}
      labelsData={[]}
      labelsTransitionDuration={0}
      htmlElementsData={props.labels}
      htmlLat={(d: any) => d.lat}
      htmlLng={(d: any) => d.lng}
      htmlAltitude={() => 0.018}
      htmlElement={(d: any) => {
        const el = document.createElement("div");
        el.className = `globe-pill ${d.kind}`;
        el.textContent = d.name;
        el.dataset.kind = d.kind;
        if (d.area != null) el.dataset.area = String(d.area);
        if (d.visited != null) el.dataset.visited = String(d.visited ? 1 : 0);
        if (d.hover != null) el.dataset.hover = String(d.hover ? 1 : 0);
        return el;
      }}
      htmlTransitionDuration={0}
    />
  );
}
