#!/bin/bash

# GamerHeads Cloud Run 部署脚本
# 适用于多用户/开源部署环境
# 使用方法: ./deploy.sh

set -e

echo "🚀 GamerHeads Cloud Run 部署工具"
echo "=================================="
echo ""

# 检查是否已登录gcloud
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &>/dev/null; then
    echo "❌ 未检测到活动的 gcloud 账号，请先运行:"
    echo "   gcloud auth login"
    exit 1
fi

# ── 选择操作模式 ──────────────────────────────────────────────
echo "请选择操作:"
echo "  1) 全新部署"
echo "  2) 更新已有服务 (仅更新代码，保留现有配置)"
echo "  3) 管理授权用户 (添加/删除可登录的邮箱)"
read -p "输入选项 [1/2/3, 默认: 1]: " DEPLOY_MODE
DEPLOY_MODE=${DEPLOY_MODE:-1}
echo ""

# 获取当前项目ID
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null)

if [ -z "$CURRENT_PROJECT" ]; then
    echo "⚠️  未设置默认 GCP 项目"
    read -p "请输入您的 GCP 项目ID: " PROJECT_ID
    gcloud config set project $PROJECT_ID
else
    echo "📋 当前检测到的 GCP 项目: $CURRENT_PROJECT"
    read -p "是否部署到此项目? (y/n) [默认: y]: " USE_CURRENT
    USE_CURRENT=${USE_CURRENT:-y}
    if [ "$USE_CURRENT" != "y" ]; then
        read -p "请输入您想部署的 GCP 项目ID: " PROJECT_ID
        gcloud config set project $PROJECT_ID
    else
        PROJECT_ID=$CURRENT_PROJECT
    fi
fi

# ══════════════════════════════════════════════════════════════
# 更新模式：读取现有服务配置，直接重新部署代码
# ══════════════════════════════════════════════════════════════
if [ "$DEPLOY_MODE" == "2" ]; then
    echo ""
    echo "🔍 正在查询项目 [$PROJECT_ID] 中的 Cloud Run 服务..."
    SERVICES_RAW=$(gcloud run services list \
        --project=$PROJECT_ID \
        --platform=managed \
        --format="csv[no-heading](metadata.name,metadata.labels['cloud.googleapis.com/location'])" \
        2>/dev/null || echo "")

    if [ -z "$SERVICES_RAW" ]; then
        echo "❌ 未找到任何 Cloud Run 服务，请先执行全新部署。"
        exit 1
    fi

    echo ""
    echo "已有服务列表:"
    echo "$SERVICES_RAW" | while IFS=',' read -r svc_name svc_region; do
        echo "   • $svc_name  ($svc_region)"
    done

    echo ""
    read -p "输入要更新的服务名称 [默认: gamerheads]: " SERVICE_NAME
    SERVICE_NAME=${SERVICE_NAME:-gamerheads}
    read -p "输入服务所在区域 [默认: us-central1]: " REGION
    REGION=${REGION:-us-central1}

    # 验证服务是否存在
    if ! gcloud run services describe "$SERVICE_NAME" \
            --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
        echo "❌ 服务 [$SERVICE_NAME] 在区域 [$REGION] 不存在，请检查名称和区域。"
        exit 1
    fi

    # 读取并展示现有配置
    echo ""
    echo "📋 现有服务配置 (将完整保留):"
    gcloud run services describe "$SERVICE_NAME" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="table[no-heading,box](
            spec.template.spec.containers[0].env[].name,
            spec.template.spec.containers[0].env[].value
        )" 2>/dev/null | sed 's/^/   /' || true

    echo ""
    echo "📋 更新确认:"
    echo "   项目ID : $PROJECT_ID"
    echo "   服务名 : $SERVICE_NAME"
    echo "   区域   : $REGION"
    echo "   操作   : 仅更新代码，所有环境变量/配置保持不变"
    echo ""
    read -p "确认开始更新? (y/n) [默认: y]: " CONFIRM
    CONFIRM=${CONFIRM:-y}
    if [ "$CONFIRM" != "y" ]; then
        echo "❌ 已取消"
        exit 0
    fi

    echo ""
    echo "🏗️  开始更新 Cloud Run 服务..."
    echo "📦 正在将本地源码打包并通过 Cloud Build 构建 (大约需要 3-5 分钟)..."

    gcloud run deploy "$SERVICE_NAME" \
        --source . \
        --region="$REGION" \
        --platform=managed \
        --project="$PROJECT_ID"

    echo ""
    echo "✅ 更新成功!"
    echo ""
    PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
    SERVICE_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"
    echo "🌐 服务访问地址: $SERVICE_URL"
    echo ""
    echo "🎉 代码已更新，原有配置（Bucket、验证方式等）均保持不变。"
    exit 0
