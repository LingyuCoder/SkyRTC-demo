var express = require('express');
var app = express();
var server = require('http').createServer(app);
var SkyRTC = require('./lib/SkyRTC.js').listen(server);
var path = require("path");

var port = process.env.PORT || 3000;
server.listen(port);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', function(req, res) {
  res.sendfile(__dirname + '/index.html');
});

SkyRTC.rtc.on('new_connect', function(rtc){
  console.log('创建新连接');
});

SkyRTC.rtc.on('remove_peer', function(socketId, rtc){
  console.log(socketId + "用户离开");
});

SkyRTC.rtc.on('new_peer', function(socket, rtc){
  console.log("新用户" + socket.id + "加入");
});
