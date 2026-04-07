#!/bin/bash

# GamerHeads Cloud Run 部署脚本 / Deployment Script
# 适用于多用户/开源部署环境 / For multi-user / open-source deployment
# 使用方法 / Usage: ./deploy.sh

set -e

# ── Language Selection / 语言选择 ─────────────────────────────
echo "Please select language / 请选择语言:"
echo "  1) 中文"
echo "  2) English"
read -p "Enter / 输入 [1/2, default/默认: 1]: " LANG_SEL
LANG_SEL=${LANG_SEL:-1}
if [ "$LANG_SEL" == "2" ]; then
    LANG_CHOICE="en"
else
    LANG_CHOICE="zh"
fi
echo ""

# Translation helper: _t "Chinese text" "English text"
_t() {
    if [ "$LANG_CHOICE" == "en" ]; then
        printf '%s' "$2"
    else
        printf '%s' "$1"
    fi
}

echo "🚀 GamerHeads Cloud Run $(_t "部署工具" "Deployment Tool")"
echo "=================================="
echo ""

# 检查是否已登录gcloud / Check gcloud login
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &>/dev/null; then
    echo "$(_t "❌ 未检测到活动的 gcloud 账号，请先运行:" "❌ No active gcloud account detected. Please run:")"
    echo "   gcloud auth login"
    exit 1
fi

# ── 选择操作模式 / Select operation mode ──────────────────────
echo "$(_t "请选择操作:" "Select an operation:")"
echo "  1) $(_t "全新部署" "Fresh deployment")"
echo "  2) $(_t "更新已有服务 (仅更新代码，保留现有配置)" "Update existing service (code only, keep existing config)")"
echo "  3) $(_t "管理授权用户 (添加/删除可登录的邮箱)" "Manage authorized users (add/remove login emails)")"
read -p "$(_t "输入选项 [1/2/3, 默认: 1]: " "Enter option [1/2/3, default: 1]: ")" DEPLOY_MODE
DEPLOY_MODE=${DEPLOY_MODE:-1}
echo ""

# 获取当前项目ID / Get current project ID
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null)

if [ -z "$CURRENT_PROJECT" ]; then
    echo "$(_t "⚠️  未设置默认 GCP 项目" "⚠️  No default GCP project set")"
    read -p "$(_t "请输入您的 GCP 项目ID: " "Please enter your GCP project ID: ")" PROJECT_ID
    gcloud config set project $PROJECT_ID
else
    echo "$(_t "📋 当前检测到的 GCP 项目: $CURRENT_PROJECT" "📋 Current GCP project detected: $CURRENT_PROJECT")"
    read -p "$(_t "是否部署到此项目? (y/n) [默认: y]: " "Deploy to this project? (y/n) [default: y]: ")" USE_CURRENT
    USE_CURRENT=${USE_CURRENT:-y}
    if [ "$USE_CURRENT" != "y" ]; then
        read -p "$(_t "请输入您想部署的 GCP 项目ID: " "Please enter the GCP project ID to deploy to: ")" PROJECT_ID
        gcloud config set project $PROJECT_ID
    else
        PROJECT_ID=$CURRENT_PROJECT
    fi
fi

