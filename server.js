/**
 * WA API Gateway (whatsapp-web.js) — Refactored
 * ------------------------------------------------
 * Perubahan utama dari versi sebelumnya:
 *  - Basic Auth AKTIF + fail-fast kalau env belum di-set
 *  - Message queue dengan jeda acak (mitigasi flag spam / ban-risk)
 *  - Reconnect pakai exponential backoff (bukan flat 5 detik)
 *  - Semua endpoint grup dibungkus try/catch (tidak ada unhandled rejection)
 *  - addParticipants/removeParticipants di-await + hasil per nomor dikembalikan
 *  - File upload selalu dihapus (finally), fix req.file -> req.files
 *  - Helper ensureReady() konsisten di semua endpoint
 *  - Error dikembalikan dengan HTTP status yang benar (bukan 200 "false")
 *  - URL webhook internal dipindah ke env var
 *  - Logging pesan masuk dikurangi (tidak dump seluruh object)
 *  - Flag --single-process dihapus (sering menyebabkan ProtocolError)
 *  - BARU: Deteksi & self-healing untuk error "Attempted to use detached Frame"
 *    (bug upstream whatsapp-web.js/puppeteer yang bikin client.getState()
 *    tetap "CONNECTED" padahal frame internal sudah rusak). Lihat:
 *    https://github.com/pedroslopez/whatsapp-web.js/issues/5728
 *
 * Env vars yang dibutuhkan (wajib):
 *  - BASIC_AUTH_USER
 *  - BASIC_AUTH_PASS
 * Opsional:
 *  - PORT                    (default 5003)
 *  - PM2_PROCESS_NAME        (default 'wa-api')
 *  - PM2_RESTART_SECRET      (kalau di-set, /pm2-restart butuh header x-restart-secret)
 *  - N8N_TELEGRAM_WEBHOOK_URL (relay /telegram-webhook)
 *  - MSG_DELAY_MIN_MS        (default 3000)
 *  - MSG_DELAY_MAX_MS        (default 8000)
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { phoneNumberFormatter } = require('./helper/formatter');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const qrcode = require('qrcode');
const socketIO = require('socket.io');
const axios = require('axios');
const multer = require('multer');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5003;
const PM2_PROCESS_NAME = process.env.PM2_PROCESS_NAME || 'wa-api';
const N8N_TELEGRAM_WEBHOOK_URL = process.env.N8N_TELEGRAM_WEBHOOK_URL || '';

// Jeda acak antar pengiriman pesan (anti pola spam)
const MSG_DELAY_MIN_MS = parseInt(process.env.MSG_DELAY_MIN_MS || '3000', 10);
const MSG_DELAY_MAX_MS = parseInt(process.env.MSG_DELAY_MAX_MS || '8000', 10);

// Fail-fast: jangan jalan tanpa kredensial
const VALID_USER = process.env.BASIC_AUTH_USER;
const VALID_PASS = process.env.BASIC_AUTH_PASS;
if (!VALID_USER || !VALID_PASS) {
	console.error('FATAL: env BASIC_AUTH_USER dan BASIC_AUTH_PASS wajib di-set.');
	console.error('Contoh (PM2): pm2 set / ecosystem.config.js env, atau export di shell.');
	process.exit(1);
}

// ─── App / Server ─────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Upload (multer) ──────────────────────────────────────────────────────────

const storage = multer.diskStorage({
	destination: 'uploads/',
	filename: (req, file, cb) => {
		const ext = path.extname(file.originalname);
		cb(null, `${Date.now()}${ext}`);
	}
});
const upload = multer({ storage });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timestamp() {
	return new Date().toLocaleString();
}

function safeUnlink(filePath) {
	if (!filePath) return;
	fs.unlink(filePath, (err) => {
		if (err) console.error('Gagal hapus file upload:', filePath, err.message);
	});
}

/**
 * Validasi & format nomor. Return string chatId kalau valid, null kalau tidak.
 * Catatan: regex dites terhadap hasil format, bukan input mentah,
 * supaya input seperti "+62812..." atau "0812-3456" tetap bisa di-handle formatter.
 */
function validateNumber(number) {
	if (!number) return null;
	const formatted = phoneNumberFormatter(number);
	// hasil formatter diharapkan seperti "628xxxx@c.us" — cek bagian angkanya saja
	const digits = String(formatted).replace(/@c\.us$/, '');
	if (!/^\d+$/.test(digits)) return null;
	return formatted;
}

