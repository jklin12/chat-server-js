const { Client, LocalAuth } = require('whatsapp-web.js');
const { phoneNumberFormatter } = require('./helper/formatter');
const fs = require('fs');
const express = require('express');
const qrcode = require('qrcode');
const socketIO = require('socket.io');
const http = require('http');
const { EventEmitter } = require('events');

// Opsional: Tingkatkan limit EventEmitter jika perlu
EventEmitter.defaultMaxListeners = 20;

const PORT = process.env.PORT || 5003;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

let isClientReady = false;

// Inisialisasi WhatsApp Client
const client = new Client({
	puppeteer: {
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
	},
	authStrategy: new LocalAuth({
		dataPath: 'wa_session'
	})
});

// Middleware express
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Halaman utama
app.get('/', (req, res) => {
	res.sendFile('index.html', { root: __dirname });
});

// WhatsApp Event Handler
client.on('qr', (qr) => {
	qrcode.toDataURL(qr, (err, url) => {
		io.emit("qr", url);
		io.emit('message', `${new Date().toLocaleString()} QR Code received`);
	});
});

client.on('ready', () => {
	isClientReady = true;
	io.emit('message', `${new Date().toLocaleString()} WhatsApp is ready!`);
});

client.on('authenticated', () => {
	io.emit('message', `${new Date().toLocaleString()} WhatsApp is authenticated!`);
});

client.on('auth_failure', () => {
	console.log('Authentication failure, restarting...');

	io.emit('message', `${new Date().toLocaleString()} Auth failure, restarting...`);
});

client.on('disconnected', () => {
	console.log('Disconnected from WhatsApp');

	io.emit('message', `${new Date().toLocaleString()} Disconnected`);
});

client.on('loading_screen', (percent, message) => {
	console.log('LOADING SCREEN', percent, message);
});


// Balasan otomatis
client.on('message', msg => {
	/*console.log(msg.body);
	if (msg.body === '!ping') {
		msg.reply('pong');
	} else if (msg.body === 'skuy') {
		msg.reply('helo ma bradah');
	}*/
});

// Socket.IO connection
io.on('connection', (socket) => {
	const now = new Date().toLocaleString();
	socket.emit('message', `${now} Connected`);
});

// Endpoint kirim pesan manual
app.post('/send-message', async (req, res) => {
	try {
		// 1. Cek Client Ready
		if (!isClientReady) {
			return res.status(503).json({ status: false, message: 'Client not ready' });
		}

		const { number, message } = req.body;

		// 2. Validasi Input
		if (!number || !message) {
			return res.status(400).json({ status: false, message: 'Invalid input' });
		}

		const formattedNumber = phoneNumberFormatter(number);

		// 3. Cek apakah user terdaftar (Safety First)
		const isRegistered = await client.isRegisteredUser(formattedNumber);
		if (!isRegistered) {
			return res.status(422).json({
				status: false,
				message: 'Nomor tidak terdaftar di WhatsApp'
			});
		}

		// 4. Ambil Object Chat
		const chat = await client.getChatById(formattedNumber);

		// --- INI YANG ANDA MINTA ---
		// Jika object chat gagal diambil atau null
		if (!chat) {
			return res.status(404).json({
				status: false,
				message: 'Gagal mendapatkan object chat'
			});
		}
		// ---------------------------

		// 5. Typing Effect
		await chat.sendStateTyping();

		const typingDuration = calculateTypingDuration(message);
		await sleep(typingDuration);

		// 6. Kirim Pesan
		const response = await client.sendMessage(formattedNumber, message);
 
		res.status(200).json({
			status: true,
			response: response
		});

	} catch (error) {
		console.error('Error:', error);
		res.status(500).json({
			status: false,
			message: error.message
		});
	}
});


const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const calculateTypingDuration = (message) => {
	// Estimasi 100ms per karakter
	const duration = message.length * 100;
	// Minimal 2 detik, Maksimal 10 detik
	return Math.min(Math.max(duration, 2000), 10000);
};

// Jalankan server dan inisialisasi WhatsApp
server.listen(PORT, () => {
	console.log(`App listening on port ${PORT}`);
});
client.initialize();
