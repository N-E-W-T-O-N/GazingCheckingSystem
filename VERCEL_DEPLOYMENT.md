# Vercel Deployment Guide

This project is now configured for Vercel deployment. It consists of two main components:
- **Frontend**: TypeScript/Vite SPA
- **Backend**: Python FastAPI server

## Quick Start

### 1. Deploy Frontend to Vercel

#### Option A: Using Vercel Dashboard (Recommended)

1. Push your code to GitHub (if not already there)
2. Go to [vercel.com](https://vercel.com) and sign up/login
3. Click "Add New..." → "Project"
4. Import your GitHub repository
5. Vercel will auto-detect the configuration from `vercel.json`
6. Configure environment variables (see below)
7. Click "Deploy"

#### Option B: Using Vercel CLI

```bash
npm install -g vercel
vercel login
vercel --prod
```

### 2. Configure Environment Variables

In your Vercel project settings, add:

```
VITE_API_URL = https://your-api-domain.com
```

**Important**: The `VITE_API_URL` should point to where your FastAPI backend is deployed (see Backend Deployment below).

### 3. Deploy Backend

You have three options:

#### Option 1: Deploy FastAPI Backend Separately (Recommended for Vercel Free Tier)

Deploy your FastAPI backend to any Python-compatible hosting:
- Railway.app
- Render.com
- PythonAnywhere
- Heroku
- DigitalOcean App Platform

Example with Railway:
```bash
cd backend
pip install -r requirements.txt
# Follow Railway's deployment guide
```

Then set `VITE_API_URL` in Vercel to your Railway URL.

#### Option 2: Use Vercel's Python Runtime (Pro/Enterprise)

Create `api/` directory and convert routes to serverless functions. This requires Vercel's paid plans.

#### Option 3: Keep Backend Locally (Development Only)

For local development:
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

Frontend dev server at `http://localhost:5173` will proxy requests to `http://localhost:8000`.

## Project Structure for Vercel

```
.
├── vercel.json              # Vercel configuration
├── .vercelignore           # Files to exclude from deployment
├── frontend/               # SPA source (deployed to Vercel)
│   ├── src/
│   ├── dist/              # Build output (auto-built by Vercel)
│   ├── package.json
│   └── vite.config.ts
└── backend/                # FastAPI server (deploy separately)
    ├── app/
    ├── requirements.txt
    └── run.sh
```

## Environment Variables

### Development (.env.local)

```env
VITE_API_URL=http://localhost:8000
```

Or leave empty to use relative paths (vite dev server proxies to backend).

### Production (Vercel Dashboard)

```env
VITE_API_URL=https://your-backend-domain.com
```

## API Endpoints

The frontend expects these endpoints on the backend:

- `POST /ingest` - Upload engagement events
- `GET /sessions/{sessionId}` - Get session data
- `WS /live` - WebSocket for real-time data (if needed)

All API requests from the frontend are prefixed with `VITE_API_URL`.

## CORS Configuration

Ensure your FastAPI backend has CORS properly configured:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://your-vercel-domain.vercel.app",
        "https://your-custom-domain.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

## Troubleshooting

### "Failed to fetch" errors
- Check that `VITE_API_URL` is set correctly in Vercel environment variables
- Verify CORS is configured on your backend
- Ensure backend is running and accessible

### Build fails
- Verify `frontend/` directory has `package.json`
- Check that `npm install` and `npm run build` work locally
- Review build logs in Vercel dashboard

### API calls return 404
- Confirm backend endpoint URLs match (e.g., `/ingest` vs `/api/ingest`)
- Check that `VITE_API_URL` in Vercel doesn't have a trailing slash

## Local Development

```bash
# Terminal 1: Start backend
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000

# Terminal 2: Start frontend
cd frontend
npm install
npm run dev
```

Frontend will be at `http://localhost:5173` and proxy API calls to backend.

## Production Checklist

- [ ] Backend deployed and accessible
- [ ] `VITE_API_URL` set in Vercel environment
- [ ] CORS configured on backend
- [ ] Frontend builds successfully
- [ ] Test API endpoints work from deployed site
- [ ] SSL/TLS enabled on both frontend and backend
- [ ] Monitor performance and errors

## Additional Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Vite Deployment Guide](https://vitejs.dev/guide/build.html)
- [FastAPI Deployment](https://fastapi.tiangolo.com/deployment/)
