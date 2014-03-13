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
	//事件处理器
	function EventEmitter() {
		this.events = {};
	}

	EventEmitter.prototype.on = function(eventName, callback) {
		this.events[eventName] = this.events[eventName] || [];
		this.events[eventName].push(callback);
	};

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
	}
	//事件处理器
	SkyRTC.prototype = new EventEmitter();
	//通过dataChannels进行广播
	SkyRTC.prototype.broadcast = function(message) {
		var socketId;
		for (socketId in this.dataChannels) {
			this.sendMessage(message, socketId);
		}
	};
	SkyRTC.prototype.sendMessage = function(message, socketId) {
		if (this.dataChannels[socketId].readyState.toLowerCase() === 'open') {
			this.dataChannels[socketId].send(message);
		}
	};
	//本地连接信道，信道为websocket
	SkyRTC.prototype.connect = function(server) {
		var socket,
			that = this;
		socket = this.socket = new WebSocket(server);
		socket.onopen = function() {
			socket.send(JSON.stringify({
				"eventName": "__join"
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
			delete that.peerConnections[data.socketId];
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
			try {
				var json = JSON.parse(message.data);
				if (json.type === '__file') {
					that.receiveFileChunk(json);
				} else {
					that.emit('data_channel_message', channel, socketId, message.data);
				}
			} catch (err) {
				console.log(err);
				that.emit('data_channel_message', channel, socketId, message.data);
			}
		};

		channel.onerror = function(err) {
			that.emit('data_channel_error', channel, socketId, err);
		};

		this.dataChannels[socketId] = channel;
		return channel;
	};

	SkyRTC.prototype.receiveFileChunk = function(json) {
		var dataURL;
		this.fileData[json.uuid] = this.fileData[json.uuid] || "";
		this.fileData[json.uuid] += json.data;
		if (json.last) {
			this.getTransferedFile(json.uuid, json.name);
			delete this.fileData[json.uuid];
		} else {
			this.emit("receive_file_chunk", json.uuid, json.name ,json.percent);
		}
	};

	SkyRTC.prototype.getTransferedFile = function(uuid, fileName) {
		var dataURL = this.fileData[uuid];
		var hyperlink = document.createElement("a");
		hyperlink.href = dataURL;
		hyperlink.target = '_blank';
		hyperlink.download = fileName || dataURL;

		var mouseEvent = new MouseEvent('click', {
			view: window,
			bubbles: true,
			cancelable: true
		});
		hyperlink.dispatchEvent(mouseEvent);
		(window.URL || window.webkitURL).revokeObjectURL(hyperlink.href);
		this.emit("receive_file", uuid, fileName);
	};

	SkyRTC.prototype.sendFile = function(dom) {
		var that = this,
			file = dom.files[0],
			reader = new window.FileReader(file),
			getRandomString = function() {
				return (Math.random() * new Date().getTime()).toString(36).toUpperCase().replace(/\./g, '-');
			},
			uuid = getRandomString(),
			packetSize = 1000,
			packetsToSend = 0,
			textToTransfer = '',
			sendedPackets = 0,
			allPackets = 0,
			sendChunk = function(event, fileData) {
				var _packet = {
					type: "__file",
					uuid: uuid,
					name: file.name
				};
				if (event) {
					fileData = event.target.result;
					allPackets = packetsToSend = parseInt(fileData.length / packetSize, 10);
				}

				sendedPackets++;
				packetsToSend--;

				
				if (fileData.length > packetSize) {
					_packet.data = fileData.slice(0, packetSize);
					_packet.percent = sendedPackets/ allPackets * 100;
					that.emit("send_file_chunk", sendedPackets/ allPackets * 100, file);
				} else {
					_packet.data = fileData;
					_packet.last = true;
					that.emit("sended_file", file);
				}


				that.broadcast(JSON.stringify(_packet));

				textToTransfer = fileData.slice(_packet.data.length);



				if (textToTransfer.length) {
					setTimeout(function() {
						sendChunk(null, textToTransfer);
					}, moz ? 1 : 500);
				}
			};


		reader.readAsDataURL(file);
		reader.onload = sendChunk;
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