# ══════════════════════════════════════════════════════════════
# 更新模式 / Update mode
# ══════════════════════════════════════════════════════════════
if [ "$DEPLOY_MODE" == "2" ]; then
    echo ""
    echo "$(_t "🔍 正在查询项目 [$PROJECT_ID] 中的 Cloud Run 服务..." "🔍 Fetching Cloud Run services in project [$PROJECT_ID]...")"
    SERVICES_RAW=$(gcloud run services list \
        --project=$PROJECT_ID \
        --platform=managed \
        --format="csv[no-heading](metadata.name,metadata.labels['cloud.googleapis.com/location'])" \
        2>/dev/null || echo "")

    if [ -z "$SERVICES_RAW" ]; then
        echo "$(_t "❌ 未找到任何 Cloud Run 服务，请先执行全新部署。" "❌ No Cloud Run services found. Please perform a fresh deployment first.")"
        exit 1
    fi

    echo ""
    echo "$(_t "已有服务列表:" "Existing services:")"
    echo "$SERVICES_RAW" | while IFS=',' read -r svc_name svc_region; do
        echo "   • $svc_name  ($svc_region)"
    done

    FIRST_SVC=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f1)
    FIRST_REGION=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f2)
    echo ""
    read -p "$(_t "输入要更新的服务名称 [默认: ${FIRST_SVC}]: " "Enter the service name to update [default: ${FIRST_SVC}]: ")" SERVICE_NAME
    SERVICE_NAME=${SERVICE_NAME:-$FIRST_SVC}
    read -p "$(_t "输入服务所在区域 [默认: ${FIRST_REGION}]: " "Enter the service region [default: ${FIRST_REGION}]: ")" REGION
    REGION=${REGION:-$FIRST_REGION}

    # 验证服务是否存在 / Verify service exists
    if ! gcloud run services describe "$SERVICE_NAME" \
            --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
        echo "$(_t "❌ 服务 [$SERVICE_NAME] 在区域 [$REGION] 不存在，请检查名称和区域。" "❌ Service [$SERVICE_NAME] not found in region [$REGION]. Please check the name and region.")"
        exit 1
    fi

    # 读取并展示现有配置 / Show existing config
    echo ""
    echo "$(_t "📋 现有服务配置 (将完整保留):" "📋 Existing service config (will be fully preserved):")"
    gcloud run services describe "$SERVICE_NAME" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="table[no-heading,box](
            spec.template.spec.containers[0].env[].name,
            spec.template.spec.containers[0].env[].value
        )" 2>/dev/null | sed 's/^/   /' || true

    echo ""
    echo "$(_t "📋 更新确认:" "📋 Update confirmation:")"
    echo "   $(_t "项目ID : $PROJECT_ID" "Project ID : $PROJECT_ID")"
    echo "   $(_t "服务名 : $SERVICE_NAME" "Service    : $SERVICE_NAME")"
    echo "   $(_t "区域   : $REGION" "Region     : $REGION")"
    echo "   $(_t "操作   : 仅更新代码，所有环境变量/配置保持不变" "Action     : Code update only, all env vars/config unchanged")"
    echo ""
    read -p "$(_t "确认开始更新? (y/n) [默认: y]: " "Confirm update? (y/n) [default: y]: ")" CONFIRM
    CONFIRM=${CONFIRM:-y}
    if [ "$CONFIRM" != "y" ]; then
        echo "$(_t "❌ 已取消" "❌ Cancelled")"
        exit 0
    fi

    echo ""
    echo "$(_t "🏗️  开始更新 Cloud Run 服务..." "🏗️  Starting Cloud Run service update...")"
    echo "$(_t "📦 正在将本地源码打包并通过 Cloud Build 构建 (大约需要 3-5 分钟)..." "📦 Packaging local source and building via Cloud Build (approx. 3-5 minutes)...")"

    gcloud run deploy "$SERVICE_NAME" \
        --source . \
        --region="$REGION" \
        --platform=managed \
        --project="$PROJECT_ID"

    echo ""
    echo "$(_t "✅ 更新成功!" "✅ Update successful!")"
    echo ""
    PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
    SERVICE_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"
    echo "$(_t "🌐 服务访问地址: $SERVICE_URL" "🌐 Service URL: $SERVICE_URL")"
    echo ""
    echo "$(_t "🎉 代码已更新，原有配置（Bucket、验证方式等）均保持不变。" "🎉 Code updated. Existing config (Bucket, auth settings, etc.) remains unchanged.")"
    exit 0
fi

