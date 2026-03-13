# GamerHeads Cloud Run 部署指南

## 📋 准备工作

### 1. 确保已安装必要工具
```bash
# 检查gcloud CLI
gcloud version

# 检查Node.js (本地测试用)
node --version  # 应该 >= 20.0.0
```

### 2. 登录Google Cloud
```bash
# 登录
gcloud auth login

# 设置项目
gcloud config set project YOUR_PROJECT_ID
```

---

## 🚀 快速部署（推荐）

### 使用自动化脚本

```bash
cd /data1/gamerhead

# 添加执行权限
chmod +x deploy.sh

# 运行部署脚本
./deploy.sh
```

脚本会引导您完成：
- ✅ 项目ID配置
- ✅ 服务名称设置
- ✅ 区域选择
- ✅ API Key配置
- ✅ 自动启用所需API
- ✅ 一键部署

---

## 🔧 手动部署步骤

### 步骤1：启用必要的API

```bash
export PROJECT_ID="your-project-id"

gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  --project=$PROJECT_ID
```

### 步骤2：部署到Cloud Run

```bash
export SERVICE_NAME="gamerheads"
export REGION="us-central1"
export GEMINI_API_KEY="your-gemini-api-key"

gcloud run deploy $SERVICE_NAME \
  --source . \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --set-env-vars="GEMINI_API_KEY=$GEMINI_API_KEY,GOOGLE_CLOUD_PROJECT=$PROJECT_ID" \
  --memory=2Gi \
  --cpu=2 \
  --timeout=3600 \
  --max-instances=10 \
  --min-instances=0 \
  --project=$PROJECT_ID
```

### 步骤3：验证部署

```bash
# 获取服务URL
gcloud run services describe $SERVICE_NAME \
  --region=$REGION \
  --format='value(status.url)'

# 测试健康检查
curl https://YOUR_SERVICE_URL/api/health
```

---

## 🔐 使用Secret Manager（推荐生产环境）

### 创建Secret

```bash
# 创建API Key secret
echo -n "YOUR_GEMINI_API_KEY" | \
  gcloud secrets create gemini-api-key --data-file=-

# 授权Cloud Run访问
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:${PROJECT_ID}@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 更新Cloud Run配置

```bash
gcloud run services update $SERVICE_NAME \
  --region=$REGION \
  --update-secrets="GEMINI_API_KEY=gemini-api-key:latest"
```

---

## 📊 部署后管理

### 查看日志

```bash
# 实时日志
gcloud run services logs tail $SERVICE_NAME --region=$REGION

# 最近日志
gcloud run services logs read $SERVICE_NAME --region=$REGION --limit=50
```

### 查看服务状态

```bash
gcloud run services describe $SERVICE_NAME --region=$REGION
```

### 更新部署

```bash
# 代码修改后，重新运行部署命令即可
gcloud run deploy $SERVICE_NAME --source . --region=$REGION
```

### 删除服务

```bash
gcloud run services delete $SERVICE_NAME --region=$REGION
```

---

## 🗄️ Firestore配置

### 自动配置

Cloud Run服务会自动获得Firestore访问权限，无需额外配置。

### 手动创建Firestore数据库

如果项目中没有Firestore，需要先创建：

```bash
# 创建Firestore数据库（Native模式）
gcloud firestore databases create --region=$REGION
```

### 验证日志记录

1. 访问您的应用并执行一些操作（生成脚本/头像/视频）
2. 访问Admin页面查看统计数据
3. 或直接在Firestore控制台查看 `generation_logs` 集合

---

## ⚙️ 环境变量说明

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `GEMINI_API_KEY` | ✅ | Google Gemini API密钥 |
| `GOOGLE_CLOUD_PROJECT` | ✅ | GCP项目ID（自动设置） |
| `NODE_ENV` | ❌ | 自动设置为production |
| `PORT` | ❌ | 自动设置为8080 |

---

## 🔍 故障排查

### 构建失败

```bash
# 查看构建日志
gcloud builds list --limit=5

# 查看详细构建日志
gcloud builds log BUILD_ID
```

### 服务无法启动

```bash
# 查看服务日志
gcloud run services logs tail $SERVICE_NAME --region=$REGION

# 常见问题：
# 1. API Key未设置或无效
# 2. 内存不足（增加--memory参数）
# 3. 构建时dist目录未生成
```

### Firestore连接失败

```bash
# 确认Firestore已启用
gcloud firestore databases list

# 确认服务账号权限
gcloud projects get-iam-policy $PROJECT_ID
```

---

## 💰 成本优化

### 当前配置成本估算

- **最小实例**: 0（无流量时不收费）
- **最大实例**: 10
- **内存**: 2GB
- **CPU**: 2核

### 优化建议

```bash
# 降低资源配置（适用于低流量）
gcloud run services update $SERVICE_NAME \
  --memory=1Gi \
  --cpu=1 \
  --region=$REGION

# 设置最大并发请求
gcloud run services update $SERVICE_NAME \
  --concurrency=80 \
  --region=$REGION
```

---

## 📚 相关链接

- [Cloud Run文档](https://cloud.google.com/run/docs)
- [Firestore文档](https://cloud.google.com/firestore/docs)
- [Gemini API文档](https://ai.google.dev/docs)

---

## ✅ 部署检查清单

- [ ] 已安装gcloud CLI
- [ ] 已登录Google Cloud
- [ ] 已设置项目ID
- [ ] 已获取Gemini API Key
- [ ] 已启用必要的API
- [ ] 已创建Firestore数据库
- [ ] 已运行部署脚本
- [ ] 已验证服务URL
- [ ] 已测试应用功能
- [ ] 已查看Admin页面日志
