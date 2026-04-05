# Restaurant Chooser

A full-featured restaurant picker for the Waterloo / Cedar Falls, Iowa area. Picks a random restaurant from 200+ local spots with a slot-machine spin animation, plus browse, favorites, history, stats, battle mode, and an admin panel for managing the catalog.

## Features

- **Pick tab** — slot-machine spin picker with confetti, multi-select category and price filters, live search, "favorites only" and "exclude recent" toggles, plus a 3-way Battle Mode bracket
- **Browse tab** — sortable paginated grid, expandable detail modal with Google Maps links, suggest-a-restaurant form
- **Favorites tab** — heart any restaurant to save it locally
- **Stats tab** — cuisine and price bar charts, personal counters, clear-history
- **Admin tab** — PIN-gated panel for approving/rejecting user suggestions and full CRUD on restaurants
- **Light/dark theme toggle** with CSS variables, persisted in localStorage
- Mobile-friendly bottom tab nav with safe-area insets, spacebar shortcut to pick

## Architecture

- **Backend:** Node.js + Express + PostgreSQL (via `pg`). Two tables: `restaurants` and `suggestions`, both with `JSONB` tags.
- **Frontend:** Single `public/index.html` — vanilla JS, no build step, no frameworks.
- **Seed data:** 204 restaurants in `public/restaurants.js`, loaded into Postgres on first run if the table is empty.
- **Admin auth:** PIN-based. The client sends `x-admin-pin` on admin endpoints; the server compares against `ADMIN_PIN`.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Railway's Postgres plugin provides this automatically. |
| `ADMIN_PIN` | recommended | PIN required to unlock the admin panel. Defaults to `1234` for local dev (warning logged). |
| `GOOGLE_PLACES_API_KEY` | no | Optional legacy Google Places live-lookup key (surfaced via `/api/config`). Leave empty for DB-only mode. |
| `PORT` | no | Server port. Defaults to `3000`. |
| `NODE_ENV` | no | Set to `production` to force SSL on the Postgres connection. |

See `.env.example`.

## Local Development

```bash
# 1. Install
npm install

# 2. Start a local Postgres and create a database
sudo service postgresql start
sudo -u postgres psql -c "CREATE USER rcuser WITH PASSWORD 'rcpass';"
sudo -u postgres psql -c "CREATE DATABASE restaurantchooser OWNER rcuser;"

# 3. Run the server
DATABASE_URL='postgres://rcuser:rcpass@localhost:5432/restaurantchooser' \
  ADMIN_PIN='1234' \
  npm start

# 4. Open http://localhost:3000
```

On first boot the server seeds all 204 restaurants from `public/restaurants.js` into the `restaurants` table.

## Deploying to Railway

1. Create a new Railway project from this repo.
2. Add the **PostgreSQL** plugin — Railway injects `DATABASE_URL` automatically.
3. In the service variables, set `ADMIN_PIN` to a private value.
4. Deploy. Data persists across redeploys because Railway's Postgres is managed and durable.

## API Reference

### Public

- `GET /api/config` — returns `{ apiKey }` for legacy Google Places client fallback
- `GET /api/restaurants` — list approved restaurants. Query: `?category=pizza&price=$$&search=tacos`
- `GET /api/restaurants/:id` — single restaurant
- `POST /api/suggestions` — submit a new restaurant suggestion. Body: `{ name, cuisine, address, price, tags?, note?, suggested_by? }`

### Admin (require header `x-admin-pin: <pin>`)

- `POST /api/admin/auth` — returns `{ valid: boolean }`
- `GET  /api/admin/suggestions` — list pending suggestions
- `POST /api/admin/suggestions/:id/approve` — approve (transactional copy into `restaurants`)
- `POST /api/admin/suggestions/:id/reject`
- `POST /api/restaurants` — create a restaurant
- `PUT  /api/restaurants/:id` — partial update (any field)
- `DELETE /api/restaurants/:id`

## Data Model

```sql
restaurants (
  id SERIAL PRIMARY KEY,
  name TEXT, cuisine TEXT, tags JSONB,
  address TEXT, price TEXT,
  rating REAL, total_ratings INTEGER, place_id TEXT,
  status TEXT,                  -- 'approved' | 'pending' | 'rejected'
  created_at, updated_at TIMESTAMPTZ
)

suggestions (
  id SERIAL PRIMARY KEY,
  name, cuisine, address, price, note, suggested_by TEXT,
  tags JSONB,
  status TEXT,                  -- 'pending' | 'approved' | 'rejected'
  created_at TIMESTAMPTZ
)
```

## localStorage Keys

- `rc_favorites` — array of restaurant IDs
- `rc_history` — array of recent picks (capped at 50)
- `rc_theme` — `'dark'` or `'light'`
- `rc_favoritesOnly`, `rc_excludeRecent` — pick filter toggles
- `rc_admin_pin` — admin PIN (only set after successful unlock)