# ══════════════════════════════════════════════════════════════
# 管理授权用户模式 / Manage authorized users mode
# ══════════════════════════════════════════════════════════════
if [ "$DEPLOY_MODE" == "3" ]; then
    echo ""
    echo "$(_t "🔍 正在查询项目 [$PROJECT_ID] 中的 Cloud Run 服务..." "🔍 Fetching Cloud Run services in project [$PROJECT_ID]...")"
    SERVICES_RAW=$(gcloud run services list \
        --project=$PROJECT_ID \
        --platform=managed \
        --format="csv[no-heading](metadata.name,metadata.labels['cloud.googleapis.com/location'])" \
        2>/dev/null || echo "")

    if [ -z "$SERVICES_RAW" ]; then
        echo "$(_t "❌ 未找到任何 Cloud Run 服务" "❌ No Cloud Run services found")"
        exit 1
    fi

    echo ""
    echo "$(_t "已有服务列表:" "Existing services:")"
    echo "$SERVICES_RAW" | while IFS=',' read -r svc_name svc_region; do
        echo "   • $svc_name  ($svc_region)"
    done

    FIRST_SVC=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f1)
    FIRST_REGION=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f2)
    echo ""
    read -p "$(_t "输入服务名称 [默认: ${FIRST_SVC}]: " "Enter service name [default: ${FIRST_SVC}]: ")" SERVICE_NAME
    SERVICE_NAME=${SERVICE_NAME:-$FIRST_SVC}
    read -p "$(_t "输入服务区域 [默认: ${FIRST_REGION}]: " "Enter service region [default: ${FIRST_REGION}]: ")" REGION
    REGION=${REGION:-$FIRST_REGION}

    # 验证服务是否存在 / Verify service exists
    if ! gcloud run services describe "$SERVICE_NAME" \
            --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
        echo "$(_t "❌ 服务 [$SERVICE_NAME] 在区域 [$REGION] 不存在，请检查名称和区域。" "❌ Service [$SERVICE_NAME] not found in region [$REGION]. Please check the name and region.")"
        exit 1
    fi

    # 读取当前所有环境变量 / Read current env vars
    echo ""
    echo "$(_t "🔍 正在读取当前配置..." "🔍 Reading current configuration...")"
    ENV_JSON=$(gcloud run services describe "$SERVICE_NAME" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="json(spec.template.spec.containers[0].env)" 2>/dev/null) || true

    # 解析各环境变量 / Parse env vars
    get_env() {
        echo "$ENV_JSON" | grep -A1 "\"name\": \"$1\"" | grep '"value"' | sed 's/.*"value": "\(.*\)".*/\1/' || true
    }

    CUR_PROJECT=$(get_env "GOOGLE_CLOUD_PROJECT")
    CUR_LOCATION=$(get_env "GCP_LOCATION")
    CUR_DATABASE=$(get_env "DATASTORE_DATABASE")
    CUR_BUCKET=$(get_env "GCS_BUCKET_NAME")
    CUR_CLIENT_ID=$(get_env "GOOGLE_CLIENT_ID")
    CUR_AUTHORIZED=$(get_env "AUTHORIZED_USERS")
    CUR_BASIC_AUTH=$(get_env "BASIC_AUTH_USERS")

    if [ -z "$CUR_CLIENT_ID" ]; then
        echo "$(_t "❌ 该服务未启用 Google Sign-In，无法管理授权用户。" "❌ This service does not have Google Sign-In enabled. Cannot manage authorized users.")"
        exit 1
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 当前授权用户列表:" "📋 Current authorized users:")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ -z "$CUR_AUTHORIZED" ]; then
        echo "   $(_t "（未设置，任意 Google 账号均可登录）" "(Not set — any Google account can log in)")"
    else
        echo "$CUR_AUTHORIZED" | tr ',' '\n' | while read -r email; do
            echo "   • $email"
        done
    fi

    echo ""
    echo "$(_t "请选择操作:" "Select an operation:")"
    echo "  1) $(_t "添加新用户" "Add new user")"
    echo "  2) $(_t "删除用户" "Remove user")"
    echo "  3) $(_t "查看当前列表后退出" "View current list and exit")"
    read -p "$(_t "输入选项 [1/2/3]: " "Enter option [1/2/3]: ")" USER_OP

    NEW_AUTHORIZED="$CUR_AUTHORIZED"

    if [ "$USER_OP" == "1" ]; then
        echo ""
        echo "$(_t "输入要添加的邮箱 (每行一个，直接回车结束):" "Enter emails to add (one per line, press Enter when done):")"
        while true; do
            read -p "$(_t "  邮箱: " "  Email: ")" NEW_EMAIL
            [ -z "$NEW_EMAIL" ] && break
            if echo "$NEW_AUTHORIZED" | tr ',' '\n' | grep -qx "$NEW_EMAIL"; then
                echo "  ⚠️  $NEW_EMAIL $(_t "已在列表中" "is already in the list")"
            else
                if [ -z "$NEW_AUTHORIZED" ]; then
                    NEW_AUTHORIZED="$NEW_EMAIL"
                else
                    NEW_AUTHORIZED="${NEW_AUTHORIZED},${NEW_EMAIL}"
                fi
                echo "  ✅ $(_t "已添加: $NEW_EMAIL" "Added: $NEW_EMAIL")"
            fi
        done

    elif [ "$USER_OP" == "2" ]; then
        echo ""
        echo "$(_t "当前用户列表:" "Current user list:")"
        i=1
        declare -a EMAIL_ARR
        while IFS= read -r email; do
            echo "  $i) $email"
            EMAIL_ARR[$i]="$email"
            i=$((i+1))
        done < <(echo "$CUR_AUTHORIZED" | tr ',' '\n')

        echo ""
        read -p "$(_t "输入要删除的用户编号 (多个用空格分隔): " "Enter numbers of users to remove (space-separated): ")" DEL_NUMS
        for num in $DEL_NUMS; do
            DEL_EMAIL="${EMAIL_ARR[$num]}"
            if [ -n "$DEL_EMAIL" ]; then
                NEW_AUTHORIZED=$(echo "$NEW_AUTHORIZED" | tr ',' '\n' | grep -vx "$DEL_EMAIL" | tr '\n' ',' | sed 's/,$//')
                echo "  ✅ $(_t "已删除: $DEL_EMAIL" "Removed: $DEL_EMAIL")"
            fi
        done

    else
        exit 0
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 更新后的授权用户列表:" "📋 Updated authorized user list:")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$NEW_AUTHORIZED" | tr ',' '\n' | while read -r email; do
        echo "   • $email"
    done
    echo ""
    read -p "$(_t "确认更新? (y/n) [默认: y]: " "Confirm update? (y/n) [default: y]: ")" CONFIRM
    CONFIRM=${CONFIRM:-y}
    if [ "$CONFIRM" != "y" ]; then
        echo "$(_t "❌ 已取消" "❌ Cancelled")"
        exit 0
    fi

    # 写回所有环境变量 / Write back all env vars
    TMPFILE=$(mktemp)
    [ -n "$CUR_PROJECT" ]   && echo "GOOGLE_CLOUD_PROJECT: '${CUR_PROJECT}'"  >> "$TMPFILE"
    [ -n "$CUR_LOCATION" ]  && echo "GCP_LOCATION: '${CUR_LOCATION}'"         >> "$TMPFILE"
    [ -n "$CUR_DATABASE" ]  && echo "DATASTORE_DATABASE: '${CUR_DATABASE}'"   >> "$TMPFILE"
    [ -n "$CUR_BUCKET" ]    && echo "GCS_BUCKET_NAME: '${CUR_BUCKET}'"        >> "$TMPFILE"
    [ -n "$CUR_CLIENT_ID" ] && echo "GOOGLE_CLIENT_ID: '${CUR_CLIENT_ID}'"    >> "$TMPFILE"
    [ -n "$CUR_BASIC_AUTH" ] && echo "BASIC_AUTH_USERS: '${CUR_BASIC_AUTH}'"  >> "$TMPFILE"
    echo "AUTHORIZED_USERS: '${NEW_AUTHORIZED}'" >> "$TMPFILE"

    echo ""
    echo "$(_t "🔄 正在更新授权用户..." "🔄 Updating authorized users...")"
    gcloud run services update "$SERVICE_NAME" \
        --region="$REGION" \
        --project="$PROJECT_ID" \
        --env-vars-file="$TMPFILE" 2>&1
    rm -f "$TMPFILE"

    echo ""
    echo "$(_t "✅ 授权用户已更新，新用户立即生效，无需其他操作。" "✅ Authorized users updated. Changes take effect immediately — no further action needed.")"
    exit 0
