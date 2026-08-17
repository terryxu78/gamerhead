# GamerHeads - AI Video Generation App

**GamerHeads** is a web application powered by Google's Vertex AI (Gemini 3.6 Flash and Gemini Omni models) that automates the creation of AI-generated scripts, avatar images, and video clips with synchronized dialogue and vocal reactions. Designed for one-command deployment to Google Cloud Run.

---

## Features

- **AI Script Generation & Video Analysis** — Generate high-energy livestream scripts and shot breakdowns using `gemini-3.6-flash` via Vertex AI.
- **AI Avatar / Image Generation** — Create character images using `gemini-3.1-flash-lite-image` (Vertex AI global endpoint).
- **AI Video & Vocal FX Generation** — Generate synchronized video clips and vocal reactions using `gemini-omni-flash-preview` (Gemini Omni Flash) with seamless scene continuity or original avatar adherence. Videos are automatically saved to a GCS bucket.
- **Script-Subtitled Export** — Optional checkbox at export time burns SRT subtitles (built from the script dialogue) into the final video.
- **Admin Dashboard** — Monitor usage across all users:
  - Scorecards: total generations, scripts, avatars, video clips, Gamerhead exports, H:V aspect ratio
  - Activity trend line chart (per model, per day)
  - Model usage bar chart
  - Activity log table with sortable columns, CSV export, and authenticated file download
- **User Management** — Add or remove authorized Google accounts at any time without redeployment.
- **Two Authentication Modes** — Google Sign-In (OAuth 2.0) or fixed username/password.
- **No API Keys Required** — All AI calls use Application Default Credentials (ADC) via Vertex AI. No Gemini API key needed.

---

## Deployment to Google Cloud Platform

The `deploy.sh` script handles everything interactively — infrastructure, permissions, and deployment.

### Prerequisites

1. **Google Cloud CLI** installed and authenticated:
   ```bash
   gcloud auth login
   ```
2. **GCP Project with Billing enabled** — Cloud Run requires an active billing account.
3. **Sufficient IAM permissions** in the project to create buckets, bind IAM roles, and deploy Cloud Run services.

### Running the Script

```bash
chmod +x deploy.sh
./deploy.sh
```

The script presents three modes:

| Mode | Description |
|------|-------------|
| `1` Full deployment | First-time setup: creates all resources and deploys |
| `2` Update code | Redeploys latest code, preserves all existing config |
| `3` Manage users | Add or remove authorized Google accounts |

### Full Deployment Walkthrough

When you select **Mode 1**, the script will:

1. **Enable GCP APIs** — Cloud Build, Cloud Run, Artifact Registry, Firestore, Vertex AI, Cloud Storage.
2. **Create Firestore database** (Datastore Mode) — stores all generation logs.
3. **Create GCS bucket** — stores generated videos. A default name is suggested; you can customize it.
4. **Configure authentication:**
   - **Option 1 — Google Sign-In (recommended):** Guides you through creating an OAuth 2.0 Client ID and optionally restricting access to a whitelist of Google email addresses.
   - **Option 2 — Fixed username/password:** Lets you define one or more username/password pairs injected as environment variables.
5. **Configure IAM permissions automatically** — The Compute Service Account is granted:
   - `roles/storage.objectAdmin` (project-wide + bucket-specific) — read/write GCS objects
   - `roles/iam.serviceAccountTokenCreator` — sign GCS URLs for authenticated file downloads
   - `roles/aiplatform.user` — call Vertex AI / Gemini / Omni APIs
   - `roles/datastore.user` — read/write Firestore logs
   - `roles/logging.logWriter`, `roles/monitoring.metricWriter`, `roles/cloudtrace.agent`
6. **Build and deploy** via Cloud Build (source-based, ~3–5 minutes).

---

## Admin Dashboard

Access the dashboard at `/admin` (or via the Admin button in the UI). It is only visible to users with admin privileges.

### Activity Log — File Download

Files stored in GCS are linked in the Activity Log table. Clicking a file link calls `/api/admin/signed-url` on the server, which generates a short-lived (15-minute) signed GCS URL and redirects the browser to it. This avoids Access Denied errors from direct GCS URLs, which require the bucket to be public.

Each click generates a fresh signed URL, so re-clicking a link always works regardless of when you last accessed the page.

### Model Name Display

Model names in the dashboard strip only the hyphen separator, preserving the vendor prefix:
- `gemini-omni-flash-preview` → `gemini omni-flash-preview`
- `gemini-3.6-flash` → `gemini 3.6-flash`
- `gemini-3.1-flash-lite-image` → `gemini 3.1-flash-lite-image`

---

## Managing Authorized Users (Google Sign-In mode)

After initial deployment, run the script and select **Mode 3** to add or remove authorized email addresses without touching any other configuration:

```bash
./deploy.sh
# → Select option 3
```

Changes take effect immediately with no redeployment.

---

## Updating the Code

To push new code to an existing deployment without changing any environment variables or configuration:

```bash
./deploy.sh
# → Select option 2
```

---

## Architecture Notes

- All AI API calls (Gemini 3.6 Flash, Gemini 3.1 Flash-Lite Image, Gemini Omni Flash) are made **server-side** from the Node.js Cloud Run instance using ADC (or optional `GEMINI_API_KEY`) — user browsers never touch the AI APIs directly.
- Generated videos are proxied through the server or stored to GCS; the GCS bucket is private by default.
- Firestore (Datastore Mode) is used for logging; no SQL database is required.
