# Vercel Compatibility Setup - Summary

Your project has been configured for Vercel deployment. Here's what was done:

## Files Created/Modified

### New Files:
1. **`vercel.json`** - Vercel deployment configuration
   - Configures frontend build and output directory
   - Sets up API endpoint rewrites
   - Specifies environment variables

2. **`.vercelignore`** - Excludes unnecessary files from deployment
   - Excludes backend Python code, Docker files, etc.
   - Keeps deployment size minimal

3. **`VERCEL_DEPLOYMENT.md`** - Complete deployment guide
   - Step-by-step instructions for deploying to Vercel
   - Backend deployment options
   - Environment variable setup
   - Troubleshooting tips

4. **`.env.example`** - Example environment configuration
   - Shows required environment variables
   - Documents variable purposes

5. **`frontend/src/config.ts`** - Centralized API configuration
   - Manages API endpoint URLs
   - Supports both development and production
   - Handles WebSocket protocol conversion

### Modified Files:
1. **`frontend/vite.config.ts`**
   - Added environment variable definition support
   - Maintains dev-time proxy configuration

2. **`frontend/src/main.ts`**
   - Now imports and uses centralized config
   - API endpoint is dynamically configured

3. **`.gitignore`**
   - Added `.env` and `.env.local` to prevent committing secrets

## Architecture

```
┌─────────────────────────────────────────┐
│           Vercel Deployment             │
├─────────────────────────────────────────┤
│  Frontend (TypeScript/Vite SPA)          │
│  ├── Built and deployed by Vercel        │
│  ├── Uses VITE_API_URL environment var   │
│  └── API requests routed via vercel.json │
└─────────────────┬───────────────────────┘
                  │
                  │ API calls to
                  │ VITE_API_URL/ingest
                  │
          ┌───────▼──────────┐
          │  Your API Server  │
          │   (Deployed       │
          │   Separately)     │
          └──────────────────┘
```

## Next Steps

### 1. Deploy Frontend to Vercel

**Using Git (Recommended):**
- Push your code to GitHub
- Go to [vercel.com](https://vercel.com)
- Click "Add New" → "Project"
- Import your GitHub repository
- Vercel will auto-detect the configuration
- Click "Deploy"

**Using Vercel CLI:**
```bash
npm install -g vercel
vercel login
vercel --prod
```

### 2. Deploy Backend

Choose one option:

**Option A: Deploy to Railway (Free tier available)**
```bash
cd backend
npm install -g @railway/cli
railway login
railway init
railway deploy
```

**Option B: Deploy to Render**
- Connect your GitHub repo to Render
- Create a new Web Service
- Set build command: `pip install -r requirements.txt`
- Set start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

**Option C: Keep it Local (Development Only)**
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

### 3. Configure Environment Variables

In Vercel Project Settings → Environment Variables, add:

```
VITE_API_URL = https://your-backend-url.com
```

(If using Option C, use `http://localhost:8000` locally)

### 4. Verify CORS Configuration

Update your backend's CORS configuration:

```python
# In backend/app/main.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://your-project.vercel.app",
        "https://your-custom-domain.com",  # if using custom domain
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

## Local Development

Your local setup remains unchanged:

```bash
# Terminal 1: Backend
cd backend
python -m uvicorn app.main:app --reload --port 8000

# Terminal 2: Frontend
cd frontend
npm run dev
```

Frontend at `http://localhost:5173` will proxy API requests to the backend.

## Environment Variables

### Development (`.env.local` - not committed)
```env
VITE_API_URL=http://localhost:8000
```

### Production (Vercel Dashboard)
```env
VITE_API_URL=https://your-deployed-backend.com
```

## Key Features

✅ **Monorepo Support** - Frontend and backend in one repo  
✅ **API Endpoint Management** - Centralized configuration in `config.ts`  
✅ **Environment Variable Support** - Different configs for dev/prod  
✅ **CORS Friendly** - Rewrites handle API routing  
✅ **Type-Safe** - Full TypeScript support  
✅ **Zero Configuration** - Works out of the box with `vercel.json`  

## Troubleshooting

**Frontend deployed but API calls fail:**
- Check `VITE_API_URL` is set in Vercel environment variables
- Verify backend CORS configuration
- Ensure backend is accessible from the internet

**Build fails on Vercel:**
- Check build logs in Vercel dashboard
- Verify `frontend/package.json` build script works locally
- Ensure all dependencies are in `package.json`

**CORS errors:**
- Update backend's allowed origins to include your Vercel domain
- Format: `https://your-project.vercel.app` (no trailing slash)

## Documentation

For detailed instructions, see:
- **`VERCEL_DEPLOYMENT.md`** - Complete deployment guide
- **`frontend/src/config.ts`** - API endpoint configuration
- **`vercel.json`** - Deployment configuration

## Support

For Vercel-specific issues:
- [Vercel Docs](https://vercel.com/docs)
- [Vercel Support](https://vercel.com/support)

For FastAPI/backend issues:
- [FastAPI Docs](https://fastapi.tiangolo.com)
- [Uvicorn Docs](https://www.uvicorn.org)