fi

# ══════════════════════════════════════════════════════════════
# 全新部署模式 / Fresh deployment mode
# ══════════════════════════════════════════════════════════════

# 检查并设置 Billing / Check Billing
BILLING_ENABLED=$(gcloud beta billing projects describe $PROJECT_ID --format="value(billingEnabled)" 2>/dev/null || echo "False")
if [ "$BILLING_ENABLED" != "True" ]; then
    echo "$(_t "❌ 错误: 您的项目 $PROJECT_ID 未启用结算功能(Billing)。" "❌ Error: Billing is not enabled for project $PROJECT_ID.")"
    echo "$(_t "Cloud Run 需要开启结算账户才能使用。请访问 GCP 控制台开启后重试。" "Cloud Run requires billing to be enabled. Please enable it in the GCP Console and retry.")"
    exit 1
fi

echo ""
echo "$(_t "🔧 正在启用必要的 GCP API (这可能需要几分钟)..." "🔧 Enabling required GCP APIs (this may take a few minutes)...")"
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  --project=$PROJECT_ID

# 设置服务名称 / Set service name
read -p "$(_t "输入 Cloud Run 服务名称 [默认: gamerheads]: " "Enter Cloud Run service name [default: gamerheads]: ")" SERVICE_NAME
SERVICE_NAME=${SERVICE_NAME:-gamerheads}

