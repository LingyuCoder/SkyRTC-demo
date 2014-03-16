var SkyRTC = (function() {
	var PeerConnection = (window.PeerConnection || window.webkitPeerConnection00 || window.webkitRTCPeerConnection || window.mozRTCPeerConnection);
	var URL = (window.URL || window.webkitURL || window.msURL || window.oURL);
	var getUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
	var nativeRTCIceCandidate = (window.mozRTCIceCandidate || window.RTCIceCandidate);
	var nativeRTCSessionDescription = (window.mozRTCSessionDescription || window.RTCSessionDescription); // order is very important: "RTCSessionDescription" defined in Nighly but useless
	var moz = !! navigator.mozGetUserMedia;
	var iceServer = {
		"iceServers": [{
			"url": "stun:stun.l.google.com:19302"
		}]
	};
	var packetSize = 1000;
	//事件处理器
	function EventEmitter() {
		this.events = {};
	}
	//绑定事件函数
	EventEmitter.prototype.on = function(eventName, callback) {
		this.events[eventName] = this.events[eventName] || [];
		this.events[eventName].push(callback);
	};
	//触发事件函数
	EventEmitter.prototype.emit = function(eventName, _) {
		var events = this.events[eventName],
			args = Array.prototype.slice.call(arguments, 1),
			i, m;

		if (!events) {
			return;
		}
		for (i = 0, m = events.length; i < m; i++) {
			events[i].apply(null, args);
		}
	};

	function SkyRTC() {
		//房间
		this.room = "";
		//接收文件时用于暂存接收文件
		this.fileData = {};
		//本地WebSocket连接
		this.socket = null;
		//本地socket的id，由后台服务器创建
		this.me = null;
		//保存所有与本地相连的peer connection， 键为socket id，值为PeerConnection类型
		this.peerConnections = {};
		//保存所有与本地连接的socket的id
		this.connections = [];
		//保存所有与本地连接的数据流
		this.streams = [];
		//初始时需要构建链接的数目
		this.numStreams = 0;
		//初始时已经连接的数目
		this.initializedStreams = 0;
		//保存所有的data channel，键为socket id，值通过PeerConnection实例的createChannel创建
		this.dataChannels = {};
		//保存所有发文件的data channel及其发文件状态
		this.fileChannels = {};
		//保存所有接受到的文件
		this.receiveFiles = {};
	}
	//继承自事件处理器，提供绑定事件和触发事件的功能
	SkyRTC.prototype = new EventEmitter();
	//消息广播
	SkyRTC.prototype.broadcast = function(message) {
		var socketId;
		for (socketId in this.dataChannels) {
			this.sendMessage(message, socketId);
		}
	};
	//发送消息方法
	SkyRTC.prototype.sendMessage = function(message, socketId) {
		if (this.dataChannels[socketId].readyState.toLowerCase() === 'open') {
			this.dataChannels[socketId].send(message);
		}
	};
	//本地连接信道，信道为websocket
	SkyRTC.prototype.connect = function(server, room) {
		var socket,
			that = this;
		room = room || "";
		socket = this.socket = new WebSocket(server);
		socket.onopen = function() {
			socket.send(JSON.stringify({
				"eventName": "__join",
				"data": {
					"room": room
				}
			}));
			that.emit("socket_opened", socket);
		};

		socket.onmessage = function(message) {
			var json = JSON.parse(message.data);
			if (json.eventName) {
				that.emit(json.eventName, json.data);
			} else {
				that.emit("socket_receive_message", json);
			}
		};

		socket.onerror = function(error) {
			that.emit("socket_error", error);
		};

		socket.onclose = function(data) {
			delete that.peerConnections[socket.id];
			delete that.dataChannels[socket.id];
			delete that.fileChannels[socket.id];
			that.emit('socket_closed', socket.id);
		};

		this.on('_peers', function(data) {
			//获取所有服务器上的
			that.connections = data.connections;
			that.me = data.you;
			that.emit("get_peers", that.connections);
		});

		this.on("_ice_candidate", function(data) {
			var candidate = new nativeRTCIceCandidate(data);
			var pc = that.peerConnections[data.socketId];
			pc.addIceCandidate(candidate);
			that.emit('get_ice_candidate', candidate);
		});

		this.on('_new_peer', function(data) {
			that.connections.push(data.socketId);
			var pc = that.createPeerConnection(data.socketId),
				i, m;
			for (i = 0, m = that.streams.length; i < m; i++) {
				pc.addStream(that.streams[i]);
			}
			that.emit('new_peer', data.socketId);
		});

		this.on('_remove_peer', function(data) {
			var sendId;
			delete that.peerConnections[data.socketId];
			delete that.dataChannels[data.socketId];
			for (sendId in that.fileChannels[data.socketId]) {
				that.emit("send_file_error", new Error("Connection has been closed"), sendId, data.socketId, that.fileChannels[data.socketId][sendId].file);
			}
			delete that.fileChannels[data.socketId];
			that.emit("remove_peer", data.socketId);
		});

		this.on('_offer', function(data) {
			that.receiveOffer(data.socketId, data.sdp);
			that.emit("get_offer", data);
		});

		this.on('_answer', function(data) {
			that.receiveAnswer(data.socketId, data.sdp);
			that.emit('get_answer', data);
		});

		this.on('send_file_error', function(error, sendId, socketId, file) {
			that.cleanSendFile(sendId, socketId);
		});

		this.on('receive_file_error', function(error, sendId) {
			that.cleanReceiveFile(sendId);
		});

		this.emit('connected');
	};

	SkyRTC.prototype.createStream = function(options) {
		var that = this;

		options.video = !! options.video;
		options.audio = !! options.audio;

		if (getUserMedia) {
			this.numStreams++;
			getUserMedia.call(navigator, options, function(stream) {
					that.streams.push(stream);
					that.initializedStreams++;
					that.emit("stream_created", stream);
					if (that.initializedStreams === that.numStreams) {
						that.emit("ready");
					}
				},
				function(error) {
					that.emit("stream_create_error", error);
				});
		} else {
			alert('WebRTC is not yet supported in this browser.');
		}
	};

	SkyRTC.prototype.createPeerConnections = function() {
		var i, m;
		for (i = 0, m = rtc.connections.length; i < m; i++) {
			this.createPeerConnection(this.connections[i]);
		}
	};

	SkyRTC.prototype.createPeerConnection = function(socketId) {
		var that = this;
		var pc = new PeerConnection(iceServer);
		this.peerConnections[socketId] = pc;
		pc.onicecandidate = function(evt) {
			if (evt.candidate)
				that.socket.send(JSON.stringify({
					"eventName": "__ice_candidate",
					"data": {
						"label": evt.candidate.sdpMLineIndex,
						"candidate": evt.candidate.candidate,
						"socketId": socketId
					}
				}));
			that.emit("pc_get_ice_candidate", evt.candidate);
		};

		pc.onopen = function() {
			that.emit("pc_opened", pc);
		};

		pc.onaddstream = function(evt) {
			that.emit('pc_add_stream', evt.stream, socketId);
		};

		pc.ondatachannel = function(evt) {
			that.addDataChannel(socketId, evt.channel);
		};
		return pc;
	};

	SkyRTC.prototype.addStreams = function() {
		var i, m,
			stream,
			connection;
		for (i = 0, m = this.streams.length; i < m; i++) {
			stream = this.streams[i];
			for (connection in this.peerConnections) {
				this.peerConnections[connection].addStream(stream);
			}
		}
	};

	SkyRTC.prototype.sendOffers = function() {
		var i, m,
			pc,
			that = this,
			pcCreateOfferCbGen = function(pc, socketId) {
				return function(session_desc) {
					pc.setLocalDescription(session_desc);
					that.socket.send(JSON.stringify({
						"eventName": "__offer",
						"data": {
							"sdp": session_desc,
							"socketId": socketId
						}
					}));
				};
			},
			pcCreateOfferErrorCb = function(error) {
				console.log(error);
			};
		for (i = 0, m = this.connections.length; i < m; i++) {
			pc = this.peerConnections[this.connections[i]];
			pc.createOffer(pcCreateOfferCbGen(pc, this.connections[i]), pcCreateOfferErrorCb);
		}
	};

	SkyRTC.prototype.receiveOffer = function(socketId, sdp) {
		var pc = this.peerConnections[socketId];
		this.sendAnswer(socketId, sdp);
	};

	SkyRTC.prototype.sendAnswer = function(socketId, sdp) {
		var pc = this.peerConnections[socketId];
		var that = this;
		pc.setRemoteDescription(new nativeRTCSessionDescription(sdp));
		pc.createAnswer(function(session_desc) {
			pc.setLocalDescription(session_desc);
			that.socket.send(JSON.stringify({
				"eventName": "__answer",
				"data": {
					"socketId": socketId,
					"sdp": session_desc
				}
			}));
		}, function(error) {
			console.log(error);
		});
	};

	SkyRTC.prototype.receiveAnswer = function(socketId, sdp) {
		var pc = this.peerConnections[socketId];
		pc.setRemoteDescription(new nativeRTCSessionDescription(sdp));
	};

	SkyRTC.prototype.attachStream = function(stream, domId) {
		var element = document.getElementById(domId);
		if (navigator.mozGetUserMedia) {
			element.mozSrcObject = stream;
			element.play();
		} else {
			element.src = webkitURL.createObjectURL(stream);
		}
		element.src = webkitURL.createObjectURL(stream);
	};

	SkyRTC.prototype.addDataChannels = function() {
		var connection;
		for (connection in this.peerConnections) {
			this.createDataChannel(connection);
		}
	};

	SkyRTC.prototype.createDataChannel = function(socketId, label) {
		var pc, key, channel;
		pc = this.peerConnections[socketId];

		if (!socketId) {
			this.emit("data_channel_create_error", socketId, new Error("attempt to create data channel without socket id"));
		}

		if (!(pc instanceof PeerConnection)) {
			this.emit("data_channel_create_error", socketId, new Error("attempt to create data channel without peerConnection"));
		}
		try {
			channel = pc.createDataChannel(label);
			this.emit("data_channel_created", channel, socketId);
		} catch (error) {
			this.emit("data_channel_create_error", socketId, error);
		}

		return this.addDataChannel(socketId, channel);
	};

	SkyRTC.prototype.addDataChannel = function(socketId, channel) {
		var that = this;
		channel.onopen = function() {
			that.emit('data_channel_opened', channel, socketId);
		};

		channel.onclose = function(event) {
			delete that.dataChannels[socketId];
			that.emit('data_channel_closed', channel, socketId);
		};

		channel.onmessage = function(message) {
			var json;
			json = JSON.parse(message.data);
			if (json.type === '__file') {
				/*that.receiveFileChunk(json);*/
				that.parseFilePacket(json, socketId);
			} else {
				that.emit('data_channel_message', channel, socketId, message.data);
			}
		};

		channel.onerror = function(err) {
			that.emit('data_channel_error', channel, socketId, err);
		};

		this.dataChannels[socketId] = channel;
		return channel;
	};
	/**********************************************/
	/*               file transfer                */
	/**********************************************/

	SkyRTC.prototype.shareFile = function(dom) {
		var socketId,
			that = this;
		for (socketId in that.dataChannels) {
			that.sendFile(socketId, dom);
		}
	};

	SkyRTC.prototype.sendFile = function(socketId, dom) {
		var that = this,
			file,
			reader,
			fileToSend,
			sendId;
		if (typeof dom === 'string') {
			dom = document.getElementById(dom);
		}
		if (!dom) {
			that.emit("send_file_error", new Error("Can not find dom while sending file"), socketId);
			return;
		}
		if (!dom.files || !dom.files[0]) {
			that.emit("send_file_error", new Error("No file need to be sended"), socketId);
			return;
		}
		file = dom.files[0];
		that.fileChannels[socketId] = that.fileChannels[socketId] || {};
		sendId = that.getRandomString();
		fileToSend = {
			file: file,
			state: "ask"
		};
		that.fileChannels[socketId][sendId] = fileToSend;
		that.sendAsk(socketId, sendId, fileToSend);
		that.emit("send_file", sendId, socketId, file);
	};

	SkyRTC.prototype.parseFilePacket = function(json, socketId) {
		var signal = json.signal,
			that = this;
		if (signal === 'ask') {
			that.receiveFileAsk(json.sendId, json.name, json.size, socketId);
		} else if (signal === 'accept') {
			that.receiveFileAccept(json.sendId, socketId);
		} else if (signal === 'refuse') {
			that.receiveFileRefuse(json.sendId, socketId);
		} else if (signal === 'chunk') {
			that.receiveFileChunk(json.data, json.sendId, socketId, json.last, json.percent);
		} else if (signal === 'close') {
			//TODO
		}
	};

	SkyRTC.prototype.receiveFileChunk = function(data, sendId, socketId, last, percent) {
		var that = this,
			fileInfo = that.receiveFiles[sendId];
		if (!fileInfo.data) {
			fileInfo.state = "receive";
			fileInfo.data = "";
		}
		fileInfo.data = fileInfo.data || "";
		fileInfo.data += data;
		if (last) {
			fileInfo.state = "end";
			that.getTransferedFile(sendId);
		} else {
			that.emit("receive_file_chunk", sendId, socketId, fileInfo.name, percent);
		}
	};

	SkyRTC.prototype.getTransferedFile = function(sendId) {
		var that = this,
			fileInfo = that.receiveFiles[sendId],
			hyperlink = document.createElement("a"),
			mouseEvent = new MouseEvent('click', {
				view: window,
				bubbles: true,
				cancelable: true
			});
		hyperlink.href = fileInfo.data;
		hyperlink.target = '_blank';
		hyperlink.download = fileInfo.name || dataURL;

		hyperlink.dispatchEvent(mouseEvent);
		(window.URL || window.webkitURL).revokeObjectURL(hyperlink.href);
		that.emit("receive_file", sendId, fileInfo.socketId, fileInfo.name);
		that.cleanReceiveFile(sendId);
	};

	SkyRTC.prototype.receiveFileAsk = function(sendId, fileName, fileSize, socketId) {
		var that = this;
		that.receiveFiles[sendId] = {
			socketId: socketId,
			state: "ask",
			name: fileName,
			size: fileSize
		};
		that.emit("receive_file_ask", sendId, socketId, fileName, fileSize);
	};

	SkyRTC.prototype.receiveFileRefuse = function(sendId, socketId) {
		var that = this;
		that.fileChannels[socketId][sendId].state = "refused";
		that.emit("send_file_refused", sendId, socketId, that.fileChannels[socketId][sendId].file);
		that.cleanSendFile(sendId, socketId);
	};

	SkyRTC.prototype.receiveFileAccept = function(sendId, socketId) {
		var that = this,
			fileToSend,
			reader,
			initSending = function(event, text) {
				fileToSend.state = "send";
				fileToSend.fileData = event.target.result;
				fileToSend.sendedPackets = 0;
				fileToSend.packetsToSend = fileToSend.allPackets = parseInt(fileToSend.fileData.length / packetSize, 10);
				that.sendFileChunks();
			};
		fileToSend = that.fileChannels[socketId][sendId];
		reader = new window.FileReader(fileToSend.file);
		reader.readAsDataURL(fileToSend.file);
		reader.onload = initSending;
		that.emit("send_file_accepted", sendId, socketId, that.fileChannels[socketId][sendId].file);
	};

	SkyRTC.prototype.sendFileChunks = function() {
		var socketId,
			sendId,
			that = this,
			nextTick = false;
		for (socketId in that.fileChannels) {
			for (sendId in that.fileChannels[socketId]) {
				if (that.fileChannels[socketId][sendId].state === "send") {
					nextTick = true;
					that.sendFileChunk(socketId, sendId);
				}
			}
		}
		if (nextTick) {
			setTimeout(function() {
				that.sendFileChunks();
			}, 10);
		}
	};

	SkyRTC.prototype.sendFileChunk = function(socketId, sendId) {
		var that = this,
			fileToSend = that.fileChannels[socketId][sendId],
			packet = {
				type: "__file",
				signal: "chunk",
				sendId: sendId
			},
			channel;

		fileToSend.sendedPackets++;
		fileToSend.packetsToSend--;


		if (fileToSend.fileData.length > packetSize) {
			packet.last = false;
			packet.data = fileToSend.fileData.slice(0, packetSize);
			packet.percent = fileToSend.sendedPackets / fileToSend.allPackets * 100;
			that.emit("send_file_chunk", sendId, socketId, fileToSend.sendedPackets / fileToSend.allPackets * 100, fileToSend.file);
		} else {
			packet.data = fileToSend.fileData;
			packet.last = true;
			fileToSend.state = "end";
			that.emit("sended_file", sendId, socketId, fileToSend.file);
			that.cleanSendFile(sendId, socketId);
		}

		channel = that.dataChannels[socketId];

		if (!channel) {
			that.emit("send_file_error", new Error("Channel has been destoried"), sendId, socketId, fileToSend.file);
			return;
		}
		channel.send(JSON.stringify(packet));
		fileToSend.fileData = fileToSend.fileData.slice(packet.data.length);
	};

	SkyRTC.prototype.cleanSendFile = function(sendId, socketId) {
		var that = this;
		delete that.fileChannels[socketId][sendId];
	};

	SkyRTC.prototype.sendFileAccept = function(sendId) {
		console.log(sendId, this.receiveFiles);
		var that = this,
			fileInfo = that.receiveFiles[sendId],
			channel = that.dataChannels[fileInfo.socketId],
			packet;
		if (!channel) {
			that.emit("receive_file_error", new Error("Channel has been destoried"), sendId, socketId);
		}
		packet = {
			type: "__file",
			signal: "accept",
			sendId: sendId
		};
		channel.send(JSON.stringify(packet));
	};

	SkyRTC.prototype.sendFileRefuse = function(sendId) {
		var that = this,
			fileInfo = that.receiveFiles[sendId],
			channel = that.dataChannels[fileInfo.socketId],
			packet;
		if (!channel) {
			that.emit("receive_file_error", new Error("Channel has been destoried"), sendId, socketId);
		}
		packet = {
			type: "__file",
			signal: "refuse",
			sendId: sendId
		};
		channel.send(JSON.stringify(packet));
		that.cleanReceiveFile(sendId);
	};

	SkyRTC.prototype.cleanReceiveFile = function(sendId) {
		var that = this;
		delete that.receiveFiles[sendId];
	};

	SkyRTC.prototype.sendAsk = function(socketId, sendId, fileToSend) {
		var that = this,
			channel = that.dataChannels[socketId],
			packet;
		if (!channel) {
			that.emit("send_file_error", new Error("Channel has been closed"), sendId, socketId, fileToSend.file);
		}
		packet = {
			name: fileToSend.file.name,
			size: fileToSend.file.size,
			sendId: sendId,
			type: "__file",
			signal: "ask"
		};
		channel.send(JSON.stringify(packet));
	};

	SkyRTC.prototype.getRandomString = function() {
		return (Math.random() * new Date().getTime()).toString(36).toUpperCase().replace(/\./g, '-');
	};

	var rtc = new SkyRTC();

	rtc.on('ready', function() {
		rtc.createPeerConnections();
		rtc.addStreams();
		rtc.addDataChannels();
		rtc.sendOffers();
	});

	return rtc;
}());