fi

# ══════════════════════════════════════════════════════════════
# 管理授权用户模式
# ══════════════════════════════════════════════════════════════
if [ "$DEPLOY_MODE" == "3" ]; then
    echo ""
    echo "🔍 正在查询项目 [$PROJECT_ID] 中的 Cloud Run 服务..."
    SERVICES_RAW=$(gcloud run services list \
        --project=$PROJECT_ID \
        --platform=managed \
        --format="csv[no-heading](metadata.name,metadata.labels['cloud.googleapis.com/location'])" \
        2>/dev/null || echo "")

    if [ -z "$SERVICES_RAW" ]; then
        echo "❌ 未找到任何 Cloud Run 服务"
        exit 1
    fi

    echo ""
    echo "已有服务列表:"
    echo "$SERVICES_RAW" | while IFS=',' read -r svc_name svc_region; do
        echo "   • $svc_name  ($svc_region)"
    done

    echo ""
    read -p "输入服务名称 [默认: gamerheads]: " SERVICE_NAME
    SERVICE_NAME=${SERVICE_NAME:-gamerheads}
    read -p "输入服务区域 [默认: us-central1]: " REGION
    REGION=${REGION:-us-central1}

    # 读取当前所有环境变量
    echo ""
    echo "🔍 正在读取当前配置..."
    ENV_JSON=$(gcloud run services describe "$SERVICE_NAME" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="json(spec.template.spec.containers[0].env)" 2>/dev/null)

    # 解析各环境变量
    get_env() {
        echo "$ENV_JSON" | grep -A1 "\"name\": \"$1\"" | grep '"value"' | sed 's/.*"value": "\(.*\)".*/\1/'
    }

    CUR_PROJECT=$(get_env "GOOGLE_CLOUD_PROJECT")
    CUR_LOCATION=$(get_env "GCP_LOCATION")
    CUR_DATABASE=$(get_env "DATASTORE_DATABASE")
    CUR_BUCKET=$(get_env "GCS_BUCKET_NAME")
    CUR_CLIENT_ID=$(get_env "GOOGLE_CLIENT_ID")
    CUR_AUTHORIZED=$(get_env "AUTHORIZED_USERS")
    CUR_BASIC_AUTH=$(get_env "BASIC_AUTH_USERS")

    if [ -z "$CUR_CLIENT_ID" ]; then
        echo "❌ 该服务未启用 Google Sign-In，无法管理授权用户。"
        exit 1
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📋 当前授权用户列表:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ -z "$CUR_AUTHORIZED" ]; then
        echo "   （未设置，任意 Google 账号均可登录）"
    else
        echo "$CUR_AUTHORIZED" | tr ',' '\n' | while read -r email; do
            echo "   • $email"
        done
    fi

    echo ""
    echo "请选择操作:"
    echo "  1) 添加新用户"
    echo "  2) 删除用户"
    echo "  3) 查看当前列表后退出"
    read -p "输入选项 [1/2/3]: " USER_OP

    NEW_AUTHORIZED="$CUR_AUTHORIZED"

    if [ "$USER_OP" == "1" ]; then
        echo ""
        echo "输入要添加的邮箱 (每行一个，直接回车结束):"
        while true; do
            read -p "  邮箱: " NEW_EMAIL
            [ -z "$NEW_EMAIL" ] && break
            if echo "$NEW_AUTHORIZED" | tr ',' '\n' | grep -qx "$NEW_EMAIL"; then
                echo "  ⚠️  $NEW_EMAIL 已在列表中"
            else
                if [ -z "$NEW_AUTHORIZED" ]; then
                    NEW_AUTHORIZED="$NEW_EMAIL"
                else
                    NEW_AUTHORIZED="${NEW_AUTHORIZED},${NEW_EMAIL}"
                fi
                echo "  ✅ 已添加: $NEW_EMAIL"
            fi
        done

    elif [ "$USER_OP" == "2" ]; then
        echo ""
        echo "当前用户列表:"
        i=1
        declare -a EMAIL_ARR
        while IFS= read -r email; do
            echo "  $i) $email"
            EMAIL_ARR[$i]="$email"
            i=$((i+1))
        done < <(echo "$CUR_AUTHORIZED" | tr ',' '\n')

        echo ""
        read -p "输入要删除的用户编号 (多个用空格分隔): " DEL_NUMS
        for num in $DEL_NUMS; do
            DEL_EMAIL="${EMAIL_ARR[$num]}"
            if [ -n "$DEL_EMAIL" ]; then
                NEW_AUTHORIZED=$(echo "$NEW_AUTHORIZED" | tr ',' '\n' | grep -vx "$DEL_EMAIL" | tr '\n' ',' | sed 's/,$//')
                echo "  ✅ 已删除: $DEL_EMAIL"
            fi
        done

    else
        exit 0
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📋 更新后的授权用户列表:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$NEW_AUTHORIZED" | tr ',' '\n' | while read -r email; do
        echo "   • $email"
    done
    echo ""
    read -p "确认更新? (y/n) [默认: y]: " CONFIRM
    CONFIRM=${CONFIRM:-y}
    if [ "$CONFIRM" != "y" ]; then
        echo "❌ 已取消"
        exit 0
    fi

    # 写回所有环境变量（--env-vars-file 为全量替换，必须带上所有变量）
    TMPFILE=$(mktemp)
    [ -n "$CUR_PROJECT" ]   && echo "GOOGLE_CLOUD_PROJECT: '${CUR_PROJECT}'"  >> "$TMPFILE"
    [ -n "$CUR_LOCATION" ]  && echo "GCP_LOCATION: '${CUR_LOCATION}'"         >> "$TMPFILE"
    [ -n "$CUR_DATABASE" ]  && echo "DATASTORE_DATABASE: '${CUR_DATABASE}'"   >> "$TMPFILE"
    [ -n "$CUR_BUCKET" ]    && echo "GCS_BUCKET_NAME: '${CUR_BUCKET}'"        >> "$TMPFILE"
    [ -n "$CUR_CLIENT_ID" ] && echo "GOOGLE_CLIENT_ID: '${CUR_CLIENT_ID}'"    >> "$TMPFILE"
    [ -n "$CUR_BASIC_AUTH" ] && echo "BASIC_AUTH_USERS: '${CUR_BASIC_AUTH}'"  >> "$TMPFILE"
    echo "AUTHORIZED_USERS: '${NEW_AUTHORIZED}'" >> "$TMPFILE"

    echo ""
    echo "🔄 正在更新授权用户..."
    gcloud run services update "$SERVICE_NAME" \
        --region="$REGION" \
        --project="$PROJECT_ID" \
        --env-vars-file="$TMPFILE" 2>&1
    rm -f "$TMPFILE"

    echo ""
    echo "✅ 授权用户已更新，新用户立即生效，无需其他操作。"
    exit 0
