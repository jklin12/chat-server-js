const { Client, LocalAuth, MessageMedia, GroupChat } = require('whatsapp-web.js');
const { phoneNumberFormatter } = require('./helper/formatter');
const fs = require('fs');
const express = require('express');
const qrcode = require('qrcode');
const socketIO = require('socket.io');
const http = require('http');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const https = require('https');
const dns = require('dns');



const storage = multer.diskStorage({
	destination: 'uploads/',
	filename: (req, file, cb) => {
		const ext = path.extname(file.originalname); // Ambil ekstensi file
		const fileName = `${Date.now()}${ext}`; // Buat nama file dengan timestamp
		cb(null, fileName);
	}
});


const upload = multer({ storage: storage });

const PORT = process.env.PORT || 5003;
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const client = new Client({
	authStrategy: new LocalAuth()
});



//const client = new Client({});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => {
	res.sendFile('index.html', { root: __dirname });
});

// initialize whatsapp and the example event
client.on('message', async message => {
	try {

		const media = await message.downloadMedia();

		const postData = new URLSearchParams();
		postData.append('from', message.from);
		postData.append('message', message.body);
		postData.append('has_quote', message.hasQuotedMsg);
		postData.append('quote_message_id', message._data.quotedStanzaID);
		postData.append('quote_message', message._data.quotedMsg?.body);

		if (message.hasMedia || message.type === 'ptt') {
			postData.append('media', media.data);
			postData.append('message_type', message.type);
		}

		//console.log(postData);

		const response = await axios.post(
			'https://siva.sanf.co.id:5678/webhook/04706a72-8bf3-4ed3-ace1-8ac7a1005792',
			postData.toString(),
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				}
			}
		);
		console.log('Response:', response.data);
	} catch (error) {
		console.error('Error sending API request:', error);
	}

});

client.initialize();

// socket connection
var today = new Date();
var now = today.toLocaleString();
io.on('connection', (socket) => {
	socket.emit('message', `${now} Connected`);

	client.on('qr', (qr) => {
		console.log("QR");

		qrcode.toDataURL(qr, (err, url) => {
			socket.emit("qr", url);
			socket.emit('message', `${now} QR Code received`);
		});
	});

	client.on('ready', () => {
		console.log("Ready");
		socket.emit('message', `${now} WhatsApp is ready!`);
	});

	client.on('authenticated', (session) => {
		console.log("authenticated");
		socket.emit('message', `${now} Whatsapp is authenticated!`);

	});

	client.on('auth_failure', function (session) {
		console.log("Auth failure, ");
		socket.emit('message', `${now} Auth failure, restarting...`);
	});

	client.on('disconnected', function () {
		console.log("disconnected ");

		socket.emit('message', `${now} Disconnected`);

	});
});

// send message group routing
app.post('/send-message-group', (req, res) => {
	const { group_id, message } = req.body;

	// Validasi input
	if (!group_id || !message) {
		return res.status(400).json({
			status: false,
			message: "Both 'group_id' and 'message' fields are required."
		});
	}


	const isConnected = client.info && client.info.wid;
	if (!isConnected) {
		return res.status(400).json({
			status: false,
			message: "WhatsApp client is not connected. Please scan the QR Code first."
		});
	}

	client.sendMessage(group_id, message)
		.then(response => {
			res.status(200).json({
				status: true,
				response: response
			});
		})
		.catch(error => {
			res.status(200).json({
				status: "false",
				response: error.toString()
			});
		});
});

// send message routing
app.post('/send-message', (req, res) => {
	const { number, message } = req.body;

	// Validasi input
	if (!number || !message) {
		return res.status(400).json({
			status: false,
			message: "Both 'number' and 'message' fields are required."
		});
	}

	// Validasi apakah nomor sesuai format
	const formattedNumber = phoneNumberFormatter(number);
	const numberRegex = /^\d+$/; // Contoh: hanya angka

	if (!numberRegex.test(number)) {
		return res.status(400).json({
			status: false,
			message: "Invalid phone number format. Only numeric values are allowed."
		});
	}


	//const isConnected = client.info && client.info.wid;
	/*if (!isConnected) {
		return res.status(400).json({
			status: false,
			message: "WhatsApp client is not connected. Please scan the QR Code first."
		});
	}*/

	client.sendMessage(formattedNumber, message)
		.then(response => {
			res.status(200).json({
				status: true,
				response: response
			});
		})
		.catch(error => {
			res.status(200).json({
				status: "false",
				response: error.toString()
			});
		});
});


