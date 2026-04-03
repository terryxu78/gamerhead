# GamerHeads Cloud Run 部署指南

## 一、部署前提条件

### 1. 本地工具

| 工具 | 要求 | 用途 |
|------|------|------|
| `gcloud` CLI | 已安装并初始化 | 与 GCP 交互、触发部署 |
| `gsutil` | 随 gcloud 一起安装 | 创建和管理 GCS Bucket |

```bash
# 验证安装
gcloud version
```

### 2. GCP 项目

- 已有 GCP 项目 ID
- 项目已绑定有效的结算账户（Cloud Run 必须开启 Billing）

```bash
# 登录
gcloud auth login

# 确认当前项目
gcloud config get-value project

# 或手动设置
gcloud config set project YOUR_PROJECT_ID
```

### 3. 网络环境

所有对 Vertex AI（Gemini / Veo）的 API 调用均在 Cloud Run 服务端发起，**不经过用户浏览器**。但部署操作本身（运行 deploy.sh、gcloud 命令）需要能访问 GCP API，在非大陆 IP 的网络环境中执行。

---

## 二、执行部署所需的操作者权限

> 这是运行 `deploy.sh` 的用户账号（即 `gcloud auth login` 登录的账号）需要拥有的权限，与应用运行时的服务账号权限无关。

### 最简方式：授予 Owner 角色

```bash
# 在 GCP Console → IAM → 为自己的账号添加 Owner 角色
# 或通过命令行（需要现有 Owner 执行）：
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="user:your-email@example.com" \
  --role="roles/owner"
```

### 精细权限方式（最小权限原则）

如果不希望授予 Owner，至少需要以下角色：

| 角色 | 用途 |
|------|------|
| `roles/serviceusage.serviceUsageAdmin` | 启用 Cloud Build、Cloud Run、Firestore 等 GCP API |
| `roles/run.admin` | 创建和更新 Cloud Run 服务 |
| `roles/cloudbuild.builds.editor` | 触发 Cloud Build 构建任务 |
| `roles/storage.admin` | 创建 GCS Bucket、设置 Bucket 级别 IAM |
| `roles/datastore.owner` | 创建 Firestore（Datastore Mode）数据库 |
| `roles/resourcemanager.projectIamAdmin` | 为 Compute Service Account 绑定 IAM 角色 |
| `roles/iam.serviceAccountAdmin` | 查询和操作服务账号 |

> 提示：`roles/resourcemanager.projectIamAdmin` 是关键。deploy.sh 会自动为 Compute Service Account 绑定多个角色（见第五节），缺少此权限会导致权限配置步骤报错。

---

## 三、快速部署

```bash
chmod +x deploy.sh
./deploy.sh
```

脚本提供三种操作模式，按提示选择：

```
请选择操作:
  1) 全新部署
  2) 更新已有服务 (仅更新代码，保留现有配置)
  3) 管理授权用户 (添加/删除可登录的邮箱)
```

---

## 四、全新部署流程详解（模式 1）

### 步骤 1：选择项目

脚本自动读取当前 gcloud 配置的项目，确认或手动输入目标项目 ID。

### 步骤 2：配置基础参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| Cloud Run 服务名 | `gamerheads` | 部署后的服务标识 |
| 部署区域 | `us-central1` | Cloud Run 实例所在区域 |
| Firestore 数据库名 | `gamerhead` | 存储生成日志的数据库 |

### 步骤 3：配置 GCS 存储桶

用于保存 Veo 生成的视频文件。脚本会自动生成一个默认 Bucket 名称（如 `gamerheadxxxx`），也可自定义。

- 如果 Bucket 不存在，脚本自动创建。
- 如果 Bucket 已存在，跳过创建。

### 步骤 4：选择登录验证方式

**选项 1 — Google 账号登录（推荐）**

