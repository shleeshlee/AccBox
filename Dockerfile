FROM python:3.11-slim

# 安装 nginx 和 supervisor
RUN apt-get update && apt-get install -y nginx supervisor && \
    rm -rf /var/lib/apt/lists/* && \
    rm /etc/nginx/sites-enabled/default

# 安装 Python 依赖（指定 bcrypt 版本以兼容 passlib）
RUN pip install --no-cache-dir fastapi uvicorn cryptography pydantic "passlib[bcrypt]" "python-jose[cryptography]" "bcrypt==4.0.1"

# 创建应用目录
WORKDIR /app

# 复制应用文件
COPY main.py .
COPY index.html /var/www/html/
COPY style.css /var/www/html/
COPY app.js /var/www/html/
COPY flags.js /var/www/html/

# 复制配置文件
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 80

# 启动 supervisor（管理 nginx + python）
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
