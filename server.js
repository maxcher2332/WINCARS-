/**
 * Wincars window-sticker proxy
 * Uses Vehicle Databases "Advanced VIN Decode" API on Starter plan.
 * API key lives only on the server (Render env: VDB_API_KEY).
 */

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_API_KEY) {
  console.error("❌ Missing VDB_API_KEY environment variable.");
  process.exit(1);
}

app.use(cors());
app.use(express.static("./"));

/* ----- helpers ----- */
const parseNum = v => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  // VDB returns prices as "50,200" — strip commas
  const cleaned = String(v).replace(/[, $]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};
const safeStr = v => (v === null || v === undefined ? "" : String(v));

/**
 * GET /api/window-sticker?vin=...
 * Calls Advanced VIN Decode and reshapes response into sticker JSON.
 */
app.get("/api/window-sticker", async (req, res) => {
  const vin = (req.query.vin || "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: "Invalid VIN (must be 17 chars)." });
  }

  const url = `https://api.vehicledatabases.com/advanced-vin-decode/v2/${encodeURIComponent(vin)}`;

  try {
    const r = await fetch(url, {
      headers: { "x-authkey": VDB_API_KEY, "Accept": "application/json" }
    });
    console.log(`[VDB] GET ${url} → ${r.status}`);
    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({
        error: "Vehicle Databases API error",
        status: r.status,
        details: text
      });
    }
    let raw;
    try { raw = JSON.parse(text); }
    catch { return res.status(502).json({ error: "Bad JSON from VDB", body: text }); }

    res.json(mapToSticker(raw, vin));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

/** Raw passthrough — useful for debugging in the browser */
app.get("/api/vin-decode", async (req, res) => {
  const vin = (req.query.vin || "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: "Invalid VIN." });
  }
  const url = `https://api.vehicledatabases.com/advanced-vin-decode/v2/${encodeURIComponent(vin)}`;
  try {
    const r = await fetch(url, {
      headers: { "x-authkey": VDB_API_KEY, "Accept": "application/json" }
    });
    const t = await r.text();
    res.status(r.status).type("application/json").send(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Plan info */
app.get("/api/info", async (_req, res) => {
  try {
    const r = await fetch("https://api.vehicledatabases.com/info", {
      headers: { "x-authkey": VDB_API_KEY, "Accept": "application/json" }
    });
    const t = await r.text();
    res.status(r.status).type("application/json").send(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =====================================================================
   Map VDB Advanced-VIN-Decode response → window-sticker.html shape
   ===================================================================== */
function mapToSticker(raw, vin) {
  const d = raw?.data || {};
  const price = d.price || {};
  const vehicle = d.vehicle || {};
  const engine = d.engine?.[0] || d.engine || {};
  const trans = d.transmission?.[0] || d.transmission || {};
  const fuel = d.fuel_economy?.[0] || d.fuel_economy || {};
  const equipment = d.equipment || {};

  const msrp = parseNum(price.base_msrp);
  const destination = parseNum(price.delivery_charges);
  const totalPrice = parseNum(price.total_price) || (msrp + destination);

  // Build standard equipment from whatever categories VDB returns
  const standardEquipment = {};
  for (const [k, v] of Object.entries(equipment)) {
    if (Array.isArray(v) && v.length) {
      standardEquipment[k.toUpperCase().replace(/_/g, " ")] = v.map(it =>
        typeof it === "string" ? it : (it.name || it.description || JSON.stringify(it))
      );
    }
  }

  return {
    make:           safeStr(d.make),
    year:           safeStr(d.year),
    model:          safeStr(d.trim_and_style || `${d.model || ""} ${d.trim || ""}`.trim()),
    modelNumber:    safeStr(d.style_id || d.model_number || ""),
    exteriorColor:  safeStr(d.exterior_color || d.colors?.exterior || ""),
    interiorColor:  safeStr(d.interior_color || d.colors?.interior || ""),
    bodyType:       safeStr(vehicle.body_type),
    doors:          safeStr(vehicle.doors),

    pricing: {
      msrp,
      destination,
      totalPrice,
      optionsTotal: parseNum(price.options_total)
    },

    engine: {
      description: safeStr(engine.description || engine.name || ""),
      displacement: safeStr(engine.displacement),
      horsepower: parseNum(engine.horsepower || engine.hp),
      cylinders: safeStr(engine.cylinders)
    },

    transmission: safeStr(trans.description || trans.name || trans.type),

    summary: safeStr(d.summary),

    warranty: Array.isArray(d.warranty) ? d.warranty.map(w => ({
      name:  safeStr(w.name || w.type),
      terms: safeStr(w.terms || `${w.months || ""} mo / ${w.miles || ""} mi`)
    })) : [],

    optionalEquipment: Array.isArray(d.optional_equipment)
      ? d.optional_equipment.map(o => ({
          category: safeStr(o.category || "Other"),
          name:     safeStr(o.name || o.description),
          price:    o.price ?? "included"
        }))
      : [],

    standardEquipment,

    equipmentLayout: {
      columnA: ["COMFORT", "CONVENIENCE", "EXTERIOR AND APPEARANCE", "IN-CAR ENTERTAINMENT"],
      columnB: ["POWERTRAIN AND MECHANICAL", "SAFETY AND SECURITY", "TECHNOLOGY AND TELEMATICS"]
    },

    fuelEconomy: {
      type:                safeStr(fuel.type) || "Gasoline Vehicle",
      combinedMpg:         parseNum(fuel.combined || fuel.combined_mpg),
      cityMpg:             parseNum(fuel.city || fuel.city_mpg),
      highwayMpg:          parseNum(fuel.highway || fuel.highway_mpg),
      gallonsPer100Miles:  parseNum(fuel.gallons_per_100mi),
      annualFuelCost:      parseNum(fuel.annual_cost),
      fuelCostVsAverage:   parseNum(fuel.cost_vs_average),
      fuelCostYears:       parseNum(fuel.years || 5),
      bestVehicleMpge:     parseNum(fuel.best_mpge || 140),
      ghgRating:           parseNum(fuel.ghg_rating)
    },

    safetyRatings: {
      overall:               0,
      frontalCrashDriver:    0,
      frontalCrashPassenger: 0,
      sideCrashFrontSeat:    0,
      sideCrashRearSeat:     0,
      rollover:              0
    },

    country:      safeStr(d.country || d.manufacturer_country || ""),
    manufacturer: safeStr(d.manufacturer || d.make || ""),
    vin
  };
}

app.listen(PORT, () => {
  console.log(`✅ Wincars window-sticker server running on port ${PORT}`);
});