脚本引导你完成：
1. 在 GCP Console 配置 OAuth 同意屏幕（[Auth Platform](https://console.cloud.google.com/auth/overview)）
2. 创建 OAuth 2.0 客户端 ID（[API 凭据页面](https://console.cloud.google.com/apis/credentials)）
3. 输入客户端 ID
4. （可选）输入授权邮箱白名单，多个邮箱用逗号分隔

> 留空白名单 = 任意 Google 账号均可登录（不推荐生产环境）。

**选项 2 — 固定用户名/密码**

逐一输入用户名和密码，支持多个账号，凭据通过环境变量注入 Cloud Run，浏览器弹出原生登录框。

### 步骤 5：自动配置 IAM 权限

脚本完全自动完成以下权限配置，无需手动操作：

**Compute Service Account**（`PROJECT_NUMBER-compute@developer.gserviceaccount.com`）会被授予：

| 角色 | 用途 |
|------|------|
| `roles/storage.objectAdmin`（Bucket 级） | 读写视频文件到指定 GCS Bucket |
| `roles/storage.objectAdmin`（项目级） | 项目范围的 GCS 对象操作 |
| `roles/iam.serviceAccountTokenCreator` | 生成 GCS 签名 URL（Admin 文件下载用） |
| `roles/aiplatform.user` | 调用 Vertex AI（Gemini / Veo）API |
| `roles/datastore.user` | 读写 Firestore 日志 |
| `roles/logging.logWriter` | 写入 Cloud Logging |
| `roles/monitoring.metricWriter` | 写入 Cloud Monitoring 指标 |
| `roles/cloudtrace.agent` | 上报 Cloud Trace 链路数据 |

**Cloud Build Service Account**（`PROJECT_NUMBER@cloudbuild.gserviceaccount.com`）会被授予：

| 角色 | 用途 |
|------|------|
| `roles/artifactregistry.writer` | 推送构建镜像到 Artifact Registry |

### 步骤 6：构建与部署

使用 Cloud Build 对本地源码进行云端构建（约 3–5 分钟），完成后输出服务访问 URL。

---

## 五、更新代码（模式 2）

适用于修改代码后重新部署，**所有环境变量和配置保持不变**。

```bash
./deploy.sh
# 选择 2
```

脚本会列出当前项目中所有 Cloud Run 服务，选择目标服务和区域后直接触发重新构建部署。

---

## 六、管理授权用户（模式 3，仅 Google Sign-In）

无需重新部署，随时增删允许登录的 Google 邮箱：

```bash
./deploy.sh
# 选择 3
```

支持：
- 查看当前授权用户列表
- 添加新邮箱（每行一个）
- 按编号删除指定邮箱

修改后立即生效，无需其他操作。

---

## 七、环境变量说明

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `GOOGLE_CLOUD_PROJECT` | 是 | GCP 项目 ID |
| `GCP_LOCATION` | 是 | 部署区域（如 `us-central1`） |
| `DATASTORE_DATABASE` | 是 | Firestore 数据库名 |
| `GCS_BUCKET_NAME` | 是 | 存储生成视频的 GCS Bucket 名称 |
| `GOOGLE_CLIENT_ID` | 条件必需 | Google Sign-In 模式下的 OAuth 客户端 ID |
| `AUTHORIZED_USERS` | 否 | 授权邮箱列表，逗号分隔；留空则不限制 |
| `BASIC_AUTH_USERS` | 条件必需 | 固定密码模式下的账号列表，格式 `user:pass,user2:pass2` |

> 无需 Gemini API Key。所有 AI 调用均通过 Vertex AI + ADC（Application Default Credentials）自动鉴权。

---

## 八、部署后管理

### 查看实时日志

```bash
gcloud run services logs tail gamerheads --region=us-central1
```

### 查看服务状态

```bash
gcloud run services describe gamerheads --region=us-central1
```

### 手动更新代码

```bash
gcloud run deploy gamerheads --source . --region=us-central1
```

### 删除服务

```bash
gcloud run services delete gamerheads --region=us-central1
```

---

## 九、故障排查

### Cloud Build 构建失败

```bash
# 查看最近构建列表
gcloud builds list --limit=5

# 查看详细日志
gcloud builds log BUILD_ID
```

常见原因：
- 操作者账号缺少 `roles/artifactregistry.writer` 或 `roles/cloudbuild.builds.editor`
- 源码中存在语法错误

### Cloud Run 服务无法启动

```bash
gcloud run services logs tail gamerheads --region=us-central1
```

常见原因：
- 环境变量缺失（如 `GCS_BUCKET_NAME` 未设置）
- Compute Service Account 缺少必要 IAM 角色（重跑 deploy.sh 模式 1 可重新配置权限）

### Firestore 连接失败

```bash
# 确认数据库已创建
gcloud firestore databases list

# 确认 Compute SA 有 datastore.user 权限
gcloud projects get-iam-policy YOUR_PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:compute@developer.gserviceaccount.com"
```

### Admin 页面文件下载报错

文件下载通过服务端生成签名 URL（有效期 15 分钟），需要 Compute Service Account 拥有 `roles/iam.serviceAccountTokenCreator`。如果报签名错误，确认该角色已授予：

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/iam.serviceAccountTokenCreator"
```

---

## 十、成本参考

Cloud Run 按实际请求计费，无流量时（`min-instances=0`）不产生费用。

| 配置项 | 默认值 |
|--------|--------|
| 最小实例数 | 0（无流量不计费） |
| 最大实例数 | 10 |
| 内存 | 2 GB |
| CPU | 2 核 |
| 超时时间 | 3600 秒 |

Veo 视频生成按 Vertex AI 定价计费，费用取决于视频时长和模型版本，详见 [Vertex AI 定价页面](https://cloud.google.com/vertex-ai/pricing)。

---

## 十一、部署检查清单

- [ ] `gcloud auth login` 登录账号拥有足够权限（见第二节）
- [ ] GCP 项目已开启结算账户
- [ ] 网络环境可访问 GCP API
- [ ] 运行 `./deploy.sh` 选择模式 1 完成全新部署
- [ ] 部署完成后访问服务 URL 验证登录
- [ ] 进入 Admin 页面确认日志正常记录
- [ ] 点击 Activity Log 中的文件链接确认可正常下载
- [ ] （Google Sign-In 模式）在 OAuth 凭据页面将实际服务 URL 添加到「已获授权的 JavaScript 来源」