# 设置区域 / Set region
read -p "$(_t "输入部署区域 [默认: us-central1]: " "Enter deployment region [default: us-central1]: ")" REGION
REGION=${REGION:-us-central1}

# 设置数据库名称 / Set database name
read -p "$(_t "输入 Firestore 数据库名称 [默认: gamerheads]: " "Enter Firestore database name [default: gamerheads]: ")" DATASTORE_DATABASE
DATASTORE_DATABASE=${DATASTORE_DATABASE:-gamerheads}

echo ""
echo "$(_t "🗄️  检查并创建 Datastore Mode 数据库 [$DATASTORE_DATABASE]..." "🗄️  Checking/creating Datastore Mode database [$DATASTORE_DATABASE]...")"
DB_EXISTS=$(gcloud firestore databases describe \
  --database="$DATASTORE_DATABASE" \
  --project=$PROJECT_ID \
  --format="value(name)" 2>/dev/null || echo "")

if [ -z "$DB_EXISTS" ]; then
    echo "   $(_t "创建 Datastore Mode 数据库: $DATASTORE_DATABASE (region: $REGION)..." "Creating Datastore Mode database: $DATASTORE_DATABASE (region: $REGION)...")"
    gcloud firestore databases create \
      --database="$DATASTORE_DATABASE" \
      --location="$REGION" \
      --type=datastore-mode \
      --project=$PROJECT_ID
    echo "   ✅ $(_t "数据库 [$DATASTORE_DATABASE] 创建成功" "Database [$DATASTORE_DATABASE] created successfully")"
else
    echo "   ℹ️  $(_t "数据库 [$DATASTORE_DATABASE] 已存在，跳过创建" "Database [$DATASTORE_DATABASE] already exists, skipping creation")"
fi

echo ""
echo "$(_t "ℹ️  此版本使用 Vertex AI (Application Default Credentials)，无需 Gemini API Key。" "ℹ️  This version uses Vertex AI (Application Default Credentials) — no Gemini API Key required.")"
echo "   $(_t "Cloud Run 将使用 Compute Service Account 自动鉴权。" "Cloud Run will authenticate automatically using the Compute Service Account.")"
echo ""
echo "$(_t "📦 配置生成视频的 GCS 存储桶:" "📦 Configure GCS bucket for generated videos:")"
DEFAULT_BUCKET="gamerheads$(date +%s | tail -c 5 | head -c 4)"
echo "   $(_t "默认 Bucket 名称: ${DEFAULT_BUCKET}" "Default bucket name: ${DEFAULT_BUCKET}")"
read -p "$(_t "输入 GCS Bucket 名称 (直接回车使用默认 [${DEFAULT_BUCKET}]): " "Enter GCS bucket name (press Enter to use default [${DEFAULT_BUCKET}]): ")" GCS_BUCKET
GCS_BUCKET=${GCS_BUCKET:-$DEFAULT_BUCKET}

# Create bucket if it doesn't exist
if ! gsutil ls "gs://${GCS_BUCKET}" &>/dev/null; then
    echo "   $(_t "创建 GCS Bucket: gs://${GCS_BUCKET} (region: ${REGION:-us-central1})..." "Creating GCS bucket: gs://${GCS_BUCKET} (region: ${REGION:-us-central1})...")"
    gsutil mb -l "${REGION:-us-central1}" "gs://${GCS_BUCKET}"
    echo "   ✅ $(_t "Bucket 创建成功" "Bucket created successfully")"
else
    echo "   ℹ️  $(_t "Bucket 已存在: gs://${GCS_BUCKET}" "Bucket already exists: gs://${GCS_BUCKET}")"
fi
GCS_BUCKET_NAME_ENV="$GCS_BUCKET"

echo "$(_t "🛡️  请选择网站登录验证方式:" "🛡️  Select website login authentication method:")"
echo "1) $(_t "Google 账号登录 (推荐，用户使用 Google 账号登录)" "Google Sign-In (recommended — users log in with their Google account)")"
echo "2) $(_t "固定用户名和密码验证" "Fixed username and password")"
read -p "$(_t "输入选项 [1/2, 默认: 1]: " "Enter option [1/2, default: 1]: ")" AUTH_MODE
AUTH_MODE=${AUTH_MODE:-1}

BASIC_AUTH_ENV=""
GOOGLE_CLIENT_ID_ENV=""
AUTHORIZED_USERS_ENV=""