/** Cek koneksi WA, kirim response error kalau belum ready. Return true kalau ready. */
function ensureReady(res) {
	const connected = isClientReady && client.info && client.info.wid;
	if (!connected) {
		res.status(503).json({
			status: false,
			message: 'WhatsApp client is not connected. Please scan the QR Code first.'
		});
		return false;
	}
	return true;
}

// ─── Deteksi & self-healing "detached Frame" ─────────────────────────────────
// Bug upstream: client.getState()/isClientReady bisa tetap "CONNECTED" walau
// frame internal Puppeteer sudah mati (biasanya muncul setelah idle lama atau
// reconnect). ensureReady() TIDAK bisa mendeteksi ini, jadi kita tangani
// khusus: begitu error ini muncul di operasi apapun, paksa destroy + init ulang.

function isDetachedFrameError(err) {
	const msg = err && err.message ? err.message : String(err);
	return msg.includes('detached Frame');
}

function isTransientPuppeteerError(err) {
	const msg = err && err.message ? err.message : String(err);
	return (
		msg.includes('Execution context was destroyed') ||
		msg.includes('Target closed') ||
		msg.includes('Session closed')
	);
}

/** Batasi waktu tunggu promise yang bisa menggantung selamanya (mis. getState/destroy saat Chromium hang). */
function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timeout setelah ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let forcedRestartInProgress = false;

async function forceRestartClient(reason) {
	if (forcedRestartInProgress) return;
	forcedRestartInProgress = true;
	isClientReady = false;
	unhealthySince = unhealthySince || Date.now();
	console.error(timestamp(), `Detached frame terdeteksi (sumber: ${reason}). Memaksa restart client...`);
	io.emit('message', `${timestamp()} Session korup (detached frame), restarting client...`);
	try {
		// destroy() bisa menggantung kalau Chromium sudah hang → batasi 20 detik
		await withTimeout(client.destroy(), 20000, 'client.destroy');
	} catch (err) {
		console.log(timestamp(), 'Destroy saat force restart:', err.message);
	}
	setTimeout(() => {
		forcedRestartInProgress = false;
		safeInitialize();
	}, 3000);
}

/**
 * Bungkus operasi client.* yang rawan detached frame. Kalau errornya cocok,
 * langsung trigger force restart supaya sesi yang sudah korup tidak terus
 * dipakai (karena isClientReady bisa saja masih terbaca true).
 */
async function withFrameGuard(fn, label) {
	try {
		return await fn();
	} catch (err) {
		if (isDetachedFrameError(err)) {
			forceRestartClient(label).catch(() => {});
		}
		throw err;
	}
}

// ─── Basic Auth Middleware ────────────────────────────────────────────────────

const basicAuth = (req, res, next) => {
	// Endpoint yang dikecualikan dari auth
	if (req.path === '/telegram-webhook') return next();
	if (req.path === '/' || req.path.startsWith('/socket.io')) return next();

	const authHeader = req.headers['authorization'];
	if (!authHeader) {
		return res.status(401).json({ status: false, message: 'Akses ditolak. Header Authorization (Basic Auth) tidak ditemukan.' });
	}

	const [type, credentials] = authHeader.split(' ');
	if (type !== 'Basic' || !credentials) {
		return res.status(401).json({ status: false, message: 'Format Authorization tidak valid. Gunakan Basic Auth.' });
	}

	const decoded = Buffer.from(credentials, 'base64').toString('utf8');
	const separatorIndex = decoded.indexOf(':');
	if (separatorIndex === -1) {
		return res.status(401).json({ status: false, message: 'Format kredensial tidak valid.' });
	}

	const username = decoded.slice(0, separatorIndex);
	const password = decoded.slice(separatorIndex + 1);

	if (username === VALID_USER && password === VALID_PASS) return next();

	return res.status(401).json({ status: false, message: 'Username atau Password salah.' });
};

app.use(basicAuth); // AKTIF — semua endpoint API terlindungi

// ─── WhatsApp Client ──────────────────────────────────────────────────────────