app.post('/send-media', upload.single('media'), async (req, res) => {
	try {
		const { number, caption, url } = req.body;

		if (!number) {
			return res.status(400).json({ error: "Both 'number' and 'file' fields are required" });
		}

		const formattedNumber = phoneNumberFormatter(number);
		const numberRegex = /^\d+$/; // Contoh: hanya angka

		if (!numberRegex.test(number)) {
			return res.status(400).json({
				status: false,
				message: "Invalid phone number format. Only numeric values are allowed."
			});
		}

		const isConnected = client.info && client.info.wid;
		if (!isConnected) {
			return res.status(400).json({
				status: false,
				message: "WhatsApp client is not connected. Please scan the QR Code first."
			});
		}


		if (!url) {
			const filePath = req.file.path;
			if (!filePath) {
				return res.status(400).json({ error: "Both 'number' and 'file' fields are required" });
			}
			const media = MessageMedia.fromFilePath(filePath);
			if (req.file && req.file.originalname) {
				media.filename = req.file.originalname;
			}
			await client.sendMessage(formattedNumber, media, { caption: caption || '' })
				.then(response => {
					res.status(200).json({
						status: true,
						response: response
					});
				})
				.catch(error => {
					res.status(200).json({
						status: "false",
						response: error.toString()
					});
				});
			fs.unlinkSync(filePath);
		} else {
			const media = await MessageMedia.fromUrl(url);
			await client.sendMessage(formattedNumber, media, { caption: caption || '' })
				.then(response => {
					res.status(200).json({
						status: true,
						response: response
					});
				})
				.catch(error => {
					res.status(200).json({
						status: "false",
						response: error.toString()
					});
				});
		}
	} catch (error) {
		res.status(500).json({ status: "false", details: error.message });
	}
});

app.post('/send-media-group', upload.single('media'), async (req, res) => {
	try {
		const { group_id, caption, url } = req.body;

		if (!group_id) {
			return res.status(400).json({
				status: false,
				message: "Both 'group_id' and 'url' fields are required."
			});
		}


		const isConnected = client.info && client.info.wid;
		if (!isConnected) {
			return res.status(400).json({
				status: false,
				message: "WhatsApp client is not connected. Please scan the QR Code first."
			});
		}


		if (!url) {
			const filePath = req.file.path;
			if (!filePath) {
				return res.status(400).json({ error: "Both 'number' and 'file' fields are required" });
			}
			const media = MessageMedia.fromFilePath(filePath);
			if (req.file && req.file.originalname) {
				media.filename = req.file.originalname;
			}
			await client.sendMessage(group_id, media, { caption: caption || '' })
				.then(response => {
					res.status(200).json({
						status: true,
						response: response
					});
				})
				.catch(error => {
					res.status(200).json({
						status: "false",
						response: error.toString()
					});
				});
			fs.unlinkSync(filePath);
		} else {
			const media = await MessageMedia.fromUrl(url);
			await client.sendMessage(group_id, media, { caption: caption || '' })
				.then(response => {
					res.status(200).json({
						status: true,
						response: response
					});
				})
				.catch(error => {
					res.status(200).json({
						status: "false",
						response: error.toString()
					});
				});
		}
	} catch (error) {
		res.status(500).json({ status: "false", details: error.message });
	}
});


app.post('/list-member-group', async (req, res) => {
	const { group_id } = req.body;


	if (!group_id) {
		return res.status(400).json({
			status: false,
			message: "Field 'group_id' is required."
		});
	}

	const chat = await client.getChatById(group_id);

	if (chat.isGroup) {
		console.log(`Mengambil data dari grup: ${chat.name}`);

		// 3. Loop participants
		chat.participants.forEach(member => {
			console.log(`- ${member.id.user} (Admin: ${member.isAdmin})`);
		});

		return res.json({
			status: true,
			message: 'Group Found.',
			data: chat.participants
		});
	} else {
		return res.json({
			status: false,
			message: 'Group Not Found.',
			group_id
		});
	}
});