if [ "$AUTH_MODE" == "1" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 步骤一：配置 Google Auth Platform (OAuth 同意屏幕)" "📋 Step 1: Configure Google Auth Platform (OAuth Consent Screen)")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   1. $(_t "访问: https://console.cloud.google.com/auth/overview" "Go to: https://console.cloud.google.com/auth/overview")"
    echo "      $(_t "选择项目: $PROJECT_ID" "Select project: $PROJECT_ID")"
    echo ""
    echo "   2. $(_t "点击「Get Started」(首次) 或进入已有配置" "Click \"Get Started\" (first time) or open existing config")"
    echo ""
    echo "   3. $(_t "【Branding】页面:" "【Branding】page:")"
    echo "      - App name: GamerHeads ($(_t "或自定义" "or custom name"))"
    echo "      - User support email: $(_t "填写您的邮箱" "enter your email")"
    echo "      - Developer contact email: $(_t "填写您的邮箱" "enter your email")"
    echo "      → Next"
    echo ""
    echo "   4. $(_t "【Audience】页面:" "【Audience】page:")"
    echo "      - $(_t "选择「External」" "Select \"External\"")"
    echo "      → Next"
    echo "   5. → $(_t "Contact Info 页面: 填写您的邮箱，完成后点击「Save and Create」" "Contact Info page: enter your email, then click \"Save and Create\"")"
    echo ""
    echo "   6. $(_t "【Audience】页面: 点击发布应用" "【Audience】page: click \"Publish app\"")"
    echo ""
    read -p "   ✅ $(_t "以上步骤完成后按回车继续..." "Press Enter when the above steps are complete...")" _CONFIRM_AUTH_PLATFORM
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 步骤二：创建 OAuth 2.0 客户端 ID" "📋 Step 2: Create OAuth 2.0 Client ID")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   1. $(_t "访问: https://console.cloud.google.com/apis/credentials" "Go to: https://console.cloud.google.com/apis/credentials")"
    echo "      $(_t "选择项目: $PROJECT_ID" "Select project: $PROJECT_ID")"
    echo ""
    echo "   2. $(_t "点击「创建凭据」→「OAuth 客户端 ID」" "Click \"Create Credentials\" → \"OAuth client ID\"")"
    echo ""
    echo "   3. $(_t "应用类型选「Web 应用」" "Set application type to \"Web application\"")"
    echo ""
    echo "   4. $(_t "「已获授权的 JavaScript 来源」填入 Cloud Run 服务 URL" "Under \"Authorized JavaScript origins\" enter the Cloud Run service URL")"
    echo "      $(_t "初次部署可先填: http://localhost" "For first deployment you can use: http://localhost")"
    echo "      $(_t "部署完成后再改为实际 URL (如: https://gamerheads-xxx.run.app)" "Update to the real URL after deployment (e.g. https://gamerheads-xxx.run.app)")"
    echo ""
    echo "   5. $(_t "点击「创建」，复制生成的「客户端 ID」" "Click \"Create\" and copy the generated \"Client ID\"")"
    echo ""
    read -p "👉 $(_t "输入 OAuth 2.0 客户端 ID: " "Enter OAuth 2.0 Client ID: ")" GOOGLE_CLIENT_ID_INPUT
    if [ -z "$GOOGLE_CLIENT_ID_INPUT" ]; then
        echo "$(_t "❌ 客户端 ID 不能为空" "❌ Client ID cannot be empty")"
        exit 1
    fi
    GOOGLE_CLIENT_ID_ENV="$GOOGLE_CLIENT_ID_INPUT"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 步骤三：配置授权用户" "📋 Step 3: Configure authorized users")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   $(_t "Google Auth Platform 已设为公开，由应用层统一控制访问权限。" "Google Auth Platform is set to public; access is controlled at the application level.")"
    echo "   $(_t "输入允许登录的邮箱列表（逗号分隔）。" "Enter the list of emails allowed to log in (comma-separated).")"
    echo "   $(_t "留空 = 任意 Google 账号均可进入应用（不推荐）。" "Leave empty = any Google account can access the app (not recommended).")"
    echo "   $(_t "后续可随时通过 ./deploy.sh 选 3 添加/删除用户。" "You can add/remove users anytime by running ./deploy.sh and selecting option 3.")"
    echo "   ($(_t "如: a@gmail.com,b@company.com" "e.g. a@gmail.com,b@company.com"))"
    echo ""
    read -p "👉 $(_t "授权邮箱列表: " "Authorized email list: ")" AUTHORIZED_USERS_INPUT
    AUTHORIZED_USERS_ENV="$AUTHORIZED_USERS_INPUT"

    echo ""
    echo "✅ $(_t "Google Sign-In 配置完成" "Google Sign-In configuration complete")"

