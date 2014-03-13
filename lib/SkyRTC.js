var WebSocketServer = require('ws').Server;
var UUID = require('node-uuid');
var events = require('events');
var util = require('util');
var errorCb = function(error) {
	if (error) {
		console.log(error);
	}
};

function SkyRTC() {
	this.sockets = [];
	this.on('__join', function(data, socket) {
		var ids = [],
			i, m,
			curSocket;

		for (i = 0, m = this.sockets.length; i < m; i++) {
			curSocket = this.sockets[i];
			if (curSocket.id === socket.id) {
				continue;
			}
			ids.push(curSocket.id);
			curSocket.send(JSON.stringify({
				"eventName": "_new_peer",
				"data": {
					"socketId": socket.id
				}
			}), errorCb);
		}

		socket.send(JSON.stringify({
			"eventName": "_peers",
			"data": {
				"connections": ids,
				"you": socket.id
			}
		}), errorCb);

		this.emit('new_peer', socket, this);
	});

	this.on('__ice_candidate', function(data, socket) {
		var soc = this.getSocket(data.socketId);

		if (soc) {
			soc.send(JSON.stringify({
				"eventName": "_ice_candidate",
				"data": {
					"label": data.label,
					"candidate": data.candidate,
					"socketId": socket.id
				}
			}), errorCb);

			this.emit('get_ice_candidate', this);
		}
	});

	this.on('__offer', function(data, socket) {
		var soc = this.getSocket(data.socketId);

		if (soc) {
			soc.send(JSON.stringify({
				"eventName": "_offer",
				"data": {
					"sdp": data.sdp,
					"socketId": socket.id
				}
			}), errorCb);
		}
		this.emit('send_offer', this);
	});

	this.on('__answer', function(data, socket) {
		var soc = this.getSocket(data.socketId);
		if (soc) {
			soc.send(JSON.stringify({
				"eventName": "_answer",
				"data": {
					"sdp": data.sdp,
					"socketId": socket.id
				}
			}), errorCb);
			this.emit('send_answer', this);
		}
	});
}

util.inherits(SkyRTC, events.EventEmitter);

SkyRTC.prototype.addSocket = function(socket) {
	this.sockets.push(socket);
};

SkyRTC.prototype.removeSocket = function(socket) {
	var i = this.sockets.indexOf(socket);
	this.sockets.splice(i, 1);
};

SkyRTC.prototype.broadcast = function(data, errorCb) {
	var i;
	for (i = this.sockets.length; i--;) {
		this.sockets[i].send(data, errorCb);
	}
};

SkyRTC.prototype.getSocket = function(id) {
	var i,
		curSocket;
	if (!this.sockets) {
		return;
	}
	for (i = this.sockets.length; i--;) {
		curSocket = this.sockets[i];
		if (id === curSocket.id) {
			return curSocket;
		}
	}
	return;
};

SkyRTC.prototype.init = function(socket) {
	var that = this;
	socket.id = UUID.v4();
	that.addSocket(socket);
	//为新连接绑定事件处理器
	socket.on('message', function(data) {
		var json = JSON.parse(data);
		if (json.eventName) {
			that.emit(json.eventName, json.data, socket);
		} else {
			that.emit("socket_message", json);
		}
	});
	//新连接关闭后从SkyRTC实例中移除连接，并通知其他连接
	socket.on('close', function() {
		var i, m;
		that.removeSocket(socket);

		that.broadcast(JSON.stringify({
			"eventName": "_remove_peer",
			"data": {
				"socketId": socket.id
			}
		}), errorCb);

		that.emit('remove_peer', socket.id, that);
	});
	that.emit('new_connect', that);
};

module.exports.listen = function(server) {
	var SkyRTCServer;
	if (typeof server === 'number') {
		SkyRTCServer = new WebSocketServer({
			port: server
		});
	} else {
		SkyRTCServer = new WebSocketServer({
			server: server
		});
	}

	SkyRTCServer.rtc = new SkyRTC();

	SkyRTCServer.on('connection', function(socket) {
		this.rtc.init(socket);
	});

	return SkyRTCServer;
};