const { Client, LocalAuth } = require('whatsapp-web.js');
const { phoneNumberFormatter } = require('./helper/formatter');
const fs = require('fs');
const express = require('express');
const qrcode = require('qrcode');
const socketIO = require('socket.io');
const http = require('http');

const PORT = process.env.PORT || 5003;
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const client = new Client({
    webVersionCache:
    {
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2410.1.html',
        type: 'remote'
    }
});



//const client = new Client({});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => {
	res.sendFile('index.html', { root: __dirname });
});

// initialize whatsapp and the example event
client.on('message', msg => {
	if (msg.body == '!ping') {
		msg.reply('pong');
	} else if (msg.body == 'skuy') {
		msg.reply('helo ma bradah');
	}
});
client.initialize();

// socket connection
var today = new Date();
var now = today.toLocaleString();
io.on('connection', (socket) => {
	socket.emit('message', `${now} Connected`);

	client.on('qr', (qr) => {
		qrcode.toDataURL(qr, (err, url) => {
			socket.emit("qr", url);
			socket.emit('message', `${now} QR Code received`);
		});
	});

	client.on('ready', () => {
		socket.emit('message', `${now} WhatsApp is ready!`);
	});

	client.on('authenticated', (session) => {
		socket.emit('message', `${now} Whatsapp is authenticated!`);

	});

	client.on('auth_failure', function (session) {
		socket.emit('message', `${now} Auth failure, restarting...`);
	});

	client.on('disconnected', function () {
		socket.emit('message', `${now} Disconnected`);

	});

	client.on('message', message => {
		console.log(message.body);
		//socket.emit('message', `${now} Pesan Masuk : ${message}`);
		//client.sendMessage(message.from, 'pong');
	});
});

// send message routing
app.post('/send-message', (req, res) => {
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
			res.status(200).json({
				status: "falses",
				response: error.toString()
			});
		});
});

server.listen(PORT, () => {
	console.log('App listen on port ', PORT);
});

