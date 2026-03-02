# GamerHeads - 开源部署指南

本项目支持用户直接将代码部署到自己的 Google Cloud Platform (GCP) 项目中。
为了保证最大的兼容性和部署成功率，我们默认使用**源码云端构建**的方式进行部署。

---

## 架构设计：源码云端构建部署

- 用户 clone 代码并在本地进行任何需要的修改（或直接使用默认版本）。
- 部署时，本地代码将通过 GCP Cloud Build 上传到用户的 GCP 环境进行安全、独立的编译。
- 编译完成的镜像将直接在用户的 Cloud Run 中运行。
- **优势**: 环境独立、兼容性好、所见即所得。用户修改的任何代码都能立即生效。

*(注：我们也配置了 GitHub Actions 自动构建，但这仅作为镜像备份，GCP Cloud Run 的主要部署来源依然是源码构建。)*

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

### 自动构建与部署

脚本运行时，会自动帮您：
1. **检查并创建配套的 Firestore Native 数据库**。
2. **打包您当前目录的所有文件，上传到 GCP Cloud Build，并在云端完成编译**（这需要大约 3-5 分钟）。
3. **一键部署到 Cloud Run 并返回给您服务访问地址**。

---

现在，任何人只需要下载这份代码，运行 `./deploy.sh`，即可在他们自己的 GCP 环境中轻松启动属于自己的 GamerHeads 服务！