// Bersihkan SingletonLock kalau tertinggal dari crash sebelumnya
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
const singletonLockPath = path.join(SESSION_DIR, 'session-client-one', 'SingletonLock');
const legacyLockPath = path.join(SESSION_DIR, 'session', 'Default', 'SingletonLock');
[singletonLockPath, legacyLockPath].forEach((lockPath) => {
	if (fs.existsSync(lockPath)) {
		try {
			fs.unlinkSync(lockPath);
			console.log('Force removed locked session file:', lockPath);
		} catch (err) {
			console.error('Could not remove SingletonLock:', err.message);
		}
	}
});

// Catatan: --single-process DIHAPUS — flag ini sering menyebabkan
// ProtocolError / crash Chromium di Linux, yang memicu restart berulang
// (dan restart berulang = sinyal login anomali di mata WhatsApp).
//
// Catatan 2: --disable-features=site-per-process JUGA DIHAPUS — flag ini
// mematikan isolasi iframe per-proses dan berkorelasi dengan munculnya
// error "Attempted to use detached Frame" pada whatsapp-web.js (frame
// WhatsApp Web butuh isolasi proses yang stabil). Kalau perlu, aktifkan
// lagi lewat env WA_EXTRA_ARGS, tapi default-nya sekarang tanpa flag ini.
const puppeteerArgs = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--disable-dev-shm-usage',
	'--disable-accelerated-2d-canvas',
	'--no-first-run',
	'--disable-gpu',
	...(process.env.WA_EXTRA_ARGS ? process.env.WA_EXTRA_ARGS.split(' ').filter(Boolean) : [])
];

const client = new Client({
	authStrategy: new LocalAuth({ clientId: 'client-one' }),
	puppeteer: {
		headless: true,
		args: puppeteerArgs
	},
	restartOnAuthFail: true
});

let isClientReady = false;

// ─── Message Queue (anti-spam pattern / ban-risk mitigation) ─────────────────
// Semua pengiriman pesan lewat queue ini, dengan jeda acak antar pesan.
// Kalau n8n nge-hit endpoint 50x sekaligus, pesan tetap keluar satu-satu.

const sendQueue = [];
let queueProcessing = false;

function randomDelay() {
	return MSG_DELAY_MIN_MS + Math.random() * (MSG_DELAY_MAX_MS - MSG_DELAY_MIN_MS);
}

async function processQueue() {
	if (queueProcessing) return;
	queueProcessing = true;
	while (sendQueue.length > 0) {
		const job = sendQueue.shift();
		try {
			const response = await withFrameGuard(
				() => client.sendMessage(job.chatId, job.content, job.options),
				'sendMessage (queue)'
			);
			job.resolve(response);
		} catch (err) {
			job.reject(err);
		}
		if (sendQueue.length > 0) {
			await new Promise((r) => setTimeout(r, randomDelay()));
		}
	}
	queueProcessing = false;
}

function queueMessage(chatId, content, options = {}) {
	return new Promise((resolve, reject) => {
		sendQueue.push({ chatId, content, options, resolve, reject });
		processQueue().catch((err) => console.error('Queue processing error:', err.message));
	});
}

// ─── Init Guard ───────────────────────────────────────────────────────────────
// Mencegah client.initialize() terpanggil dobel (penyebab error
// "onQRChangedEvent already exists") dan mencegah init tumpang tindih
// dengan proses navigasi/logout.

let isInitializing = false;

async function safeInitialize() {
	if (isInitializing) {
		console.log(timestamp(), 'Init sudah berjalan, skip permintaan init baru.');
		return;
	}
	isInitializing = true;
	try {
		await client.initialize();
		initFailCount = 0;
	} catch (err) {
		console.error(timestamp(), 'Initialize error:', err.message);
		initFailCount++;
		// Sebelumnya gagal init = diam selamanya (proses online di PM2, WA mati).
		// Sekarang: bersihkan Chromium yang setengah jalan, lalu coba lagi; kalau
		// tetap gagal beberapa kali, exit supaya PM2 start ulang dari nol.
		if (initFailCount >= MAX_INIT_FAILS) {
			hardExit(`initialize gagal ${initFailCount}x berturut-turut`);
		} else {
			try {
				await withTimeout(client.destroy(), 20000, 'client.destroy');
			} catch (e) {
				console.log(timestamp(), 'Destroy setelah init gagal:', e.message);
			}
			console.log(timestamp(), `Retry initialize dalam 30 detik (gagal ${initFailCount}/${MAX_INIT_FAILS})...`);
			setTimeout(safeInitialize, 30000);
		}
	} finally {
		isInitializing = false;
	}
}

