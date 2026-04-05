const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const SEED_RESTAURANTS = require("./public/restaurants.js");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";

if (!process.env.ADMIN_PIN) {
  console.warn("[warn] ADMIN_PIN not set — defaulting to '1234' for local dev.");
}

// ──────────────────── Database ────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[fatal] DATABASE_URL not set. On Railway attach the Postgres plugin; locally set DATABASE_URL=postgres://...");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" || /railway|render|heroku|supabase/i.test(DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      cuisine TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      address TEXT NOT NULL,
      price TEXT NOT NULL,
      rating REAL DEFAULT 0,
      total_ratings INTEGER DEFAULT 0,
      place_id TEXT DEFAULT '',
      status TEXT DEFAULT 'approved',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      cuisine TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      address TEXT NOT NULL,
      price TEXT NOT NULL,
      suggested_by TEXT DEFAULT 'anonymous',
      note TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_restaurants_status ON restaurants(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);`);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM restaurants");
  if (rows[0].c === 0) {
    console.log(`[seed] restaurants table empty, inserting ${SEED_RESTAURANTS.length} rows...`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of SEED_RESTAURANTS) {
        await client.query(
          `INSERT INTO restaurants (name, cuisine, tags, address, price, rating, total_ratings, place_id, status)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,'approved')`,
          [r.name, r.cuisine, JSON.stringify(r.tags || []), r.address, r.price, r.rating || 0, r.total_ratings || 0, r.place_id || ""]
        );
      }
      await client.query("COMMIT");
      console.log("[seed] done.");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

// ──────────────────── Middleware ────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function requireAdmin(req, res, next) {
  const pin = req.headers["x-admin-pin"];
  if (pin && pin === ADMIN_PIN) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ──────────────────── Public API ────────────────────
app.get("/api/config", (_req, res) => {
  res.json({ apiKey: process.env.GOOGLE_PLACES_API_KEY || "" });
});

app.get("/api/restaurants", async (req, res) => {
  try {
    const { category, price, search } = req.query;
    const where = ["status = 'approved'"];
    const params = [];
    if (category) {
      params.push(category);
      where.push(`tags @> to_jsonb(ARRAY[$${params.length}]::text[])`);
    }
    if (price) {
      params.push(price);
      where.push(`price = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(name ILIKE $${params.length} OR cuisine ILIKE $${params.length} OR address ILIKE $${params.length})`);
    }
    const sql = `SELECT * FROM restaurants WHERE ${where.join(" AND ")} ORDER BY name ASC`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/restaurants/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM restaurants WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/suggestions", async (req, res) => {
  try {
    const { name, cuisine, tags, address, price, note, suggested_by } = req.body || {};
    if (!name || !cuisine || !address || !price) {
      return res.status(400).json({ error: "name, cuisine, address, and price are required" });
    }
    const { rows } = await pool.query(
      `INSERT INTO suggestions (name, cuisine, tags, address, price, note, suggested_by, status)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,'pending') RETURNING *`,
      [name, cuisine, JSON.stringify(tags || []), address, price, note || "", suggested_by || "anonymous"]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ──────────────────── Admin API ────────────────────
app.post("/api/admin/auth", (req, res) => {
  const pin = req.headers["x-admin-pin"] || (req.body && req.body.pin);
  res.json({ valid: !!pin && pin === ADMIN_PIN });
});

app.get("/api/admin/suggestions", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM suggestions WHERE status = 'pending' ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/suggestions/:id/approve", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM suggestions WHERE id = $1", [req.params.id]);
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }
    const s = rows[0];
    await client.query(
      `INSERT INTO restaurants (name, cuisine, tags, address, price, status)
       VALUES ($1,$2,$3::jsonb,$4,$5,'approved')`,
      [s.name, s.cuisine, JSON.stringify(s.tags), s.address, s.price]
    );
    await client.query("UPDATE suggestions SET status = 'approved' WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

app.post("/api/admin/suggestions/:id/reject", requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE suggestions SET status = 'rejected' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/restaurants", requireAdmin, async (req, res) => {
  try {
    const { name, cuisine, tags, address, price, rating, total_ratings, place_id } = req.body || {};
    if (!name || !cuisine || !address || !price) {
      return res.status(400).json({ error: "name, cuisine, address, and price are required" });
    }
    const { rows } = await pool.query(
      `INSERT INTO restaurants (name, cuisine, tags, address, price, rating, total_ratings, place_id)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8) RETURNING *`,
      [name, cuisine, JSON.stringify(tags || []), address, price, rating || 0, total_ratings || 0, place_id || ""]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/restaurants/:id", requireAdmin, async (req, res) => {
  try {
    const { name, cuisine, tags, address, price, rating, total_ratings, place_id, status } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE restaurants SET
         name = COALESCE($1, name),
         cuisine = COALESCE($2, cuisine),
         tags = COALESCE($3::jsonb, tags),
         address = COALESCE($4, address),
         price = COALESCE($5, price),
         rating = COALESCE($6, rating),
         total_ratings = COALESCE($7, total_ratings),
         place_id = COALESCE($8, place_id),
         status = COALESCE($9, status),
         updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [name, cuisine, tags ? JSON.stringify(tags) : null, address, price, rating, total_ratings, place_id, status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/restaurants/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM restaurants WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ──────────────────── Start ────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("[fatal] DB init failed:", err);
    process.exit(1);
  });
