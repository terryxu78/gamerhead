<div align="center">
<img width="1200" height="475" alt="GamerHeads Banner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# GamerHeads - AI Video Generation App

This repository contains the source code for **GamerHeads**, a web application that leverages Google's Gemini models (including Veo for video generation) to create dynamic video content. The project is designed to be easily deployed to your own Google Cloud Platform (GCP) environment via Cloud Run.

---

## 🚀 Features

- **Automated AI Video Creation:** Generate images, scripts, and video clips using Gemini and Veo models.
- **Admin Dashboard:** Monitor API usage, view generated logs, and export statistics.
- **Built-in Authentication:** Protect your application either using Google Identity-Aware Proxy (IAP) or simple Basic Authentication (Fixed Username/Password).
- **One-Click Deployment:** A comprehensive `deploy.sh` script automates GCP Cloud Build, Cloud Run deployment, Datastore setup, and IAM permissions.

---

## 💻 Local Development

**Prerequisites:**  
- [Node.js](https://nodejs.org/) (v20+ recommended)

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Set your API Key:**
   Create a `.env.local` file in the root directory (or edit the existing one) and add your Gemini API key:
   ```env
   VITE_GEMINI_API_KEY=your_gemini_api_key_here
   ```
3. **Run the app locally:**
   ```bash
   npm run dev
   ```

---

## ☁️ Deployment to Google Cloud Platform (GCP)

This project includes a robust deployment script (`deploy.sh`) that automates the process of building the code in the cloud and deploying it to **Google Cloud Run**.

### Prerequisites for Cloud Deployment
1. **Google Cloud CLI:** Ensure you have the `gcloud` CLI installed and initialized.
   ```bash
   gcloud auth login
   ```
2. **GCP Project with Billing Enabled:** You must have a GCP Project ID, and it **must be linked to an active Billing Account**, as Cloud Run requires billing to be enabled.
3. **Gemini API Key:** Obtain an API key from Google AI Studio.

### Deployment Steps

1. Make the deployment script executable:
   ```bash
   chmod +x deploy.sh
   ```
2. Run the deployment script:
   ```bash
   ./deploy.sh
   ```
3. **Follow the interactive prompts:**
   - Confirm or input your GCP Project ID.
   - Set the Cloud Run service name and region (defaults to `us-central1`).
   - Enter your Gemini API Key.
   - **Choose Authentication Method:**
     - **Option 1 (IAP):** Leaves the app open internally, relying on you configuring GCP Identity-Aware Proxy in the Cloud Console to restrict access.
     - **Option 2 (Fixed Password):** Allows you to add one or multiple Username/Password combinations. The script securely injects these credentials into Cloud Run via environment variables, triggering a browser native login prompt when accessing the site.
4. **Sit back and relax:** The script will automatically:
   - Enable necessary GCP APIs (Cloud Build, Cloud Run, Artifact Registry, Firestore).
   - Create a Firestore Native database to store generation logs.
   - Fix any IAM permissions for the Cloud Build and Cloud Run service accounts.
   - Build the Docker container in the cloud and deploy it to Cloud Run.

---

## ⚠️ Important Note on API Region Restrictions

**"User location is not supported for the API use" Error**

The architecture of this application initiates Gemini API requests (like image, script, and Veo video generation) directly from the **client-side (the user's browser)** to Google's API servers. 

If you or your users encounter a region restriction error, it means **your local machine's IP address** is in a region where Google does not currently support the Gemini/Veo API.

**Solution:** You must use a VPN or proxy on your local machine (e.g., set to a US node) before clicking the generate buttons in the web application.

---

## 🛡️ Admin Dashboard & Logs

The application includes an `/admin` route (or click the Admin Dashboard button). 
- If you deployed using **Option 2 (Fixed Password)**, the system automatically extracts the username you logged in with.
- If you deployed using **Option 1 (IAP)**, it automatically extracts your Google Account Email from the IAP headers.
- All generation actions (successes and failures) are logged to GCP Datastore/Firestore and displayed securely in the dashboard.