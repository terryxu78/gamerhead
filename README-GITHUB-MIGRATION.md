# GamerHeads - 开源部署指南

本项目支持用户直接将代码部署到自己的 Google Cloud Platform (GCP) 项目中。
为了兼顾 "开箱即用" 和 "二次开发" 两种需求，我们设计了以下部署流水线架构。

---

## 架构设计：双轨部署流水线

本项目使用 **GitHub Actions** + **GitHub Container Registry (GHCR)** + **Google Cloud Run** 的组合。

1. **官方预编译镜像 (推荐普通用户使用)**
   - 我们在 GitHub 仓库的 `.github/workflows/docker-publish.yml` 中配置了自动化流水线。
   - 每当主分支更新时，GitHub Actions 会自动打包出最新的 Docker 镜像，并发布到公开的 GitHub Packages (GHCR)。
   - **优势**: 用户不需要在本地安装 Docker，也不需要在 GCP 上重新编译。只需拉取编译好的镜像直接运行，速度极快（通常 < 1分钟）。

2. **从源码构建部署 (推荐开发者/二次修改用户)**
   - 如果用户 clone 了代码并在本地修改了界面或逻辑，预编译的镜像就无法满足需求了。
   - 用户可以选择直接将本地代码上传给 GCP，让 GCP Cloud Build 编译成镜像并运行。
   - **优势**: 所见即所得，修改了什么代码就部署什么代码。

---

## 如何部署到您自己的 GCP 环境

我们在项目中提供了一个交互式的 `deploy.sh` 脚本，可以自动帮您完成数据库初始化和 Cloud Run 的部署。

### 前置准备

1. **安装并登录 Google Cloud CLI**
   您需要在本地电脑上安装 [Google Cloud CLI (gcloud)](https://cloud.google.com/sdk/docs/install)，并执行以下命令登录您的 Google 账号：
   ```bash
   gcloud auth login
   ```

2. **准备 GCP 项目及 Billing**
   您必须拥有一个 GCP 项目（Project ID），并且该项目**必须关联一个结算账户 (Billing Account)**，否则无法使用 Cloud Run。

3. **获取 Gemini API Key**
   确保您已经在 Google AI Studio 申请了 Gemini API 密钥。

### 开始部署

1. 在终端进入代码目录。
2. 赋予脚本执行权限：
   ```bash
   chmod +x deploy.sh
   ```
3. 运行部署脚本：
   ```bash
   ./deploy.sh
   ```

### 选择部署模式

脚本运行时，会提示您选择部署模式：

```text
🌟 请选择部署方式:
1) 快速部署 (使用官方预编译镜像，推荐，速度最快)
2) 从源码部署 (如果您修改了本地代码，选此项)
输入选项 [1/2, 默认: 1]:
```

- **选 1 (快速部署)**：脚本会直接拉取开源仓库的 `ghcr.io/...:latest` 镜像部署到您的 GCP。
- **选 2 (源码部署)**：脚本会打包您当前目录的所有文件，上传到 GCP Cloud Build，并在云端完成编译（这需要大约 3-5 分钟）。

*(注：无论选择哪种方式，脚本都会自动帮您检查并创建配套的 Firestore Native 数据库)*

---

## 开发者维护指南：如何发布"官方镜像"

如果您是本仓库的所有者/维护者：

1. **将代码推送到 GitHub 主分支 (main)**
   只需正常的 `git push` 操作，GitHub Actions 就会自动触发构建。

2. **设置公开访问权限**
   由于 Cloud Run 在没有配置特殊凭证时只能拉取公开镜像：
   - 请登录您的 GitHub，进入个人主页的 **Packages**。
   - 找到刚才生成的 Docker 镜像（通常名为您的仓库名）。
   - 进入 **Package settings** -> **Change package visibility**，将其设置为 **Public**。
   - 修改项目中的 `deploy.sh`，将 `OFFICIAL_IMAGE` 变量替换为您刚刚公开的 GHCR 地址。

---

现在，任何人只需要下载这份代码，运行 `./deploy.sh`，即可在他们自己的 GCP 环境中轻松启动属于自己的 GamerHeads 服务！