elif [ "$AUTH_MODE" == "2" ]; then
    echo ""
    echo "$(_t "配置固定用户名和密码 (支持多个账号):" "Configure fixed username(s) and password(s) (multiple accounts supported):")"

    USERS_LIST=""
    USER_COUNT=0

    while true; do
        read -p "👉 $(_t "输入用户名 (直接回车结束添加): " "Enter username (press Enter when done): ")" BASIC_USER
        if [ -z "$BASIC_USER" ]; then
            if [ $USER_COUNT -eq 0 ]; then
                echo "$(_t "❌ 至少需要配置一个用户名或密码" "❌ At least one username/password is required")"
                exit 1
            fi
            break
        fi

        read -s -p "🔑 $(_t "输入密码: " "Enter password: ")" BASIC_PASS
        echo ""
        if [ -z "$BASIC_PASS" ]; then
            echo "$(_t "❌ 密码不能为空，请重新输入" "❌ Password cannot be empty. Please try again.")"
            continue
        fi

        if [ -z "$USERS_LIST" ]; then
            USERS_LIST="${BASIC_USER}:${BASIC_PASS}"
        else
            USERS_LIST="${USERS_LIST},${BASIC_USER}:${BASIC_PASS}"
        fi

        USER_COUNT=$((USER_COUNT + 1))
        echo "✅ $(_t "账号 [$BASIC_USER] 已记录. (当前共 $USER_COUNT 个账号)" "Account [$BASIC_USER] recorded. (Total: $USER_COUNT account(s))")"
        echo "----------------------------------------"
    done

    BASIC_AUTH_ENV="$USERS_LIST"
    echo "✅ $(_t "已完成配置 (共 $USER_COUNT 个账号)" "Configuration complete ($USER_COUNT account(s))")"
fi

echo ""
echo "$(_t "📋 部署确认:" "📋 Deployment confirmation:")"
echo "   $(_t "项目ID: $PROJECT_ID" "Project ID: $PROJECT_ID")"
echo "   $(_t "服务名: $SERVICE_NAME" "Service   : $SERVICE_NAME")"
echo "   $(_t "区域: $REGION" "Region    : $REGION")"
echo "   $(_t "数据库: $DATASTORE_DATABASE" "Database  : $DATASTORE_DATABASE")"
echo "   $(_t "AI 模式: Vertex AI (ADC)" "AI mode   : Vertex AI (ADC)")"
echo "   $(_t "视频存储: gs://${GCS_BUCKET_NAME_ENV}" "Video storage: gs://${GCS_BUCKET_NAME_ENV}")"
if [ "$AUTH_MODE" == "1" ]; then
    echo "   $(_t "验证方式: Google Sign-In" "Auth method: Google Sign-In")"
    echo "   $(_t "Client ID: ${GOOGLE_CLIENT_ID_ENV:0:20}..." "Client ID  : ${GOOGLE_CLIENT_ID_ENV:0:20}...")"
    if [ -n "$AUTHORIZED_USERS_ENV" ]; then
        echo "   $(_t "授权用户: $AUTHORIZED_USERS_ENV" "Authorized users: $AUTHORIZED_USERS_ENV")"
    else
        echo "   $(_t "授权用户: 任意 Google 账号" "Authorized users: Any Google account")"
    fi
elif [ "$AUTH_MODE" == "2" ]; then
    echo "   $(_t "验证方式: 固定用户名/密码 (共 $USER_COUNT 个账号)" "Auth method: Fixed username/password ($USER_COUNT account(s))")"
fi
echo ""

read -p "$(_t "确认开始部署? (y/n) [默认: y]: " "Confirm deployment? (y/n) [default: y]: ")" CONFIRM
CONFIRM=${CONFIRM:-y}
if [ "$CONFIRM" != "y" ]; then
    echo "$(_t "❌ 已取消部署" "❌ Deployment cancelled")"
    exit 0
fi

echo ""
echo "$(_t "🔐 配置服务权限..." "🔐 Configuring service permissions...")"
# 获取 Project Number / Get Project Number
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