fi

# ══════════════════════════════════════════════════════════════
# 全新部署模式（以下为原有流程）
# ══════════════════════════════════════════════════════════════

# 检查并设置 Billing
BILLING_ENABLED=$(gcloud beta billing projects describe $PROJECT_ID --format="value(billingEnabled)" 2>/dev/null || echo "False")
if [ "$BILLING_ENABLED" != "True" ]; then
    echo "❌ 错误: 您的项目 $PROJECT_ID 未启用结算功能(Billing)。"
    echo "Cloud Run 需要开启结算账户才能使用。请访问 GCP 控制台开启后重试。"
    exit 1
fi

echo ""
echo "🔧 正在启用必要的 GCP API (这可能需要几分钟)..."
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  --project=$PROJECT_ID

# 设置服务名称
read -p "输入 Cloud Run 服务名称 [默认: gamerheads]: " SERVICE_NAME
SERVICE_NAME=${SERVICE_NAME:-gamerheads}

# 设置区域
read -p "输入部署区域 [默认: us-central1]: " REGION
REGION=${REGION:-us-central1}

# 设置数据库名称
read -p "输入 Firestore 数据库名称 [默认: gamerhead]: " DATASTORE_DATABASE
DATASTORE_DATABASE=${DATASTORE_DATABASE:-gamerhead}

echo ""
echo "🗄️  检查并创建 Datastore Mode 数据库 [$DATASTORE_DATABASE]..."
DB_EXISTS=$(gcloud firestore databases describe \
  --database="$DATASTORE_DATABASE" \
  --project=$PROJECT_ID \
  --format="value(name)" 2>/dev/null || echo "")

if [ -z "$DB_EXISTS" ]; then
    echo "   创建 Datastore Mode 数据库: $DATASTORE_DATABASE (region: $REGION)..."
    gcloud firestore databases create \
      --database="$DATASTORE_DATABASE" \
      --location="$REGION" \
      --type=datastore-mode \
      --project=$PROJECT_ID
    echo "   ✅ 数据库 [$DATASTORE_DATABASE] 创建成功"
