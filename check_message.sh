#!/bin/bash

# URL endpoint
URL="http://wa.banjarbaru-bagawi.id/send-message"


# Data yang dikirim
NUMBER="085600200913"
CURRENT_DATE=$(date '+%Y-%m-%d %H:%M:%S') # Format tanggal dan jam
MESSAGE="Test Koneksi - Tanggal dan Waktu: $CURRENT_DATE"

# Eksekusi curl
curl --location "$URL" \
--header "Content-Type: application/x-www-form-urlencoded" \
--data-urlencode "number=$NUMBER" \
--data-urlencode "message=$MESSAGE"

