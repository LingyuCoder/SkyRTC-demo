var SkyRTC = function() {
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

    /**********************************************************/
    /*                                                        */
    /*                       事件处理器                       */
    /*                                                        */
    /**********************************************************/
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


    /**********************************************************/
    /*                                                        */
    /*                   流及信道建立部分                     */
    /*                                                        */
    /**********************************************************/


    /*******************基础部分*********************/
    function skyrtc() {
        //本地media stream
        this.localMediaStream = null;
        //所在房间
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
    skyrtc.prototype = new EventEmitter();


    /*************************服务器连接部分***************************/


    //本地连接信道，信道为websocket
    skyrtc.prototype.connect = function(server, room) {
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
                that.emit("socket_receive_message", socket, json);
            }
        };

        socket.onerror = function(error) {
            that.emit("socket_error", error, socket);
        };

        socket.onclose = function(data) {
            that.localMediaStream.close();
            var pcs = that.peerConnections;
            for (i = pcs.length; i--;) {
                that.closePeerConnection(pcs[i]);
            }
            that.peerConnections = [];
            that.dataChannels = {};
            that.fileChannels = {};
            that.connections = [];
            tjat.fileData = {};
            that.emit('socket_closed', socket);
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
            pc.addStream(that.localMediaStream);
            that.emit('new_peer', data.socketId);
        });

        this.on('_remove_peer', function(data) {
            var sendId;
            that.closePeerConnection(that.peerConnections[data.socketId]);
            delete that.peerConnections[data.socketId];
            delete that.dataChannels[data.socketId];
            for (sendId in that.fileChannels[data.socketId]) {
                that.emit("send_file_error", new Error("Connection has been closed"), data.socketId, sendId, that.fileChannels[data.socketId][sendId].file);
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

        this.on('send_file_error', function(error, socketId, sendId, file) {
            that.cleanSendFile(sendId, socketId);
        });

        this.on('receive_file_error', function(error, sendId) {
            that.cleanReceiveFile(sendId);
        });

        this.on('ready', function() {
            that.createPeerConnections();
            that.addStreams();
            that.addDataChannels();
            that.sendOffers();
        });

        this.emit('connected', socket);
    };


    /*************************流处理部分*******************************/


    //创建本地流
    skyrtc.prototype.createStream = function(options) {
        var that = this;

        options.video = !! options.video;
        options.audio = !! options.audio;

        if (getUserMedia) {
            this.numStreams++;
            getUserMedia.call(navigator, options, function(stream) {
                    that.localMediaStream = stream;
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
            that.emit("stream_create_error", new Error('WebRTC is not yet supported in this browser.'));
        }
    };
    
    //将本地流添加到所有的PeerConnection实例中
    skyrtc.prototype.addStreams = function() {
        var i, m,
            stream,
            connection;
        for (connection in this.peerConnections) {
            this.peerConnections[connection].addStream(this.localMediaStream);
        }
    };

    //将流绑定到video标签上用于输出
    skyrtc.prototype.attachStream = function(stream, domId) {
        var element = document.getElementById(domId);
        if (navigator.mozGetUserMedia) {
            element.mozSrcObject = stream;
            element.play();
        } else {
            element.src = webkitURL.createObjectURL(stream);
        }
        element.src = webkitURL.createObjectURL(stream);
    };


    /***********************信令交换部分*******************************/


    //向所有PeerConnection发送Offer类型信令
    skyrtc.prototype.sendOffers = function() {
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

    //接收到Offer类型信令后作为回应返回answer类型信令
    skyrtc.prototype.receiveOffer = function(socketId, sdp) {
        var pc = this.peerConnections[socketId];
        this.sendAnswer(socketId, sdp);
    };

    //发送answer类型信令
    skyrtc.prototype.sendAnswer = function(socketId, sdp) {
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

    //接收到answer类型信令后将对方的session描述写入PeerConnection中
    skyrtc.prototype.receiveAnswer = function(socketId, sdp) {
        var pc = this.peerConnections[socketId];
        pc.setRemoteDescription(new nativeRTCSessionDescription(sdp));
    };


    /***********************点对点连接部分*****************************/


    //创建与其他用户连接的PeerConnections
    skyrtc.prototype.createPeerConnections = function() {
        var i, m;
        for (i = 0, m = rtc.connections.length; i < m; i++) {
            this.createPeerConnection(this.connections[i]);
        }
    };

    //创建单个PeerConnection
    skyrtc.prototype.createPeerConnection = function(socketId) {
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
            that.emit("pc_get_ice_candidate", evt.candidate, socketId, pc);
        };

        pc.onopen = function() {
            that.emit("pc_opened", socketId, pc);
        };

        pc.onaddstream = function(evt) {
            that.emit('pc_add_stream', evt.stream, socketId, pc);
        };

        pc.ondatachannel = function(evt) {
            that.addDataChannel(socketId, evt.channel);
            that.emit('pc_add_data_channel', evt.channel, socketId, pc);
        };
        return pc;
    };

    //关闭PeerConnection连接
    skyrtc.prototype.closePeerConnection = function(pc) {
        if (!pc) return;
        pc.close();
    };
    

    /***********************数据通道连接部分*****************************/

    
    //消息广播
    skyrtc.prototype.broadcast = function(message) {
        var socketId;
        for (socketId in this.dataChannels) {
            this.sendMessage(message, socketId);
        }
    };

    //发送消息方法
    skyrtc.prototype.sendMessage = function(message, socketId) {
        if (this.dataChannels[socketId].readyState.toLowerCase() === 'open') {
            this.dataChannels[socketId].send(JSON.stringify({
                type: "__msg",
                data: message
            }));
        }
    };
    
    //对所有的PeerConnections创建Data channel
    skyrtc.prototype.addDataChannels = function() {
        var connection;
        for (connection in this.peerConnections) {
            this.createDataChannel(connection);
        }
    };

    //对某一个PeerConnection创建Data channel
    skyrtc.prototype.createDataChannel = function(socketId, label) {
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
        } catch (error) {
            this.emit("data_channel_create_error", socketId, error);
        }

        return this.addDataChannel(socketId, channel);
    };

    //为Data channel绑定相应的事件回调函数
    skyrtc.prototype.addDataChannel = function(socketId, channel) {
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
                that.emit('data_channel_message', channel, socketId, json.data);
            }
        };

        channel.onerror = function(err) {
            that.emit('data_channel_error', channel, socketId, err);
        };

        this.dataChannels[socketId] = channel;
        return channel;
    };



    /**********************************************************/
    /*                                                        */
    /*                       文件传输                         */
    /*                                                        */
    /**********************************************************/

    /************************公有部分************************/

    //解析Data channel上的文件类型包,来确定信令类型
    skyrtc.prototype.parseFilePacket = function(json, socketId) {
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

    /***********************发送者部分***********************/


    //通过Dtata channel向房间内所有其他用户广播文件
    skyrtc.prototype.shareFile = function(dom) {
        var socketId,
            that = this;
        for (socketId in that.dataChannels) {
            that.sendFile(dom, socketId);
        }
    };

    //向某一单个用户发送文件
    skyrtc.prototype.sendFile = function(dom, socketId) {
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

    //发送多个文件的碎片
    skyrtc.prototype.sendFileChunks = function() {
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

    //发送某个文件的碎片
    skyrtc.prototype.sendFileChunk = function(socketId, sendId) {
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
            that.emit("send_file_error", new Error("Channel has been destoried"), socketId, sendId, fileToSend.file);
            return;
        }
        channel.send(JSON.stringify(packet));
        fileToSend.fileData = fileToSend.fileData.slice(packet.data.length);
    };

    //发送文件请求后若对方同意接受,开始传输
    skyrtc.prototype.receiveFileAccept = function(sendId, socketId) {
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

    //发送文件请求后若对方拒绝接受,清除掉本地的文件信息
    skyrtc.prototype.receiveFileRefuse = function(sendId, socketId) {
        var that = this;
        that.fileChannels[socketId][sendId].state = "refused";
        that.emit("send_file_refused", sendId, socketId, that.fileChannels[socketId][sendId].file);
        that.cleanSendFile(sendId, socketId);
    };

    //清除发送文件缓存
    skyrtc.prototype.cleanSendFile = function(sendId, socketId) {
        var that = this;
        delete that.fileChannels[socketId][sendId];
    };

    //发送文件请求
    skyrtc.prototype.sendAsk = function(socketId, sendId, fileToSend) {
        var that = this,
            channel = that.dataChannels[socketId],
            packet;
        if (!channel) {
            that.emit("send_file_error", new Error("Channel has been closed"), socketId, sendId, fileToSend.file);
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

    //获得随机字符串来生成文件发送ID
    skyrtc.prototype.getRandomString = function() {
        return (Math.random() * new Date().getTime()).toString(36).toUpperCase().replace(/\./g, '-');
    };

    /***********************接收者部分***********************/


    //接收到文件碎片
    skyrtc.prototype.receiveFileChunk = function(data, sendId, socketId, last, percent) {
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

    //接收到所有文件碎片后将其组合成一个完整的文件并自动下载
    skyrtc.prototype.getTransferedFile = function(sendId) {
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

    //接收到发送文件请求后记录文件信息
    skyrtc.prototype.receiveFileAsk = function(sendId, fileName, fileSize, socketId) {
        var that = this;
        that.receiveFiles[sendId] = {
            socketId: socketId,
            state: "ask",
            name: fileName,
            size: fileSize
        };
        that.emit("receive_file_ask", sendId, socketId, fileName, fileSize);
    };
   
    //发送同意接收文件信令
    skyrtc.prototype.sendFileAccept = function(sendId) {
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

    //发送拒绝接受文件信令
    skyrtc.prototype.sendFileRefuse = function(sendId) {
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

    //清除接受文件缓存
    skyrtc.prototype.cleanReceiveFile = function(sendId) {
        var that = this;
        delete that.receiveFiles[sendId];
    };

    return new skyrtc();
};