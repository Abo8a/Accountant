FROM python:3.12-slim

# Зеркало Debian: если deb.debian.org недоступен с сервера, задаётся через build-arg (например ftp.de.debian.org).
ARG DEBIAN_MIRROR=deb.debian.org

# Tesseract для OCR сканов (языки rus + eng)
RUN if [ "${DEBIAN_MIRROR}" != "deb.debian.org" ]; then \
      sed -i -e "s|deb.debian.org/debian|${DEBIAN_MIRROR}/debian|g" \
             -e "s|security.debian.org/debian-security|${DEBIAN_MIRROR}/debian-security|g" \
             $(ls /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null) || true; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

# Индекс pip: по умолчанию PyPI; на сервере с ограниченным доступом задаётся через build-arg (зеркало).
ARG PIP_INDEX_URL=https://pypi.org/simple

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -i "${PIP_INDEX_URL}" -r requirements.txt

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
