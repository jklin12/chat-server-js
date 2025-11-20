#!/bin/bash
# Format tanggal dan jam lokal
datetime=$(date '+%d %B %Y, pukul %H:%M WIB')
# Kirim curl dengan message yang memuat tanggal & jam
curl --location 'http://wa.banjarbaru-bagawi.id/send-message' --data-urlencode 'number=6282244784747@c.us'  --data-urlencode "message=Pesan otomatis: $datetime"
