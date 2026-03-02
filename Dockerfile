# 使用Node.js 20官方镜像
FROM node:20-slim

# 设置工作目录
WORKDIR /app

# 复制package文件
COPY package*.json ./

# 安装所有依赖（包括devDependencies用于构建）
RUN npm install

# 复制所有源代码
COPY . .

# 构建前端资源
RUN npm run build

# 生产环境只保留必要依赖
RUN npm prune --production

# 暴露端口
EXPOSE 8080

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8080

# 启动应用
CMD ["node", "server.js"]