let initFailCount = 0;
const MAX_INIT_FAILS = 3;

/** Keluar dengan kode 1 setelah mencoba menutup Chromium; PM2 (autorestart) yang start ulang. */
async function hardExit(reason) {
	console.error(timestamp(), `Watchdog: ${reason} → exit supaya PM2 restart.`);
	try {
		await withTimeout(client.destroy(), 10000, 'client.destroy');
	} catch (e) { /* abaikan, tetap exit */ }
	process.exit(1);
}

// ─── Client Events ────────────────────────────────────────────────────────────

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

client.on('qr', (qr) => {
	awaitingQr = true; // menunggu scan manual → watchdog tidak boleh exit-loop
	console.log(timestamp(), 'QR received');
	qrcode.toDataURL(qr, (err, url) => {
		if (err) return console.error('QR toDataURL error:', err.message);
		io.emit('qr', url);
		io.emit('message', `${timestamp()} QR Code received`);
	});
});

client.on('ready', () => {
	isClientReady = true;
	reconnectAttempts = 0; // reset backoff setelah berhasil konek
	unhealthySince = null;
	awaitingQr = false;
	watchdogFails = 0;
	lastWaState = 'CONNECTED';
	lastWaStateAt = Date.now();
	console.log(timestamp(), 'Client ready');
	io.emit('message', `${timestamp()} WhatsApp is ready!`);
});

client.on('authenticated', () => {
	console.log(timestamp(), 'Authenticated');
	io.emit('message', `${timestamp()} WhatsApp is authenticated!`);
});

client.on('auth_failure', (msg) => {
	isClientReady = false;
	console.error(timestamp(), 'Auth failure:', msg);
	io.emit('message', `${timestamp()} Auth failure, restarting...`);
});