echo "   - $(_t "配置 Cloud Build 权限..." "Configuring Cloud Build permissions...")"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer" \
  --condition=None \
  > /dev/null 2>&1 || echo "   ($(_t "忽略权限赋予的警告，继续执行" "Ignoring permission grant warning, continuing"))"

echo "   - $(_t "配置 Cloud Run 运行所需的各项服务权限 (Datastore, Vertex AI, Storage 等)..." "Configuring Cloud Run service permissions (Datastore, Vertex AI, Storage, etc.)...")"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

if [ -n "$GCS_BUCKET_NAME_ENV" ]; then
    echo "   - $(_t "授予 Compute SA 对 gs://${GCS_BUCKET_NAME_ENV} 的访问权限..." "Granting Compute SA access to gs://${GCS_BUCKET_NAME_ENV}...")"
    gsutil iam ch "serviceAccount:${COMPUTE_SA}:roles/storage.objectAdmin" "gs://${GCS_BUCKET_NAME_ENV}" \
      > /dev/null 2>&1 || echo "   ($(_t "⚠️ Bucket IAM 绑定失败，请确认您有该 Bucket 的管理权限" "⚠️ Bucket IAM binding failed — ensure you have admin rights on this bucket"))"
fi

ROLES=(
  "roles/datastore.user"
  "roles/cloudtrace.agent"
  "roles/cloudtranslate.user"
  "roles/logging.logWriter"
  "roles/monitoring.metricWriter"
  "roles/iam.serviceAccountTokenCreator"
  "roles/storage.objectAdmin"
  "roles/aiplatform.user"
)

for ROLE in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="$ROLE" \
    --condition=None \
    > /dev/null 2>&1 || echo "   ($(_t "⚠️ 无法绑定角色 $ROLE，可能是权限不足" "⚠️ Could not bind role $ROLE — insufficient permissions"))"
done

echo "   ✅ $(_t "权限配置完成" "Permission configuration complete")"

echo ""
echo "$(_t "🏗️  开始部署到 Cloud Run..." "🏗️  Starting deployment to Cloud Run...")"
echo "$(_t "📦 正在将本地源码打包并利用 GCP Cloud Build 进行云端构建并部署 (大约需要 3-5 分钟)..." "📦 Packaging local source and building via GCP Cloud Build (approx. 3-5 minutes)...")"

# 使用临时文件传递环境变量以支持密码中的特殊字符 (!@#$%^&*)
# Use a temp file to pass env vars — supports special chars in passwords
ENV_FILE=$(mktemp)
echo "GOOGLE_CLOUD_PROJECT: \"${PROJECT_ID}\"" >> "$ENV_FILE"
echo "GCP_LOCATION: \"${REGION}\"" >> "$ENV_FILE"
echo "DATASTORE_DATABASE: \"${DATASTORE_DATABASE}\"" >> "$ENV_FILE"
if [ -n "$GCS_BUCKET_NAME_ENV" ]; then
    echo "GCS_BUCKET_NAME: \"${GCS_BUCKET_NAME_ENV}\"" >> "$ENV_FILE"
fi
if [ "$AUTH_MODE" == "1" ]; then
    echo "GOOGLE_CLIENT_ID: \"${GOOGLE_CLIENT_ID_ENV}\"" >> "$ENV_FILE"
    if [ -n "$AUTHORIZED_USERS_ENV" ]; then
        echo "AUTHORIZED_USERS: '${AUTHORIZED_USERS_ENV}'" >> "$ENV_FILE"
    fi
elif [ "$AUTH_MODE" == "2" ]; then
    # 单引号可以防止 YAML 解析器转义特殊字符
    # Single quotes prevent YAML parser from escaping special characters
    echo "BASIC_AUTH_USERS: '${BASIC_AUTH_ENV}'" >> "$ENV_FILE"
fi

gcloud run deploy $SERVICE_NAME \
  --source . \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --env-vars-file="$ENV_FILE" \
  --memory=2Gi \
  --cpu=2 \
  --timeout=3600 \
  --max-instances=10 \
  --min-instances=0 \
  --project=$PROJECT_ID

rm -f "$ENV_FILE"

echo ""
echo "✅ $(_t "部署成功!" "Deployment successful!")"
echo ""

PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SERVICE_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"

echo "$(_t "🌐 服务访问地址: $SERVICE_URL" "🌐 Service URL: $SERVICE_URL")"
echo ""
echo "$(_t "🎉 恭喜！GamerHeads 现已在您的 GCP 环境中运行。" "🎉 Congratulations! GamerHeads is now running in your GCP environment.")"
