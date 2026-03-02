#!/bin/bash

# GamerHeads Cloud Run 部署脚本
# 使用方法: ./deploy.sh

set -e

echo "🚀 GamerHeads Cloud Run 部署工具"
echo "=================================="
echo ""

# 检查是否已登录gcloud
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &>/dev/null; then
    echo "❌ 未检测到活动的gcloud账号，请先运行:"
    echo "   gcloud auth login"
    exit 1
fi

# 获取当前项目ID
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null)

if [ -z "$CURRENT_PROJECT" ]; then
    echo "⚠️  未设置默认项目"
    read -p "请输入您的GCP项目ID: " PROJECT_ID
    gcloud config set project $PROJECT_ID
else
    echo "📋 当前项目: $CURRENT_PROJECT"
    read -p "是否使用此项目? (y/n): " USE_CURRENT
    if [ "$USE_CURRENT" != "y" ]; then
        read -p "请输入您的GCP项目ID: " PROJECT_ID
        gcloud config set project $PROJECT_ID
    else
        PROJECT_ID=$CURRENT_PROJECT
    fi
fi

# 设置服务名称
read -p "输入Cloud Run服务名称 [默认: gamerheads]: " SERVICE_NAME
SERVICE_NAME=${SERVICE_NAME:-gamerheads}

# 设置区域
read -p "输入部署区域 [默认: us-central1]: " REGION
REGION=${REGION:-us-central1}

# 获取API Key
read -p "输入您的Gemini API Key: " API_KEY

if [ -z "$API_KEY" ]; then
    echo "❌ API Key不能为空"
    exit 1
fi

echo ""
echo "📝 部署配置:"
echo "   项目ID: $PROJECT_ID"
echo "   服务名: $SERVICE_NAME"
echo "   区域: $REGION"
echo "   API Key: ${API_KEY:0:10}..."
echo ""

read -p "确认部署? (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
    echo "❌ 取消部署"
    exit 0
fi

echo ""
echo "🔧 启用必要的API..."
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  --project=$PROJECT_ID

read -p "输入您的GitHub用户名 (例如: terryxu78): " GITHUB_USER
read -p "输入您的GitHub仓库名 (例如: gamerheads-prod): " GITHUB_REPO

if [ -z "$GITHUB_USER" ] || [ -z "$GITHUB_REPO" ]; then
    echo "❌ GitHub 用户名和仓库名不能为空"
    exit 1
fi

GHCR_IMAGE="ghcr.io/$GITHUB_USER/$GITHUB_REPO:latest"

echo ""
echo "🏗️  开始部署从 GitHub Container Registry 获取的镜像..."
echo "📦 镜像地址: $GHCR_IMAGE"
echo "⚠️  注意：如果您的 GitHub 镜像是私有的，需确保已正确配置 Cloud Run 访问权限，或将该镜像在 GitHub Packages 中设为 Public。"

gcloud run deploy $SERVICE_NAME \
  --image=$GHCR_IMAGE \
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

echo ""
echo "✅ 部署成功!"
echo ""

# 获取服务URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
  --region=$REGION \
  --project=$PROJECT_ID \
  --format='value(status.url)')

echo "🌐 服务URL: $SERVICE_URL"
echo ""
echo "📊 查看日志:"