// Reconnect dengan exponential backoff.
// Kalau WhatsApp menolak sesi (misal nomor sedang dibatasi), JANGAN
// hantam login tiap 5 detik — itu memperburuk flag di sistem WhatsApp.
client.on('disconnected', async (reason) => {
	isClientReady = false;
	console.warn(timestamp(), 'Client disconnected:', reason);
	io.emit('message', `${timestamp()} Disconnected: ${reason}`);

	// Kalau LOGOUT (dari HP / sengaja) atau NAVIGATION, JANGAN auto re-init.
	// Sesi sudah invalid; re-init di momen page sedang navigasi cuma memicu
	// race "Execution context was destroyed". Perlu scan QR ulang manual.
	if (reason === 'LOGOUT' || reason === 'NAVIGATION') {
		console.log(timestamp(), 'Logout terdeteksi. Membersihkan client, tidak auto-reconnect.');
		try {
			await client.destroy();
		} catch (err) {
			// "context destroyed" saat destroy setelah logout itu wajar — telan saja
			console.log(timestamp(), 'Destroy setelah logout:', err.message);
		}
		io.emit('message', `${timestamp()} Logged out. Perlu scan QR ulang — restart proses (mis. via /pm2-restart atau pm2 restart).`);
		return;
	}

	// Untuk disconnect biasa (koneksi putus / timeout), baru reconnect dengan backoff.
	unhealthySince = unhealthySince || Date.now(); // watchdog exit kalau tak pulih > 15 menit
	reconnectAttempts++;
	if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
		console.error(timestamp(), `Reconnect dihentikan setelah ${MAX_RECONNECT_ATTEMPTS} percobaan. Perlu cek manual (kemungkinan sesi ditolak / nomor dibatasi).`);
		io.emit('message', `${timestamp()} Reconnect stopped — cek manual!`);
		return;
	}

	const delay = Math.min(5000 * 2 ** reconnectAttempts, 300000); // max 5 menit
	console.log(timestamp(), `Reinitializing client in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
	setTimeout(() => {
		safeInitialize();
	}, delay);
});

// Catat state terakhir + kapan berubah, dipakai watchdog untuk mendeteksi
// client yang "nyangkut" di OPENING/PAIRING (tidak pernah balik CONNECTED).
let lastWaState = null;
let lastWaStateAt = Date.now();

client.on('change_state', (state) => {
	lastWaState = state;
	lastWaStateAt = Date.now();
	console.log(timestamp(), 'Client state changed:', state);
});

// Log pesan masuk seperlunya saja — jangan dump seluruh object
// (isi chat pribadi tidak perlu masuk log PM2).
client.on('message', (message) => {
	console.log(timestamp(), `Incoming [${message.type}] from ${message.from}`);
	// Relay ke n8n bisa diaktifkan di sini bila diperlukan.
});

// ─── Watchdog periodik untuk detached frame "diam-diam" ──────────────────────
// Kadang error ini tidak muncul lewat request apapun (client idle, tidak ada
// trafik) dan baru ketahuan saat request berikutnya masuk berjam-jam kemudian.
// Ping ringan berkala membantu ketahuan lebih cepat & self-heal otomatis.
//
// Selain detached frame, watchdog juga menangani 3 kondisi "hang" yang
// sebelumnya lolos (client tetap online di PM2 tapi tidak bisa kirim/terima):
//   1. state nyangkut di OPENING/PAIRING > STUCK_STATE_MS
//   2. getState() menggantung/error berturut-turut >= MAX_WATCHDOG_FAILS
//   3. tidak sehat terus-menerus > HARD_EXIT_MS → process.exit(1), PM2 yang start ulang
const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000; // 2 menit
const STUCK_STATE_MS = 5 * 60 * 1000;
const GETSTATE_TIMEOUT_MS = 60 * 1000;
const MAX_WATCHDOG_FAILS = 3;
const HARD_EXIT_MS = 15 * 60 * 1000;
const STUCK_STATES = ['OPENING', 'PAIRING'];

let watchdogFails = 0;
// Mulai dihitung sejak proses start: proses baru yang tidak pernah ready
// (init menggantung) juga harus berujung exit, bukan diam selamanya.
let unhealthySince = Date.now();
let awaitingQr = false;

setInterval(async () => {
	if (forcedRestartInProgress) return;

	// Belum pernah ready / sedang disconnect: hanya pantau lama tidak sehatnya
	if (!isClientReady) {
		// Menunggu scan QR (LOGOUT/sesi baru) bukan hang — jangan exit-loop.
		if (awaitingQr) {
			unhealthySince = Date.now();
			return;
		}
		if (unhealthySince && Date.now() - unhealthySince > HARD_EXIT_MS) {
			hardExit('client tidak ready > 15 menit');
		}
		return;
	}

	// 1) State nyangkut di OPENING/PAIRING
	if (STUCK_STATES.includes(lastWaState) && Date.now() - lastWaStateAt > STUCK_STATE_MS) {
		console.error(timestamp(), `Watchdog: state nyangkut di ${lastWaState} > 5 menit.`);
		unhealthySince = unhealthySince || Date.now();
		forceRestartClient(`watchdog stuck ${lastWaState}`).catch(() => {});
		return;
	}

	// 2) getState dengan timeout
	try {
		await withFrameGuard(() => withTimeout(client.getState(), GETSTATE_TIMEOUT_MS, 'getState'), 'watchdog getState');
		watchdogFails = 0;
		unhealthySince = null;
	} catch (err) {
		if (isDetachedFrameError(err)) return; // sudah ditangani withFrameGuard
		watchdogFails++;
		console.log(timestamp(), `Watchdog getState gagal (${watchdogFails}/${MAX_WATCHDOG_FAILS}):`, err.message);
		unhealthySince = unhealthySince || Date.now();
		if (watchdogFails >= MAX_WATCHDOG_FAILS) {
			watchdogFails = 0;
			forceRestartClient('watchdog getState gagal berturut-turut').catch(() => {});
		}
	}
}, WATCHDOG_INTERVAL_MS);

safeInitialize();

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
	console.log(timestamp(), 'Socket connected:', socket.id);
	socket.emit('message', `${timestamp()} Connected`);
	if (isClientReady) {
		socket.emit('message', `${timestamp()} WhatsApp is ready!`);
	}
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
	res.sendFile('index.html', { root: __dirname });
});

// Kirim pesan teks ke nomor
app.post('/send-message', async (req, res) => {
	const { number, message } = req.body;

	if (!number || !message) {
		return res.status(400).json({ status: false, message: "Both 'number' and 'message' fields are required." });
	}

	const chatId = validateNumber(number);
	if (!chatId) {
		return res.status(400).json({ status: false, message: 'Invalid phone number format.' });
	}

	if (!ensureReady(res)) return;

	try {
		const response = await queueMessage(chatId, message);
		res.json({ status: true, queue_length: sendQueue.length, response });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.', response: error.toString() });
		}
		res.status(500).json({ status: false, response: error.toString() });
	}
});

// Kirim pesan teks ke grup
app.post('/send-message-group', async (req, res) => {
	const { group_id, message } = req.body;

	if (!group_id || !message) {
		return res.status(400).json({ status: false, message: "Both 'group_id' and 'message' fields are required." });
	}

	if (!ensureReady(res)) return;

	try {
		const response = await queueMessage(group_id, message);
		res.json({ status: true, queue_length: sendQueue.length, response });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.', response: error.toString() });
		}
		res.status(500).json({ status: false, response: error.toString() });
	}
});

// Kirim media ke nomor (file upload atau URL)
app.post('/send-media', upload.any(), async (req, res) => {
	const { number, caption, url } = req.body;
	const file = req.files && req.files.length > 0 ? req.files[0] : null;
	const filePath = file ? file.path : null;

	try {
		if (!number) {
			return res.status(400).json({ status: false, message: "Field 'number' is required." });
		}

		const chatId = validateNumber(number);
		if (!chatId) {
			return res.status(400).json({ status: false, message: 'Invalid phone number format.' });
		}

		if (!ensureReady(res)) return;

		let media;
		if (url) {
			media = await MessageMedia.fromUrl(url);
		} else {
			if (!file) {
				return res.status(400).json({ status: false, message: "File upload is missing (or 'url' is not provided)." });
			}
			media = MessageMedia.fromFilePath(filePath);
			if (file.originalname) media.filename = file.originalname; // fix: dulu pakai req.file yang selalu undefined
		}

		const response = await queueMessage(chatId, media, { caption: caption || '' });
		res.json({ status: true, response });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.', response: error.toString() });
		}
		res.status(500).json({ status: false, response: error.toString() });
	} finally {
		safeUnlink(filePath); // file selalu dibersihkan, sukses maupun gagal
	}
});

// Kirim media ke grup (file upload atau URL)
app.post('/send-media-group', upload.any(), async (req, res) => {
	const { group_id, caption, url } = req.body;
	const file = req.files && req.files.length > 0 ? req.files[0] : null;
	const filePath = file ? file.path : null;

	try {
		if (!group_id) {
			return res.status(400).json({ status: false, message: "Field 'group_id' is required." });
		}

		if (!ensureReady(res)) return;

		let media;
		if (url) {
			media = await MessageMedia.fromUrl(url);
		} else {
			if (!file) {
				return res.status(400).json({ status: false, message: "File upload is missing (or 'url' is not provided)." });
			}
			media = MessageMedia.fromFilePath(filePath);
			if (file.originalname) media.filename = file.originalname;
		}

		const response = await queueMessage(group_id, media, { caption: caption || '' });
		res.json({ status: true, response });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.', response: error.toString() });
		}
		res.status(500).json({ status: false, response: error.toString() });
	} finally {
		safeUnlink(filePath);
	}
});

// List member grup
app.post('/list-member-group', async (req, res) => {
	const { group_id } = req.body;

	if (!group_id) {
		return res.status(400).json({ status: false, message: "Field 'group_id' is required." });
	}

	if (!ensureReady(res)) return;

	try {
		const chat = await withFrameGuard(() => client.getChatById(group_id), 'list-member-group');
		if (!chat.isGroup) {
			return res.status(404).json({ status: false, message: 'Group Not Found.', group_id });
		}
		res.json({ status: true, message: 'Group Found.', data: chat.participants });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.' });
		}
		res.status(500).json({ status: false, message: 'Error fetching group.', error: error.message });
	}
});

// Tambah member ke grup
app.post('/add-member-group', async (req, res) => {
	const { group_id, number } = req.body;

	if (!group_id || !number) {
		return res.status(400).json({ status: false, message: "Fields 'group_id' and 'number' are required." });
	}

	const chatId = validateNumber(number);
	if (!chatId) {
		return res.status(400).json({ status: false, message: 'Invalid phone number format.' });
	}

	if (!ensureReady(res)) return;

	try {
		const chat = await withFrameGuard(() => client.getChatById(group_id), 'add-member-group');
		if (!chat.isGroup) {
			return res.status(404).json({ status: false, message: 'Group Not Found.', group_id });
		}
		// di-await + hasil per nomor dikembalikan (bisa gagal karena privacy setting, dll.)
		const result = await withFrameGuard(() => chat.addParticipants([chatId]), 'add-member-group');
		res.json({ status: true, message: 'Add participants processed.', result });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.' });
		}
		res.status(500).json({ status: false, message: 'Error adding participant.', error: error.message });
	}
});

// Hapus member dari grup
app.post('/remove-member-group', async (req, res) => {
	const { group_id, number } = req.body;

	if (!group_id || !number) {
		return res.status(400).json({ status: false, message: "Fields 'group_id' and 'number' are required." });
	}

	const chatId = validateNumber(number);
	if (!chatId) {
		return res.status(400).json({ status: false, message: 'Invalid phone number format.' });
	}

	if (!ensureReady(res)) return;

	try {
		const chat = await withFrameGuard(() => client.getChatById(group_id), 'remove-member-group');
		if (!chat.isGroup) {
			return res.status(404).json({ status: false, message: 'Group Not Found.', group_id });
		}
		const result = await withFrameGuard(() => chat.removeParticipants([chatId]), 'remove-member-group');
		res.json({ status: true, message: 'Remove participants processed.', result });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.' });
		}
		res.status(500).json({ status: false, message: 'Error removing participant.', error: error.message });
	}
});

// Kirim link undangan grup ke nomor
app.post('/send-invitation-link', async (req, res) => {
	const { group_id, number } = req.body;

	if (!group_id || !number) {
		return res.status(400).json({ status: false, message: "Fields 'group_id' and 'number' are required." });
	}

	const chatId = validateNumber(number);
	if (!chatId) {
		return res.status(400).json({ status: false, message: 'Invalid phone number format.' });
	}

	if (!ensureReady(res)) return;

	try {
		const chat = await withFrameGuard(() => client.getChatById(group_id), 'send-invitation-link');
		if (!chat.isGroup) {
			return res.status(404).json({ status: false, message: 'Group Not Found.', group_id });
		}
		const code = await withFrameGuard(() => chat.getInviteCode(), 'send-invitation-link');
		await queueMessage(chatId, `Anda diundang ke grup ${chat.name}. Gunakan link ini untuk bergabung: https://chat.whatsapp.com/${code}`);
		res.json({ status: true, message: 'Invitation link sent.', code });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.' });
		}
		res.status(500).json({ status: false, message: 'Error sending invitation.', error: error.message });
	}
});

