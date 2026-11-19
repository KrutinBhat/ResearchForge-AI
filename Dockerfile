FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    HOME=/tmp

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libglib2.0-0 \
    libgomp1 \
    && tesseract --version \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system rfuser \
    && adduser --system --ingroup rfuser --home /home/rfuser rfuser

WORKDIR /srv/researchforge

COPY requirements.txt requirements-docker.txt ./
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements-docker.txt

COPY --chown=rfuser:rfuser app ./app
COPY --chown=rfuser:rfuser alembic ./alembic
COPY --chown=rfuser:rfuser alembic.ini ./
COPY --chown=rfuser:rfuser firebase-applet-config.json ./

RUN mkdir -p /tmp/researchforge && chown -R rfuser:rfuser /tmp/researchforge /srv/researchforge

USER rfuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.getenv('PORT', '8000') + '/api/ready', timeout=3)" || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
