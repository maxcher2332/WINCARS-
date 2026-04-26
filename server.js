/**
 * SAFE BACKEND PROXY for Vehicle Databases Window Sticker API
 * The API key lives only on the server (Render env var: VDB_API_KEY).
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

/**
 * GET /api/window-sticker?vin=XXXXXXXXXXXXXXXXX
 * Calls Vehicle Databases, returns JSON for window-sticker.html
 */
app.get("/api/window-sticker", async (req, res) => {
  const vin = (req.query.vin || "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: "Invalid VIN (must be 17 chars)." });
  }

  // Vehicle Databases endpoint pattern: /{api-name}/v2/{vin}
  const url = `https://api.vehicledatabases.com/window-sticker/v2/${encodeURIComponent(vin)}`;

  try {
    const apiResp = await fetch(url, {
      headers: {
        "x-authkey": VDB_API_KEY,
        "Accept":    "application/json"
      }
    });

    console.log(`[VDB] GET ${url} → ${apiResp.status}`);
    const text = await apiResp.text();

    if (!apiResp.ok) {
      return res.status(apiResp.status).json({
        error: "Vehicle Databases API error",
        status: apiResp.status,
        details: text
      });
    }

    let raw;
    try { raw = JSON.parse(text); }
    catch { return res.status(502).json({ error: "Bad JSON from VDB", body: text }); }

    // Log first response so we can see field structure
    console.log("[VDB] raw keys:", Object.keys(raw));
    console.log("[VDB] raw sample:", JSON.stringify(raw).slice(0, 800));

    res.json(mapVdbToSticker(raw, vin));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

/**
 * Endpoint to test Advanced VIN Decode as a fallback (uses same pattern)
 * GET /api/vin-decode?vin=XXXXXXXXXXXXXXXXX
 */
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

/** Plan info (credits left etc.) — quick health-check */
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

function mapVdbToSticker(raw, vin) {
  const d = raw?.data || raw || {};
  const safeNumber = v => (typeof v === "number" ? v : Number(v) || 0);
  return {
    make:           d.make            || d.manufacturer_name || "",
    year:           d.year            || d.model_year        || "",
    model:          d.model_full_name || d.trim_full         || d.model || "",
    modelNumber:    d.model_number    || d.style_id          || "",
    exteriorColor:  d.exterior_color  || d.ext_color         || "",
    interiorColor:  d.interior_color  || d.int_color         || "",
    pricing: {
      msrp:         safeNumber(d.msrp || d.base_price),
      destination:  safeNumber(d.destination_charge || d.destination),
      totalPrice:   safeNumber(d.total_price || d.invoice_total),
      optionsTotal: safeNumber(d.options_total || d.optional_equipment_price)
    },
    warranty:  (d.warranty || []).map(w => ({
      name:  w.name  || w.type,
      terms: w.terms || `${w.months} month/${w.miles?.toLocaleString()} miles`
    })),
    optionalEquipment: (d.optional_equipment || []).map(o => ({
      category: o.category || "Other",
      name:     o.name     || o.description,
      price:    o.price ?? "included"
    })),
    standardEquipment: d.standard_equipment || {},
    equipmentLayout: {
      columnA: ["COMFORT", "CONVENIENCE", "EXTERIOR AND APPEARANCE", "IN-CAR ENTERTAINMENT"],
      columnB: ["POWERTRAIN AND MECHANICAL", "SAFETY AND SECURITY", "TECHNOLOGY AND TELEMATICS"]
    },
    fuelEconomy: {
      type:                d.fuel_economy?.type            || "Gasoline Vehicle",
      combinedMpg:         safeNumber(d.fuel_economy?.combined),
      cityMpg:             safeNumber(d.fuel_economy?.city),
      highwayMpg:          safeNumber(d.fuel_economy?.highway),
      gallonsPer100Miles:  safeNumber(d.fuel_economy?.gallons_per_100mi),
      annualFuelCost:      safeNumber(d.fuel_economy?.annual_cost),
      fuelCostVsAverage:   safeNumber(d.fuel_economy?.cost_vs_average),
      fuelCostYears:       safeNumber(d.fuel_economy?.years || 5),
      bestVehicleMpge:     safeNumber(d.fuel_economy?.best_mpge || 140),
      ghgRating:           safeNumber(d.fuel_economy?.ghg_rating)
    },
    safetyRatings: {
      overall:               safeNumber(d.safety_ratings?.overall),
      frontalCrashDriver:    safeNumber(d.safety_ratings?.frontal_driver),
      frontalCrashPassenger: safeNumber(d.safety_ratings?.frontal_passenger),
      sideCrashFrontSeat:    safeNumber(d.safety_ratings?.side_front),
      sideCrashRearSeat:     safeNumber(d.safety_ratings?.side_rear),
      rollover:              safeNumber(d.safety_ratings?.rollover)
    },
    country:      d.country      || "",
    manufacturer: d.manufacturer || "",
    vin:          vin
  };
}

app.listen(PORT, () => {
  console.log(`✅ Window sticker server running on port ${PORT}`);
});