// Cek nama grup
app.post('/check-group-name', async (req, res) => {
	const { group_id } = req.body;

	if (!group_id) {
		return res.status(400).json({ status: false, message: "Field 'group_id' is required." });
	}

	if (!ensureReady(res)) return;

	try {
		const chat = await withFrameGuard(() => client.getChatById(group_id), 'check-group-name');
		if (!chat.isGroup) {
			return res.status(404).json({ status: false, message: 'Group Not Found or ID is not a group.', group_id });
		}
		res.json({
			status: true,
			message: 'Group Found.',
			data: {
				name: chat.name,
				id: chat.id._serialized,
				participants: chat.participants.length
			}
		});
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.' });
		}
		res.status(500).json({ status: false, message: 'Error fetching group.', error: error.message });
	}
});

// Rename grup
app.post('/rename-group', async (req, res) => {
	const { group_id, new_name } = req.body;

	if (!group_id || !new_name) {
		return res.status(400).json({ status: false, message: "Fields 'group_id' and 'new_name' are required." });
	}

	if (!ensureReady(res)) return;

	try {
		const chat = await withFrameGuard(() => client.getChatById(group_id), 'rename-group');
		if (!chat.isGroup) {
			return res.status(404).json({ status: false, message: 'Group Not Found or ID is not a group.', group_id });
		}
		const oldName = chat.name;
		await withFrameGuard(() => chat.setSubject(new_name), 'rename-group');
		res.json({ status: true, message: 'Group name updated successfully.', data: { old_name: oldName, new_name } });
	} catch (error) {
		if (isDetachedFrameError(error)) {
			return res.status(503).json({ status: false, message: 'Session sedang pulih dari error internal, coba lagi sebentar.' });
		}
		res.status(500).json({ status: false, message: 'Error updating group name.', error: error.message });
	}
});

