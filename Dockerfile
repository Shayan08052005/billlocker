FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py billing.py operations.py gst_lookup.py public.py ./
COPY static ./static
ENV BILLLOCKER_DATA_DIR=/var/data/billlocker
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-8000} --workers 2 --threads 2 --timeout 90 public:application"]
