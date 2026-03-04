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
  --project=$PROJECT_ID

echo ""
echo "🗄️  检查并创建 Firestore 数据库..."
# 检查 Firestore 数据库是否已存在
DB_EXISTS=$(gcloud firestore databases list --project=$PROJECT_ID --format="value(name)" 2>/dev/null || echo "")

if [ -z "$DB_EXISTS" ]; then
    echo "   创建 Firestore Native 数据库 (region: us-central1)..."
    gcloud firestore databases create \
      --location=us-central1 \
      --type=firestore-native \
      --project=$PROJECT_ID
    echo "   ✅ Firestore 数据库创建成功"
else
    echo "   ℹ️  Firestore 数据库已存在，跳过创建"
fi

# 设置服务名称
read -p "输入 Cloud Run 服务名称 [默认: gamerheads]: " SERVICE_NAME
SERVICE_NAME=${SERVICE_NAME:-gamerheads}

# 设置区域
read -p "输入部署区域 [默认: us-central1]: " REGION
REGION=${REGION:-us-central1}

# 获取API Key
read -p "输入您的 Gemini API Key: " API_KEY

if [ -z "$API_KEY" ]; then
    echo "❌ API Key 不能为空"
    exit 1
fi

echo ""
echo "🛡️ 请选择网站登录验证方式:"
echo "1) IAP 验证 (依赖 GCP IAP,已完整组织设定)"
echo "2) 固定用户名和密码验证"
read -p "输入选项 [1/2, 默认: 1]: " AUTH_MODE
AUTH_MODE=${AUTH_MODE:-1}

BASIC_AUTH_ENV=""
if [ "$AUTH_MODE" == "2" ]; then
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
    
    # 我们把多个账号拼成 user1:pass1,user2:pass2 的格式传给 Cloud Run
    BASIC_AUTH_ENV="$USERS_LIST"
    echo "✅ 已完成配置 (共 $USER_COUNT 个账号)"
fi

echo ""
echo " 部署确认:"
echo "   项目ID: $PROJECT_ID"
echo "   服务名: $SERVICE_NAME"
echo "   区域: $REGION"
echo "   API Key: ${API_KEY:0:10}***"
if [ "$AUTH_MODE" == "2" ]; then
echo "   验证方式: 固定用户名/密码 (共 $USER_COUNT 个账号)"
else
echo "   验证方式: IAP"
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
echo "GEMINI_API_KEY: \"${API_KEY}\"" >> "$ENV_FILE"
echo "GOOGLE_CLOUD_PROJECT: \"${PROJECT_ID}\"" >> "$ENV_FILE"
if [ "$AUTH_MODE" == "2" ]; then
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

# 获取服务URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
  --region=$REGION \
  --project=$PROJECT_ID \
  --format='value(status.url)')

echo "🌐 服务访问地址: $SERVICE_URL"
echo ""
echo "🎉 恭喜！GamerHeads 现已在您的 GCP 环境中运行。"