else
    echo "   ℹ️  数据库 [$DATASTORE_DATABASE] 已存在，跳过创建"
fi

echo ""
echo "ℹ️  此版本使用 Vertex AI (Application Default Credentials)，无需 Gemini API Key。"
echo "   Cloud Run 将使用 Compute Service Account 自动鉴权。"
echo ""
echo "📦 配置生成视频的 GCS 存储桶:"
DEFAULT_BUCKET="gamerhead$(date +%s | tail -c 5 | head -c 4)"
echo "   默认 Bucket 名称: ${DEFAULT_BUCKET}"
read -p "输入 GCS Bucket 名称 (直接回车使用默认 [${DEFAULT_BUCKET}]): " GCS_BUCKET
GCS_BUCKET=${GCS_BUCKET:-$DEFAULT_BUCKET}

# Create bucket if it doesn't exist
if ! gsutil ls "gs://${GCS_BUCKET}" &>/dev/null; then
    echo "   创建 GCS Bucket: gs://${GCS_BUCKET} (region: ${REGION:-us-central1})..."
    gsutil mb -l "${REGION:-us-central1}" "gs://${GCS_BUCKET}"
    echo "   ✅ Bucket 创建成功"
else
    echo "   ℹ️  Bucket 已存在: gs://${GCS_BUCKET}"
fi
GCS_BUCKET_NAME_ENV="$GCS_BUCKET"

echo "🛡️  请选择网站登录验证方式:"
echo "1) Google 账号登录 (推荐，用户使用 Google 账号登录)"
echo "2) 固定用户名和密码验证"
read -p "输入选项 [1/2, 默认: 1]: " AUTH_MODE
AUTH_MODE=${AUTH_MODE:-1}

BASIC_AUTH_ENV=""
GOOGLE_CLIENT_ID_ENV=""
AUTHORIZED_USERS_ENV=""