// Relay webhook Telegram -> sistem internal (n8n)
app.post('/telegram-webhook', async (req, res) => {
	try {
		if (!N8N_TELEGRAM_WEBHOOK_URL) {
			console.error('N8N_TELEGRAM_WEBHOOK_URL belum di-set, webhook Telegram tidak di-relay.');
			return res.status(200).send('OK'); // tetap 200 agar Telegram tidak retry terus
		}

		const payload = req.body;
		console.log(timestamp(), 'Received Telegram webhook, relaying...');

		const response = await axios.post(N8N_TELEGRAM_WEBHOOK_URL, payload, {
			headers: { 'Content-Type': 'application/json' },
			timeout: 15000
		});

		console.log(timestamp(), 'Relay OK:', response.status);
		res.status(200).send('OK');
	} catch (error) {
		console.error('Error relaying Telegram webhook:', error.message);
		res.status(500).send('Internal Server Error');
	}
});

// Logout WhatsApp secara aman.
// Catatan: logout memicu WA Web navigasi ke halaman QR, sehingga error
// "Execution context was destroyed" WAJAR muncul di sini — itu bukan kegagalan,
// jadi kita telan. Setelah logout, proses HARUS di-restart untuk scan QR baru.
app.post('/logout', async (req, res) => {
	if (!isClientReady) {
		return res.status(503).json({ status: false, message: 'Client belum ready / sudah tidak login.' });
	}

	isClientReady = false;
	try {
		await client.logout();
	} catch (err) {
		// "context destroyed" karena page navigasi — expected, abaikan
		console.log(timestamp(), 'Logout (navigasi):', err.message);
	}
	try {
		await client.destroy();
	} catch (err) {
		console.log(timestamp(), 'Destroy setelah logout:', err.message);
	}

	io.emit('message', `${timestamp()} Logged out. Restart proses untuk scan QR baru.`);
	res.json({
		status: true,
		message: 'Logged out. Restart proses (mis. POST /pm2-restart atau pm2 restart) untuk scan QR baru.'
	});
});

