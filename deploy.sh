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

echo ""
echo "🌟 请选择部署方式:"
echo "1) 快速部署 (使用官方预编译镜像，推荐，速度最快)"
echo "2) 从源码部署 (如果您修改了本地代码，选此项)"
read -p "输入选项 [1/2, 默认: 1]: " DEPLOY_MODE
DEPLOY_MODE=${DEPLOY_MODE:-1}

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
echo "📝 部署确认:"
echo "   项目ID: $PROJECT_ID"
echo "   服务名: $SERVICE_NAME"
echo "   区域: $REGION"
echo "   API Key: ${API_KEY:0:10}***"
echo ""

read -p "确认开始部署? (y/n) [默认: y]: " CONFIRM
CONFIRM=${CONFIRM:-y}
if [ "$CONFIRM" != "y" ]; then
    echo "❌ 已取消部署"
    exit 0
fi

echo ""
echo "🏗️  开始部署到 Cloud Run..."

if [ "$DEPLOY_MODE" == "1" ]; then
    # 填入您未来的官方 GitHub 镜像库地址
    # 假设您的 GitHub 用户名是 terryxu78，仓库是 gamerheads
    OFFICIAL_IMAGE="ghcr.io/terryxu78/gamerheads:latest"
    echo "📦 使用官方镜像: $OFFICIAL_IMAGE"
    
    gcloud run deploy $SERVICE_NAME \
      --image=$OFFICIAL_IMAGE \
      --region=$REGION \
      --platform=managed \
      --allow-unauthenticated \
      --set-env-vars="GEMINI_API_KEY=$API_KEY,GOOGLE_CLOUD_PROJECT=$PROJECT_ID" \
      --memory=2Gi \
      --cpu=2 \
      --timeout=3600 \
      --max-instances=10 \
      --min-instances=0 \
      --project=$PROJECT_ID

else
    echo "📦 使用本地源码构建并部署 (首次构建可能需要 3-5 分钟)..."
    
    gcloud run deploy $SERVICE_NAME \
      --source . \
      --region=$REGION \
      --platform=managed \
      --allow-unauthenticated \
      --set-env-vars="GEMINI_API_KEY=$API_KEY,GOOGLE_CLOUD_PROJECT=$PROJECT_ID" \
      --memory=2Gi \
      --cpu=2 \
      --timeout=3600 \
      --max-instances=10 \
      --min-instances=0 \
      --project=$PROJECT_ID
fi

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