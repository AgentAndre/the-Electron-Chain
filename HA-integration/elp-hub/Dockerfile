FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir \
    aiomqtt==2.3.0 \
    aiosqlite==0.20.0 \
    fastapi==0.115.5 \
    uvicorn[standard]==0.32.1 \
    pydantic==2.10.3

COPY hub.py db.py repositories.py api.py /app/
COPY dashboard /app/dashboard

ENV ELP_DB_PATH=/data/elp.sqlite
ENV DASHBOARD_DIR=/app/dashboard
VOLUME ["/data"]
EXPOSE 8000

CMD ["python", "-u", "hub.py"]
