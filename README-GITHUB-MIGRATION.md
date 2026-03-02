# GamerHeads - GitHub 迁移与部署指南

本文档描述了如何将当前位于 `/data1/gameh.rayner.prod` 的代码迁移到 GitHub，以及如何在未来使用 GitHub Actions 自动构建 Docker 镜像，并在 Cloud Run 中拉取和部署。

## 1. 将代码推送到 GitHub

当前目录尚未关联 GitHub 仓库，您可以通过以下步骤将代码首次上传到您的 GitHub 账号（例如：`terryxu78`）下的新仓库：

```bash
# 1. 进入代码目录
cd /data1/gameh.rayner.prod

# 2. 初始化 Git 仓库
git init

# 3. 添加所有文件
git add .

# 4. 提交更改
git commit -m "Initial commit: Move to GitHub and setup GHCR deployment"

# 5. 重命名默认分支为 main
git branch -M main

# 6. 添加您的 GitHub 仓库远程地址 (请将 YOUR_REPO 替换为您的仓库名，如 gamerheads-prod)
git remote add origin https://github.com/terryxu78/YOUR_REPO.git

# 7. 推送代码
git push -u origin main
```

## 2. GitHub Actions 自动构建镜像 (重建逻辑)

我们在 `.github/workflows/docker-publish.yml` 中配置了自动化工作流。

**重建逻辑工作流程：**
1. **触发构建**：当您向 GitHub 仓库的 `main` 分支推送代码（`git push`），或发布新的 Tag 时，GitHub Actions 会自动触发。
2. **构建镜像**：Actions 会读取代码库中的 `Dockerfile` 并在 GitHub 服务器上构建 Docker 镜像。
3. **推送到 GHCR**：构建完成后，镜像会被自动推送到 GitHub Container Registry (GHCR)，路径为 `ghcr.io/terryxu78/YOUR_REPO:latest`。

*如果您想手动重建，也可以在 GitHub 网页端的 "Actions" 标签页中点击 "Build and Push Docker Image" -> "Run workflow" 按钮。*

### 注意事项：镜像权限设置
为了让 Cloud Run 能够拉取您构建的 Docker 镜像：
1. 登录 GitHub，点击头像 -> **Your profile** -> **Packages**。
2. 找到您刚刚推送的镜像（例如：`YOUR_REPO`）。
3. 点击 **Package settings**。
4. 在 "Danger Zone" 中，找到 **Change package visibility**，将其设置为 **Public**。
*(如果必须保持 Private，则需要在 Cloud Run 部署时配置拉取私有镜像的凭据，设置较为复杂，推荐前端/打包应用在 Package 级别设为 Public，代码本身仍可为 Private 仓库)*。

## 3. 使用脚本部署到 Cloud Run

我们已更新了本地的 `deploy.sh`。它不再使用本地源码通过 Cloud Build 慢速构建，而是直接从您构建好的 GitHub Container Registry 中拉取最新的镜像。

**部署步骤：**
```bash
./deploy.sh
```

**在脚本执行过程中，您需要：**
1. 确认当前的 GCP 项目。
2. 提供 Cloud Run 服务名称和部署区域 (Region)。
3. 输入您的 Gemini API Key。
4. **（新增）** 输入您的 GitHub 用户名（如 `terryxu78`）和仓库名（如 `gamerheads-prod`）。脚本会自动拼接成 `ghcr.io/terryxu78/gamerheads-prod:latest` 并使用该镜像进行部署。

这样，您的发布流程变成了：
**写代码 -> git commit -> git push (自动触发 GitHub Action 构建并更新 GHCR 镜像) -> 等待构建完成 -> 运行 ./deploy.sh 将最新镜像部署到 GCP Cloud Run。**