if [ "$AUTH_MODE" == "1" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📋 步骤一：配置 Google Auth Platform (OAuth 同意屏幕)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   1. 访问: https://console.cloud.google.com/auth/overview"
    echo "      选择项目: $PROJECT_ID"
    echo ""
    echo "   2. 点击「Get Started」(首次) 或进入已有配置"
    echo ""
    echo "   3. 【Branding】页面:"
    echo "      - App name: GamerHeads (或自定义)"
    echo "      - User support email: 填写您的邮箱"
    echo "      - Developer contact email: 填写您的邮箱"
    echo "      → Next"
    echo ""
    echo "   4. 【Audience】页面:"
    echo "      - 选择「External」"
    echo "      → Next"
    echo "   5. → Contact Info 页面: 填写您的邮箱，完成后点击「Save and Create」"    
    echo ""  
    echo "   6. 【Audience】页面: 点击发布应用"
    echo ""
    read -p "   ✅ 以上步骤完成后按回车继续..." _CONFIRM_AUTH_PLATFORM
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📋 步骤二：创建 OAuth 2.0 客户端 ID"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   1. 访问: https://console.cloud.google.com/apis/credentials"
    echo "      选择项目: $PROJECT_ID"
    echo ""
    echo "   2. 点击「创建凭据」→「OAuth 客户端 ID」"
    echo ""
    echo "   3. 应用类型选「Web 应用」"
    echo ""
    echo "   4. 「已获授权的 JavaScript 来源」填入 Cloud Run 服务 URL"
    echo "      初次部署可先填: http://localhost"
    echo "      部署完成后再改为实际 URL (如: https://gamerheads-xxx.run.app)"
    echo ""
    echo "   5. 点击「创建」，复制生成的「客户端 ID」"
    echo ""
    read -p "👉 输入 OAuth 2.0 客户端 ID: " GOOGLE_CLIENT_ID_INPUT
    if [ -z "$GOOGLE_CLIENT_ID_INPUT" ]; then
        echo "❌ 客户端 ID 不能为空"
        exit 1
    fi
    GOOGLE_CLIENT_ID_ENV="$GOOGLE_CLIENT_ID_INPUT"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📋 步骤三：配置授权用户"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   Google Auth Platform 已设为公开，由应用层统一控制访问权限。"
    echo "   输入允许登录的邮箱列表（逗号分隔）。"
    echo "   留空 = 任意 Google 账号均可进入应用（不推荐）。"
    echo "   后续可随时通过 ./deploy.sh 选 3 添加/删除用户。"
    echo "   (如: a@gmail.com,b@company.com)"
    echo ""
    read -p "👉 授权邮箱列表: " AUTHORIZED_USERS_INPUT
    AUTHORIZED_USERS_ENV="$AUTHORIZED_USERS_INPUT"

    echo ""
    echo "✅ Google Sign-In 配置完成"

elif [ "$AUTH_MODE" == "2" ]; then
    echo ""
    echo "配置固定用户名和密码 (支持多个账号):"

    USERS_LIST=""
    USER_COUNT=0

    while true; do
        read -p "👉 输入用户名 (直接回车结束添加): " BASIC_USER
        if [ -z "$BASIC_USER" ]; then
            if [ $USER_COUNT -eq 0 ]; then
                echo "❌ 至少需要配置一个用户名或密码"
                exit 1
            fi
            break
        fi

        read -s -p "🔑 输入密码: " BASIC_PASS
        echo ""
        if [ -z "$BASIC_PASS" ]; then
            echo "❌ 密码不能为空，请重新输入"
            continue
        fi

        if [ -z "$USERS_LIST" ]; then
            USERS_LIST="${BASIC_USER}:${BASIC_PASS}"
        else
            USERS_LIST="${USERS_LIST},${BASIC_USER}:${BASIC_PASS}"
        fi

        USER_COUNT=$((USER_COUNT + 1))
        echo "✅ 账号 [$BASIC_USER] 已记录. (当前共 $USER_COUNT 个账号)"
        echo "----------------------------------------"
    done

    BASIC_AUTH_ENV="$USERS_LIST"
    echo "✅ 已完成配置 (共 $USER_COUNT 个账号)"
fi

echo ""
echo "📋 部署确认:"
echo "   项目ID: $PROJECT_ID"
echo "   服务名: $SERVICE_NAME"
echo "   区域: $REGION"
echo "   数据库: $DATASTORE_DATABASE"
echo "   AI 模式: Vertex AI (ADC)"
echo "   视频存储: gs://${GCS_BUCKET_NAME_ENV}"
if [ "$AUTH_MODE" == "1" ]; then
    echo "   验证方式: Google Sign-In"
    echo "   Client ID: ${GOOGLE_CLIENT_ID_ENV:0:20}..."
    if [ -n "$AUTHORIZED_USERS_ENV" ]; then
        echo "   授权用户: $AUTHORIZED_USERS_ENV"
    else
        echo "   授权用户: 任意 Google 账号"
    fi
elif [ "$AUTH_MODE" == "2" ]; then
    echo "   验证方式: 固定用户名/密码 (共 $USER_COUNT 个账号)"
fi
echo ""

read -p "确认开始部署? (y/n) [默认: y]: " CONFIRM
CONFIRM=${CONFIRM:-y}
if [ "$CONFIRM" != "y" ]; then
    echo "❌ 已取消部署"
    exit 0
fi

echo ""
echo "🔐 配置服务权限..."
# 获取 Project Number
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

echo "   - 配置 Cloud Build 权限..."
# 赋予 Cloud Build 默认服务账户写入 Artifact Registry 的权限，防止因为权限不足导致构建后的镜像无法推送
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer" \
  --condition=None \
  > /dev/null 2>&1 || echo "   (忽略权限赋予的警告，继续执行)"

echo "   - 配置 Cloud Run 运行所需的各项服务权限 (Datastore, Vertex AI, Storage 等)..."
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# 如果配置了 GCS Bucket，给 Compute SA 授予 Bucket 级别的 objectAdmin 权限
if [ -n "$GCS_BUCKET_NAME_ENV" ]; then
    echo "   - 授予 Compute SA 对 gs://${GCS_BUCKET_NAME_ENV} 的访问权限..."
    gsutil iam ch "serviceAccount:${COMPUTE_SA}:roles/storage.objectAdmin" "gs://${GCS_BUCKET_NAME_ENV}" \
      > /dev/null 2>&1 || echo "   (⚠️ Bucket IAM 绑定失败，请确认您有该 Bucket 的管理权限)"
fi

# 需要赋予 Compute Service Account 的角色列表
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
    > /dev/null 2>&1 || echo "   (⚠️ 无法绑定角色 $ROLE，可能是权限不足)"
done

echo "   ✅ 权限配置完成"

echo ""
echo "🏗️  开始部署到 Cloud Run..."
echo "📦 正在将本地源码打包并利用 GCP Cloud Build 进行云端构建并部署 (大约需要 3-5 分钟)..."

# 使用临时文件传递环境变量以支持密码中的特殊字符 (!@#$%^&*)
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
echo "✅ 部署成功!"
echo ""

PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SERVICE_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"

echo "🌐 服务访问地址: $SERVICE_URL"
echo ""
echo "🎉 恭喜！GamerHeads 现已在您的 GCP 环境中运行。"