app.post('/add-member-group', async (req, res) => {
	const { group_id, number } = req.body;

	const formattedNumber = phoneNumberFormatter(number);
	const numberRegex = /^\d+$/; // Contoh: hanya angka

	if (!numberRegex.test(number)) {
		return res.status(400).json({
			status: false,
			message: "Invalid phone number format. Only numeric values are allowed."
		});
	}


	if (!group_id) {
		return res.status(400).json({
			status: false,
			message: "Field 'group_id' is required."
		});
	}

	const chat = await client.getChatById(group_id);
	if (chat.isGroup) {
		chat.addParticipants([formattedNumber]); // Pass an array of contact IDs [id1, id2, id3 .....]
		return res.json({
			status: true,
			message: 'Success Add participants.'
		});
	}

	return res.json({
		status: false,
		message: 'Group Not Found.'
	});
});

app.post('/remove-member-group', async (req, res) => {
	const { group_id, number } = req.body;

	const formattedNumber = phoneNumberFormatter(number);
	const numberRegex = /^\d+$/; // Contoh: hanya angka

	if (!numberRegex.test(number)) {
		return res.status(400).json({
			status: false,
			message: "Invalid phone number format. Only numeric values are allowed."
		});
	}


	if (!group_id) {
		return res.status(400).json({
			status: false,
			message: "Field 'group_id' is required."
		});
	}

	const chat = await client.getChatById(group_id);
	if (chat.isGroup) {
		chat.removeParticipants([formattedNumber]); // Pass an array of contact IDs [id1, id2, id3 .....]
		return res.json({
			status: true,
			message: 'Success Remove participants.'
		});
	}

	return res.json({
		status: false,
		message: 'Group Not Found.'
	});
});


app.post('/send-invitation-link', async (req, res) => {
	const { group_id, number } = req.body;

	const formattedNumber = phoneNumberFormatter(number);
	const numberRegex = /^\d+$/; // Contoh: hanya angka

	if (!numberRegex.test(number)) {
		return res.status(400).json({
			status: false,
			message: "Invalid phone number format. Only numeric values are allowed."
		});
	}


	if (!group_id) {
		return res.status(400).json({
			status: false,
			message: "Field 'group_id' is required."
		});
	}

	const chat = await client.getChatById(group_id);
	if (chat.isGroup) {
		const code = await chat.getInviteCode();

		client.sendMessage(formattedNumber, `AAnda diundang ke grup ${chat.name}. Gunakan link ini untuk bergabung: https://chat.whatsapp.com/${code}`);
		return res.json({
			status: true,
			message: `Success Add participants. ${code}`
		});
	}

	return res.json({
		status: false,
		message: 'Group Not Found.'
	});
});




app.post('/check-group-name', async (req, res) => {
	const { group_id } = req.body;

	if (!group_id) {
		return res.status(400).json({
			status: false,
			message: "Field 'group_id' is required."
		});
	}

	try {
		const chat = await client.getChatById(group_id);

		if (chat.isGroup) {
			return res.json({
				status: true,
				message: 'Group Found.',
				data: {
					name: chat.name,
					id: chat.id._serialized,
					participants: chat.participants.length
				}
			});
		} else {
			return res.json({
				status: false,
				message: 'Group Not Found or ID is not a group.',
				group_id
			});
		}
	} catch (error) {
		return res.status(500).json({
			status: false,
			message: 'Error fetching group.',
			error: error.message
		});
	}
});

app.post('/rename-group', async (req, res) => {
	const { group_id, new_name } = req.body;

	if (!group_id || !new_name) {
		return res.status(400).json({
			status: false,
			message: "Fields 'group_id' and 'new_name' are required."
		});
	}

	try {
		const chat = await client.getChatById(group_id);

		if (chat.isGroup) {
			await chat.setSubject(new_name);
			return res.json({
				status: true,
				message: 'Group name updated successfully.',
				data: {
					old_name: chat.name,
					new_name: new_name
				}
			});
		} else {
			return res.json({
				status: false,
				message: 'Group Not Found or ID is not a group.',
				group_id
			});
		}
	} catch (error) {
		return res.status(500).json({
			status: false,
			message: 'Error updating group name.',
			error: error.message
		});
	}
});


server.listen(PORT, () => {
	console.log('App listen on port ', PORT);
});

