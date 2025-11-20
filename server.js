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
app.post('/send-message', (req, res) => {

	if (!isClientReady) {
		return res.status(500).json({ status: false, message: 'Client not ready' });
	}

	const number = phoneNumberFormatter(req.body.number);
	const message = req.body.message;

	client.sendMessage(number, message)
		.then(response => {
			res.status(200).json({
				status: true,
				response: response
			});
		})
		.catch(error => {
			res.status(500).json({
				status: false,
				response: error.toString()
			});
		});
});

// Jalankan server dan inisialisasi WhatsApp
server.listen(PORT, () => {
	console.log(`App listening on port ${PORT}`);
});
client.initialize();