// Restart proses via PM2.
// Sudah di belakang Basic Auth; kalau PM2_RESTART_SECRET di-set,
// wajib juga kirim header x-restart-secret (lapisan kedua).
app.post('/pm2-restart', (req, res) => {
	const secret = process.env.PM2_RESTART_SECRET;
	if (secret && req.headers['x-restart-secret'] !== secret) {
		return res.status(403).json({ status: false, message: 'Invalid restart secret.' });
	}

	const pm2 = require('pm2');
	pm2.connect((err) => {
		if (err) {
			console.error('PM2 connect error:', err.message);
			return res.status(500).json({ status: false, message: err.message });
		}
		pm2.restart(PM2_PROCESS_NAME, (restartErr) => {
			pm2.disconnect();
			if (restartErr) {
				console.error('PM2 restart error:', restartErr.message);
				return res.status(500).json({ status: false, message: restartErr.message });
			}
			res.json({ status: true, message: `Process "${PM2_PROCESS_NAME}" restarted.` });
		});
	});
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
	console.log(`(${signal}) Shutting down gracefully...`);
	try {
		if (client) await client.destroy();
	} catch (err) {
		console.error('Error during client destroy:', err.message);
	}
	process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Jaring pengaman terakhir — log, jangan biarkan proses mati diam-diam.
// Error "Execution context was destroyed"/"Target closed"/"Session closed"
// biasa terjadi saat logout/navigasi Puppeteer; itu tidak berbahaya, cukup
// dicatat sebagai info. Sedangkan "detached Frame" ARTINYA sesi korup —
// walau isClientReady masih true — jadi kita paksa restart client.
process.on('unhandledRejection', (reason) => {
	const msg = reason && reason.message ? reason.message : String(reason);

	if (isTransientPuppeteerError({ message: msg })) {
		console.log(timestamp(), 'Info (Puppeteer navigasi/close, aman diabaikan):', msg);
		return;
	}

	if (isDetachedFrameError({ message: msg })) {
		console.error(timestamp(), 'Detached frame (unhandled rejection):', msg);
		forceRestartClient('unhandledRejection').catch(() => {});
		return;
	}

	console.error(timestamp(), 'Unhandled Rejection:', reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
	console.log(timestamp(), 'App listening on port', PORT);
});