/**
 * =====================================================================
 * SAFE BACKEND PROXY for the Vehicle Databases Window Sticker API
 * =====================================================================
 *
 * Why this file exists:
 *   Your Vehicle Databases API key MUST NEVER live in front-end code.
 *   If you put it in HTML/JS that the browser downloads, anyone can
 *   open DevTools and steal it. This tiny server keeps the key on the
 *   backend and exposes a clean endpoint your website can call.
 *
 * How to run:
 *   1. Install Node.js (https://nodejs.org)
 *   2. In this folder: `npm install express node-fetch dotenv cors`
 *   3. Create a file called `.env` next to this file containing:
 *        VDB_API_KEY=your_real_api_key_here
 *      (do NOT commit .env to git — add it to .gitignore)
 *   4. Run: `node server.js`
 *   5. Open http://localhost:3000/window-sticker.html
 *      Or call the JSON endpoint directly:
 *        http://localhost:3000/api/window-sticker?vin=JM3KFBCM5P0102946
 *
 * In production:
 *   Deploy to any Node host (Render, Railway, Heroku, your VPS).
 *   Put the API key into the host's "Environment Variables" UI.
 *
 * =====================================================================
 */

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_API_KEY) {
  console.error(
    "❌ Missing VDB_API_KEY environment variable.\n" +
    "   Create a .env file with: VDB_API_KEY=your_key_here"
  );
  process.exit(1);
}

app.use(cors());                               // allow your front-end domain
app.use(express.static("./"));                 // serves window-sticker.html

/**
 * GET /api/window-sticker?vin=XXXXXXXXXXXXXXXXX
 *
 * Calls Vehicle Databases, normalizes the response into the shape that
 * window-sticker.html expects, and returns it as JSON.
 *
 * NOTE on field mapping:
 *   The exact field names from Vehicle Databases may differ slightly
 *   between endpoints / package tiers. Adjust `mapVdbToSticker` below
 *   once you see the real response (log it the first time you call).
 */
app.get("/api/window-sticker", async (req, res) => {
  const vin = (req.query.vin || "").trim().toUpperCase();

  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: "Invalid VIN (must be 17 chars)." });
  }

  try {
    // Adjust this URL to whichever Vehicle Databases endpoint you have
    // access to under your "Starter" package — see their docs.
    const url = `https://api.vehicledatabases.com/window-sticker/${encodeURIComponent(vin)}`;

    const apiResp = await fetch(url, {
      headers: {
        "x-AuthKey": VDB_API_KEY,             // VDB uses the x-AuthKey header
        "Accept":    "application/json"
      }
    });

    if (!apiResp.ok) {
      const text = await apiResp.text();
      return res.status(apiResp.status).json({
        error: "Vehicle Databases API error",
        status: apiResp.status,
        details: text
      });
    }

    const raw = await apiResp.json();
    const normalized = mapVdbToSticker(raw, vin);
    res.json(normalized);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

/**
 * Map the raw Vehicle Databases response into the exact shape that
 * window-sticker.html expects (see vehicleData object in that file).
 *
 * The first time you call the live endpoint, do `console.log(raw)` and
 * align the field paths below with what you actually get back.
 */
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
  console.log(`✅ Window sticker server running at http://localhost:${PORT}`);
  console.log(`   Try: http://localhost:${PORT}/window-sticker.html`);
});
