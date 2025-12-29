# TRP Link Tracker

A Cloudflare Workers-based link shortener and tracker with analytics.

## Features

- **Link Shortening**: Create short links with custom or auto-generated slugs
- **Owner Index**: Fast link listing using owner-based indexing (O(m) instead of O(n))
- **Analytics Tracking**: Track clicks with geolocation, device, browser, and referrer data
- **Aggregated Analytics**: Daily aggregates for efficient dashboard queries
- **Recent Links**: Public endpoint to view recently created links
- **RESTful API**: Full CRUD operations for link management

## API Endpoints

### Create Link
```bash
POST /api/links
Content-Type: application/json

{
  "slug": "mylink",           # optional, auto-generated if not provided
  "destination": "https://...",
  "title": "My Link"          # optional
}
```

### List Links (Owner)
```bash
GET /api/links?key={owner_key}
```

### Recent Links (Public)
```bash
GET /api/recent?limit=10     # limit is optional (1-100, default: 10)
```

### Get Link Stats
```bash
GET /api/stats/{slug}?key={owner_key}
```

### Update Link
```bash
PUT /api/update/{slug}?key={owner_key}
Content-Type: application/json

{
  "destination": "https://...",
  "title": "Updated Title"
}
```

### Delete Link
```bash
DELETE /api/delete/{slug}?key={owner_key}
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Start dev server
npm run dev

# Deploy
npm run deploy
```

## Architecture

### Owner Index
Links are indexed by owner key in KV storage using `owner:{owner_key}` keys that contain arrays of slugs. This provides O(m) listing performance where m = number of links owned, instead of O(n) where n = total links in the system.

### Analytics
- Individual click events stored as `click:{slug}:{timestamp}:{random}`
- Daily aggregates stored as `agg:{slug}:{YYYY-MM-DD}`
- Total clicks counter maintained on link record

## Testing

Comprehensive test suite covers:
- Owner index maintenance
- Link CRUD operations
- Recent links endpoint
- Parameter validation
- Link deletion cleanup

Run tests with: `npm test`
